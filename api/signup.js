const { sql, ensureSchema } = require('../lib/db');
const { hashPassword, createSession } = require('../lib/auth');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

function setCookieHeader(res, name, value, expiresDate) {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Expires=${expiresDate.toUTCString()}`
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail}`;
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = hashPassword(password);
    const isAdmin = normalizedEmail === ADMIN_EMAIL;

    const result = await sql`
      INSERT INTO users (email, password_hash, is_admin, credits, credits_infinite)
      VALUES (${normalizedEmail}, ${passwordHash}, ${isAdmin}, 5, ${isAdmin})
      RETURNING id, email, is_admin, credits, credits_infinite
    `;
    const user = result.rows[0];

    const session = await createSession(user.id, true);
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    setCookieHeader(res, 'session', session.token, expires);

    res.json({
      ok: true,
      user: {
        email: user.email,
        isAdmin: user.is_admin,
        credits: user.credits,
        creditsInfinite: user.credits_infinite
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
