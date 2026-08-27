// INR conversion rate for Razorpay pricing. Razorpay only settles in INR
// unless International Payments is enabled on the account, so every pack's
// USD price below also gets an INR amount (in paise — the smallest INR
// unit, i.e. priceInrPaise = rupees * 100) for the Razorpay Orders/
// Subscriptions API. Adjust RAZORPAY_INR_PER_USD in your Vercel env vars
// if your actual conversion differs from this default.
const INR_PER_USD = Number(process.env.RAZORPAY_INR_PER_USD) || 83;
function toInrPaise(usd) {
  return Math.round(usd * INR_PER_USD * 100);
}

const PACKS = {
  starter: { credits: 10,   priceUsd: 2,   rank: 'Starter',         rung: 1 },
  popular: { credits: 35,   priceUsd: 5,   rank: 'Popular',         rung: 2 },
  pro:     { credits: 100,  priceUsd: 10,  rank: 'Pro',             rung: 3 },
  bulk:    { credits: 250,  priceUsd: 20,  rank: 'Bulk',            rung: 4 },
  godly:   { credits: 2000, priceUsd: 100, rank: 'Limited Edition', rung: 5 },
};
// priceInrPaise added after the object literal so every entry can reuse
// toInrPaise() without repeating it on each line above.
Object.values(PACKS).forEach(p => { p.priceInrPaise = toInrPaise(p.priceUsd); });

// Monthly subscriptions. `planId` is a PayPal *Billing Plan ID* (starts
// "P-..."), NOT one of our own keys — it comes from PayPal after you create
// the Product + Plan in the PayPal dashboard (or via the /v1/billing/plans
// API) and has to be pasted in here before subscriptions will work. Until
// then this stays null and the subscribe buttons on the frontend won't
// render for that tier (see initSubscribeButtons in public/index.html).
//
// `razorpayPlanId` is the Razorpay equivalent (starts "plan_..."), created
// via create-razorpay-subscriptions.js (Razorpay's own dashboard wizard for
// this has a broken plan-select dropdown, so the script creates Plans +
// Subscriptions through the API directly). Defaults below are the real IDs
// that script produced; override via env vars the same way PayPal's are,
// so a plan can be swapped without a code change.
//
// Credits-per-cycle here were chosen to price noticeably better per-minute
// than the equivalent one-time PACKS tier, since a subscriber is committing
// to recurring revenue and should see a clear reason to pick monthly over
// a one-off top-up. See the pricing note in this file's git history / the
// conversation that introduced this for the full comparison against
// PACKS and competitor per-minute pricing.
const SUBSCRIPTIONS = {
  sub_10: {
    credits: 100, priceUsd: 10, rank: 'Monthly Starter',
    planId: process.env.PAYPAL_PLAN_ID_10 || null,
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_10 || 'plan_TThmbWGUwKw42v',
  },
  sub_20: {
    credits: 200, priceUsd: 20, rank: 'Monthly Growth',
    planId: process.env.PAYPAL_PLAN_ID_20 || null,
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_20 || 'plan_TThmcheiZMUtao',
  },
  sub_50: {
    credits: 600, priceUsd: 50, rank: 'Monthly Pro',
    planId: process.env.PAYPAL_PLAN_ID_50 || null,
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_50 || 'plan_TThmdl5wFIJWJK',
  },
};
Object.values(SUBSCRIPTIONS).forEach(p => { p.priceInrPaise = toInrPaise(p.priceUsd); });

// Reverse lookup: PayPal only ever hands us back a plan_id (in webhooks and
// in the subscription object), never our internal sub_10/sub_20/sub_50 key —
// so every place that receives a plan_id from PayPal needs to map it back
// to one of our plans before it can trust anything about price/credits.
function subscriptionByPlanId(planId) {
  return Object.entries(SUBSCRIPTIONS).find(([, p]) => p.planId && p.planId === planId)?.[1] || null;
}

// Same idea, but for Razorpay's plan_id (webhooks and subscription objects
// hand this back, never our sub_10/sub_20/sub_50 key).
function subscriptionByRazorpayPlanId(razorpayPlanId) {
  return Object.entries(SUBSCRIPTIONS).find(([, p]) => p.razorpayPlanId && p.razorpayPlanId === razorpayPlanId)?.[1] || null;
}

module.exports = {
  PACKS,
  SUBSCRIPTIONS,
  subscriptionByPlanId,
  subscriptionByRazorpayPlanId,
};
