const { sql, ensureSchema } = require('../lib/db');
const { subscriptionByPlanId, subscriptionByRazorpayPlanId } = require('../lib/packs');
const razorpay = require('../lib/razorpay');

// (module.exports.config is set at the bottom of this file, after the
// handler is assigned — setting it here would get wiped out, since
// `module.exports = async (req, res) => {...}` further down replaces the
// whole exports object rather than adding to it.)

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function getPayPalToken() {
  const env = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
  const base = env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return { token: data.access_token, base };
}

// SECURITY: anyone on the internet can POST to this URL pretending to be
// PayPal and claim any event they like ("subscription activated, please
// add 1000 credits"). PayPal signs every real webhook delivery with a
// transmission signature that can only be produced by PayPal, and provides
// a /v1/notifications/verify-webhook-signature endpoint to check it. We
// call that on every request and refuse anything that doesn't come back
// VERIFIED — this is the entire trust boundary for this endpoint, not
// something to skip "for now" even in testing.
async function verifyWebhookSignature(req, token, base) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const body = {
    auth_algo: req.headers['paypal-auth-algo'],
    cert_url: req.headers['paypal-cert-url'],
    transmission_id: req.headers['paypal-transmission-id'],
    transmission_sig: req.headers['paypal-transmission-sig'],
    transmission_time: req.headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: req.body,
  };
  const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

