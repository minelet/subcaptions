// auth.js — session + password helpers
const crypto = require('crypto');
const { sql, ensureSchema } = require('./db');

const SESSION_DAYS = 30;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId, persistent) {
  await ensureSchema();
  const token = generateToken();
  const expires = persistent
    ? new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 1 * 24 * 60 * 60 * 1000); // 1 day fallback for non-persistent server-side cap
  await sql`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (${token}, ${userId}, ${expires.toISOString()})
  `;
  return { token, expires, persistent: !!persistent };
}

async function getSessionUser(token) {
  if (!token) return null;
  await ensureSchema();
  const rows = await sql`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ${token} AND sessions.expires_at > NOW()
  `;
  return rows[0] || null;
}

async function destroySession(token) {
  if (!token) return;
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=None');
  if (process.env.VERCEL_ENV !== 'development') parts.push('Secure');
  // Only set Max-Age/Expires for persistent ("remember me") sessions.
  // Omitting both makes it a session cookie that clears when the browser closes.
  if (opts.persistent) {
    if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
    if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  }
  const existing = res.getHeader('Set-Cookie');
  const cookieStr = parts.join('; ');
  if (existing) {
    res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', cookieStr);
  }
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  hashPassword, verifyPassword, generateToken,
  createSession, getSessionUser, destroySession,
  parseCookies, setCookie, clearCookie
};
