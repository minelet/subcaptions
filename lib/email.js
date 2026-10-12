// ── Purchase-receipt email ──────────────────────────────────────────────
// Deliberately a plain lib/*.js file, NOT api/*.js — this project is
// already at Vercel Hobby's 12-serverless-function cap (see the notes in
// api/capture-order.js and api/use-credits.js), so a new endpoint isn't an
// option. This is just a function every purchase-completion code path
// calls directly, in-process, the same way lib/groqKeys.js and lib/db.js
// already are.
//
// Uses Resend's plain HTTP API via fetch — no SDK, no new npm dependency,
// same "just fetch() the provider" pattern already used for PayPal/Razorpay
// elsewhere in this repo. Set these in Vercel (Project Settings →
// Environment Variables):
//
//   RESEND_API_KEY=re_xxx
//   EMAIL_FROM="Litix <receipts@yourdomain.com>"   (must be a domain
//     verified in Resend — an unverified/default sender will get every
//     send rejected)
//
// If RESEND_API_KEY isn't set, sendPurchaseReceiptEmail() logs a warning
// and resolves without sending — so local/dev/staging environments that
// haven't configured it don't crash the purchase flow, they just skip the
// email.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(usd) {
  return '$' + Number(usd).toFixed(2);
}

// item: { label, credits, priceUsd, kind: 'pack' | 'subscription' }
// provider: 'paypal' | 'razorpay' | 'test'
function buildReceiptContent({ item, provider, isTest }) {
  const cycleNote = item.kind === 'subscription' ? ' (billed monthly)' : '';
  const testBanner = isTest
    ? '<p style="background:#fff3cd;color:#664d03;padding:10px 14px;border-radius:6px;font-size:13px;margin:0 0 20px;">' +
      'This is a TEST receipt sent from the admin "Test Purchase" tool — no real payment was made.</p>'
    : '';

  const subject = (isTest ? '[TEST] ' : '') + 'Your Litix receipt — ' + item.label;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
    ${testBanner}
    <h2 style="margin:0 0 4px;">Thanks for your purchase!</h2>
    <p style="color:#555;margin:0 0 20px;">Here's your receipt from Litix.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">Item</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(item.label)}${cycleNote}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">Credits added</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${item.credits}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">Amount</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${isTest ? '$0.00 (test)' : money(item.priceUsd)}</td></tr>
      <tr><td style="padding:8px 0;color:#666;">Payment method</td>
          <td style="padding:8px 0;text-align:right;text-transform:capitalize;">${escapeHtml(provider)}</td></tr>
    </table>
    <p style="color:#999;font-size:12px;margin-top:24px;">If you didn't make this purchase, or have any questions, just reply to this email.</p>
  </div>`.trim();

  const text = `${isTest ? '[TEST] ' : ''}Thanks for your purchase!\n\n` +
    `Item: ${item.label}${cycleNote}\n` +
    `Credits added: ${item.credits}\n` +
    `Amount: ${isTest ? '$0.00 (test)' : money(item.priceUsd)}\n` +
    `Payment method: ${provider}\n` +
    (isTest ? '\nThis is a TEST receipt — no real payment was made.\n' : '');

  return { subject, html, text };
}

// Fire this from every place credits actually get granted (see the
// `inserted.rows.length > 0` / `already.rows.length === 0` guards in
// api/capture-order.js, api/confirm-subscription.js, api/paypal-webhook.js,
// and the admin Test Purchase branch in api/use-credits.js) — those same
// guards already exist to prevent double-crediting, so they're also the
// correct place to prevent double-emailing.
//
// Never throws: a failed send is logged and swallowed so a flaky email
// provider can never block or fail an actual purchase.
async function sendPurchaseReceiptEmail({ toEmail, item, provider, isTest = false }) {
  if (!toEmail) {
    console.error('sendPurchaseReceiptEmail: no recipient email, skipping', { item, provider });
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('sendPurchaseReceiptEmail: RESEND_API_KEY not set, skipping send', { toEmail, item, provider, isTest });
    return;
  }
  const from = process.env.EMAIL_FROM || 'Litix <onboarding@resend.dev>';

  const { subject, html, text } = buildReceiptContent({ item, provider, isTest });

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toEmail, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('sendPurchaseReceiptEmail: Resend rejected the send', res.status, body.slice(0, 500));
    }
  } catch (e) {
    console.error('sendPurchaseReceiptEmail: fetch to Resend failed', e.message);
  }
}

module.exports = { sendPurchaseReceiptEmail };
