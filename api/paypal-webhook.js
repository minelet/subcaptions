const { sql, ensureSchema } = require('../lib/db');
const { subscriptionByPlanId } = require('../lib/packs');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

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
