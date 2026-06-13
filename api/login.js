const { sql, ensureSchema } = require('../lib/db');
const { verifyPassword, createSession } = require('../lib/auth');
const parseBody = require('../lib/parse-body');

function setCookieHeader(res, name, value, expiresDate) {
  const cookie = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=None', `Expires=${expiresDate.toUTCString()}`].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureSchema();
    const { email, password } = await parseBody(req);
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const { rows } = await sql`SELECT * FROM users WHERE email = ${normalizedEmail}`;
    const user = rows[0];
    if (!user || user.password_hash.startsWith('google-oauth:') || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const session = await createSession(user.id, true);
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    setCookieHeader(res, 'session', session.token, expires);
    res.json({ ok: true, user: { email: user.email, isAdmin: user.is_admin, credits: user.credits, creditsInfinite: user.credits_infinite } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
