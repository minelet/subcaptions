const { sql, ensureSchema } = require('../lib/db');
const { parseCookies, getSessionUser } = require('../lib/auth');
const { captureOrder } = require('../lib/paypal');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const cookies = parseCookies(req);
    const user = await getSessionUser(cookies.session);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId) return res.status(400).json({ error: 'Missing paypalOrderId' });

    const rows = await sql`
      SELECT * FROM orders WHERE paypal_order_id = ${paypalOrderId} AND user_id = ${user.id}
    `;
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status === 'completed') {
      // Already processed (avoid double-crediting on retries)
      const u = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
      return res.json({ ok: true, alreadyProcessed: true, credits: u[0].credits, creditsInfinite: u[0].credits_infinite });
    }

    const capture = await captureOrder(paypalOrderId);

    if (capture.status !== 'COMPLETED') {
      await sql`UPDATE orders SET status = 'failed' WHERE id = ${order.id}`;
      return res.status(400).json({ error: `Payment not completed (status: ${capture.status})` });
    }

    // Mark completed and add credits — wrapped so both happen together
    await sql`UPDATE orders SET status = 'completed' WHERE id = ${order.id}`;

    const updated = await sql`
      UPDATE users SET credits = credits + ${order.credits}
      WHERE id = ${user.id}
      RETURNING credits, credits_infinite
    `;

    res.json({
      ok: true,
      credits: updated[0].credits,
      creditsInfinite: updated[0].credits_infinite,
      added: order.credits
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
