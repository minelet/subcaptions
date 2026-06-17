const { sql, ensureSchema } = require('../../lib/db');
const { getSessionCookie, getSessionUser } = require('../../lib/auth');

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const search = (req.query?.search || '').trim();
    const result = search
      ? await sql`
          SELECT id, email, is_admin, credits, credits_infinite, credits_used, credits_bought, rank, created_at
          FROM users WHERE email ILIKE ${'%' + search + '%'} ORDER BY created_at DESC
        `
      : await sql`
          SELECT id, email, is_admin, credits, credits_infinite, credits_used, credits_bought, rank, created_at
          FROM users ORDER BY created_at DESC
        `;
    return res.status(200).json({ users: result.rows });
  }

  // PATCH — update a user's credits and/or rank
  if (req.method === 'PATCH') {
    const { userId, credits, creditsInfinite, infinite, rank } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // Rank-only update
    if (rank !== undefined && credits === undefined && creditsInfinite === undefined && infinite === undefined) {
      await sql`UPDATE users SET rank = ${rank} WHERE id = ${userId}`;
      return res.status(200).json({ ok: true });
    }

    const isInfinite = creditsInfinite ?? infinite ?? false;
    await sql`
      UPDATE users
      SET credits = ${credits ?? 0},
          credits_infinite = ${isInfinite}
      WHERE id = ${userId}
    `;
    return res.status(200).json({ ok: true });
  }

  // DELETE — remove a user
  if (req.method === 'DELETE') {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const target = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].is_admin) return res.status(400).json({ error: 'Cannot delete an admin account' });

    await sql`DELETE FROM users WHERE id = ${userId}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
