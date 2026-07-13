const { sql, ensureSchema } = require('../../lib/db');
const { getSessionCookie, getSessionUser } = require('../../lib/auth');

function toCsv(rows){
  const header = ['id','email','event_type','candidates_found','detail','created_at'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [header.join(',')];
  rows.forEach(r => lines.push(header.map(h => esc(r[h])).join(',')));
  return lines.join('\n');
}

module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Forbidden' });
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
};
