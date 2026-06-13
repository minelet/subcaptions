const { parseCookies, clearCookie, destroySession } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const cookies = parseCookies(req);
  await destroySession(cookies.session);
  clearCookie(res, 'session');
  res.json({ ok: true });
};
