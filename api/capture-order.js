const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser, formatUser } = require('../lib/auth');
const { PACKS } = require('../lib/packs');
const { recordPurchase, streakTierLabel } = require('../lib/rankStreak');

async function getPayPalToken() {
  const env = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
  const base = env === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return { token: data.access_token, base };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { paypalOrderId } = req.body || {};
  if (!paypalOrderId) return res.status(400).json({ error: 'Missing paypalOrderId' });

  // Check if already processed
  const existing = await sql`SELECT id, credits FROM orders WHERE paypal_order_id = ${paypalOrderId} AND status = 'completed'`;
  if (existing.rows.length > 0) {
    return res.status(200).json({ alreadyProcessed: true, added: 0, credits: user.credits });
  }

  try {
    const { token, base } = await getPayPalToken();

    // Capture the order
    const captureRes = await fetch(`${base}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const captureData = await captureRes.json();

    if (captureData.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    // Determine credits from custom_id or description
    const unit = captureData.purchase_units?.[0];
    const customId = unit?.custom_id || unit?.payments?.captures?.[0]?.custom_id;
    const pack = PACKS[customId];
    if (!pack) return res.status(400).json({ error: 'Unknown pack in order' });

    // Record order. The UNIQUE constraint on paypal_order_id is the real
    // guard here: RETURNING id tells us whether *this* request was the one
    // that actually won the insert. If two requests for the same order race
    // each other, only one gets a row back — the other must not credit the
    // user, or the account gets double-credited.
    const inserted = await sql`
      INSERT INTO orders (user_id, paypal_order_id, pack_id, credits, amount_usd, status)
      VALUES (${user.id}, ${paypalOrderId}, ${customId}, ${pack.credits}, ${pack.priceUsd}, 'completed')
      ON CONFLICT (paypal_order_id) DO NOTHING
      RETURNING id
    `;

    if (inserted.rows.length === 0) {
      // Another concurrent/duplicate request already recorded this order.
      // Don't credit again — just report current state.
      const current = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
      const row = current.rows[0];
      return res.status(200).json({ alreadyProcessed: true, added: 0, credits: row.credits, creditsInfinite: row.credits_infinite });
    }

    // Add credits, then run the full rank & streak engine for this purchase:
    // jump-starts/raises the rank rung (never lowers it), advances the streak
    // (resetting/decaying first if a period was missed), and starts/continues
    // Gold+/Diamond+ credit drips as appropriate.
    await sql`
      UPDATE users
      SET credits = credits + ${pack.credits},
          credits_bought = credits_bought + ${pack.credits}
      WHERE id = ${user.id}
    `;
    const rankResult = await recordPurchase(user.id, pack.rung);

    const updated = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
    const row = updated.rows[0];

    res.status(200).json({
      added: pack.credits,
      credits: row.credits,
      creditsInfinite: row.credits_infinite,
      rank: rankResult.rank,
      rankRung: rankResult.rankRung,
      streakCount: rankResult.streakCount,
      streakTier: rankResult.tier,
      streakTierLabel: streakTierLabel(rankResult.tier),
      decay: rankResult.decay, // non-null if a missed-period decay was just applied before this purchase
    });
  } catch (e) {
    console.error('PayPal capture error:', e);
    res.status(500).json({ error: 'Payment capture failed' });
  }
};
