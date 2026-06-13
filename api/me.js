const { parseCookies, getSessionUser } = require('../lib/auth');

module.exports = async (req, res) => {
  const cookies = parseCookies(req);
  const user = await getSessionUser(cookies.session);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  res.json({
    email: user.email,
    isAdmin: user.is_admin,
    credits: user.credits,
    creditsInfinite: user.credits_infinite
  });
};
