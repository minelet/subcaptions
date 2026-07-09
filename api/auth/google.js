const crypto = require('crypto');

module.exports = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.redirect('/?error=google_not_configured');
  }

  const base = req.headers['x-forwarded-proto'] === 'https'
    ? `https://${req.headers.host}`
    : `http://${req.headers.host}`;

  const redirectUri = `${base}/api/auth/google-callback`;
  const from = req.query && req.query.from === 'admin' ? 'admin' : '';

  // Real CSRF nonce: a random value only this server issued, stashed in a
  // short-lived HttpOnly cookie and echoed back by Google in `state`. The
  // callback verifies the two match before doing anything, so an attacker
  // can't craft their own /api/auth/google-callback?code=...&state=... link
  // to force-link an account or trigger login-CSRF. The redirect-target hint
  // ("admin" vs default) rides alongside the nonce rather than being the
  // entire state value.
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${nonce}.${from}`;

  res.setHeader('Set-Cookie',
    `oauth_state=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};
