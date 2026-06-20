const { sql, ensureSchema } = require('../../lib/db');
const { createSession, setSessionCookie } = require('../../lib/auth');

module.exports = async (req, res) => {
  const { code, error, state } = req.query || {};

  if (error || !code) return res.redirect('/?error=google_denied');

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
      VALUES (${profile.email.toLowerCase()}, ${isAdmin}, ${isAdmin ? 0 : 5}, ${isAdmin})
      ON CONFLICT (email) DO UPDATE
        SET is_admin = EXCLUDED.is_admin OR users.is_admin,
            credits_infinite = EXCLUDED.credits_infinite OR users.credits_infinite
      RETURNING id
    `;

    const userId = result.rows[0].id;
    const sessionId = await createSession(userId);
    setSessionCookie(res, sessionId, true);

    res.redirect(state === 'admin' ? '/admin.html' : '/');
  } catch (e) {
    console.error('Google OAuth error:', e);
    res.redirect('/?error=google_failed');
  }
};
