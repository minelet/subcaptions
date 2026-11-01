const { ensureSchema, sql } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { analyzeTranscriptForClips, rerankCandidates, GroqAuthError } = require('../lib/shortify');
const { getKeyPool, keyStatus, fmtDuration } = require('../lib/groqKeys');

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
  // Owner-only key readout: which clip keys are working / cooling and when
  // each one comes back. GET /api/shortify?status=1  (never shows the keys).
  if (req.method === 'GET' && req.query && req.query.status) {
    if (!user.is_admin) return res.status(403).json({ error: 'Admin only' });
    return res.status(200).json({ keys: keyStatus('clips'), model: require('../lib/shortify').getLastModel() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Final-judge pass: client sends its best candidates, we rank them with the smarter model.
  if (req.body && Array.isArray(req.body.rerank)) {
    if (!user.credits_infinite && (!user.credits || user.credits <= 0)) return res.status(402).json({ error: 'Insufficient credits' });
    if (!getKeyPool('clips').length) return res.status(503).json({ error: 'Clip detection is temporarily unavailable.' });
    const items = req.body.rerank.slice(0, 30).filter(i => i && Number.isFinite(i.id) && Number.isFinite(i.start) && Number.isFinite(i.end) && typeof i.excerpt === 'string');
    if (items.length < 2) return res.status(200).json({ picks: [] });
    try {
      const picks = await rerankCandidates(items, 'clips');
      return res.status(200).json({ picks });
    } catch (err) {
      if (err instanceof GroqAuthError) {
        const soon = Math.min(...keyStatus('clips').map(k => k.backInSec));
        return res.status(503).json({ error: 'busy', retryInSec: Number.isFinite(soon) ? Math.max(1, soon) : 60 });
      }
      console.error('rerank error:', err);
      return res.status(500).json({ error: 'rerank failed' });
    }
  }

  const { segments, durationSec, windowStart, windowEnd } = req.body || {};
  const win = (typeof windowStart === 'number' && typeof windowEnd === 'number' && windowEnd > windowStart) ? { start: windowStart, end: windowEnd } : null;

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
  //
  // SECURITY FIX: "assumes" was doing a lot of work in that sentence —
  // there was no actual server-side check backing it up. Calling this URL
  // directly with a valid session and 0 credits got a full, real, paid-tier
  // LLM analysis for free, same class of bug as the transcribe proxy fix
  // above. This doesn't meter exact cost per call, but it does stop the
  // endpoint from doing any Groq work at all for an account with nothing
  // to spend and no infinite-credits flag.
  if(!user.credits_infinite && (!user.credits || user.credits <= 0)){
    return res.status(402).json({ error: 'Insufficient credits' });
  }

  // Dedicated clip-finder pool (GROQ_CLIP_KEYS). Failover happens per chunk
  // inside analyzeTranscriptForClips: a dying key is swapped for the next
  // one instantly, mid-analysis, and benched until Groq says it's back.
  if (!getKeyPool('clips').length) {
    console.error('shortify: no Groq keys configured (set GROQ_CLIP_KEYS)');
    return res.status(503).json({ error: 'Clip detection is temporarily unavailable — please try again shortly.' });
  }

  try {
    const stats = {};
    const candidates = await analyzeTranscriptForClips(segments, durationSec, null, 'clips', win, stats);
    console.log('shortify window', win ? win.start + '-' + win.end : 'all', 'segments', segments.length, JSON.stringify(stats), 'kept', candidates.length);
    await logEvent(user.id, 'success', candidates.length, null);
    return res.status(200).json({ candidates, debug: stats });
  } catch (err) {
    if (err instanceof GroqAuthError) {
      await logEvent(user.id, 'auth_error', null, String(err.message || '').slice(0, 300));
      const soon = Math.min(...keyStatus('clips').map(k => k.backInSec));
      return res.status(503).json({
        error: 'All clip-finder keys are busy right now' + (soon > 0 ? ' — one is back in ' + fmtDuration(soon) : '') + '. Please try again shortly.',
        retryInSec: Number.isFinite(soon) ? Math.max(1, soon) : 60,
        keys: user.is_admin ? keyStatus('clips') : undefined,
      });
    }
    console.error('shortify error:', err);
    return res.status(500).json({ error: 'Clip detection failed. Please try again.' });
  }
};
