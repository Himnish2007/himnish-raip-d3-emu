'use strict';

// ---------------------------------------------------------------------------
// Optional PostgreSQL / TimescaleDB persistence.
//
// Activated only when DATABASE_URL is set. Provides:
//   - permanent time-series storage of every reading (survives restarts)
//   - long-range history queries (30-day / multi-year trends)
//   - a master-data state blob (so users/coaches/thresholds survive even
//     without a mounted volume)
//
// Design rules:
//   - The app's real-time path stays IN-MEMORY (correct for a live dashboard).
//     Postgres is a durable archive written alongside, never in the hot path.
//   - Every DB call is wrapped so a database hiccup NEVER crashes the app —
//     it logs and the app keeps running on memory + JSON.
//   - TimescaleDB is used if the extension is available; otherwise a plain
//     indexed table is used. Same code runs on either.
//
// Testable with PGlite (in-process Postgres) by injecting a client; production
// uses node-postgres (pg) Pool via DATABASE_URL.
// ---------------------------------------------------------------------------

function createDb(databaseUrl, injectedClient) {
  let client = injectedClient || null;

  async function connect() {
    if (client) return;
    const { Pool } = require('pg');
    const ssl = process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined;
    client = new Pool({ connectionString: databaseUrl, ssl, max: 5 });
  }

  async function q(text, params) { return client.query(text, params); }

  async function init() {
    await connect();
    await q(`CREATE TABLE IF NOT EXISTS readings (
      id bigserial,
      sensor_id text NOT NULL,
      coach_id text, emu_id text, tm_id text,
      temperature double precision, battery integer, signal integer,
      ts timestamptz NOT NULL DEFAULT now()
    )`);
    await q(`CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts ON readings (sensor_id, ts DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts DESC)`);
    // coach-level history (Reports -> Coach History, Admin coach detail) filters by coach_id; without
    // this index those queries fell back to scanning every row and filtering, which gets slow as the
    // readings table grows into the hundreds of millions of rows at full fleet scale.
    await q(`CREATE INDEX IF NOT EXISTS idx_readings_coach_ts ON readings (coach_id, ts DESC)`);
    await q(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated timestamptz DEFAULT now())`);
    // Append-only, SQL-queryable alert history (separate from the current-state JSON in app_state,
    // which only holds the latest snapshot). One row per state transition, kept forever.
    await q(`CREATE TABLE IF NOT EXISTS alert_events (
      id bigserial PRIMARY KEY,
      alert_id integer NOT NULL,
      event text NOT NULL,
      severity text, sensor_id text, coach_id text, emu_id text, tm_id text,
      message text, actor text, detail text,
      at timestamptz NOT NULL DEFAULT now()
    )`);
    await q(`CREATE INDEX IF NOT EXISTS idx_alert_events_coach_at ON alert_events (coach_id, at DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_alert_events_alert_id ON alert_events (alert_id)`);
    // Optional TimescaleDB hypertable — ignored gracefully if unavailable.
    let hyper = false;
    try {
      await q(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
      await q(`SELECT create_hypertable('readings','ts', if_not_exists => TRUE, migrate_data => TRUE)`);
      hyper = true;
    } catch (e) { /* plain table + index is fine */ }
    console.log(`[db] connected. TimescaleDB hypertable: ${hyper ? 'yes' : 'no (plain table)'}`);
    return { hyper };
  }

  async function insertReading(r) {
    await q(
      `INSERT INTO readings (sensor_id,coach_id,emu_id,tm_id,temperature,battery,signal,ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.sensor_id, r.coach_id || null, r.emu_id || null, r.tm_id || null,
        r.temperature == null ? null : r.temperature,
        r.battery_health == null ? null : Math.round(r.battery_health),
        r.signal_strength == null ? null : Math.round(r.signal_strength),
        r.last_update || new Date().toISOString()]
    );
  }

  // One row per alert state transition (raised/resolved/acknowledged/closed) — an append-only,
  // SQL-queryable history, kept separate from the mutable current-state snapshot in app_state.
  async function logAlertEvent(e) {
    await q(
      `INSERT INTO alert_events (alert_id,event,severity,sensor_id,coach_id,emu_id,tm_id,message,actor,detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.alert_id, e.event, e.severity || null, e.sensor_id || null, e.coach_id || null, e.emu_id || null,
        e.tm_id || null, e.message || null, e.actor || null, e.detail || null]
    );
  }
  async function alertHistoryForCoach(coachId, fromIso, toIso, cap) {
    const res = await q(
      `SELECT * FROM alert_events WHERE coach_id = $1 AND at BETWEEN $2 AND $3 ORDER BY at DESC, id DESC LIMIT $4`,
      [coachId, fromIso, toIso, cap || 1000]);
    return res.rows;
  }

  // Last reading per sensor — to repopulate live view after a restart.
  async function latestPerSensor() {
    const res = await q(
      `SELECT DISTINCT ON (sensor_id) sensor_id,coach_id,emu_id,tm_id,temperature,battery,signal,ts
       FROM readings ORDER BY sensor_id, ts DESC`);
    return res.rows;
  }

  // Recent samples (for in-memory trend backfill).
  async function recentSeries(sinceIso, cap) {
    const res = await q(
      `SELECT sensor_id, ts, temperature FROM readings WHERE ts >= $1 ORDER BY ts ASC LIMIT $2`,
      [sinceIso, cap || 200000]);
    return res.rows;
  }

  // Long-range history for one sensor (downsampled in JS by the caller).
  async function historyRange(sensorId, fromIso, toIso, cap) {
    const res = await q(
      `SELECT ts, temperature FROM readings
       WHERE sensor_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts DESC LIMIT $4`,
      [sensorId, fromIso, toIso, cap || 20000]);
    // newest-first + reverse: if the cap is hit, the OLDEST rows are dropped, never the latest ones
    return res.rows.reverse();
  }

  // All readings for one coach in a date range (for historical reports).
  async function historyForCoach(coachId, fromIso, toIso, cap) {
    const res = await q(
      `SELECT sensor_id, tm_id, ts, temperature FROM readings
       WHERE coach_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts DESC LIMIT $4`,
      [coachId, fromIso, toIso, cap || 50000]);
    return res.rows.reverse();
  }

  // Retention: delete readings older than N days. Returns rows removed.
  async function purgeOld(days) {
    const res = await q(`DELETE FROM readings WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]);
    return res.rowCount || 0;
  }

  async function saveState(snapshot) {
    await q(
      `INSERT INTO app_state (id,data,updated) VALUES (1,$1,now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated = now()`,
      [JSON.stringify(snapshot)]);
  }
  async function loadState() {
    const res = await q(`SELECT data FROM app_state WHERE id = 1`);
    if (!res.rows.length) return null;
    const d = res.rows[0].data;
    return typeof d === 'string' ? JSON.parse(d) : d;
  }

  return { init, insertReading, latestPerSensor, recentSeries, historyRange, historyForCoach, purgeOld, saveState, loadState,
    logAlertEvent, alertHistoryForCoach,
    _setClient: (c) => { client = c; } };
}

module.exports = { createDb };
