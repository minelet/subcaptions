const { sql, ensureSchema } = require('../lib/db');
const {
  verifyPassword, createSession, setSessionCookie, setCsrfCookie, formatUser,
  getSessionCookie, deleteSession, verifyCsrf, clearSessionCookie, getSessionUser,
} = require('../lib/auth');

// Merged session endpoint. Vercel's Hobby plan caps deployments at 12
// serverless functions, so the 3 separate api/login.js, api/logout.js,
// and api/me.js handlers were combined into this single file.
// vercel.json routes each original URL here and adds a `resource` query
// param to pick which handler runs below — the public URLs (/api/login,
// /api/logout, /api/me) are unchanged.

// ── Login rate limiting ──────────────────────────────────────────────────
// Simple DB-backed sliding-window throttle: too many failed attempts for
// the same email+IP within WINDOW_MS blocks further attempts until the
// window rolls off. Deliberately keyed by email+IP together (not just IP,
// which would let an attacker lock out a legitimate user; not just email,
// which would let one IP spray many emails unthrottled).
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const { email, password, rememberMe } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const normalEmail = email.trim().toLowerCase();
  const ip = getClientIp(req);
  const attemptKey = `${normalEmail}|${ip}`;

  const recentAttempts = await sql`
    SELECT COUNT(*)::int AS n FROM login_attempts
    WHERE attempt_key = ${attemptKey} AND created_at > NOW() - (${WINDOW_MS}::text || ' milliseconds')::interval
  `;
  if (recentAttempts.rows[0].n >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  }

  const result = await sql`
    SELECT id, email, password_hash, password_salt, is_admin, credits, credits_infinite, credits_bought, credits_used, wm_free_until
    FROM users WHERE email = ${normalEmail}
  `;

  const user = result.rows[0];
  const valid = user && user.password_hash
    ? verifyPassword(password, user.password_hash, user.password_salt)
    : false;

  if (!valid) {
    await sql`INSERT INTO login_attempts (attempt_key) VALUES (${attemptKey})`;
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Successful login — no need to keep this account/IP's failure history around.
  await sql`DELETE FROM login_attempts WHERE attempt_key = ${attemptKey}`;

  const sessionId = await createSession(user.id);
  setSessionCookie(res, sessionId, rememberMe !== false);
  await setCsrfCookie(res, sessionId);

  res.status(200).json({ user: formatUser(user) });
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sessionId = getSessionCookie(req);
  await deleteSession(sessionId);
  clearSessionCookie(res);

  res.status(200).json({ ok: true });
}

// ── Rewarded-ad unlock ───────────────────────────────────────────────────
// ad-start hands out a one-time nonce; ad-complete only counts if it comes
// back with that nonce after the minimum watch time. Caps: AD_MAX_PER_DAY
// unlocks/day, each lasting AD_UNLOCK_MINUTES. With a provider that offers
// server-to-server postbacks, verify the postback here instead of trusting
// the client (see AD_POSTBACK_SECRET note in README).
const AD_MIN_WATCH_MS = 12 * 1000;
const AD_NONCE_TTL_MS = 10 * 60 * 1000;
const AD_MAX_PER_DAY = 6;
const AD_UNLOCK_MINUTES = 60;

async function handleAdUnlock(req, res, sessionId, user) {
  if (!(await verifyCsrf(req, sessionId))) return res.status(403).json({ error: 'Invalid CSRF token' });
  const { action, nonce } = req.body || {};
  const row = (await sql`
    SELECT id, is_admin, credits, credits_infinite, credits_bought, credits_used, wm_free_until,
           ad_day, ad_count, ad_nonce, ad_nonce_at FROM users WHERE id = ${user.id}`).rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const day = row.ad_day ? new Date(row.ad_day).toISOString().slice(0, 10) : null;
  const used = day === today ? (row.ad_count || 0) : 0;

  if (action === 'ad-start') {
    if (used >= AD_MAX_PER_DAY) return res.status(429).json({ error: 'Daily ad limit reached — try again tomorrow.' });
    const n = require('crypto').randomBytes(16).toString('hex');
    await sql`UPDATE users SET ad_nonce = ${n}, ad_nonce_at = NOW() WHERE id = ${user.id}`;
    return res.status(200).json({ nonce: n, minWatchMs: AD_MIN_WATCH_MS });
  }
  if (action === 'ad-complete') {
    if (!nonce || !row.ad_nonce || nonce !== row.ad_nonce || !row.ad_nonce_at)
      return res.status(400).json({ error: 'Invalid ad session' });
    const age = Date.now() - new Date(row.ad_nonce_at).getTime();
    if (age < AD_MIN_WATCH_MS) return res.status(400).json({ error: 'Ad not finished yet' });
    if (age > AD_NONCE_TTL_MS) return res.status(400).json({ error: 'Ad session expired' });
    if (used >= AD_MAX_PER_DAY) return res.status(429).json({ error: 'Daily ad limit reached — try again tomorrow.' });
    const upd = await sql`
      UPDATE users SET ad_nonce = NULL, ad_nonce_at = NULL, ad_day = ${today}::date, ad_count = ${used + 1},
        wm_free_until = NOW() + (${AD_UNLOCK_MINUTES}::text || ' minutes')::interval
      WHERE id = ${user.id} AND ad_nonce = ${nonce}
      RETURNING id, email, is_admin, credits, credits_infinite, credits_bought, credits_used, wm_free_until`;
    if (!upd.rows[0]) return res.status(400).json({ error: 'Invalid ad session' });
    return res.status(200).json({ user: formatUser(upd.rows[0]), adsLeftToday: AD_MAX_PER_DAY - used - 1 });
  }
  return res.status(400).json({ error: 'Unknown action' });
}

async function handleMe(req, res) {
  if (req.method === 'POST') {
    await ensureSchema();
    const sid = getSessionCookie(req);
    const u = await getSessionUser(sid);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    return handleAdUnlock(req, res, sid, u);
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // Refreshed on every /api/me call (every authenticated page load) so the
  // admin panel always has a current, matching CSRF cookie — including for
  // sessions that were created before this cookie existed.
  await setCsrfCookie(res, sessionId);

  res.status(200).json({ ...formatUser(user) });
}

module.exports = async (req, res) => {
  // These responses carry per-session identity (who's logged in, or the
  // act of logging in/out). Without an explicit no-store, a shared cache
  // sitting in front of this deploy (or even a browser's own disk cache,
  // since none of these responses had a Cache-Control before) is allowed
  // to serve a stale copy — e.g. serving a request that just switched to a
  // different Google account a cached /api/me response from the account
  // that was logged in a moment earlier. That looks exactly like "I picked
  // a different account but it's still showing the old one", even though
  // the session cookie itself was updated correctly server-side.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const resource = req.query?.resource;

  if (resource === 'login') return handleLogin(req, res);
  if (resource === 'logout') return handleLogout(req, res);
  if (resource === 'me') return handleMe(req, res);

  return res.status(400).json({ error: 'Unknown resource' });
};
