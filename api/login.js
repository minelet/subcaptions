const { sql, ensureSchema } = require('../lib/db');
const { verifyPassword, createSession, setCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const { email, password, rememberMe } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const normalizedEmail = String(email).trim().toLowerCase();

    const { rows } = await sql`SELECT * FROM users WHERE email = ${normalizedEmail}`;
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const session = await createSession(user.id, !!rememberMe);
    setCookie(res, 'session', session.token, { expires: session.expires, persistent: session.persistent });

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
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
