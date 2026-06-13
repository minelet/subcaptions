const { sql, ensureSchema } = require('../lib/db');
const { parseCookies, getSessionUser } = require('../lib/auth');

module.exports = async (req, res) => {
  try {
    await ensureSchema();
    const cookies = parseCookies(req);
    const admin = await getSessionUser(cookies.session);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Forbidden' });

    const action = req.query.action;

    // GET /api/admin?action=users
    if (req.method === 'GET' && action === 'users') {
      const search = (req.query.search || '').trim().toLowerCase();
      let rows;
      if (search) {
        const result = await sql`
          SELECT id, email, is_admin, credits, credits_infinite, created_at
          FROM users
          WHERE LOWER(email) LIKE ${'%' + search + '%'}
          ORDER BY id DESC
        `;
        rows = result.rows;
      } else {
        const result = await sql`
          SELECT id, email, is_admin, credits, credits_infinite, created_at
          FROM users ORDER BY id DESC
        `;
        rows = result.rows;
      }
      return res.json({ users: rows });
    }

    // GET /api/admin?action=orders
    if (req.method === 'GET' && action === 'orders') {
      const { rows } = await sql`
        SELECT orders.id, orders.pack_id, orders.amount_usd, orders.credits, orders.status, orders.created_at, users.email
        FROM orders
        JOIN users ON users.id = orders.user_id
        ORDER BY orders.created_at DESC
        LIMIT 200
      `;
      return res.json({ orders: rows });
    }

    // POST /api/admin?action=set-credits
    if (req.method === 'POST' && action === 'set-credits') {
      const { userId, credits, infinite } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      if (infinite === true) {
        await sql`UPDATE users SET credits_infinite = TRUE WHERE id = ${userId}`;
      } else {
        const val = Number.isFinite(credits) ? credits : 0;
        await sql`UPDATE users SET credits_infinite = FALSE, credits = ${val} WHERE id = ${userId}`;
      }
      const { rows } = await sql`SELECT id, email, is_admin, credits, credits_infinite FROM users WHERE id = ${userId}`;
      return res.json({ ok: true, user: rows[0] });
    }

    // POST /api/admin?action=delete-user
    if (req.method === 'POST' && action === 'delete-user') {
      const { userId } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      if (Number(userId) === admin.id) return res.status(400).json({ error: "Can't delete yourself" });
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
      await sql`DELETE FROM orders WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
