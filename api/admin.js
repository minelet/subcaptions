const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { displayRank, RUNG_NAMES } = require('../lib/rankStreak');

// Merged admin endpoint. Vercel's Hobby plan caps deployments at 12
// serverless functions, so the 4 separate api/admin/*.js handlers
// (users, orders, streak-events, clip-finder-stats) were combined into
// this single file. vercel.json routes each original URL here and adds
// a `resource` query param to pick which handler runs below — the
// public URLs (/api/admin/users, /api/admin/orders, etc.) are unchanged.

function toCsv(rows) {
  const header = ['id', 'email', 'event_type', 'candidates_found', 'detail', 'created_at'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [header.join(',')];
  rows.forEach(r => lines.push(header.map(h => esc(r[h])).join(',')));
  return lines.join('\n');
}

async function handleUsers(req, res) {
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

    const sessionId = getSessionCookie(req);
    const adminUser = await getSessionUser(sessionId);

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
          adminId: adminUser.id,
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

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleOrders(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const result = await sql`
    SELECT o.id, o.credits, o.amount_usd, o.status, o.created_at, u.email
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC
  `;
  return res.status(200).json({ orders: result.rows });
}

async function handleStreakEvents(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const userId = parseInt(req.query?.userId, 10);
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 200);

  const result = await sql`
    SELECT id, event_type, detail, created_at
    FROM streak_events
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return res.status(200).json({ events: result.rows });
}

async function handleClipFinderStats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Optional ?days=7 (or 30/90) — defaults to all-time when omitted/invalid.
  const daysParam = parseInt(req.query?.days, 10);
  const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : null;
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  const totals = since
    ? await sql`SELECT event_type, COUNT(*)::int AS count FROM clip_finder_events WHERE created_at >= ${since} GROUP BY event_type`
    : await sql`SELECT event_type, COUNT(*)::int AS count FROM clip_finder_events GROUP BY event_type`;
  const summary = { success: 0, auth_error: 0, error: 0, refund: 0 };
  totals.rows.forEach(r => { summary[r.event_type] = r.count; });

  const totalRuns = summary.success + summary.auth_error + summary.error;
  const failureRate = totalRuns > 0 ? Math.round(((summary.auth_error + summary.error) / totalRuns) * 100) : 0;

  // CSV export ignores the 50-row cap the dashboard view uses — full range.
  if (req.query?.format === 'csv') {
    const all = since
      ? await sql`SELECT cfe.id, cfe.event_type, cfe.candidates_found, cfe.detail, cfe.created_at, u.email FROM clip_finder_events cfe LEFT JOIN users u ON u.id = cfe.user_id WHERE cfe.created_at >= ${since} ORDER BY cfe.created_at DESC`
      : await sql`SELECT cfe.id, cfe.event_type, cfe.candidates_found, cfe.detail, cfe.created_at, u.email FROM clip_finder_events cfe LEFT JOIN users u ON u.id = cfe.user_id ORDER BY cfe.created_at DESC`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="clip-finder-events${days ? '-' + days + 'd' : ''}.csv"`);
    return res.status(200).send(toCsv(all.rows));
  }

  const recent = since
    ? await sql`SELECT cfe.id, cfe.event_type, cfe.candidates_found, cfe.detail, cfe.created_at, u.email FROM clip_finder_events cfe LEFT JOIN users u ON u.id = cfe.user_id WHERE cfe.created_at >= ${since} ORDER BY cfe.created_at DESC LIMIT 50`
    : await sql`SELECT cfe.id, cfe.event_type, cfe.candidates_found, cfe.detail, cfe.created_at, u.email FROM clip_finder_events cfe LEFT JOIN users u ON u.id = cfe.user_id ORDER BY cfe.created_at DESC LIMIT 50`;

  return res.status(200).json({
    summary,
    totalRuns,
    failureRate,
    recent: recent.rows,
  });
}

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });

  const resource = req.query?.resource;

  switch (resource) {
    case 'users':
      return handleUsers(req, res);
    case 'orders':
      return handleOrders(req, res);
    case 'streak-events':
      return handleStreakEvents(req, res);
    case 'clip-finder-stats':
      return handleClipFinderStats(req, res);
    default:
      return res.status(404).json({ error: 'Unknown admin resource' });
  }
};
