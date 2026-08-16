const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { notifyAdmins } = require('../lib/push');

const MAX_MSG_LEN = 4000;
const MAX_SUBJECT_LEN = 150;

// Customer-facing support ticket endpoint. A user can only ever see and
// touch their own tickets — every query below is scoped by user_id, so
// there's no way to read or reply into someone else's thread by guessing
// a ticketId. The admin side of this same table lives in api/admin.js
// (resource=support).
//
// GET  (no ticketId)   → list this user's tickets, newest activity first
// GET  ?ticketId=X      → one ticket + full thread (must belong to caller);
//                         also marks it read-by-user
// POST {action:'create', subject, message}
// POST {action:'reply', ticketId, message}
module.exports = async (req, res) => {
  await ensureSchema();

  const sessionId = getSessionCookie(req);
  const user = await getSessionUser(sessionId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method === 'GET') {
    const ticketId = parseInt(req.query?.ticketId, 10);
    if (Number.isInteger(ticketId) && ticketId > 0) {
      const ticketRes = await sql`
        SELECT id, subject, status, unread_by_user, created_at, last_message_at
        FROM support_tickets WHERE id = ${ticketId} AND user_id = ${user.id}
      `;
      const ticket = ticketRes.rows[0];
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      const messages = await sql`
        SELECT id, sender_type, body, created_at
        FROM support_messages WHERE ticket_id = ${ticketId} ORDER BY created_at ASC
      `;

      if (ticket.unread_by_user) {
        await sql`UPDATE support_tickets SET unread_by_user = FALSE WHERE id = ${ticketId}`;
      }

      return res.status(200).json({ ticket, messages: messages.rows });
    }

    const tickets = await sql`
      SELECT t.id, t.subject, t.status, t.unread_by_user, t.created_at, t.last_message_at,
             (SELECT body FROM support_messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message
      FROM support_tickets t
      WHERE t.user_id = ${user.id}
      ORDER BY t.last_message_at DESC
      LIMIT 100
    `;
    const unreadRes = await sql`
      SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id = ${user.id} AND unread_by_user = TRUE
    `;

    return res.status(200).json({ tickets: tickets.rows, unreadCount: unreadRes.rows[0].n });
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'create') {
      const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim().slice(0, MAX_SUBJECT_LEN) : '';
      const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, MAX_MSG_LEN) : '';
      if (!subject) return res.status(400).json({ error: 'Subject is required' });
      if (!message) return res.status(400).json({ error: 'Message is required' });

      // One open ticket at a time keeps the thread model simple for both
      // sides — if the customer already has something open, steer them
      // into replying there instead of fragmenting the conversation.
      const existingOpen = await sql`
        SELECT id FROM support_tickets WHERE user_id = ${user.id} AND status = 'open' LIMIT 1
      `;
      if (existingOpen.rows[0]) {
        return res.status(409).json({ error: 'You already have an open ticket', ticketId: existingOpen.rows[0].id });
      }

      const inserted = await sql`
        INSERT INTO support_tickets (user_id, subject, status, unread_by_admin)
        VALUES (${user.id}, ${subject}, 'open', TRUE)
        RETURNING id, created_at
      `;
      const ticketId = inserted.rows[0].id;
      await sql`
        INSERT INTO support_messages (ticket_id, sender_type, sender_id, body)
        VALUES (${ticketId}, 'user', ${user.id}, ${message})
      `;
      // Fire-and-forget: don't make the customer wait on push delivery, and
      // don't fail their ticket creation if a push send errors out.
      notifyAdmins({
        title: 'New support ticket',
        body: `${user.email}: ${subject}`,
        ticketId,
      }).catch(() => {});
      return res.status(200).json({ ok: true, ticketId });
    }

    if (action === 'reply') {
      const ticketId = parseInt(req.body?.ticketId, 10);
      const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, MAX_MSG_LEN) : '';
      if (!Number.isInteger(ticketId) || ticketId <= 0) return res.status(400).json({ error: 'Invalid ticketId' });
      if (!message) return res.status(400).json({ error: 'Message is required' });

      const ticketRes = await sql`SELECT id, status FROM support_tickets WHERE id = ${ticketId} AND user_id = ${user.id}`;
      const ticket = ticketRes.rows[0];
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      await sql`
        INSERT INTO support_messages (ticket_id, sender_type, sender_id, body)
        VALUES (${ticketId}, 'user', ${user.id}, ${message})
      `;
      // A reply from the customer always reopens a closed ticket — if the
      // admin marked it resolved and the person writes back, that's a
      // strong signal it wasn't actually resolved.
      await sql`
        UPDATE support_tickets
        SET last_message_at = NOW(), unread_by_admin = TRUE, unread_by_user = FALSE, status = 'open'
        WHERE id = ${ticketId}
      `;
      const subjectRow = await sql`SELECT subject FROM support_tickets WHERE id = ${ticketId}`;
      notifyAdmins({
        title: 'New support reply',
        body: `${user.email}: ${subjectRow.rows[0]?.subject || 'Support ticket'}`,
        ticketId,
      }).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
