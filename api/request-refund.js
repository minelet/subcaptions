const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');

const MAX_REASON_LEN = 500;

// Replaces the old self-service refund. This endpoint never changes anyone's
// credit balance — it only records a pending request, and only after
// confirming the request points at a real deduction that actually belongs
// to the caller. An admin has to separately approve it (api/admin.js,
// resource=refund-requests) before any credits move. See lib/db.js for the
// credit_transactions / refund_requests tables this relies on.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { transactionId, reason } = req.body || {};
  const txId = parseInt(transactionId, 10);
  if (!Number.isInteger(txId) || txId <= 0) {
    return res.status(400).json({ error: 'Invalid transactionId' });
  }
  const safeReason = typeof reason === 'string' ? reason.slice(0, MAX_REASON_LEN) : null;

  // The transaction must exist, be a deduction, and belong to this user —
  // this is the check the old endpoint never had. Nobody can request a
  // refund for a charge that never happened or that happened on someone
  // else's account.
  const txRes = await sql`
    SELECT id, amount FROM credit_transactions
    WHERE id = ${txId} AND user_id = ${user.id} AND type = 'deduct'
  `;
  const tx = txRes.rows[0];
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  // One live request per transaction — stops someone from spamming the same
  // charge into the admin queue repeatedly, or double-dipping if an earlier
  // request on it was already approved.
  const existing = await sql`
    SELECT id FROM refund_requests
    WHERE transaction_id = ${txId} AND status IN ('pending', 'approved')
  `;
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'A refund request already exists for this charge' });
  }

  const inserted = await sql`
    INSERT INTO refund_requests (user_id, transaction_id, amount, reason, status)
    VALUES (${user.id}, ${txId}, ${tx.amount}, ${safeReason}, 'pending')
    RETURNING id, created_at
  `;

  return res.status(200).json({
    ok: true,
    requestId: inserted.rows[0].id,
    status: 'pending',
  });
};
