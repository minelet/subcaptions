// ── Server-managed Groq API key pool ────────────────────────────────────────
// Customers never see or manage a Groq key anymore. Set GROQ_API_KEYS in
// Vercel to a comma-separated list — the first key is primary, the rest are
// fallbacks (up to 10 extra, 11 total works fine but any number is fine):
//
//   GROQ_API_KEYS=gsk_primary_xxx,gsk_backup1_xxx,gsk_backup2_xxx,...
//
// (GROQ_API_KEY, singular, also works as a one-key fallback for convenience.)
//
// When a key gets rate-limited (429) or rejected (401), we mark it "cooling
// down" for a bit so this warm instance stops handing it out immediately —
// then the next request gets served a different key, so a single exhausted
// key doesn't take the whole app down. This state is per-instance, in
// memory only: a cold start just re-learns which keys are hot by trying
// them again, which is fine at this scale.

const COOLDOWN_MS = 60 * 1000;
const cooldowns = new Map(); // key -> timestamp when usable again
const reasons = new Map();   // key -> why it is benched (for the status readout)

// Keys live ONLY in the GROQ_API_KEYS env var — never hardcoded here.
// GitHub's push protection will block any commit containing a raw
// gsk_... key, and rightly so: this file gets committed to git history,
// which is a much bigger exposure surface than an env var Vercel injects
// at runtime. Set GROQ_API_KEYS in Vercel (Project Settings → Environment
// Variables, all environments) to a comma-separated list — first key is
// primary, the rest are fallbacks.
// Paste keys between the quotes below if you want them stored in this file
// instead of Vercel env vars. Env var keys (if any) are used first.
const FILE_KEYS = [
  // 'gsk_your_first_key_here',
  // 'gsk_your_second_key_here',
];

// Failover order (first = tried first, then 2, 3, 4, 5 ...):
//   1. GROQ_API_KEY_1 ... GROQ_API_KEY_10  (explicit numbered slots)
//   2. GROQ_API_KEYS                       (comma-separated list)
//   3. GROQ_API_KEY                        (single key)
//   4. FILE_KEYS above                     (optional, in-file)
// Duplicates are removed but order is preserved, so "Key 1 fails -> Key 2 ->
// Key 3 -> Key 4 -> Key 5" is exactly the order keys are handed out in.
function getKeyPool(pool) {
  // pool === 'clips' -> keys dedicated to the AI Clip Finder ONLY
  // (GROQ_CLIP_KEYS=gsk_a,gsk_b,... and/or GROQ_CLIP_KEY_1 ... GROQ_CLIP_KEY_10).
  // If none are configured it falls back to the normal pool so nothing breaks.
  if (pool === 'clips') {
    const numbered = [];
    for (let i = 1; i <= 10; i++) numbered.push(process.env['GROQ_CLIP_KEY_' + i]);
    const list = String(process.env.GROQ_CLIP_KEYS || '').split(',');
    const clip = [...numbered, ...list].map(k => String(k || '').trim()).filter(Boolean);
    if (clip.length) return [...new Set(clip)];
  }
  const numbered = [];
  for (let i = 1; i <= 10; i++) numbered.push(process.env['GROQ_API_KEY_' + i]);
  const raw = process.env.GROQ_API_KEYS || '';
  const list = raw.split(',');
  const all = [...numbered, ...list, process.env.GROQ_API_KEY, ...FILE_KEYS]
    .map(k => String(k || '').trim())
    .filter(Boolean);
  return [...new Set(all)];
}

