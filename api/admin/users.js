const { sql, ensureSchema } = require('../../lib/db');
const { getSessionCookie, getSessionUser } = require('../../lib/auth');
const { displayRank, RUNG_NAMES } = require('../../lib/rankStreak');

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const search = (req.query?.search || '').trim();
    const result = search
      ? await sql`
          SELECT id, email, is_admin, credits, credits_infinite, credits_used, credits_bought,
                 rank, rank_expires_at, rank_rung, streak_count, last_purchase_at,
                 period_deadline_at, last_drip_at, created_at
          FROM users WHERE email ILIKE ${'%' + search + '%'} ORDER BY created_at DESC
        `
      : await sql`
          SELECT id, email, is_admin, credits, credits_infinite, credits_used, credits_bought,
                 rank, rank_expires_at, rank_rung, streak_count, last_purchase_at,
                 period_deadline_at, last_drip_at, created_at
          FROM users ORDER BY created_at DESC
        `;
    return res.status(200).json({ users: result.rows });
  }

  // PATCH — update a user's credits, rank rung, and/or streak
  if (req.method === 'PATCH') {
    const { userId, credits, creditsInfinite, infinite, rank, rankRung, streakCount } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // Admin manually setting rank rung and/or streak count directly
    if (rankRung !== undefined || streakCount !== undefined) {
      const targetRes = await sql`SELECT rank_rung, streak_count FROM users WHERE id = ${userId}`;
      if (!targetRes.rows[0]) return res.status(404).json({ error: 'User not found' });

      const newRung   = rankRung   !== undefined ? Math.max(0, Math.min(5, Number(rankRung)))   : targetRes.rows[0].rank_rung;
      const newStreak = streakCount !== undefined ? Math.max(0, Number(streakCount)) : targetRes.rows[0].streak_count;
      const newRank   = displayRank(newRung, newStreak);

      // IMPORTANT: an admin override changes rank_rung/streak_count directly,
      // but the "already counted this period" gate in applyPurchase() keys off
      // last_purchase_at/period_deadline_at, not streak_count. If we leave a
      // stale (still-in-the-future) period_deadline_at in place, the NEXT real
      // purchase will see "you already bought this period" and hold the streak
      // at whatever it was just overridden to - forever, until that old
      // deadline passes. So we clear the period anchor here: the next purchase
      // is treated as the start of a fresh period and will correctly bump the
      // streak instead of getting stuck.
      const newTier = newStreak >= 5 ? 'diamond' : newStreak >= 3 ? 'gold' : 'none';
      await sql`
        UPDATE users
        SET rank_rung          = ${newRung},
            streak_count       = ${newStreak},
            rank               = ${newRank},
            last_purchase_at   = NULL,
            period_deadline_at = NULL,
            last_drip_at       = ${newTier === 'none' ? null : new Date()}
        WHERE id = ${userId}
      `;
      await sql`
        INSERT INTO streak_events (user_id, event_type, detail)
        VALUES (${userId}, 'admin_override', ${JSON.stringify({
          adminId: user.id,
          rankRung: newRung,
          streakCount: newStreak,
        })})
      `;
      return res.status(200).json({ ok: true, rank: newRank });
    }

    // Legacy: rank text-only update (kept for backward compat but now also
    // derives rung from the rank name so the two columns stay in sync)
    if (rank !== undefined && credits === undefined && creditsInfinite === undefined && infinite === undefined) {
      const rungFromName = rank ? RUNG_NAMES.indexOf(rank) : 0;  // -1 if unknown → treated as 0
      const safeRung = rungFromName > 0 ? rungFromName : 0;
      const rankExpiresAt = rank
        ? (() => { const d = new Date(); d.setDate(d.getDate() + 31); return d; })()
        : null;
      await sql`
        UPDATE users
        SET rank = ${rank || null}, rank_expires_at = ${rankExpiresAt}, rank_rung = ${safeRung}
        WHERE id = ${userId}
      `;
      return res.status(200).json({ ok: true });
    }

    const isInfinite = creditsInfinite ?? infinite ?? false;
    await sql`
      UPDATE users
      SET credits = ${credits ?? 0},
          credits_infinite = ${isInfinite}
      WHERE id = ${userId}
    `;
    return res.status(200).json({ ok: true });
  }

  // DELETE — remove a user
  if (req.method === 'DELETE') {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const target = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].is_admin) return res.status(400).json({ error: 'Cannot delete an admin account' });

    await sql`DELETE FROM users WHERE id = ${userId}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
