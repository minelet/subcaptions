const crypto = require('crypto');
const { sql, ensureSchema } = require('../lib/db');
const { createSession, setCookie } = require('../lib/auth');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

module.exports = async (req, res) => {
  const action = req.query.action;

  // /api/google-auth?action=login — redirect to Google
  if (action === 'login') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).send('Google login not configured');

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const redirectUri = `${protocol}://${req.headers.host}/api/google-auth?action=callback`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account'
    });

    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
    return res.end();
  }

  // /api/google-auth?action=callback — OAuth callback
  if (action === 'callback') {
    try {
      const { code, error } = req.query || {};
      if (error) return res.redirect('/?error=google_denied');
      if (!code) return res.redirect('/?error=google_no_code');

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) return res.status(500).send('Google login not configured');

      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const redirectUri = `${protocol}://${req.headers.host}/api/google-auth?action=callback`;

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });
      if (!tokenResp.ok) {
        console.error(await tokenResp.text());
        return res.redirect('/?error=google_token_failed');
      }
      const tokens = await tokenResp.json();

      const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (!userInfoResp.ok) return res.redirect('/?error=google_userinfo_failed');
      const profile = await userInfoResp.json();

      const email = String(profile.email || '').trim().toLowerCase();
      if (!email) return res.redirect('/?error=google_no_email');

      await ensureSchema();

      let { rows } = await sql`SELECT * FROM users WHERE email = ${email}`;
      let user = rows[0];

      if (!user) {
        const isAdmin = email === ADMIN_EMAIL;
        const randomHash = crypto.randomBytes(32).toString('hex');
        const result = await sql`
          INSERT INTO users (email, password_hash, is_admin, credits, credits_infinite)
          VALUES (${email}, ${'google-oauth:' + randomHash}, ${isAdmin}, 5, ${isAdmin})
          RETURNING *
        `;
        user = result.rows[0];
      }

      const session = await createSession(user.id, true);
      setCookie(res, 'session', session.token, { expires: session.expires, persistent: true });

      res.writeHead(302, { Location: '/' });
      return res.end();
    } catch (err) {
      console.error(err);
      return res.redirect('/?error=google_failed');
    }
  }

  return res.status(404).json({ error: 'Unknown action' });
};
