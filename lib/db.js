const { sql } = require('@vercel/postgres');

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      is_admin BOOLEAN DEFAULT FALSE,
      credits INTEGER DEFAULT 5,
      credits_infinite BOOLEAN DEFAULT FALSE,
      credits_used INTEGER DEFAULT 0,
      credits_bought INTEGER DEFAULT 0,
      rank TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_bought INTEGER DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_expires_at TIMESTAMPTZ`;

  // ── Rank & Streak system ──────────────────────────────────────────────
  // rank_rung: 0 = no rank, 1..5 = Starter..Limited Edition (the purchase ladder).
  // This never decreases on a cheaper purchase; it only ever rises on purchase
  // or falls via missed-period decay.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_rung INTEGER DEFAULT 0`;
  // streak_count: consecutive monthly purchases, in a row, with no missed period.
  // Resets to 0 the moment a period is missed. Gold+/Diamond+ are derived from this.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INTEGER DEFAULT 0`;
  // last_purchase_at: timestamp of the most recent qualifying purchase. Anchors
  // the current 30-31 day window used to decide on-time vs missed.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ`;
  // period_deadline_at: last_purchase_at + 31 days. If "now" passes this without
  // a new purchase, at least one period has been missed.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS period_deadline_at TIMESTAMPTZ`;
  // last_drip_at: anchor for Gold+/Diamond+ credit drips, so we can lazily compute
  // how many drip intervals have elapsed since the last time we paid out.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_drip_at TIMESTAMPTZ`;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      paypal_order_id TEXT UNIQUE,
      pack_id TEXT,
      credits INTEGER,
      amount_usd NUMERIC(10,2),
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Audit trail for rank/streak changes: purchases, decay, drips. Lets admins
  // see exactly why a user's rank or streak moved, and when.
  await sql`
    CREATE TABLE IF NOT EXISTS streak_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Login rate limiting: tracks failed attempts per (email, ip) key so
  // /api/login can throttle brute-force guessing. Rows are short-lived —
  // only the last few minutes matter — so no cleanup job is required, but
  // one could periodically DELETE WHERE created_at < now() - interval '1 day'.
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      attempt_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_attempts_key_time ON login_attempts (attempt_key, created_at)`;

  // AI Clip Finder observability: every /api/shortify attempt (success or
  // failure) and every credit refund gets a row here, so the admin panel
  // has real visibility into this feature — previously nothing about it
  // was logged anywhere, so failures (e.g. bad Groq keys) were invisible.
  await sql`
    CREATE TABLE IF NOT EXISTS clip_finder_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,     -- 'success' | 'auth_error' | 'error' | 'refund'
      candidates_found INTEGER,
      detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_clip_finder_events_time ON clip_finder_events (created_at)`;
}

module.exports = { sql, ensureSchema };
