const { getSessionCookie, deleteSession, clearSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sessionId = getSessionCookie(req);
  await deleteSession(sessionId);
  clearSessionCookie(res);

  res.status(200).json({ ok: true });
};
