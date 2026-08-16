const { ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser, formatUser, setCsrfCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // Refreshed on every /api/me call (every authenticated page load) so the
  // admin panel always has a current, matching CSRF cookie — including for
  // sessions that were created before this cookie existed.
  await setCsrfCookie(res, sessionId);

  res.status(200).json(formatUser(user));
};
