const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser, formatUser } = require('../lib/auth');
const { PACKS, SUBSCRIPTIONS } = require('../lib/packs');
const razorpay = require('../lib/razorpay');

// Merged endpoint. Vercel's Hobby plan caps deployments at 12 serverless
// functions, so api/paypal-config.js was folded into this file. vercel.json
// routes /api/paypal-config here with ?resource=config — the public URL
// (/api/paypal-config) is unchanged. See handleConfig below; everything
// after it is the original order-capture logic, untouched.

// PAYPAL_CLIENT_ID and billing Plan IDs are not secrets — they're designed
// to be embedded in client-side JS (that's how every PayPal integration
// works; the secret half, PAYPAL_CLIENT_SECRET, never leaves the server
// and is not read here). This just hands the frontend what it needs to
// render the PayPal JS SDK subscribe buttons.
async function handleConfig(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    clientId: process.env.PAYPAL_CLIENT_ID || null,
    plans: Object.fromEntries(
      Object.entries(SUBSCRIPTIONS).map(([key, p]) => [key, { planId: p.planId, credits: p.credits, priceUsd: p.priceUsd, rank: p.rank }])
    ),
  });
}

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

// Razorpay config: key_id (public, safe client-side — the secret half
// never leaves the server) plus INR pricing for the one-time PACKS, so the
// frontend can create an order without hardcoding amounts twice.
async function handleRazorpayConfig(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    keyId: process.env.RAZORPAY_KEY_ID || null,
    packs: Object.fromEntries(
      Object.entries(PACKS).map(([key, p]) => [key, { credits: p.credits, priceUsd: p.priceUsd, priceInrPaise: p.priceInrPaise, rank: p.rank }])
    ),
  });
}

// Step 1 of the Razorpay one-time-pack flow: create a Razorpay Order for
// the logged-in user's chosen pack. The frontend then opens Razorpay
// Checkout with this order_id; nothing gets credited yet — that only
// happens once handleRazorpayVerify below confirms a real signed payment.
async function handleRazorpayOrder(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { packId } = req.body || {};
  const pack = PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'Unknown pack' });

  try {
    const order = await razorpay.createOrder({
      amount: pack.priceInrPaise,
      currency: 'INR',
      // notes travel with the order and come back on both the webhook
      // payload and a GET /orders/:id lookup — this is how
      // handleRazorpayVerify below knows which user/pack this order was
      // for without trusting anything the client sends except the id.
      notes: { userId: String(user.id), packId },
    });
    return res.status(200).json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    console.error('Razorpay order creation error:', e);
    return res.status(500).json({ error: 'Could not start Razorpay checkout' });
  }
}

