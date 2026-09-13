const crypto = require('crypto');
const { sql, ensureSchema } = require('./db');

// ── Password hashing (PBKDF2) ──────────────────────────────────────────────
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const { hash: attempt } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
}

// ── Sessions ───────────────────────────────────────────────────────────────
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

const SESSION_DURATION_DAYS = 30;

async function createSession(userId) {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 86400 * 1000);
  await sql`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${sessionId}, ${userId}, ${expiresAt})
  `;
  return sessionId;
}

async function getSessionUser(sessionId) {
  if (!sessionId) return null;
  const result = await sql`
    SELECT u.id, u.email, u.is_admin, u.credits, u.credits_infinite, u.credits_bought
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId}
      AND s.expires_at > NOW()
  `;
  return result.rows[0] || null;
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}

// ── Cookie helpers ──────────────────────────────────────────────────────────
function getSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

function setSessionCookie(res, sessionId, rememberMe = true) {
  const maxAge = rememberMe ? SESSION_DURATION_DAYS * 86400 : 0;
  const cookieStr = `session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieStr);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieStr]);
  }
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

// ── CSRF (belt-and-suspenders on top of SameSite=Lax) ───────────────────────
// SameSite=Lax on the session cookie already blocks the common
// cross-site-form-POST version of CSRF. The admin panel's edit/delete-user
// actions rely on that alone today. This adds a double-submit-cookie token
// as a second layer: a non-HttpOnly cookie holds a random per-session
// secret, the admin frontend echoes that value back in an X-CSRF-Token
// header on every mutating request, and the server checks the two match
// against what's on file for that session. A cross-site page can trigger a
// cookie-carrying request, but it cannot read the cookie's value
// (browsers enforce same-origin on cookie reads) to put into the header,
// so a forged request fails this check even if SameSite were ever
// misconfigured or bypassed.
//
// IMPORTANT: this secret is persisted on the `sessions` row, not held in
// serverless function memory. Each API route is its own Lambda / container
// in this deployment, so a value that only lived in one instance's memory
// (e.g. a module-level random secret regenerated per cold start) would
// almost never match between the instance that set the cookie (/api/me)
// and the instance that later checks it (/api/admin) — that was exactly
// the bug that made admin POSTs fail with 403 while GETs worked fine.
// Storing it per-session in the DB makes it consistent no matter which
// instance/container handles the request.
async function getOrCreateCsrfSecret(sessionId) {
  const result = await sql`SELECT csrf_secret FROM sessions WHERE id = ${sessionId}`;
  const row = result.rows[0];
  if (!row) return null; // no such session
  if (row.csrf_secret) return row.csrf_secret;

  const secret = crypto.randomBytes(32).toString('hex');
  await sql`UPDATE sessions SET csrf_secret = ${secret} WHERE id = ${sessionId}`;
  return secret;
}

async function setCsrfCookie(res, sessionId) {
  const token = await getOrCreateCsrfSecret(sessionId);
  if (!token) return;
  // Deliberately NOT HttpOnly — the frontend needs to read this to echo it
  // back in a header. It's not a secret on its own; it only proves anything
  // when the caller can ALSO carry the session cookie, which is what makes
  // the pairing meaningful.
  const cookieStr = `csrf_token=${token}; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION_DAYS * 86400}`;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieStr);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieStr]);
  }
}

async function verifyCsrf(req, sessionId) {
  if (!sessionId) return false;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  const cookieToken = match ? match[1] : null;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || typeof headerToken !== 'string') return false;

  const expected = await getOrCreateCsrfSecret(sessionId);
  if (!expected) return false;
  const cookieBuf = Buffer.from(cookieToken);
  const headerBuf = Buffer.from(headerToken);
  const expectedBuf = Buffer.from(expected);
  if (cookieBuf.length !== expectedBuf.length || headerBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(cookieBuf, expectedBuf) && crypto.timingSafeEqual(headerBuf, expectedBuf);
}

// ── User helpers ────────────────────────────────────────────────────────────
function formatUser(row) {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin,
    credits: row.credits,
    creditsInfinite: row.credits_infinite,
    creditsBought: row.credits_bought,
  };
}

async function ensureAdminAccount() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  const existing = await sql`SELECT id FROM users WHERE email = ${adminEmail}`;
  if (existing.rows.length === 0) return;
  await sql`
    UPDATE users SET is_admin = true, credits_infinite = true
    WHERE email = ${adminEmail}
  `;
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, getSessionUser, deleteSession,
  getSessionCookie, setSessionCookie, clearSessionCookie,
  formatUser, ensureAdminAccount,
  setCsrfCookie, verifyCsrf,
};
