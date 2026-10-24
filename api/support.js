const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser } = require('../lib/auth');
const { notifyAdmins } = require('../lib/push');
const crypto = require('crypto');
const { SUPPORT_ADDRESS } = require('../lib/email');

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

// ── Inbound email → support ticket (support@litix.in) ───────────────────────
// Lives inside this file because the project is at Vercel Hobby's 12-function
// cap, so it cannot be its own api/ file. Resend's `email.received` webhook
// POSTs here: /api/support?inbound=resend&key=<INBOUND_WEBHOOK_KEY>
//
// Trust model: (1) the shared key in the URL, and (2) the webhook only carries
// an email id — we fetch the real message from Resend with our own API key, so
// a forged webhook for an email that is not in our Resend account just 404s.
// Webhook retries are deduped on support_messages.external_id.
function extractAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}
function extractName(from) {
  const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : '';
}
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
// Keep what the customer just wrote; drop the quoted history below it.
function stripQuotedReply(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200}wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(line.trim())) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  const cleaned = out.join('\n').trim();
  return cleaned || String(text || '').trim();
}

async function handleInboundEmail(req, res) {
  const expected = process.env.INBOUND_WEBHOOK_KEY || '';
  const given = String(req.query?.key || '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set' });

  const evt = req.body || {};
  if (evt.type !== 'email.received') return res.status(200).json({ ok: true, ignored: evt.type || 'unknown' });
  const emailId = evt.data?.email_id || evt.data?.id;
  if (!emailId || typeof emailId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(emailId)) {
    return res.status(400).json({ error: 'Missing email id' });
  }

  const dup = await sql`SELECT 1 FROM support_messages WHERE external_id = ${emailId} LIMIT 1`;
  if (dup.rows.length) return res.status(200).json({ ok: true, duplicate: true });

  let email;
  try {
    const r = await fetch('https://api.resend.com/emails/receiving/' + encodeURIComponent(emailId), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      console.error('inbound: Resend fetch failed', r.status);
      return res.status(502).json({ error: 'Could not fetch email' }); // Resend will retry
    }
    email = await r.json();
  } catch (e) {
    console.error('inbound: Resend fetch threw', e.message);
    return res.status(502).json({ error: 'Could not fetch email' });
  }

  const fromAddr = extractAddress(email.from);
  if (!fromAddr || !fromAddr.includes('@')) return res.status(200).json({ ok: true, ignored: 'no sender' });
  if (fromAddr === SUPPORT_ADDRESS) return res.status(200).json({ ok: true, ignored: 'own address' }); // loop guard

  const subject = String(email.subject || '(no subject)').trim().slice(0, 150) || '(no subject)';
  const rawBody = (email.text && String(email.text).trim()) ? email.text : htmlToText(email.html);
  const body = stripQuotedReply(rawBody).slice(0, 8000) || '(empty message)';
  const messageId = email.message_id ? String(email.message_id).slice(0, 500) : null;

  // Thread it: "[#123]" token in the subject (our replies carry it), else the
  // newest open email ticket from this sender, else a new ticket.
  let ticketId = null;
  const tok = subject.match(/\[#(\d{1,9})\]/);
  if (tok) {
    const t = await sql`
      SELECT id FROM support_tickets
      WHERE id = ${parseInt(tok[1], 10)} AND source = 'email' AND contact_email = ${fromAddr}`;
    if (t.rows[0]) ticketId = t.rows[0].id;
  }
  if (!ticketId) {
    const t = await sql`
      SELECT id FROM support_tickets
      WHERE source = 'email' AND contact_email = ${fromAddr} AND status = 'open'
      ORDER BY last_message_at DESC LIMIT 1`;
    if (t.rows[0]) ticketId = t.rows[0].id;
  }
  if (!ticketId) {
    const cleanSubject = subject.replace(/\s*\[#\d+\]\s*/g, ' ').replace(/^(re|fwd?):\s*/i, '').trim().slice(0, 150) || '(no subject)';
    const ins = await sql`
      INSERT INTO support_tickets (user_id, subject, status, unread_by_admin, source, contact_email, email_message_id)
      VALUES (NULL, ${cleanSubject}, 'open', TRUE, 'email', ${fromAddr}, ${messageId})
      RETURNING id`;
    ticketId = ins.rows[0].id;
  }

  const name = extractName(email.from);
  const ins = await sql`
    INSERT INTO support_messages (ticket_id, sender_type, sender_id, body, external_id)
    VALUES (${ticketId}, 'user', NULL, ${body}, ${emailId})
    ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!ins.rows.length) return res.status(200).json({ ok: true, duplicate: true }); // lost a race with a retry

  await sql`
    UPDATE support_tickets
    SET last_message_at = NOW(), unread_by_admin = TRUE, status = 'open',
        email_message_id = COALESCE(${messageId}, email_message_id)
    WHERE id = ${ticketId}`;

  notifyAdmins({
    title: 'New email to support',
    body: `${name ? name + ' <' + fromAddr + '>' : fromAddr}: ${subject}`,
    ticketId,
  }).catch(() => {});

  return res.status(200).json({ ok: true, ticketId });
}

module.exports = async (req, res) => {
  await ensureSchema();

  // Inbound email webhook (no user session — authenticated by key, see above)
  if (req.method === 'POST' && req.query?.inbound === 'resend') return handleInboundEmail(req, res);

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
