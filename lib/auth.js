const crypto = require('crypto');
const { sql, ensureSchema } = require('./db');
const { reconcileUser, streakTier, streakTierLabel } = require('./rankStreak');

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
    SELECT u.id, u.email, u.is_admin, u.credits, u.credits_infinite,
           u.rank, u.rank_expires_at, u.rank_rung, u.streak_count,
           u.last_purchase_at, u.period_deadline_at, u.last_drip_at,
           u.credits_bought
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId}
      AND s.expires_at > NOW()
  `;
  const row = result.rows[0];
  if (!row) return null;

  // Reconcile rank/streak state to "now": applies any owed period-decay and
  // pays out any owed Gold+/Diamond+ credit drips before returning the user.
  const reconciled = await reconcileUser(row);
  return { ...row, ...reconciled };
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
  res.setHeader('Set-Cookie',
    `session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

// ── User helpers ────────────────────────────────────────────────────────────
function formatUser(row) {
  const streak = row.streak_count || 0;
  const tier = streakTier(streak);
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin,
    credits: row.credits,
    creditsInfinite: row.credits_infinite,
    rank: row.rank || null,
    rankExpiresAt: row.rank_expires_at || null,
    rankRung: row.rank_rung || 0,
    streakCount: streak,
    streakTier: tier,                 // 'none' | 'gold' | 'diamond'
    streakTierLabel: streakTierLabel(tier), // null | 'Gold+' | 'Diamond+'
    periodDeadlineAt: row.period_deadline_at || null,
    lastDripAt: row.last_drip_at || null,
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
  formatUser, ensureAdminAccount
};
