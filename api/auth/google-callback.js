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
    const normalEmail = profile.email.toLowerCase();
    const isAdmin = normalEmail === adminEmail;

    // SECURITY: check whether this email already has a password set BEFORE
    // upserting. Signup has no email verification, so an attacker can
    // pre-register any address (e.g. victim@gmail.com) with a password only
    // they know. If the real owner later signs in with Google — which DOES
    // verify the email — and we silently log them into that same pre-existing
    // row, the attacker's password still works on the account afterward: a
    // real account takeover, invisible to the real owner. A verified Google
    // login is stronger proof of ownership than an unverified password, so we
    // treat it as authoritative and clear any existing password on match —
    // the attacker's credential stops working from this point on.
    const existingRes = await sql`SELECT password_hash FROM users WHERE email = ${normalEmail}`;
    const hadPassword = !!existingRes.rows[0]?.password_hash;

    // Upsert user
    const result = await sql`
      INSERT INTO users (email, is_admin, credits, credits_infinite)
      VALUES (${normalEmail}, ${isAdmin}, ${isAdmin ? 0 : 15}, ${isAdmin})
      ON CONFLICT (email) DO UPDATE
        SET is_admin = EXCLUDED.is_admin OR users.is_admin,
            credits_infinite = EXCLUDED.credits_infinite OR users.credits_infinite,
            password_hash = NULL,
            password_salt = NULL
      RETURNING id
    `;

    const userId = result.rows[0].id;
    const sessionId = await createSession(userId);
    setSessionCookie(res, sessionId, true);

    const dest = from === 'admin' ? '/admin.html' : from === 'editor' ? '/editor.html' : '/';
    res.redirect(hadPassword ? `${dest}?notice=password_cleared` : dest);
  } catch (e) {
    console.error('Google OAuth error:', e);
    res.redirect('/?error=google_failed');
  }
};
