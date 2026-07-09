const crypto = require('crypto');
const { sql, ensureSchema } = require('../../lib/db');
const { createSession, setSessionCookie } = require('../../lib/auth');

function getOauthStateCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)oauth_state=([^;]+)/);
  return match ? match[1] : null;
}

function clearOauthStateCookie(res) {
  res.setHeader('Set-Cookie',
    'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

module.exports = async (req, res) => {
  const { code, error, state } = req.query || {};

  if (error || !code) return res.redirect('/?error=google_denied');

  // Validate the CSRF nonce before doing anything else. `state` is
  // "<nonce>.<from>"; the nonce half must exactly match what we set in the
  // HttpOnly cookie when the flow started. Constant-time compare since this
  // is a security-sensitive equality check.
  const expectedNonce = getOauthStateCookie(req);
  const [receivedNonce, from] = String(state || '').split('.');
  const nonceOk = !!expectedNonce
    && !!receivedNonce
    && expectedNonce.length === receivedNonce.length
    && crypto.timingSafeEqual(Buffer.from(expectedNonce), Buffer.from(receivedNonce));

  clearOauthStateCookie(res);

  if (!nonceOk) return res.redirect('/?error=google_state_mismatch');

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.redirect('/?error=google_not_configured');

  const base = req.headers['x-forwarded-proto'] === 'https'
    ? `https://${req.headers.host}`
    : `http://${req.headers.host}`;

  const redirectUri = `${base}/api/auth/google-callback`;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    if (!tokenRes.ok) return res.redirect('/?error=google_token_failed');
    const tokens = await tokenRes.json();

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) return res.redirect('/?error=google_userinfo_failed');
    const profile = await profileRes.json();

    if (!profile.email) return res.redirect('/?error=google_no_email');

    await ensureSchema();

    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
    const isAdmin = profile.email.toLowerCase() === adminEmail;

    // Upsert user
    const result = await sql`
      INSERT INTO users (email, is_admin, credits, credits_infinite)
      VALUES (${profile.email.toLowerCase()}, ${isAdmin}, ${isAdmin ? 0 : 15}, ${isAdmin})
      ON CONFLICT (email) DO UPDATE
        SET is_admin = EXCLUDED.is_admin OR users.is_admin,
            credits_infinite = EXCLUDED.credits_infinite OR users.credits_infinite
      RETURNING id
    `;

    const userId = result.rows[0].id;
    const sessionId = await createSession(userId);
    setSessionCookie(res, sessionId, true);

    res.redirect(from === 'admin' ? '/admin.html' : '/');
  } catch (e) {
    console.error('Google OAuth error:', e);
    res.redirect('/?error=google_failed');
  }
};
