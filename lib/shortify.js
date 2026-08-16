// lib/shortify.js
//
// Server-side "AI Viral Clip Extractor" analysis. Takes a transcript
// (segment-level text with timestamps) for a long-form video and asks
// an LLM to identify which portions are the strongest candidates for
// short-form (TikTok/Reels/Shorts) clips.
//
// BYOK: this app doesn't hold its own LLM credential for this feature.
// It runs on the same Groq API key the user already enters for
// transcription (Groq Whisper) — that key is passed in per-request from
// the client and used for this analysis call too, instead of any
// server-side env var. See analyzeTranscriptForClips()'s `apiKey` param.
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
const MODEL = 'llama-3.3-70b-versatile'; // Groq-hosted model, good instruction-following for this
const MAX_CANDIDATES_PER_CHUNK = 3;
const MAX_CANDIDATES_RETURNED = 12;  // top candidates across the whole video
const MAX_CLIP_SECONDS = 120;        // hard safety cap even if the model ignores the 90s guidance

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

  return `You are selecting short-form clip candidates (30-90 seconds) from one section of a longer video's transcript, for TikTok/Reels/Shorts repurposing.

TRANSCRIPT SECTION (timestamps in seconds from the start of the FULL video):
${transcriptText}

Select up to ${MAX_CANDIDATES_PER_CHUNK} candidate clips from THIS section only. Rules for a candidate to qualify:
- The clip must be 30-90 seconds long (never more than ${MAX_CLIP_SECONDS}).
- The clip's OPENING line (the first thing said in the clip) must ALREADY be a strong hook by itself — a surprising claim, a bold statement, a question, a punchline, or something that creates immediate curiosity. Do NOT pick a segment that builds up to a hook later — the hook has to be the very first thing said, because this clip will NOT be re-edited or reordered afterward.
- The clip must be self-contained: understandable on its own, with no context from outside the clip required.
- Prefer moments with emotional language, a complete storytelling payoff, a controversial or surprising statement, or humor.
- If nothing in this section meets the bar, return fewer candidates (or none) rather than forcing weak picks.

Respond with ONLY a JSON array (no markdown fences, no prose before or after), like:
[{"start": 123.4, "end": 178.9, "hookLine": "the exact opening line of the clip", "score": 87, "reason": "one short sentence on why this works as a standalone clip", "suggestedCaption": "a short catchy caption for the clip"}]

If nothing qualifies, return [].`;
}

// Marker so callers (analyzeTranscriptForClips / the API route) can tell an
// auth failure apart from an ordinary "model returned nothing useful" case —
// those need very different user-facing messages.
class GroqAuthError extends Error {}

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
    if (response.status === 401) {
      throw new GroqAuthError(`Groq API error 401: ${errText.slice(0, 300)}`);
    }
    throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  return (data.choices || []).map(c => (c.message && c.message.content) || '').join('');
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
// `apiKey` is the user's own Groq API key (BYOK) — the same one already
// used client-side for transcription, passed through from the request.
async function analyzeTranscriptForClips(segments, totalDurationSec, apiKey) {
  if (!apiKey) throw new GroqAuthError('Missing Groq API key');

  const chunks = chunkTranscript(segments, totalDurationSec);
  const allCandidates = [];

  for (const chunk of chunks) {
    if (!chunk.segments.length) continue;
    let text;
    try {
      text = await callGroq(buildPrompt(chunk), apiKey);
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
  return allCandidates.slice(0, MAX_CANDIDATES_RETURNED);
}

module.exports = {
  analyzeTranscriptForClips,
  chunkTranscript,
  CHUNK_SECONDS,
  MAX_CLIP_SECONDS,
  GroqAuthError,
};
