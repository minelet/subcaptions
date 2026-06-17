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
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_bought INTEGER DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_expires_at TIMESTAMPTZ`;
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
}

module.exports = { sql, ensureSchema };
