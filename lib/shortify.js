// lib/shortify.js
//
// Server-side "AI Viral Clip Extractor" analysis. Takes a transcript
// (segment-level text with timestamps) for a long-form video and asks
// an LLM to identify which portions are the strongest candidates for
// short-form (TikTok/Reels/Shorts) clips.
//
// Runs on the server's own pooled Groq keys (GROQ_API_KEYS, see
// lib/groqKeys.js) — api/shortify.js picks a key from that pool and passes
// it in as `apiKey` below. Customers never supply or see a Groq key.
//
// v1 scope (deliberately limited — bigger swings are a v2 conversation):
//  - Transcript-only signal. No audio energy/laughter/tone-of-voice
//    detection yet — that would need real audio analysis infra this app
//    doesn't have wired up.
//  - "Hook at the start" is achieved by only SELECTING segments whose own
//    opening line is already a strong hook — not by re-cutting/reordering
//    footage to manufacture one. Reordering/cold-opening is a v2 feature;
//    it's a much bigger (and riskier — jarring edits if done wrong) lift.
//  - Long videos are split into ~15-minute transcript windows, each
//    analyzed independently, then every window's candidates are merged
//    and ranked together. This keeps each LLM call small/fast regardless
//    of total video length, and bounds cost predictably per chunk instead
//    of ballooning with a single giant prompt.

const CHUNK_SECONDS = 15 * 60;       // 15-minute analysis windows
const MODEL = 'openai/gpt-oss-120b'; // Groq deprecated llama-3.3-70b-versatile (shutdown mid-Aug 2026); this is Groq's own recommended replacement
const MAX_CANDIDATES_PER_CHUNK = 3;  // only the standouts of each 15-min window
const MAX_CANDIDATES_RETURNED = 10;  // the 10 best across the whole stream
const MIN_SCORE = 85;                // quality floor: weaker picks are dropped, not shown
const MAX_CLIP_SECONDS = 75;         // hard safety cap even if the model ignores the 90s guidance

function chunkTranscript(segments, totalDurationSec) {
  const chunks = [];
  for (let start = 0; start < totalDurationSec; start += CHUNK_SECONDS) {
    const end = Math.min(start + CHUNK_SECONDS, totalDurationSec);
    const segs = segments.filter(s => s.start >= start && s.start < end);
    if (segs.length) chunks.push({ start, end, segments: segs });
  }
  return chunks;
}

function buildPrompt(chunk) {
  const transcriptText = chunk.segments
    .map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join('\n');

  return `You are a ruthless viral-clip editor for a Minecraft/gaming LIVESTREAM (streamer talking + reacting while playing). From ONE section of the stream transcript, pick ONLY the moments that would genuinely blow up as vertical Reels/Shorts/TikToks.

TRANSCRIPT SECTION (timestamps in seconds from the start of the FULL stream):
${transcriptText}

BE EXTREMELY STRICT. "score" (0-100) is your honest estimate of virality; ONLY return moments scoring ${MIN_SCORE} or higher, at most ${MAX_CANDIDATES_PER_CHUNK}. An average or merely-okay moment must NOT be returned. Returning [] is the correct answer for a boring section. What qualifies: big emotional reactions (screaming, rage, shock, disbelief), clutch plays / near-death / huge wins or fails, genuinely funny lines and banter, wild stories, drama, chat/donation reactions that pay off, unexpected twists.
Hard rules:
- 20-60 seconds long (never more than ${MAX_CLIP_SECONDS}). Start exactly where the moment starts (include just enough setup), end right after the payoff — no dead air before or after.
- The FIRST thing said must already grab attention (shout, bold line, question, punchline). Do NOT pick moments that only get good later.
- Fully self-contained: a stranger scrolling past must understand it with zero context.
- Must contain a clear payoff (a reaction, punchline or outcome), not just talking.
- Clips must not overlap.
- Ignore: stream housekeeping, "thanks for the sub", reading chat with no payoff, silence, repetitive filler.

Respond with ONLY a JSON array (no markdown fences, no prose), like:
[{"start": 123.4, "end": 168.9, "hookLine": "the exact opening line of the clip", "score": 91, "reason": "one short sentence on why this goes viral", "suggestedCaption": "PUNCHY on-screen top text, max 7 words, one emoji at the end, e.g. Bro gave him a tip for that 💀"}]

If nothing qualifies, return [].`;
}

// Marker so callers (analyzeTranscriptForClips / the API route) can tell an
// auth failure apart from an ordinary "model returned nothing useful" case —
// those need very different user-facing messages.
class GroqAuthError extends Error {
  constructor(msg, status, retryMs) { super(msg); this.status = status || null; this.retryMs = retryMs || null; }
}
const { nextAvailableKey, markKeyFailed, markKeyOk, parseRetryMs, hasLiveKey, getKeyPool, keyStatus, fmtDuration } = require('./groqKeys');

async function callGroq(prompt, apiKey) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    // GroqAuthError doubles as the "switch to the next key" signal: bad key
    // (401/403), rate limit (429) and Groq-side errors (5xx) all mean this
    // key can't serve the request right now, so the caller tries the next.
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new GroqAuthError(`Groq API error ${response.status}: ${errText.slice(0, 300)}`, response.status, parseRetryMs(response.headers, errText));
    }
    throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  return (data.choices || []).map(c => (c.message && c.message.content) || '').join('');
}

