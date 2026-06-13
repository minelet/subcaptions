// paypal.js — minimal PayPal Orders v2 client using fetch
const PAYPAL_ENV = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
const BASE_URL = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PayPal credentials not configured');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const resp = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!resp.ok) throw new Error('Failed to get PayPal access token');
  const data = await resp.json();
  return data.access_token;
}

async function createOrder({ amountUsd, referenceId }) {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: referenceId,
        amount: {
          currency_code: 'USD',
          value: amountUsd.toFixed(2)
        }
      }]
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PayPal createOrder failed: ${text}`);
  }
  return resp.json();
}

async function captureOrder(orderId) {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PayPal captureOrder failed: ${text}`);
  }
  return resp.json();
}

module.exports = { createOrder, captureOrder };
