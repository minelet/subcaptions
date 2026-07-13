const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { PACKS } = require('../lib/packs');
const { recordPurchase, streakTierLabel } = require('../lib/rankStreak');

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
    // SECURITY: this path bypasses PayPal entirely and grants free credits.
    // It exists only for the admin "Test Purchase" dev tool — never let a
    // non-admin reach it, or any logged-in user could grant themselves
    // unlimited free credits by calling this endpoint directly.
    if (!user.is_admin) return res.status(403).json({ error: 'Admin only' });

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
      streakTierLabel: streakTierLabel(rankResult.tier),
      decay: rankResult.decay,
    });
  }

  // Refund credits (called when credits were deducted up front — to block
  // refresh-to-dodge-charge — but the paid-for work then failed server-side
  // before doing anything, e.g. AI Clip Finder's analysis call erroring out).
  // Net effect of a deduct-then-refund pair is zero, so this can't be used
  // to gain credits — only to undo a charge for work that never happened.
  // Same validation/cap as a deduction, just added back instead of taken.
  if (action === 'refund') {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const MAX_REFUND_PER_CALL = 600;
    if (amount > MAX_REFUND_PER_CALL) {
      return res.status(400).json({ error: 'Amount exceeds maximum allowed per request' });
    }
    if (user.credits_infinite) return res.status(200).json({ ok: true, credits: user.credits });

    const result = await sql`
      UPDATE users
      SET credits = credits + ${amount}, credits_used = GREATEST(0, credits_used - ${amount})
      WHERE id = ${user.id}
      RETURNING credits
    `;
    try {
      await sql`INSERT INTO clip_finder_events (user_id, event_type, candidates_found, detail) VALUES (${user.id}, 'refund', NULL, ${'refunded ' + amount + ' credits'})`;
    } catch (e) { console.error('clip_finder_events refund log failed:', e); }
    return res.status(200).json({ ok: true, credits: result.rows[0].credits });
  }

  // Deduct credits (called when generating subtitles)
  if (amount !== undefined) {
    // Reject anything that isn't a whole positive number — no fractional
    // amounts (which could round away to a no-op against an INTEGER column),
    // no zero/negative, no NaN/Infinity.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    // Sanity cap — no single generation should ever need more than this many
    // credits. Prevents pathological/garbage values and limits blast radius
    // of any future client-trust bug.
    const MAX_AMOUNT_PER_CALL = 600; // 10 hours of video at 1 credit/minute
    if (amount > MAX_AMOUNT_PER_CALL) {
      return res.status(400).json({ error: 'Amount exceeds maximum allowed per request' });
    }

    if (user.credits_infinite) return res.status(200).json({ ok: true, credits: user.credits });

    // Atomic, race-safe deduction: the WHERE clause re-checks the balance
    // at write time (not from the stale value read into `user` earlier),
    // so concurrent requests can't all pass a check against the same
    // pre-decrement balance and over-deduct. Exactly one of N concurrent
    // requests can win once the balance is insufficient.
    const result = await sql`
      UPDATE users
      SET credits = credits - ${amount}, credits_used = credits_used + ${amount}
      WHERE id = ${user.id} AND credits >= ${amount}
      RETURNING credits
    `;

    if (result.rows.length === 0) {
      return res.status(402).json({ error: 'Insufficient credits' });
    }

    return res.status(200).json({ ok: true, credits: result.rows[0].credits });
  }

  return res.status(400).json({ error: 'Invalid request' });
};
