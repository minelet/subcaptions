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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

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
    VALUES (${normalEmail}, ${hash}, ${salt}, ${isAdmin}, ${isAdmin ? 0 : 5}, ${isAdmin})
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
