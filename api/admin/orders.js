const { sql, ensureSchema } = require('../../lib/db');
const { getSessionCookie, getSessionUser } = require('../../lib/auth');

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const result = await sql`
    SELECT o.id, o.credits, o.amount_usd, o.status, o.created_at, u.email
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC
  `;
  return res.status(200).json({ orders: result.rows });
};
