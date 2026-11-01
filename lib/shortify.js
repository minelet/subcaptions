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
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'; // Groq free tier: 30K tokens/min (gpt-oss-120b is only 8K/min and its hidden thinking tokens eat the budget)
const FALLBACK_MODEL = 'openai/gpt-oss-120b';
const MAX_CANDIDATES_PER_CHUNK = 4;  // only the standouts of each 15-min window
const MAX_CANDIDATES_RETURNED = 10;  // the 10 best across the whole stream
const MIN_SCORE = 60;                // quality floor: weaker picks are dropped, not shown
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
    .map(s => `[${Math.round(s.start)}]${s.loud === 2 ? ' (SHOUTING)' : s.loud === 1 ? ' (LOUD)' : ''} ${s.text}`)
    .join('\n');

  return `You are a ruthless viral-clip editor for a Minecraft/gaming LIVESTREAM (streamer talking + reacting while playing). From ONE section of the stream transcript, pick ONLY the moments that would genuinely blow up as vertical Reels/Shorts/TikToks.

The tags (SHOUTING)/(LOUD) come from the real audio volume and are a STRONG signal of excitement, rage, laughter or shock: strongly prefer moments around them (include the setup right before).

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

let lastModelUsed = null;
async function callGroq(prompt, apiKey, model) {
  model = model || MODEL;
  const body = {
    model,
    max_tokens: model === MODEL ? 1500 : 3000,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  };
  if (model !== MODEL) body.reasoning_effort = 'low'; // gpt-oss only (it thinks before answering)
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    // Model retired / not available to this account -> use the fallback model.
    if (model === MODEL && (response.status === 404 || (response.status === 400 && /model/i.test(errText)))) {
      console.error('shortify: primary model unavailable, using fallback:', errText.slice(0, 200));
      return callGroq(prompt, apiKey, FALLBACK_MODEL);
    }
    // 401/403 (bad key), 429 (rate limit), 5xx (Groq side): this key can't serve it
    // right now, so the caller switches to the next key.
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new GroqAuthError(`Groq API error ${response.status}: ${errText.slice(0, 300)}`, response.status, parseRetryMs(response.headers, errText));
    }
    throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 300)}`);
  }
  lastModelUsed = model;
  const data = await response.json();
  return (data.choices || []).map(c => (c.message && c.message.content) || '').join('');
}

