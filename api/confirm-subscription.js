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
  // SECURITY/DEBUG: previously this silently returned token: undefined on
  // auth failure, which meant every downstream PayPal call sent
  // "Authorization: Bearer undefined" and came back as a generic 401
  // "invalid_token / Token signature verification failed" — indistinguishable
  // from a real signature problem. Failing here instead, with PayPal's own
  // error_description and which env/base was used, turns that into a
  // one-line diagnosis (wrong PAYPAL_CLIENT_ID/SECRET, or PAYPAL_ENV pointed
  // at a different environment than the credentials belong to).
  if (!res.ok || !data.access_token) {
    console.error('PayPal OAuth token request failed', { env, base, status: res.status, body: data });
    throw new Error(`PayPal auth failed (${env} env): ${data.error_description || data.error || 'no access_token returned'}`);
  }
  return { token: data.access_token, base };
}

function siteOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

// Creates the PayPal subscription server-side and hands back the approval
// URL to redirect to — the same "redirect to a PayPal-hosted page, come
// back with an id in the query string" shape the one-time packs already
// use (see PAYPAL_PACKS links + handlePaypalReturn in index.html), instead
// of loading PayPal's client-side JS SDK and rendering its iframe button.
// That SDK button was the source of the "PayPal Subscribe" branding, the
// funding-source clutter, and the stray "Loading…" artifact the frontend
// couldn't fully control — none of that exists with a plain server call
// behind our own button.
async function handleCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();
  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { planKey } = req.body || {};
  const plan = SUBSCRIPTIONS[planKey];
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });
  if (!plan.planId) return res.status(400).json({ error: 'This plan isn\u2019t configured yet' });

  try {
    const { token, base } = await getPayPalToken();
    const origin = siteOrigin(req);

    const createRes = await fetch(`${base}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: plan.planId,
        custom_id: String(user.id),
        application_context: {
          brand_name: 'LitiX',
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${origin}/`,
          cancel_url: `${origin}/`,
        },
      }),
    });
    const created = await createRes.json();

    if (!createRes.ok) {
      // This is the single most useful log line for diagnosing "payment
      // error" reports — PayPal's actual reason (INVALID_RESOURCE_ID,
      // plan not ACTIVE, plan belongs to a different app/environment
      // than PAYPAL_CLIENT_ID, etc.) lands here instead of being hidden
      // behind a generic client-side SDK error.
      console.error('PayPal create subscription failed', { planKey, planId: plan.planId, status: createRes.status, body: created });
      return res.status(502).json({ error: created?.details?.[0]?.description || created?.message || 'PayPal rejected the subscription request' });
    }

    const approveUrl = (created.links || []).find(l => l.rel === 'approve')?.href;
    if (!approveUrl) {
      console.error('PayPal subscription created without an approve link', created);
      return res.status(502).json({ error: 'PayPal did not return an approval link' });
    }

    return res.status(200).json({ approveUrl });
  } catch (err) {
    console.error('create-subscription error', err);
    // Surface the real reason (e.g. the PayPal-auth error thrown above) in
    // the response, not just the generic fallback — so this shows up
    // directly in the "Payment error" dialog instead of requiring a log dive.
    return res.status(500).json({ error: err.message || 'Failed to start subscription' });
  }
}

// Called by the frontend right after the user approves on PayPal and is
// redirected back with ?subscription_id=... . This is a convenience path
// so the user sees their credits land the moment they return, instead of
// waiting on a webhook that can (per PayPal's own docs) take anywhere from
// instantly to several minutes. It is NOT the trust boundary — everything
// here is re-verified server-side against PayPal's own API before anything
// is credited, and api/paypal-webhook.js independently does the same
// crediting logic (idempotently, via subscription_charges) as a backstop
// in case this call never happens (tab closed, network drop, etc).
async function handleConfirm(req, res) {
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
}

// TEMPORARY DEBUG — diagnoses the "Token signature verification failed"
// PayPal error by running the exact same token+plan-fetch sequence
// production uses, server-side, with the real env vars, and returning what
// actually happened instead of requiring local curl access. Gated to admins
// only, same check api/admin.js uses. Safe to delete once the PayPal
// credential/app mismatch is found and fixed.
async function handleDebug(req, res) {
  await ensureSchema();
  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  const out = { env: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox' };
  try {
    const { token, base } = await getPayPalToken();
    out.tokenObtained = true;
    out.base = base;

    const planRes = await fetch(`${base}/v1/billing/plans/${process.env.PAYPAL_PLAN_ID_20}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const planBody = await planRes.json();
    out.planFetchStatus = planRes.status;
    out.planFetchBody = planBody;
  } catch (err) {
    out.tokenObtained = false;
    out.error = err.message;
  }
  return res.status(200).json(out);
}

module.exports = async (req, res) => {
  if (req.query?.resource === 'create') return handleCreate(req, res);
  if (req.query?.resource === 'debug') return handleDebug(req, res);
  return handleConfirm(req, res);
};