// Calls Groq for ONE chunk with instant failover across the dedicated clip
// pool: if a key dies (429 / expired / 5xx) mid-analysis, the SAME chunk is
// retried right away on the next live key — no progress lost, no restart.
// Dead keys are benched until Groq says they're back (see lib/groqKeys.js).
async function callGroqPooled(prompt, pool) {
  const tried = [];
  for (let i = 0; i < 12; i++) {
    const key = nextAvailableKey(tried, pool, 'chat', true);
    if (!key || tried.includes(key)) break;
    if (!hasLiveKey(pool, 'chat') && tried.length) break; // everything left is cooling
    tried.push(key);
    try {
      const out = await callGroq(prompt, key);
      markKeyOk(key);
      return out;
    } catch (e) {
      if (!(e instanceof GroqAuthError)) throw e;
      const dead = e.status === 401 || e.status === 403;
      const ms = dead ? 6 * 3600 * 1000 : (e.status >= 500 ? 10 * 1000 : (e.retryMs || 60 * 1000));
      markKeyFailed(key, ms, dead ? 'expired / invalid' : (e.status >= 500 ? 'Groq error ' + e.status : 'rate limited'));
      console.error('shortify: key slot', getKeyPool(pool).indexOf(key) + 1, 'failed', e.status, '- switching');
    }
  }
  const st = keyStatus(pool);
  const soon = st.length ? Math.min(...st.map(k => k.backInSec)) : 0;
  throw new GroqAuthError('All clip-finder keys are cooling down' + (soon ? ' — first one is back in ' + fmtDuration(soon) : ''), 503, soon * 1000);
}

function parseClipsJson(text, chunkStart, chunkEnd) {
  // The model is instructed to return raw JSON, but strip code fences
  // defensively in case it wraps the answer anyway.
  const cleaned = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(c =>
    c && typeof c.start === 'number' && typeof c.end === 'number' &&
    Number.isFinite(c.start) && Number.isFinite(c.end) &&
    c.end > c.start &&
    (typeof c.score !== 'number' || c.score >= MIN_SCORE) &&
    (c.end - c.start) <= MAX_CLIP_SECONDS &&
    // Sanity: the model should only ever reference timestamps that fall
    // within (or very slightly past, for rounding) the chunk it was given —
    // reject anything wildly out of range rather than trusting it blindly.
    c.start >= chunkStart - 5 && c.end <= chunkEnd + 5
  ).map(c => ({
    start: c.start,
    end: c.end,
    hookLine: typeof c.hookLine === 'string' ? c.hookLine.slice(0, 300) : '',
    score: typeof c.score === 'number' ? Math.max(0, Math.min(100, c.score)) : 50,
    reason: typeof c.reason === 'string' ? c.reason.slice(0, 300) : '',
    suggestedCaption: typeof c.suggestedCaption === 'string' ? c.suggestedCaption.slice(0, 200) : '',
  }));
}

// Analyzes a full transcript and returns ranked clip candidates.
// `segments` is [{start, end, text}, ...] (seconds, from Whisper/Groq).
// `totalDurationSec` is the full video's duration.
// `apiKey` is a key from the server's own pooled Groq keys (see
// api/shortify.js / lib/groqKeys.js) — never the customer's.
async function analyzeTranscriptForClips(segments, totalDurationSec, apiKey, pool, window_) {
  // apiKey given -> old single-key behavior. Otherwise use the pooled
  // failover path (pool 'clips' = dedicated clip-finder keys).
  if (!apiKey && !getKeyPool(pool).length) throw new GroqAuthError('Missing Groq API key');

  // window_ = {start,end}: analyze just that one window (the editor calls us once per
  // window so it can wait out rate limits between calls instead of failing).
  const chunks = window_
    ? [{ start: window_.start, end: window_.end, segments: segments.filter(s => s.start >= window_.start && s.start < window_.end) }]
    : chunkTranscript(segments, totalDurationSec);
  const allCandidates = [];

  for (const chunk of chunks) {
    if (!chunk.segments.length) continue;
    let text;
    try {
      text = apiKey ? await callGroq(buildPrompt(chunk), apiKey) : await callGroqPooled(buildPrompt(chunk), pool);
    } catch (e) {
      // An invalid/expired key will fail identically on every chunk — no
      // point burning through the rest of the video's windows, and the
      // caller needs to know it's a key problem, not "no clips found".
      if (e instanceof GroqAuthError) throw e;
      // Any other per-chunk failure (rate limit, malformed response, etc.)
      // shouldn't kill the whole video's results — skip it and keep
      // whatever other chunks produced.
      continue;
    }
    parseClipsJson(text, chunk.start, chunk.end).forEach(c => allCandidates.push(c));
  }

  allCandidates.sort((a, b) => b.score - a.score);
  // Drop anything overlapping a higher-scored pick (chunk edges can double-count a moment).
  const picked = [];
  for (const c of allCandidates) {
    if (c.end - c.start < 12) continue;
    if (picked.some(p => c.start < p.end && c.end > p.start)) continue;
    picked.push(c);
    if (!window_ && picked.length >= MAX_CANDIDATES_RETURNED) break;
  }
  return picked;
}

module.exports = {
  analyzeTranscriptForClips,
  chunkTranscript,
  CHUNK_SECONDS,
  MAX_CLIP_SECONDS,
  GroqAuthError,
};
