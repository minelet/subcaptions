const { SUBSCRIPTIONS } = require('../lib/packs');

// PAYPAL_CLIENT_ID and billing Plan IDs are not secrets — they're designed
// to be embedded in client-side JS (that's how every PayPal integration
// works; the secret half, PAYPAL_CLIENT_SECRET, never leaves the server
// and is not read here). This endpoint just hands the frontend what it
// needs to render the PayPal JS SDK subscribe buttons.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    clientId: process.env.PAYPAL_CLIENT_ID || null,
    plans: Object.fromEntries(
      Object.entries(SUBSCRIPTIONS).map(([key, p]) => [key, { planId: p.planId, credits: p.credits, priceUsd: p.priceUsd, rank: p.rank }])
    ),
  });
};
