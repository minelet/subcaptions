const { sql } = require('@vercel/postgres');

// ensureSchema() used to run its full list of CREATE TABLE IF NOT EXISTS /
// ALTER TABLE IF NOT EXISTS statements on every single request — correct,
// but wasteful, since a warm serverless instance re-checks table/column
// existence on every invocation even though nothing about the schema can
// have changed since the last request it served. A module-level cache
// fixes this: the migration runs once per warm container, and every
// request after that just awaits the same already-resolved promise. If it
// ever fails, the cache is cleared so the next request retries instead of
// permanently wedging this instance in a "schema never ran" state.
let schemaReady = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = runMigrations().catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function runMigrations() {
  // Fast path: on a warm-ish DB (schema already fully migrated), skip the
  // ~25 sequential CREATE/ALTER round trips below entirely. This matters a
  // lot on cold starts — those statements run one at a time, awaited in
  // series, and combined with an autosuspended serverless Postgres waking
  // up, the total latency can exceed the function's timeout, which surfaces
  // to users as a generic "Network error" (the client's fetch never gets a
  // valid JSON response back). We check for the last table/column created
  // by the migration below; if it's there, everything before it is too.
  const check = await sql`SELECT to_regclass('public.support_messages') AS t`;
  if (check.rows[0]?.t) return;

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

  // Ledger of every credit deduction. This is what makes refunds trustworthy:
  // a refund request has to point at a real row here, so there's no way to
  // manufacture a refund out of thin air by just sending a number to the API.
  await sql`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,           -- currently only 'deduct'; room to grow
      amount INTEGER NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions (user_id, created_at)`;

  // Admin-approve-only refund system. A user can only *request* a refund,
  // referencing a specific credit_transactions row; crediting the account
  // only ever happens when an admin approves that request (see api/admin.js).
  // This replaces the old self-service /api/use-credits refund action, which
  // trusted a client-sent amount with no link to a real charge at all.
  await sql`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      transaction_id INTEGER REFERENCES credit_transactions(id) ON DELETE SET NULL,
      amount INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
      admin_id INTEGER REFERENCES users(id),
      admin_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests (status, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_refund_requests_transaction ON refund_requests (transaction_id)`;

  // ── Support tickets ─────────────────────────────────────────────────────
  // A ticket is a conversation thread between one customer and the admin
  // team. unread_by_admin / unread_by_user are simple booleans (not a full
  // read-receipt system) — they exist purely to drive the badge counts and
  // notification sound in the two dashboards, and get flipped every time a
  // new message lands or a side opens the thread.
  await sql`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
      is_test BOOLEAN DEFAULT FALSE,
      unread_by_admin BOOLEAN DEFAULT TRUE,
      unread_by_user BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_message_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE`;
  await sql`
    CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,   -- 'user' | 'admin'
      sender_id INTEGER,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, last_message_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id, last_message_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages (ticket_id, created_at)`;
}

module.exports = { sql, ensureSchema };
