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
    await q(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated timestamptz DEFAULT now())`);
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
       WHERE sensor_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC LIMIT $4`,
      [sensorId, fromIso, toIso, cap || 20000]);
    return res.rows;
  }

  // All readings for one coach in a date range (for historical reports).
  async function historyForCoach(coachId, fromIso, toIso, cap) {
    const res = await q(
      `SELECT sensor_id, tm_id, ts, temperature FROM readings
       WHERE coach_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC LIMIT $4`,
      [coachId, fromIso, toIso, cap || 50000]);
    return res.rows;
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
    _setClient: (c) => { client = c; } };
}

module.exports = { createDb };
