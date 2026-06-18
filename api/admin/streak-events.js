const { sql, ensureSchema } = require('../../lib/db');
const { getSessionCookie, getSessionUser } = require('../../lib/auth');

// GET /api/admin/streak-events?userId=<id>&limit=50
// Returns the audit trail of rank/streak changes (purchases, decays, drips,
// admin overrides) for a given user, newest-first.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  const userId = parseInt(req.query?.userId, 10);
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 200);

  const result = await sql`
    SELECT id, event_type, detail, created_at
    FROM streak_events
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return res.status(200).json({ events: result.rows });
};