// Step 2: Razorpay Checkout's `handler` callback on the frontend gives us
// {razorpay_order_id, razorpay_payment_id, razorpay_signature}. We verify
// the signature, re-fetch the order from Razorpay directly (never trust
// notes/amount the client could have altered), confirm the paid amount
// matches the pack price, and only then credit — identical shape to the
// PayPal capture flow above.
async function handleRazorpayVerify(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'Missing Razorpay payment fields' });

  if (!razorpay.verifyOrderPaymentSignature({ orderId, paymentId, signature })) {
    console.error('Razorpay signature verification failed', { orderId, paymentId });
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  const existing = await sql`SELECT id FROM orders WHERE razorpay_order_id = ${orderId} AND status = 'completed'`;
  if (existing.rows.length > 0) {
    const current = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
    return res.status(200).json({ alreadyProcessed: true, added: 0, credits: current.rows[0].credits, creditsInfinite: current.rows[0].credits_infinite });
  }

  try {
    const order = await razorpay.getOrder(orderId);
    const packId = order.notes?.packId;
    const notedUserId = order.notes?.userId;
    const pack = PACKS[packId];
    if (!pack || String(user.id) !== String(notedUserId)) {
      console.error('Razorpay verify: pack/user mismatch', { orderId, packId, notedUserId, sessionUserId: user.id });
      return res.status(400).json({ error: 'Order does not match this pack/user' });
    }

    // SECURITY: same reasoning as the PayPal amount check above — confirm
    // what Razorpay actually recorded as paid_amount on the order matches
    // this pack's price, rather than trusting the notes alone.
    const priceOk = order.amount_paid === pack.priceInrPaise && order.currency === 'INR' && order.status === 'paid';
    if (!priceOk) {
      console.error('Razorpay amount mismatch', { orderId, expected: pack.priceInrPaise, got: order.amount_paid, status: order.status });
      return res.status(400).json({ error: 'Payment amount does not match the selected pack' });
    }

    const inserted = await sql`
      INSERT INTO orders (user_id, razorpay_order_id, provider, pack_id, credits, amount_usd, status)
      VALUES (${user.id}, ${orderId}, 'razorpay', ${packId}, ${pack.credits}, ${pack.priceUsd}, 'completed')
      ON CONFLICT (razorpay_order_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.rows.length === 0) {
      const current = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
      return res.status(200).json({ alreadyProcessed: true, added: 0, credits: current.rows[0].credits, creditsInfinite: current.rows[0].credits_infinite });
    }

    await sql`UPDATE users SET credits = credits + ${pack.credits}, credits_bought = credits_bought + ${pack.credits} WHERE id = ${user.id}`;
    const updated = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
    return res.status(200).json({ added: pack.credits, credits: updated.rows[0].credits, creditsInfinite: updated.rows[0].credits_infinite });
  } catch (e) {
    console.error('Razorpay verify error:', e);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
}

module.exports = async (req, res) => {
  if (req.query?.resource === 'config') return handleConfig(req, res);
  if (req.query?.resource === 'razorpay-config') return handleRazorpayConfig(req, res);
  if (req.query?.resource === 'razorpay-order') return handleRazorpayOrder(req, res);
  if (req.query?.resource === 'razorpay-verify') return handleRazorpayVerify(req, res);

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
    const capture = unit?.payments?.captures?.[0];
    const customId = unit?.custom_id || capture?.custom_id;
    const pack = PACKS[customId];
    if (!pack) return res.status(400).json({ error: 'Unknown pack in order' });

    // SECURITY: confirm the amount PayPal actually captured matches this
    // pack's price, not just that a pack id was present. custom_id alone is
    // just a label we chose — trusting it without checking the paid amount
    // means anything that could get a different custom_id attached to a
    // cheaper/free order (a tampered client-side link, a replayed/edited
    // request, a future change to how orders are created) would grant the
    // full pack's credits for whatever was actually paid, including $0.
    // Our PayPal payment links have fixed prices set server-side on PayPal's
    // end, so this should always match in normal operation — this is the
    // check that makes sure it actually does, every time, rather than
    // assuming it.
    const paidAmount = parseFloat(capture?.amount?.value);
    const paidCurrency = capture?.amount?.currency_code;
    const priceOk = Number.isFinite(paidAmount)
      && paidCurrency === 'USD'
      && Math.abs(paidAmount - pack.priceUsd) < 0.01;
    if (!priceOk) {
      console.error('PayPal amount mismatch', {
        paypalOrderId, customId, expectedUsd: pack.priceUsd, paidAmount, paidCurrency,
      });
      return res.status(400).json({ error: 'Payment amount does not match the selected pack' });
    }

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

    // Add credits for this purchase.
    await sql`
      UPDATE users
      SET credits = credits + ${pack.credits},
          credits_bought = credits_bought + ${pack.credits}
      WHERE id = ${user.id}
    `;

    const updated = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
    const row = updated.rows[0];

    res.status(200).json({
      added: pack.credits,
      credits: row.credits,
      creditsInfinite: row.credits_infinite,
    });
  } catch (e) {
    console.error('PayPal capture error:', e);
    res.status(500).json({ error: 'Payment capture failed' });
  }
};