// Reads how long Groq says a key is out for: Retry-After header (seconds),
// else x-ratelimit-reset-* headers, else "try again in 1h2m3.4s" in the body.
// Returns ms, or null if Groq didn't say.
function parseRetryMs(headers, bodyText) {
  const toMs = (str) => {
    if (!str) return null;
    str = String(str).trim();
    if (/^\d+(\.\d+)?$/.test(str)) return Math.ceil(parseFloat(str) * 1000);
    const m = str.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
    if (!m || !m[0]) return null;
    return Math.ceil(((+m[1]||0)*86400 + (+m[2]||0)*3600 + (+m[3]||0)*60 + (+m[4]||0))*1000 + (+m[5]||0));
  };
  const get = (n) => (headers && typeof headers.get === 'function') ? headers.get(n) : null;
  const vals = [toMs(get('retry-after')), toMs(get('x-ratelimit-reset-tokens')), toMs(get('x-ratelimit-reset-requests'))].filter(v => v != null);
  if (vals.length) return Math.max(...vals);
  const bm = String(bodyText || '').match(/try again in ([0-9dhms.]+)/i);
  return bm ? toMs(bm[1].replace(/\.$/, '')) : null;
}

// ms defaults: 429 -> Groq's own reset time (or 60s if unknown), 401/403 ->
// 6h ("expired/revoked"), 5xx -> 10s. Capped at 24h so a bad parse can't
// bench a key forever.
function ck(key, kind) { return (kind || 'chat') + '|' + key; }
let rrCounter = 0;

// kind: 'chat' (LLM) and 'audio' (whisper) have SEPARATE Groq limits, so a key
// that's out of audio seconds can still serve chat, and vice versa.
function markKeyFailed(key, ms = COOLDOWN_MS, reason = null, kind = 'chat') {
  if (!key) return;
  ms = Math.max(1000, Math.min(ms || COOLDOWN_MS, 24 * 3600 * 1000));
  cooldowns.set(ck(key, kind), Date.now() + ms);
  reasons.set(ck(key, kind), reason || 'rate limited');
}

function markKeyOk(key, kind = 'chat') {
  if (!key) return;
  cooldowns.delete(ck(key, kind));
  reasons.delete(ck(key, kind));
}

// Returns the best available key, skipping `excluding` and anything cooling
// down. rotate=true starts from a different key each call so load is spread
// evenly across the pool (instead of burning key 1's per-minute limit first).
// If EVERYTHING is cooling, returns the key that comes back soonest.
function nextAvailableKey(excluding = [], pool, kind = 'chat', rotate = false) {
  let keys = getKeyPool(pool);
  if (!keys.length) return null;
  if (rotate && keys.length > 1) { const r = (rrCounter++) % keys.length; keys = keys.slice(r).concat(keys.slice(0, r)); }
  const now = Date.now();
  for (const key of keys) {
    if (excluding.includes(key)) continue;
    const until = cooldowns.get(ck(key, kind));
    if (until && until > now) continue;
    return key;
  }
  const rest = keys.filter(k => !excluding.includes(k));
  if (!rest.length) return keys[0];
  return rest.sort((a, b) => (cooldowns.get(ck(a, kind)) || 0) - (cooldowns.get(ck(b, kind)) || 0))[0];
}

// True only if at least one key in the pool is usable right now.
function hasLiveKey(pool, kind = 'chat') {
  const now = Date.now();
  return getKeyPool(pool).some(k => !(cooldowns.get(ck(k, kind)) > now));
}

// Safe-to-show status (never exposes the key itself): one row per key slot.
// Shows the worse of chat/audio, with which one is limited.
function keyStatus(pool) {
  const now = Date.now();
  return getKeyPool(pool).map((k, i) => {
    const c = (cooldowns.get(ck(k, 'chat')) || 0) - now;
    const a = (cooldowns.get(ck(k, 'audio')) || 0) - now;
    const worst = Math.max(c, a, 0);
    const kind = c >= a ? 'chat' : 'audio';
    return {
      slot: i + 1,
      status: worst > 0 ? 'cooling' : 'working',
      reason: worst > 0 ? (reasons.get(ck(k, kind)) || 'rate limited') + ' (' + (kind === 'audio' ? 'transcription' : 'analysis') + ')' : null,
      backInSec: Math.ceil(worst / 1000),
    };
  });
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + s + 's';
  return s + 's';
}

module.exports = { getKeyPool, nextAvailableKey, markKeyFailed, markKeyOk, parseRetryMs, hasLiveKey, keyStatus, fmtDuration };
