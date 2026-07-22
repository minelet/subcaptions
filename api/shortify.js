const { ensureSchema, sql } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { analyzeTranscriptForClips, GroqAuthError } = require('../lib/shortify');

async function logEvent(userId, eventType, candidatesFound, detail){
  try {
    await sql`INSERT INTO clip_finder_events (user_id, event_type, candidates_found, detail) VALUES (${userId}, ${eventType}, ${candidatesFound}, ${detail})`;
  } catch (e) { console.error('clip_finder_events log failed:', e); }
}

// Practical v1 cap — bounds both cost and processing time. This feature
// costs more per minute of source video than plain captioning (it's an
// LLM call per ~15-minute window, not just a transcription pass), so it
// gets its own tighter duration cap rather than reusing the captions one.
const MAX_DURATION_SEC = 3 * 60 * 60; // 3 hours
const MAX_SEGMENTS = 8000; // defensive cap, independent of the duration cap above —
                           // guards against a malformed/garbage transcript with an
                           // absurd number of tiny segments driving cost way up.

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { segments, durationSec, apiKey } = req.body || {};

  // BYOK — this endpoint runs on the user's own Groq key (the same one
  // used client-side for transcription), not a server-side credential.
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'Missing Groq API key' });
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'Missing transcript segments' });
  }
  if (segments.length > MAX_SEGMENTS) {
    return res.status(400).json({ error: 'Transcript has too many segments' });
  }
  for (const s of segments) {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.text !== 'string') {
      return res.status(400).json({ error: 'Malformed transcript segment' });
    }
  }
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return res.status(400).json({ error: 'Missing or invalid durationSec' });
  }
  if (durationSec > MAX_DURATION_SEC) {
    return res.status(400).json({
      error: `Video too long — AI clip detection currently supports up to ${MAX_DURATION_SEC / 3600} hours.`
    });
  }

  // NOTE: credit deduction happens client-side via the existing generic
  // POST /api/use-credits endpoint BEFORE this endpoint is ever called —
  // same pattern the caption generator already uses (check balance, deduct,
  // then only proceed on success). This endpoint assumes the spend already
  // succeeded and focuses purely on the analysis itself.

  try {
    const candidates = await analyzeTranscriptForClips(segments, durationSec, apiKey);
    await logEvent(user.id, 'success', candidates.length, null);
    return res.status(200).json({ candidates });
  } catch (err) {
    if (err instanceof GroqAuthError) {
      await logEvent(user.id, 'auth_error', null, String(err.message || '').slice(0, 300));
      return res.status(401).json({ error: 'Invalid Groq API key — check the key entered above.' });
    }
    console.error('shortify error:', err);
    await logEvent(user.id, 'error', null, String(err.message || err).slice(0, 300));
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
};
