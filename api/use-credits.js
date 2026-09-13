const { sql, ensureSchema } = require('../lib/db');
const { getSessionCookie, getSessionUser, verifyCsrf } = require('../lib/auth');
const { PACKS } = require('../lib/packs');
const { nextAvailableKey, markKeyFailed } = require('../lib/groqKeys');
const { sendPurchaseReceiptEmail } = require('../lib/email');

// Vercel Functions hard-cap request bodies at 4.5MB (413
// FUNCTION_PAYLOAD_TOO_LARGE past that, enforced by the platform before our
// code even runs). Only the transcribe proxy below needs headroom close to
// that; the credit-management JSON actions are tiny. One shared cap, sized
// for the bigger of the two, is simplest.
const MAX_BODY_BYTES = 4.3 * 1024 * 1024;

function readRawBody(req){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if(size > MAX_BODY_BYTES + (1024 * 1024)){
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Groq proxy (POST /api/transcribe -> here with ?resource=transcribe) ──
// SECURITY FIX: transcription (and the Hindi/Hinglish rewrite step) used to
// call api.groq.com directly FROM THE BROWSER, with the real Groq key handed
// to any logged-in user via /api/me and this file's old 'groq-key' action —
// visible in plain text in the Network tab to every customer, who could copy
// it out and hit Groq directly, entirely outside this app's credit system,
// running up (or exhausting) the account's real Groq quota for free. Every
// Groq call is now proxied through here instead, so the key never leaves
// the server. This lives in the same file/function as the rest of the
// credits logic (rather than its own api/*.js file) because Vercel's
// Hobby plan caps a project at 12 serverless functions and this project is
// already at that cap — see the same note on api/session.js.
const GROQ_ENDPOINTS = {
  transcriptions: 'https://api.groq.com/openai/v1/audio/transcriptions',
  translations:   'https://api.groq.com/openai/v1/audio/translations',
  chat:           'https://api.groq.com/openai/v1/chat/completions',
};

async function handleTranscribeProxy(req, res, rawBody, user){
  // SECURITY FIX: this proxy had no server-side credit check at all —
  // the ONLY thing standing between a signed-in user and unlimited free
  // Groq-backed transcription was the frontend's own convention of
  // calling POST /api/use-credits (deduct) before ever calling this
  // endpoint. Nothing stopped calling this URL directly (curl, devtools,
  // a modified client) with a session cookie and 0 credits, entirely
  // skipping payment while still running up the real Groq bill. This
  // doesn't meter exact per-call cost (that still happens via the
  // deduct/reconcile calls elsewhere, which need the real audio duration
  // this endpoint doesn't know yet) — it closes the actual hole: a user
  // with no credits and no infinite-credits flag can't reach Groq at all
  // through this proxy, full stop.
  if(!user.credits_infinite && (!user.credits || user.credits <= 0)){
    return res.status(402).json({ error: 'Insufficient credits' });
  }

  const endpointKey = req.query?.endpoint;
  const targetUrl = GROQ_ENDPOINTS[endpointKey];
  if(!targetUrl) return res.status(400).json({ error: 'Unknown endpoint' });

  // Audio requests arrive as multipart/form-data (boundary is in the
  // client's own Content-Type header — forwarded byte-for-byte, we never
  // parse the multipart body ourselves). Chat requests are plain JSON from
  // our own frontend code, not user-suppliable, so a fixed type is fine.
  const contentType = endpointKey === 'chat' ? 'application/json' : req.headers['content-type'];
  if(!contentType) return res.status(400).json({ error: 'Missing Content-Type' });

  const triedKeys = [];
  let lastUpstreamStatus = 500;
  let lastUpstreamText = '';

  // Try every key in the pool once. nextAvailableKey() skips whatever's
  // currently cooling down from a recent 401/429 (possibly from a
  // different concurrent request), so a just-burned key isn't retried here.
  for(let attempt = 0; attempt < 8; attempt++){
    const key = nextAvailableKey(triedKeys);
    if(!key || triedKeys.includes(key)){
      if(!key) console.error('transcribe proxy: no Groq keys configured (set GROQ_API_KEYS)');
      break;
    }
    triedKeys.push(key);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': contentType },
        body: rawBody,
      });
    } catch(e){
      console.error('transcribe proxy: upstream fetch failed:', e.message);
      return res.status(502).json({ error: 'Could not reach the transcription service. Please try again.' });
    }

    if(upstream.status === 401 || upstream.status === 429){
      markKeyFailed(key);
      lastUpstreamStatus = upstream.status;
      lastUpstreamText = await upstream.text().catch(() => '');
      continue; // try the next key in the pool
    }

    // Success, or a real (non-key) error like a 400 for a bad param — pass
    // it straight through unchanged, same status and body, so the client's
    // existing handling (e.g. detecting a timestamp_granularities 400 on
    // the translate endpoint and retrying without it) keeps working as-is.
    const text = await upstream.text();
    // DIAGNOSTIC FIX: every non-2xx status used to reach this point and go
    // straight to the client with zero server-side trace — there was no way
    // to ever see what Groq actually said (e.g. a 404's real body/URL),
    // only the bare status code the client falls back to displaying
    // ("Transcription error 404"). Log it here so the real cause shows up
    // in the Vercel function logs the next time this happens.
    if(upstream.status < 200 || upstream.status >= 300){
      console.error('transcribe proxy: upstream returned', upstream.status, 'for', targetUrl, '-', text.slice(0, 500));
    }
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  }

  console.error('transcribe proxy: all pool keys exhausted, last status', lastUpstreamStatus, lastUpstreamText.slice(0, 300));
  return res.status(503).json({ error: 'Transcription is temporarily unavailable — please try again shortly.' });
}

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

  // bodyParser is off for this whole function (see config export below) —
  // the transcribe proxy needs the raw, unparsed multipart body, so every
  // action here reads the raw buffer itself instead of relying on Vercel's
  // default req.body.
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch(e){
    return res.status(e.statusCode || 400).json({ error: e.message || 'Failed to read request body' });
  }

  if(req.query?.resource === 'transcribe'){
    return handleTranscribeProxy(req, res, rawBody, user);
  }

  let body = {};
  if(rawBody.length){
    try { body = JSON.parse(rawBody.toString('utf8')); }
    catch(e){ return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  const { amount, action, packId } = body || {};

  // Add credits (after PayPal self-confirm flow)
  if (action === 'add' && packId) {
    // SECURITY: this path bypasses PayPal entirely and grants free credits.
    // It exists only for the admin "Test Purchase" dev tool — never let a
    // non-admin reach it, or any logged-in user could grant themselves
    // unlimited free credits by calling this endpoint directly.
    if (!user.is_admin) return res.status(403).json({ error: 'Admin only' });
    // Belt-and-suspenders CSRF check alongside the admin-only + SameSite=Lax
    // cookie protections already in place — same reasoning as api/admin.js.
    if (!(await verifyCsrf(req, sessionId))) return res.status(403).json({ error: 'Invalid CSRF token' });

    const pack = PACKS[packId];
    if (!pack) return res.status(400).json({ error: 'Unknown pack' });

    await sql`
      UPDATE users SET credits = credits + ${pack.credits}, credits_bought = credits_bought + ${pack.credits} WHERE id = ${user.id}
    `;

    const updated = await sql`SELECT credits, credits_infinite FROM users WHERE id = ${user.id}`;
    const row = updated.rows[0];

    // Sends to the admin's own email (whoever is logged in and clicked
    // "Test Purchase") — this is the whole point of wiring the email in
    // here: a real end-to-end send with zero real payment, so the receipt
    // template/deliverability can be checked before launch.
    await sendPurchaseReceiptEmail({
      toEmail: user.email,
      item: { label: pack.rank, credits: pack.credits, priceUsd: pack.priceUsd, kind: 'pack' },
      provider: 'test',
      isTest: true,
    });

    return res.status(200).json({
      credits: row.credits,
      creditsInfinite: row.credits_infinite,
    });
  }

  // NOTE: there used to be a self-service 'refund' action here that trusted
  // whatever `amount` the client sent and added it straight to the user's
  // balance — with no check that a matching deduction had ever happened. Any
  // logged-in user could call it repeatedly with no video, no work, nothing,
  // and farm unlimited free credits. It has been removed entirely. Refunds
  // now go through POST /api/request-refund, which requires a real
  // credit_transactions row for a deduction that belongs to the caller, and
  // credits are only ever granted once an admin approves that request via
  // /api/admin?resource=refund-requests (see api/admin.js). See
  // lib/db.js for the credit_transactions / refund_requests schema.

  // Deduct credits (called before generating subtitles, and again as a
  // reconciliation top-up after — see action==='reconcile' below)
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

    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : null;

    // RECONCILIATION FIX: the initial deduction (see the frontend's
    // startGroqTranscription) is charged BEFORE transcription even starts,
    // for an amount the browser estimates from `vp.duration` — a value the
    // client fully controls. A tampered client could send amount:1 for a
    // 2-hour video and pay a single credit for it. This atomic deduction
    // below was already race-safe, but never re-checked what was actually
    // charged against what the video actually needed.
    //
    // action==='reconcile' closes that gap: once transcription finishes,
    // the frontend sums the REAL audio duration Groq itself reported across
    // every chunk (something the client can't lie about, since it's reading
    // it back out of Groq's own response) and calls this again with
    // whatever shortfall remains. If the balance can't fully cover it, this
    // drains whatever's left instead of hard-failing — the work already
    // happened; the goal is closing the loophole and creating a paper
    // trail, not retroactively blocking a finished export. A user who
    // repeatedly comes up short here is visible in credit_transactions
    // (reason:'duration-reconciliation') for follow-up.
    if(action === 'reconcile'){
      const result = await sql`
        UPDATE users
        SET credits = GREATEST(credits - ${amount}, 0), credits_used = credits_used + LEAST(credits, ${amount})
        WHERE id = ${user.id}
        RETURNING credits
      `;
      if(result.rows.length){
        const txResult = await sql`
          INSERT INTO credit_transactions (user_id, type, amount, reason)
          VALUES (${user.id}, 'deduct', ${amount}, ${reason || 'duration-reconciliation'})
          RETURNING id
        `;
        return res.status(200).json({ ok: true, credits: result.rows[0].credits, transactionId: txResult.rows[0].id });
      }
      return res.status(404).json({ error: 'User not found' });
    }

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

    // Log this deduction as a real, referenceable charge. This is the row a
    // later refund *request* has to point at (see /api/request-refund) —
    // it's what makes a refund provable instead of just a trusted number.
    const txResult = await sql`
      INSERT INTO credit_transactions (user_id, type, amount, reason)
      VALUES (${user.id}, 'deduct', ${amount}, ${reason})
      RETURNING id
    `;

    return res.status(200).json({ ok: true, credits: result.rows[0].credits, transactionId: txResult.rows[0].id });
  }

  return res.status(400).json({ error: 'Invalid request' });
};

module.exports.config = { api: { bodyParser: false } };
