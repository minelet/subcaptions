const { sql, ensureSchema } = require('../lib/db');
const { hashPassword, createSession, setSessionCookie, formatUser } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const { email, password, rememberMe } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const normalEmail = email.trim().toLowerCase();
  const existing = await sql`SELECT id FROM users WHERE email = ${normalEmail}`;
  if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

  const { hash, salt } = hashPassword(password);
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const isAdmin = normalEmail === adminEmail;

  const result = await sql`
    INSERT INTO users (email, password_hash, password_salt, is_admin, credits, credits_infinite)
    VALUES (${normalEmail}, ${hash}, ${salt}, ${isAdmin}, ${isAdmin ? 0 : 5}, ${isAdmin})
    RETURNING id, email, is_admin, credits, credits_infinite
  `;

  const user = result.rows[0];
  const sessionId = await createSession(user.id);
  setSessionCookie(res, sessionId, rememberMe !== false);

  res.status(200).json({ user: formatUser(user) });
};
