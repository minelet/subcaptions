const webpush = require('web-push');
const { sql } = require('./db');

// ── Admin desktop notifications via the Web Push API ───────────────────────
// This is what lets a new customer message reach the admin even when the
// admin tab is backgrounded, or the browser itself isn't running at all
// (the OS's push service — e.g. Chrome uses FCM under the hood — wakes the
// browser's service worker to deliver it). Whether it survives the browser
// being *fully quit* depends on the OS/browser's "run in background" setting;
// most desktop Chrome/Edge installs keep this on by default, but it's worth
// knowing that's the one case notifications can be delayed until the
// browser is reopened.
//
// Requires VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT env vars.
// Generate a keypair once with `npx web-push generate-vapid-keys` and set
// them in Vercel's project settings (Production + Preview + Development).

let configured = false;
function configureWebPush() {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

async function saveSubscription(userId, sub) {
  await sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (${userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
    ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
  `;
}

async function removeSubscription(endpoint) {
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
}

// Sends payload (an object — gets JSON-stringified) to every registered
// admin device. Dead subscriptions (404/410 from the push service — browser
// uninstalled, permission revoked, etc.) are pruned as they're discovered.
async function notifyAdmins(payload) {
  if (!configureWebPush()) {
    console.warn('[push] VAPID keys not configured — skipping admin push notification');
    return;
  }
  const subs = await sql`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`;
  if (!subs.rows.length) return;

  const body = JSON.stringify(payload);
  await Promise.all(subs.rows.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`;
      } else {
        console.error('[push] send failed for subscription', s.id, err.statusCode, err.body);
      }
    }
  }));
}

module.exports = { getVapidPublicKey, saveSubscription, removeSubscription, notifyAdmins };
