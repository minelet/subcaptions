const { sql, ensureSchema } = require('../lib/db');
const { parseCookies, getSessionUser } = require('../lib/auth');
const { createOrder } = require('../lib/paypal');
const { PACKS } = require('../lib/packs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const cookies = parseCookies(req);
    const user = await getSessionUser(cookies.session);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const { packId } = req.body || {};
    const pack = PACKS[packId];
    if (!pack) return res.status(400).json({ error: 'Invalid pack' });

    // Insert a pending order first so we have a row to update on capture
    const { rows } = await sql`
      INSERT INTO orders (user_id, pack_id, amount_usd, credits, status)
      VALUES (${user.id}, ${pack.id}, ${pack.priceUsd}, ${pack.credits}, 'pending')
      RETURNING id
    `;
    const orderRowId = rows[0].id;

    const paypalOrder = await createOrder({
      amountUsd: pack.priceUsd,
      referenceId: String(orderRowId)
    });

    await sql`
      UPDATE orders SET paypal_order_id = ${paypalOrder.id}
      WHERE id = ${orderRowId}
    `;

    res.json({ ok: true, paypalOrderId: paypalOrder.id, paypalEnv: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
