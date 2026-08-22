const PACKS = {
  starter: { credits: 10,   priceUsd: 2,   rank: 'Starter',         rung: 1 },
  popular: { credits: 35,   priceUsd: 5,   rank: 'Popular',         rung: 2 },
  pro:     { credits: 100,  priceUsd: 10,  rank: 'Pro',             rung: 3 },
  bulk:    { credits: 250,  priceUsd: 20,  rank: 'Bulk',            rung: 4 },
  godly:   { credits: 2000, priceUsd: 100, rank: 'Limited Edition', rung: 5 },
};

// Monthly subscriptions. `planId` is a PayPal *Billing Plan ID* (starts
// "P-..."), NOT one of our own keys — it comes from PayPal after you create
// the Product + Plan in the PayPal dashboard (or via the /v1/billing/plans
// API) and has to be pasted in here before subscriptions will work. Until
// then this stays null and the subscribe buttons on the frontend won't
// render for that tier (see initSubscribeButtons in public/index.html).
//
// Credits-per-cycle here were chosen to price noticeably better per-minute
// than the equivalent one-time PACKS tier, since a subscriber is committing
// to recurring revenue and should see a clear reason to pick monthly over
// a one-off top-up. See the pricing note in this file's git history / the
// conversation that introduced this for the full comparison against
// PACKS and competitor per-minute pricing.
const SUBSCRIPTIONS = {
  sub_10: { credits: 100,  priceUsd: 10, rank: 'Monthly Starter', planId: process.env.PAYPAL_PLAN_ID_10 || null },
  sub_20: { credits: 200,  priceUsd: 20, rank: 'Monthly Growth',  planId: process.env.PAYPAL_PLAN_ID_20 || null },
  sub_50: { credits: 600,  priceUsd: 50, rank: 'Monthly Pro',     planId: process.env.PAYPAL_PLAN_ID_50 || null },
};

// Reverse lookup: PayPal only ever hands us back a plan_id (in webhooks and
// in the subscription object), never our internal sub_10/sub_20/sub_50 key —
// so every place that receives a plan_id from PayPal needs to map it back
// to one of our plans before it can trust anything about price/credits.
function subscriptionByPlanId(planId) {
  return Object.entries(SUBSCRIPTIONS).find(([, p]) => p.planId && p.planId === planId)?.[1] || null;
}

module.exports = { PACKS, SUBSCRIPTIONS, subscriptionByPlanId };
