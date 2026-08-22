const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { subscriptionByPlanId, SUBSCRIPTIONS } = require('../lib/packs');

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

// Called by the frontend the moment the PayPal subscribe button's
// onApprove fires. This is a convenience path so the user sees their
// credits land in the same second they approve, instead of waiting on a
// webhook that can (per PayPal's own docs) take anywhere from instantly to
// several minutes. It is NOT the trust boundary — everything here is
// re-verified server-side against PayPal's own API before anything is
// credited, and api/paypal-webhook.js independently does the same
// crediting logic (idempotently, via subscription_charges) as a backstop
// in case this call never happens (tab closed, network drop, etc).
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { paypalSubscriptionId } = req.body || {};
  if (!paypalSubscriptionId) return res.status(400).json({ error: 'Missing paypalSubscriptionId' });

  try {
    const { token, base } = await getPayPalToken();

    const subRes = await fetch(`${base}/v1/billing/subscriptions/${paypalSubscriptionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sub = await subRes.json();

    if (sub.status !== 'ACTIVE') {
      return res.status(400).json({ error: `Subscription not active yet (status: ${sub.status})` });
    }

    // SECURITY: same principle as capture-order.js — trust PayPal's own
    // plan_id on the subscription object, not anything the client claims
    // about which tier this is, then look up price/credits from OUR config.
    const plan = subscriptionByPlanId(sub.plan_id);
    if (!plan) return res.status(400).json({ error: 'Unrecognized subscription plan' });
    const planKey = Object.keys(SUBSCRIPTIONS).find(k => SUBSCRIPTIONS[k] === plan);

    // Upsert the subscription row — this user may be re-confirming (e.g.
    // page refresh right after approval) rather than creating it fresh.
    const existing = await sql`SELECT id FROM subscriptions WHERE paypal_subscription_id = ${paypalSubscriptionId}`;
    let subscriptionRowId;
    if (existing.rows.length > 0) {
      subscriptionRowId = existing.rows[0].id;
      await sql`UPDATE subscriptions SET status = 'active', current_period_end = ${sub.billing_info?.next_billing_time || null}, updated_at = NOW() WHERE id = ${subscriptionRowId}`;
    } else {
      const inserted = await sql`
        INSERT INTO subscriptions (user_id, paypal_subscription_id, plan_key, credits_per_cycle, price_usd, status, current_period_end)
        VALUES (${user.id}, ${paypalSubscriptionId}, ${planKey}, ${plan.credits}, ${plan.priceUsd}, 'active', ${sub.billing_info?.next_billing_time || null})
        RETURNING id
      `;
      subscriptionRowId = inserted.rows[0].id;
    }

    // Grant the first cycle's credits exactly once, keyed off PayPal's own
    // capture id for the first payment — same anti-double-credit guard the
    // webhook path uses, so if the webhook also fires for this same charge
    // it's a harmless no-op (unique constraint on subscription_charges).
    const firstCaptureId = `first:${paypalSubscriptionId}`;
    const already = await sql`SELECT id FROM subscription_charges WHERE subscription_id = ${subscriptionRowId} AND paypal_capture_id = ${firstCaptureId}`;
    if (already.rows.length === 0) {
      await sql`UPDATE users SET credits = credits + ${plan.credits}, credits_bought = credits_bought + ${plan.credits} WHERE id = ${user.id}`;
      await sql`INSERT INTO subscription_charges (subscription_id, paypal_capture_id, credits_granted) VALUES (${subscriptionRowId}, ${firstCaptureId}, ${plan.credits})`;
    }

    const updatedUser = await sql`SELECT credits FROM users WHERE id = ${user.id}`;
    return res.status(200).json({ ok: true, credits: updatedUser.rows[0].credits, creditsGranted: plan.credits });
  } catch (err) {
    console.error('confirm-subscription error', err);
    return res.status(500).json({ error: 'Failed to confirm subscription' });
  }
};
