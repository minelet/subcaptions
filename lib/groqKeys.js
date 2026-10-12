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
function getKeyPool() {
  const numbered = [];
  for (let i = 1; i <= 10; i++) numbered.push(process.env['GROQ_API_KEY_' + i]);
  const raw = process.env.GROQ_API_KEYS || '';
  const list = raw.split(',');
  const all = [...numbered, ...list, process.env.GROQ_API_KEY, ...FILE_KEYS]
    .map(k => String(k || '').trim())
    .filter(Boolean);
  return [...new Set(all)];
}

function markKeyFailed(key, ms = COOLDOWN_MS) {
  if (key) cooldowns.set(key, Date.now() + ms);
}

// Returns the best available key, skipping anything in `excluding` and
// anything currently cooling down. Falls back to the pool's first key
// rather than returning null if everything's excluded/cooling — a
// possibly-still-limited key beats no key at all.
function nextAvailableKey(excluding = []) {
  const pool = getKeyPool();
  if (!pool.length) return null;
  const now = Date.now();
  for (const key of pool) {
    if (excluding.includes(key)) continue;
    const until = cooldowns.get(key);
    if (until && until > now) continue;
    return key;
  }
  return pool.find(k => !excluding.includes(k)) || pool[0];
}

module.exports = { getKeyPool, nextAvailableKey, markKeyFailed };
