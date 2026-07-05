const { sql, ensureSchema } = require('../lib/db');
const { hashPassword, createSession, setSessionCookie, formatUser } = require('../lib/auth');

// Deliberately simple, permissive email shape check. This is NOT meant to
// perfectly validate every RFC 5322 edge case — it exists to (a) reject
// obviously-malformed input like markup/script payloads that were previously
// accepted verbatim (the root cause of the admin-panel stored-XSS finding:
// the frontend rendered emails unescaped, and there was no server-side
// gate stopping "<img src=x onerror=...>@x.com" from being stored as an
// "email"), and (b) give users a normal signup validation error. The
// admin.html HTML-escaping fix is the real/primary defense; this is
// defense-in-depth on top of it.
const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/;
const MAX_PASSWORD_LENGTH = 256; // prevents multi-MB password DoS via pbkdf2Sync

// SECURITY: signups grant free credits (15) with no email verification.
// Without a throttle here, a script can create accounts in a loop and farm
// unlimited free credits. Reuses the same login_attempts table/mechanism
// already used to rate-limit /api/login, keyed by IP alone (there's no
// email yet to key off of at signup time — a fixed per-IP cap is the
// right shape for this abuse, unlike login where per-(email,ip) avoids
// letting one IP lock out a legitimate user).
const MAX_SIGNUPS_PER_WINDOW = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const ip = getClientIp(req);
  const attemptKey = `signup|${ip}`;
  const recentSignups = await sql`
    SELECT COUNT(*)::int AS n FROM login_attempts
    WHERE attempt_key = ${attemptKey} AND created_at > NOW() - (${SIGNUP_WINDOW_MS}::text || ' milliseconds')::interval
  `;
  if (recentSignups.rows[0].n >= MAX_SIGNUPS_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many signups from this network. Please try again later.' });
  }
  // Count this call toward the window regardless of outcome, so scripted
  // retries with tweaked input can't dodge the counter by failing validation.
  await sql`INSERT INTO login_attempts (attempt_key) VALUES (${attemptKey})`;

  const { email, password, rememberMe } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer` });
  }

  const normalEmail = email.trim().toLowerCase();
  const { hash, salt } = hashPassword(password);
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const isAdmin = normalEmail === adminEmail;

  // Atomic insert: rely on the DB's UNIQUE(email) constraint instead of a
  // separate SELECT-then-INSERT, which had a race window where two
  // concurrent signups for the same email could both pass the existence
  // check and one would then hit an unhandled constraint-violation error.
  const result = await sql`
    INSERT INTO users (email, password_hash, password_salt, is_admin, credits, credits_infinite)
    VALUES (${normalEmail}, ${hash}, ${salt}, ${isAdmin}, ${isAdmin ? 0 : 15}, ${isAdmin})
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, is_admin, credits, credits_infinite
  `;

  if (result.rows.length === 0) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const user = result.rows[0];
  const sessionId = await createSession(user.id);
  setSessionCookie(res, sessionId, rememberMe !== false);

  res.status(200).json({ user: formatUser(user) });
};
