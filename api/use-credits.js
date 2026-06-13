const { sql, ensureSchema } = require('../lib/db');
const { parseCookies, getSessionUser } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const cookies = parseCookies(req);
    const user = await getSessionUser(cookies.session);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const { durationSeconds } = req.body || {};
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return res.status(400).json({ error: 'Invalid duration' });
    }

    // 1 credit = 1 minute, round up
    const cost = Math.ceil(durationSeconds / 60);

    if (user.credits_infinite) {
      return res.json({ ok: true, cost, credits: null, creditsInfinite: true });
    }

    if (user.credits < cost) {
      return res.status(402).json({
        error: 'Not enough credits',
        required: cost,
        available: user.credits
      });
    }

    const { rows } = await sql`
      UPDATE users SET credits = credits - ${cost}
      WHERE id = ${user.id}
      RETURNING credits
    `;

    res.json({ ok: true, cost, credits: rows[0].credits, creditsInfinite: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
