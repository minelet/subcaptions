const crypto = require('crypto');

const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

function authHeader() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured');
  return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
}

async function razorpayApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${RAZORPAY_BASE}${path}`, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Razorpay API error (${path}): ${data.error?.description || JSON.stringify(data)}`);
  }
  return data;
}

function createOrder({ amount, currency, notes }) {
  // amount is in the smallest currency unit (paise for INR), matching the
  // amount your PACKS/SUBSCRIPTIONS entries are priced in.
  return razorpayApi('/orders', { method: 'POST', body: { amount, currency, notes } });
}

function getOrder(orderId) {
  return razorpayApi(`/orders/${orderId}`);
}

function createSubscription({ plan_id, notes, total_count = 1200 }) {
  // total_count=1200 (100 years of monthly cycles) is Razorpay's own
  // recommended way to represent "no fixed end date" — Razorpay has no
  // literal "unlimited" option, see their docs on Total Count.
  return razorpayApi('/subscriptions', {
    method: 'POST',
    body: { plan_id, total_count, customer_notify: 0, notes },
  });
}

function getSubscription(subscriptionId) {
  return razorpayApi(`/subscriptions/${subscriptionId}`);
}

// SECURITY: these three verify functions are the entire trust boundary for
// crediting a user's account. Anyone can POST fake success data to our
// endpoints claiming "I paid" — the HMAC signature is the only thing that
// actually proves Razorpay processed the payment, since it's computed with
// RAZORPAY_KEY_SECRET, which never leaves our server.

// One-time order payment: Razorpay's checkout `handler` callback gives us
// {razorpay_order_id, razorpay_payment_id, razorpay_signature}. The
// signature is HMAC_SHA256(order_id + "|" + payment_id, key_secret).
function verifyOrderPaymentSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return timingSafeEqualHex(expected, signature);
}

// Subscription first payment: same idea, but HMAC input is
// payment_id + "|" + subscription_id (Razorpay's own documented format —
// note the argument order is swapped vs. the order-payment signature above).
function verifySubscriptionPaymentSignature({ paymentId, subscriptionId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  return timingSafeEqualHex(expected, signature);
}

// Webhook deliveries (recurring subscription.charged events, and our
// payment.captured fallback) are signed differently: HMAC_SHA256 of the
// *raw* request body, using a separate secret you set when creating the
// webhook in Settings > Webhooks (RAZORPAY_WEBHOOK_SECRET), not your API
// key secret.
//
// CAVEAT: this needs the exact raw bytes Razorpay sent, not a re-serialized
// JSON.stringify(req.body) — those can differ in key order/whitespace and
// silently break signature verification. This file assumes `rawBody` is
// captured upstream before body-parsing. If Razorpay's webhook test
// delivery fails verification, check that api/paypal-webhook.js is
// actually passing the untouched raw string here, not the parsed object.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expected, signatureHeader);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

module.exports = {
  createOrder,
  getOrder,
  createSubscription,
  getSubscription,
  verifyOrderPaymentSignature,
  verifySubscriptionPaymentSignature,
  verifyWebhookSignature,
};
