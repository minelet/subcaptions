const { sql, ensureSchema } = require('../lib/db');
const {
  verifyPassword, createSession, setSessionCookie, setCsrfCookie, formatUser,
  getSessionCookie, deleteSession, clearSessionCookie, getSessionUser,
} = require('../lib/auth');
const { nextAvailableKey } = require('../lib/groqKeys');

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
    SELECT id, email, password_hash, password_salt, is_admin, credits, credits_infinite, credits_bought
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

async function handleMe(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // Refreshed on every /api/me call (every authenticated page load) so the
  // admin panel always has a current, matching CSRF cookie — including for
  // sessions that were created before this cookie existed.
  await setCsrfCookie(res, sessionId);

  res.status(200).json({ ...formatUser(user), groqKey: nextAvailableKey() });
}

module.exports = async (req, res) => {
  const resource = req.query?.resource;

  if (resource === 'login') return handleLogin(req, res);
  if (resource === 'logout') return handleLogout(req, res);
  if (resource === 'me') return handleMe(req, res);

  return res.status(400).json({ error: 'Unknown resource' });
};