// Calls Groq for ONE chunk with instant failover across the dedicated clip
// pool: if a key dies (429 / expired / 5xx) mid-analysis, the SAME chunk is
// retried right away on the next live key — no progress lost, no restart.
// Dead keys are benched until Groq says they're back (see lib/groqKeys.js).
async function callGroqPooled(prompt, pool, model) {
  const tried = [];
  for (let i = 0; i < 12; i++) {
    const key = nextAvailableKey(tried, pool, 'chat', false);
    if (!key || tried.includes(key)) break;
    if (!hasLiveKey(pool, 'chat') && tried.length) break; // everything left is cooling
    tried.push(key);
    try {
      const out = await callGroq(prompt, key, model);
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


// Final judge: takes the best candidates from all windows (id, excerpt, loudness)
// and uses the smarter model to rank them and write the top-text. One small call.
async function rerankCandidates(items, pool) {
  const list = items.map(it => `#${it.id} (${Math.round(it.end - it.start)}s, ${it.loud === 2 ? 'SHOUTING' : it.loud === 1 ? 'LOUD' : 'normal volume'}, first-pass score ${Math.round(it.score)}): ${String(it.excerpt || '').slice(0, 320)}`).join('\n');
  const prompt = `You are the FINAL judge for a Minecraft/gaming stream Shorts channel. Below are candidate clips cut from one long livestream. Pick the up to 10 that would perform best as vertical Reels/Shorts/TikToks and rank them best first.

What wins: an attention-grabbing first 3 seconds, real emotional spike (SHOUTING/LOUD audio is a strong sign), a clear payoff (funny, shocking, clutch, rage, wholesome twist), understandable without context. What loses: calm talking, setup without payoff, reading chat, repetition, dead air.
Score honestly 0-100. Do NOT invent ids.

CANDIDATES:
${list}

Respond with ONLY a JSON array, best first, e.g. [{"id": 4, "score": 93, "suggestedCaption": "punchy on-screen text, max 7 words, one emoji at the end"}]`;
  const text = await callGroqPooled(prompt, pool, FALLBACK_MODEL);
  let cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const i0 = cleaned.indexOf('['), i1 = cleaned.lastIndexOf(']');
  if (i0 >= 0 && i1 > i0) cleaned = cleaned.slice(i0, i1 + 1);
  let arr; try { arr = JSON.parse(cleaned); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const valid = new Set(items.map(i => i.id));
  const seen = new Set();
  return arr.map(a => ({ id: Number(a && a.id), score: Number(a && a.score), suggestedCaption: typeof (a && a.suggestedCaption) === 'string' ? a.suggestedCaption.slice(0, 120) : '' }))
    .filter(a => valid.has(a.id) && !seen.has(a.id) && seen.add(a.id))
    .map(a => ({ ...a, score: Number.isFinite(a.score) ? Math.max(0, Math.min(100, a.score)) : 70 }))
    .slice(0, 10);
}

function parseClipsJson(text, chunkStart, chunkEnd, stats) {
  stats = stats || {};
  const bump = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
  // Strip code fences, then grab the outermost [...] in case the model added prose.
  let cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const i0 = cleaned.indexOf('['), i1 = cleaned.lastIndexOf(']');
  if (i0 >= 0 && i1 > i0) cleaned = cleaned.slice(i0, i1 + 1);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    bump(cleaned ? 'unparseable' : 'emptyReplies');
    return [];
  }
  if (!Array.isArray(parsed)) { bump('unparseable'); return []; }
  bump('rawCandidates', parsed.length);

  const out = [];
  const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return (typeof n === 'number' && Number.isFinite(n)) ? n : null; };
  for (const c of parsed) {
    if (!c || typeof c !== 'object') { bump('malformed'); continue; }
    // Models sometimes return numbers as strings ("123.4") or use other key names — accept those.
    const start = num(c.start ?? c.start_time ?? c.startTime);
    let end = num(c.end ?? c.end_time ?? c.endTime);
    const score = num(c.score);
    if (start == null || end == null || end <= start) { bump('malformed'); continue; }
    if (score != null && score < MIN_SCORE) { bump('belowScoreBar'); continue; }
    // Too long: trim to the cap instead of throwing a good moment away.
    if ((end - start) > MAX_CLIP_SECONDS) { end = start + MAX_CLIP_SECONDS; bump('trimmedLong'); }
    // Sanity: timestamps must fall inside the window the model was given.
    if (start < chunkStart - 5 || end > chunkEnd + 5) { bump('outOfRange'); continue; }
    out.push({
      start,
      end,
      hookLine: typeof c.hookLine === 'string' ? c.hookLine.slice(0, 300) : '',
      score: score != null ? Math.max(0, Math.min(100, score)) : 50,
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 300) : '',
      suggestedCaption: typeof c.suggestedCaption === 'string' ? c.suggestedCaption.slice(0, 200) : '',
    });
  }
  return out;
}

// Analyzes a full transcript and returns ranked clip candidates.
// `segments` is [{start, end, text}, ...] (seconds, from Whisper/Groq).
// `totalDurationSec` is the full video's duration.
// `apiKey` is a key from the server's own pooled Groq keys (see
// api/shortify.js / lib/groqKeys.js) — never the customer's.
async function analyzeTranscriptForClips(segments, totalDurationSec, apiKey, pool, window_, stats) {
  stats = stats || {};
  // apiKey given -> old single-key behavior. Otherwise use the pooled
  // failover path (pool 'clips' = dedicated clip-finder keys).
  if (!apiKey && !getKeyPool(pool).length) throw new GroqAuthError('Missing Groq API key');

  // window_ = {start,end}: analyze just that one window (the editor calls us once per
  // window so it can wait out rate limits between calls instead of failing).
  const chunks = window_
    ? [{ start: window_.start, end: window_.end, segments: segments.filter(s => s.start >= window_.start && s.start < window_.end) }]
    : chunkTranscript(segments, totalDurationSec);
  const allCandidates = [];

  // Hard cap per AI call (~2.5k tokens of transcript) so one request can never be
  // bigger than a key's per-minute budget, whatever model Groq serves. A 15-min
  // window just becomes 2-3 smaller calls.
  const MAX_CALL_CHARS = 9000;
  const sized = [];
  for (const ch of chunks) {
    let cur = [], len = 0;
    for (const sg of ch.segments) {
      const l = (sg.text || '').length + 8;
      if (cur.length && len + l > MAX_CALL_CHARS) { sized.push({ start: ch.start, end: ch.end, segments: cur }); cur = []; len = 0; }
      cur.push(sg); len += l;
    }
    if (cur.length) sized.push({ start: ch.start, end: ch.end, segments: cur });
  }
  stats.calls = (stats.calls || 0) + sized.length;

  for (const chunk of sized) {
    if (!chunk.segments.length) continue;
    let text;
    try {
      text = apiKey ? await callGroq(buildPrompt(chunk), apiKey) : await callGroqPooled(buildPrompt(chunk), pool);
    } catch (e) {
      // An invalid/expired key will fail identically on every chunk — no
      // point burning through the rest of the video's windows, and the
      // caller needs to know it's a key problem, not "no clips found".
      if (e instanceof GroqAuthError) throw e;
      stats.chunkErrors = (stats.chunkErrors || 0) + 1; stats.lastError = String(e && e.message || e).slice(0, 200);
      // Any other per-chunk failure (rate limit, malformed response, etc.)
      // shouldn't kill the whole video's results — skip it and keep
      // whatever other chunks produced.
      continue;
    }
    parseClipsJson(text, chunk.start, chunk.end, stats).forEach(c => allCandidates.push(c));
  }

  stats.model = lastModelUsed;
  allCandidates.sort((a, b) => b.score - a.score);
  // Drop anything overlapping a higher-scored pick (chunk edges can double-count a moment).
  const picked = [];
  for (const c of allCandidates) {
    if (c.end - c.start < 8) { if (stats) stats.tooShort = (stats.tooShort || 0) + 1; continue; }
    if (picked.some(p => c.start < p.end && c.end > p.start)) { if (stats) stats.overlapping = (stats.overlapping || 0) + 1; continue; }
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
  GroqAuthError, rerankCandidates, getLastModel: () => lastModelUsed || MODEL };
