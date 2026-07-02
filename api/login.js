const { sql, ensureSchema } = require('../lib/db');
const { verifyPassword, createSession, setSessionCookie, formatUser } = require('../lib/auth');
const { reconcileUser } = require('../lib/rankStreak');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const { email, password, rememberMe } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const normalEmail = email.trim().toLowerCase();
  const result = await sql`
    SELECT id, email, password_hash, password_salt, is_admin, credits, credits_infinite,
           rank, rank_expires_at, rank_rung, streak_count,
           last_purchase_at, period_deadline_at, last_drip_at, credits_bought
    FROM users WHERE email = ${normalEmail}
  `;

  const user = result.rows[0];
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = verifyPassword(password, user.password_hash, user.password_salt);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const sessionId = await createSession(user.id);
  setSessionCookie(res, sessionId, rememberMe !== false);

  // Reconcile any owed decay / drips before reporting the user's rank state.
  const reconciled = await reconcileUser(user);

  res.status(200).json({ user: formatUser({ ...user, ...reconciled }) });
};
