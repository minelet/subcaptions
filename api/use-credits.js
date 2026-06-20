const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { PACKS } = require('../lib/packs');
const { recordPurchase } = require('../lib/rankStreak');

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // GET — return current credits
  if (req.method === 'GET') {
    return res.status(200).json({ credits: user.credits, creditsInfinite: user.credits_infinite });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { amount, action, packId } = req.body || {};

  // Add credits (after PayPal self-confirm flow)
  if (action === 'add' && packId) {
    const pack = PACKS[packId];
    if (!pack) return res.status(400).json({ error: 'Unknown pack' });

    await sql`
      UPDATE users SET credits = credits + ${pack.credits}, credits_bought = credits_bought + ${pack.credits} WHERE id = ${user.id}
    `;
    // Any purchase counts toward streak/rank, regardless of confirmation path.
    const rankResult = await recordPurchase(user.id, pack.rung);

    const updated = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
    const row = updated.rows[0];
    return res.status(200).json({
      credits: row.credits,
      creditsInfinite: row.credits_infinite,
      rank: rankResult.rank,
      rankRung: rankResult.rankRung,
      streakCount: rankResult.streakCount,
      streakTier: rankResult.tier,
      decay: rankResult.decay,
    });
  }

  // Deduct credits (called when generating subtitles)
  if (typeof amount === 'number' && amount > 0) {
    if (user.credits_infinite) return res.status(200).json({ ok: true, credits: user.credits });
    if (user.credits < amount) return res.status(402).json({ error: 'Insufficient credits' });

    await sql`UPDATE users SET credits = credits - ${amount}, credits_used = credits_used + ${amount} WHERE id = ${user.id}`;
    const updated = await sql`SELECT credits FROM users WHERE id = ${user.id}`;
    return res.status(200).json({ ok: true, credits: updated.rows[0].credits });
  }

  return res.status(400).json({ error: 'Invalid request' });
};
