const crypto = require('crypto');
const { sql, ensureSchema } = require('../lib/db');
const { createSession } = require('../lib/auth');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

function getRedirectUri(req) {
  // Always use the stable production domain to match Google Console
  const host = process.env.PRODUCTION_DOMAIN
    || (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `https://${host}/api/auth/google-callback`;
}

function setCookieHeader(res, name, value, expiresDate) {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Expires=${expiresDate.toUTCString()}`
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

module.exports = async (req, res) => {
  const action = req.query.action;

  // redirect to Google
  if (action === 'login') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).send('Google login not configured');

    const redirectUri = getRedirectUri(req);
    const redirectAfter = req.query.redirect || '/';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
      state: encodeURIComponent(redirectAfter)
    });

    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    return res.end();
  }

  // OAuth callback
  if (action === 'callback') {
    try {
      const { code, error } = req.query || {};
      if (error || !code) {
        res.writeHead(302, { Location: `/?error=google_denied` });
        return res.end();
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) return res.status(500).send('Google login not configured');

      const redirectUri = getRedirectUri(req);

      // Exchange code for token
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
      });

      if (!tokenResp.ok) {
        console.error('Token exchange failed:', await tokenResp.text());
        res.writeHead(302, { Location: '/?error=google_token_failed' });
        return res.end();
      }
      const tokens = await tokenResp.json();

      // Get user info
      const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (!userInfoResp.ok) {
        res.writeHead(302, { Location: '/?error=google_userinfo_failed' });
        return res.end();
      }
      const profile = await userInfoResp.json();

      const email = String(profile.email || '').trim().toLowerCase();
      if (!email) {
        res.writeHead(302, { Location: '/?error=google_no_email' });
        return res.end();
      }

      await ensureSchema();

      // Find or create user
      let rows = await sql`SELECT * FROM users WHERE email = ${email}`;
      let user = rows[0];

      if (!user) {
        const isAdmin = email === ADMIN_EMAIL;
        const randomHash = crypto.randomBytes(32).toString('hex');
        const result = await sql`
          INSERT INTO users (email, password_hash, is_admin, credits, credits_infinite)
          VALUES (${email}, ${'google-oauth:' + randomHash}, ${isAdmin}, 5, ${isAdmin})
          RETURNING *
        `;
        user = result[0];
      }

      // Create session
      const session = await createSession(user.id, true);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      setCookieHeader(res, 'session', session.token, expires);

      const redirectTo = req.query.state ? decodeURIComponent(req.query.state) : '/';
      res.writeHead(302, { Location: redirectTo });
      return res.end();

    } catch (err) {
      console.error('Google auth error:', err);
      res.writeHead(302, { Location: '/?error=google_failed' });
      return res.end();
    }
  }

  return res.status(404).json({ error: 'Unknown action' });
};
