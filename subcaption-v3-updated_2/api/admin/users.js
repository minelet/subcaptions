const { sql, ensureSchema } = require('../../lib/db');
const { getSessionCookie, getSessionUser } = require('../../lib/auth');

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const result = await sql`
      SELECT id, email, is_admin, credits, credits_infinite, created_at
      FROM users ORDER BY created_at DESC
    `;
    return res.status(200).json({ users: result.rows });
  }

  // PATCH — update a user's credits
  if (req.method === 'PATCH') {
    const { userId, credits, creditsInfinite } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    await sql`
      UPDATE users
      SET credits = ${credits ?? 0},
          credits_infinite = ${creditsInfinite ?? false}
      WHERE id = ${userId}
    `;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