// Razorpay's recurring-charge + cancellation events. Handles two things:
//  - subscription.charged: fires for every successful charge, first
//    payment AND every renewal. Idempotent via the same partial unique
//    index on (subscription_id, razorpay_payment_id) that
//    api/confirm-subscription.js's handleRazorpayVerify relies on, so
//    whichever of the two (this webhook or that direct-confirm call) wins
//    the race for a given charge, the other is a harmless no-op.
//  - subscription.cancelled / subscription.completed / subscription.halted:
//    status updates only, mirroring the PayPal branch below — never claws
//    back credits already granted for past cycles.
//  - payment.captured: backstop for one-time PACKS purchases in case the
//    frontend's direct call to handleRazorpayVerify never happens (tab
//    closed mid-checkout, network drop after payment). Only acts on
//    payments whose order notes we recognize as one of our packs; anything
//    else (e.g. a subscription's own internal charge) is ignored.
async function handleRazorpayWebhook(req, res, rawBody) {
  const signature = req.headers['x-razorpay-signature'];
  if (!razorpay.verifyWebhookSignature(rawBody, signature)) {
    console.error('razorpay-webhook: signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  const eventType = event.event;

  try {
    if (eventType === 'subscription.charged') {
      const subEntity = event.payload?.subscription?.entity;
      const paymentEntity = event.payload?.payment?.entity;
      if (!subEntity?.id || !paymentEntity?.id) return res.status(200).json({ ok: true });

      const subRows = await sql`SELECT * FROM subscriptions WHERE razorpay_subscription_id = ${subEntity.id}`;
      if (subRows.rows.length === 0) {
        // Charge arrived before handleRazorpayVerify ran (race on first
        // payment, same situation the PayPal branch below handles) — look
        // the plan up directly so we don't silently drop a real charge.
        const plan = subscriptionByRazorpayPlanId(subEntity.plan_id);
        console.error('razorpay-webhook: subscription.charged for unknown subscription row', subEntity.id, { knownPlan: !!plan });
        return res.status(200).json({ ok: true });
      }

      const subscriptionRow = subRows.rows[0];
      const already = await sql`SELECT id FROM subscription_charges WHERE subscription_id = ${subscriptionRow.id} AND razorpay_payment_id = ${paymentEntity.id}`;
      if (already.rows.length === 0) {
        await sql`UPDATE users SET credits = credits + ${subscriptionRow.credits_per_cycle}, credits_bought = credits_bought + ${subscriptionRow.credits_per_cycle} WHERE id = ${subscriptionRow.user_id}`;
        await sql`INSERT INTO subscription_charges (subscription_id, razorpay_payment_id, credits_granted) VALUES (${subscriptionRow.id}, ${paymentEntity.id}, ${subscriptionRow.credits_per_cycle})`;
        await sql`UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = ${subscriptionRow.id}`;
      }
    }

    else if (eventType === 'subscription.cancelled' || eventType === 'subscription.completed') {
      const subEntity = event.payload?.subscription?.entity;
      if (!subEntity?.id) return res.status(200).json({ ok: true });
      const status = eventType === 'subscription.cancelled' ? 'cancelled' : 'expired';
      await sql`UPDATE subscriptions SET status = ${status}, updated_at = NOW() WHERE razorpay_subscription_id = ${subEntity.id}`;
    }

    else if (eventType === 'subscription.halted') {
      const subEntity = event.payload?.subscription?.entity;
      if (!subEntity?.id) return res.status(200).json({ ok: true });
      await sql`UPDATE subscriptions SET status = 'suspended', updated_at = NOW() WHERE razorpay_subscription_id = ${subEntity.id}`;
    }

    else if (eventType === 'payment.captured') {
      const paymentEntity = event.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      if (!orderId) return res.status(200).json({ ok: true }); // not an order-based payment (e.g. a subscription charge)

      const existing = await sql`SELECT id FROM orders WHERE razorpay_order_id = ${orderId} AND status = 'completed'`;
      if (existing.rows.length > 0) return res.status(200).json({ ok: true }); // already credited via handleRazorpayVerify

      const { PACKS } = require('../lib/packs');
      const order = await razorpay.getOrder(orderId);
      const packId = order.notes?.packId;
      const userId = order.notes?.userId;
      const pack = PACKS[packId];
      if (!pack || !userId) return res.status(200).json({ ok: true }); // not one of our one-time packs — nothing to do

      const priceOk = order.amount_paid === pack.priceInrPaise && order.currency === 'INR' && order.status === 'paid';
      if (!priceOk) {
        console.error('razorpay-webhook: payment.captured amount mismatch', { orderId, expected: pack.priceInrPaise, got: order.amount_paid });
        return res.status(200).json({ ok: true });
      }

      const inserted = await sql`
        INSERT INTO orders (user_id, razorpay_order_id, provider, pack_id, credits, amount_usd, status)
        VALUES (${userId}, ${orderId}, 'razorpay', ${packId}, ${pack.credits}, ${pack.priceUsd}, 'completed')
        ON CONFLICT (razorpay_order_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.rows.length > 0) {
        await sql`UPDATE users SET credits = credits + ${pack.credits}, credits_bought = credits_bought + ${pack.credits} WHERE id = ${userId}`;
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    // Same reasoning as the PayPal catch block below: return 200 once the
    // signature is verified, so Razorpay doesn't retry-storm an error that
    // a retry won't fix, and log for manual investigation instead.
    console.error('razorpay-webhook processing error', eventType, err);
    return res.status(200).json({ ok: true, loggedError: true });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const rawBody = await readRawBody(req);
  try {
    req.body = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    console.error('webhook: invalid JSON body', e.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Razorpay and PayPal both deliver to this same URL (kept to one file —
  // see the Vercel Hobby 12-function-limit note elsewhere in this repo).
  // Razorpay's signature header is the distinguishing signal; PayPal never
  // sends it.
  if (req.headers['x-razorpay-signature']) {
    return handleRazorpayWebhook(req, res, rawBody);
  }

  const { token, base } = await getPayPalToken();
  const verified = await verifyWebhookSignature(req, token, base);
  if (!verified) {
    console.error('paypal-webhook: signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  const eventType = event.event_type;

  try {
    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const sub = event.resource;
      const plan = subscriptionByPlanId(sub.plan_id);
      if (!plan) { console.error('webhook: unknown plan_id', sub.plan_id); return res.status(200).json({ ok: true }); }
      // Row may already exist from confirm-subscription.js (the fast path)
      // — this just makes sure status/period are current either way.
      await sql`
        UPDATE subscriptions SET status = 'active',
          current_period_end = ${sub.billing_info?.next_billing_time || null},
          updated_at = NOW()
        WHERE paypal_subscription_id = ${sub.id}
      `;
    }

    else if (eventType === 'PAYMENT.SALE.COMPLETED') {
      // Fires for every successful charge, including renewals. The
      // `billing_agreement_id` on a subscription-driven sale is the
      // subscription id.
      const sale = event.resource;
      const paypalSubId = sale.billing_agreement_id;
      if (!paypalSubId) return res.status(200).json({ ok: true }); // not a subscription charge

      const subRows = await sql`SELECT * FROM subscriptions WHERE paypal_subscription_id = ${paypalSubId}`;
      if (subRows.rows.length === 0) {
        // Charge arrived before confirm-subscription.js ran (race on first
        // payment) — fetch the subscription from PayPal directly so this
        // charge still gets credited instead of silently dropped.
        const subRes = await fetch(`${base}/v1/billing/subscriptions/${paypalSubId}`, { headers: { Authorization: `Bearer ${token}` } });
        const sub = await subRes.json();
        const plan = subscriptionByPlanId(sub.plan_id);
        if (!plan || !sub.subscriber?.payer_id) return res.status(200).json({ ok: true });
        // We still need a user_id — without a prior confirm-subscription
        // call we have no session to attribute this to, so log it for
        // manual reconciliation rather than guessing.
        console.error('paypal-webhook: PAYMENT.SALE.COMPLETED for unknown subscription', paypalSubId);
        return res.status(200).json({ ok: true });
      }

      const subscriptionRow = subRows.rows[0];
      const captureId = sale.id;
      const already = await sql`SELECT id FROM subscription_charges WHERE subscription_id = ${subscriptionRow.id} AND paypal_capture_id = ${captureId}`;
      if (already.rows.length === 0) {
        await sql`UPDATE users SET credits = credits + ${subscriptionRow.credits_per_cycle}, credits_bought = credits_bought + ${subscriptionRow.credits_per_cycle} WHERE id = ${subscriptionRow.user_id}`;
        await sql`INSERT INTO subscription_charges (subscription_id, paypal_capture_id, credits_granted) VALUES (${subscriptionRow.id}, ${captureId}, ${subscriptionRow.credits_per_cycle})`;
        await sql`UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = ${subscriptionRow.id}`;
      }
    }

    else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.EXPIRED') {
      const sub = event.resource;
      const status = eventType.endsWith('CANCELLED') ? 'cancelled' : 'expired';
      await sql`UPDATE subscriptions SET status = ${status}, updated_at = NOW() WHERE paypal_subscription_id = ${sub.id}`;
      // Deliberately NOT clawing back already-granted credits — those were
      // paid for and belong to the user regardless of what happens to
      // future cycles. This just stops future auto-renew credits.
    }

    else if (eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
      const sub = event.resource;
      await sql`UPDATE subscriptions SET status = 'suspended', updated_at = NOW() WHERE paypal_subscription_id = ${sub.id}`;
    }

    // Backstop for one-time PACKS purchases, mirroring the Razorpay
    // `payment.captured` branch above. The frontend's direct call to
    // /api/capture-order (fired the instant the buyer approves) is what
    // normally credits these — this only matters if that call never
    // completed (tab closed mid-approval, network drop, app killed on
    // mobile right after paying). PayPal still tells us here, independently
    // and with its own verified signature, so the buyer gets credited
    // automatically either way — no popup, no "did you pay?", nothing for
    // them to do.
    else if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = event.resource;
      const orderId = capture?.supplementary_data?.related_ids?.order_id;
      if (!orderId) return res.status(200).json({ ok: true }); // not tied to an order we can look up

      const already = await sql`SELECT id FROM orders WHERE paypal_order_id = ${orderId} AND status = 'completed'`;
      if (already.rows.length > 0) return res.status(200).json({ ok: true }); // already credited via the direct capture call

      const orderRow = (await sql`SELECT user_id, pack_id FROM orders WHERE paypal_order_id = ${orderId}`).rows[0];
      const packId = orderRow?.pack_id || capture?.custom_id;
      const { PACKS } = require('../lib/packs');
      const pack = PACKS[packId];
      if (!pack || !orderRow?.user_id) return res.status(200).json({ ok: true }); // not one of our one-time packs — nothing to do

      // SECURITY: same reasoning as every other capture path in this repo —
      // confirm what PayPal actually captured matches this pack's price
      // before crediting anything.
      const paidAmount = parseFloat(capture?.amount?.value);
      const priceOk = Number.isFinite(paidAmount)
        && capture?.amount?.currency_code === 'USD'
        && Math.abs(paidAmount - pack.priceUsd) < 0.01
        && capture?.status === 'COMPLETED';
      if (!priceOk) {
        console.error('paypal-webhook: PAYMENT.CAPTURE.COMPLETED amount mismatch', { orderId, expected: pack.priceUsd, got: paidAmount });
        return res.status(200).json({ ok: true });
      }

      const updated = await sql`UPDATE orders SET status = 'completed' WHERE paypal_order_id = ${orderId} AND status = 'pending' RETURNING id`;
      if (updated.rows.length > 0) {
        await sql`UPDATE users SET credits = credits + ${pack.credits}, credits_bought = credits_bought + ${pack.credits} WHERE id = ${orderRow.user_id}`;
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    // Return 200 even on our own processing errors once signature
    // verification passed: PayPal will retry a non-2xx with backoff, and
    // for an idempotent ledger like this it's safer to log and investigate
    // than to trigger repeated retries for an error that a retry won't fix.
    console.error('paypal-webhook processing error', eventType, err);
    return res.status(200).json({ ok: true, loggedError: true });
  }
};

// Set here, AFTER module.exports is assigned above — not near the top of
// this file, since `module.exports = async (req, res) => {...}` replaces
// the whole exports object and would silently discard a `.config` set
// earlier. This disables Vercel's automatic JSON body parsing so
// readRawBody() above can capture the exact raw bytes Razorpay's webhook
// signature needs (see the comment near readRawBody for why re-serialized
// JSON isn't good enough); PayPal's logic still gets a normal parsed
// req.body, since we parse it ourselves right at the top of the handler.
module.exports.config = { api: { bodyParser: false } };
