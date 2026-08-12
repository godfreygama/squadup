// Lightweight event analytics.
// If DATABASE_URL is set (e.g. a free Supabase/Neon Postgres instance), events are
// written to a Postgres table so you can query real usage data after deploying.
// If it's not set, events are just logged to the console — the app works either way.

let pool = null;
let ready = false;

function init() {
  if (!process.env.DATABASE_URL) {
    console.log("[analytics] No DATABASE_URL set — logging events to console only. See README for how to add a free Postgres database.");
    return;
  }
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        room_code TEXT,
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_events_room_code ON events (room_code);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);
    `).then(() => {
      ready = true;
      console.log("[analytics] Connected to Postgres. Events will be recorded.");
    }).catch(err => {
      console.error("[analytics] Failed to set up events table:", err.message);
    });
  } catch (err) {
    console.error("[analytics] 'pg' package not available:", err.message);
  }
}

function track(eventType, roomCode, payload) {
  payload = payload || {};
  if (!pool || !ready) {
    console.log(`[analytics] ${eventType}`, roomCode || "-", JSON.stringify(payload));
    return;
  }
  pool.query(
    "INSERT INTO events (event_type, room_code, payload) VALUES ($1, $2, $3)",
    [eventType, roomCode || null, payload]
  ).catch(err => console.error("[analytics] insert failed:", err.message));
}

init();

module.exports = { track };
