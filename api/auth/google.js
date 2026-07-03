module.exports = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.redirect('/?error=google_not_configured');
  }

  const base = req.headers['x-forwarded-proto'] === 'https'
    ? `https://${req.headers.host}`
    : `http://${req.headers.host}`;

  const redirectUri = `${base}/api/auth/google-callback`;
  const state = req.query && req.query.from === 'admin' ? 'admin' : '';

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
