'use strict';

const express = require('express');
const config = require('./config');

// ---------------------------------------------------------------------------
// Himnish-controlled ingestion API. One LTE module / RUT200 per motor coach
// POSTs its coach's readings here, authenticated with X-API-Key (RAIP family).
// Accepts a single reading or a coach batch (recommended).
// ---------------------------------------------------------------------------

// Ids must be plain identifiers (no markup / control chars) so device-supplied text can never
// become script in the dashboard, and batches / auto-provisioning are bounded.
const ID_RE = /^[A-Za-z0-9 ._:@\-]{1,64}$/;
const MAX_BATCH = 500;
const MAX_COACHES = Number(process.env.MAX_COACHES) || 2000;

// ---- exact-duplicate replay guard --------------------------------------------------------------
// A captured request replayed later (same sensor, same ts, same value) is rejected. This does NOT
// touch readings with a different ts, so a RUT catching up on buffered offline data (each reading
// has its own real ts, sent once) is unaffected — only a byte-for-byte resend of something already
// ingested is blocked.
const REPLAY_WINDOW_MS = 20 * 60 * 1000;
const seenReadings = new Map();   // "sensor|ts|temp" -> firstSeenMs
let lastReplayGc = Date.now();
function isReplay(sensorId, ts, temp) {
  if (!ts) return false;   // no timestamp on this reading: nothing to key a replay check on, let it through
  const now = Date.now();
  if (now - lastReplayGc > 3600000) { lastReplayGc = now; for (const [k, t] of seenReadings) if (now - t > REPLAY_WINDOW_MS) seenReadings.delete(k); }
  const key = `${sensorId}|${ts}|${temp}`;
  if (seenReadings.has(key)) return true;
  seenReadings.set(key, now);
  return false;
}

// ---- legacy shared-key usage: log once per coach per hour, not on every push -------------------
const legacyWarnedAt = new Map();
function warnLegacy(coachId) {
  const now = Date.now(), last = legacyWarnedAt.get(coachId || '(unknown)') || 0;
  if (now - last < 3600000) return;
  legacyWarnedAt.set(coachId || '(unknown)', now);
  console.warn(`[ingest] coach ${coachId || '(unknown)'} is still using the shared DATA_API_KEY, not a per-device key — it pulls its own key automatically on its next config refresh (self-update script) once it has been registered in Admin -> Field Devices.`);
}
const legacyBootstrapWarnedAt = new Map();
function warnLegacyBootstrap(deviceId) {
  const now = Date.now(), last = legacyBootstrapWarnedAt.get(deviceId) || 0;
  if (now - last < 3600000) return;
  legacyBootstrapWarnedAt.set(deviceId, now);
  console.warn(`[ingest] device ${deviceId} sent the bootstrap key in the URL (?key=) instead of the X-Bootstrap-Key header — update its script to stop the key appearing in web server logs.`);
}

function ingestRouter(store) {
  const router = express.Router();

  // A request authenticates either with ITS OWN per-device key (preferred: store.deviceByApiKey finds
  // the exact device, and the /ingest handler below then requires every coach_id in the payload to
  // match that device's own registered coach) or with the shared legacy DATA_API_KEY (accepted for
  // devices not yet migrated, unless STRICT_SECURITY=true — see .env.example). A shared-key request
  // is NOT bound to any one coach, since the key alone can't say which device sent it.
  const apiKeyGate = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key) return res.status(401).json({ ok: false, error: 'Invalid API key' });
    const device = store.deviceByApiKey(key);
    if (device) { req.ingestDevice = device; return next(); }
    if (key === config.DATA_API_KEY && !config.STRICT_SECURITY) { req.ingestLegacy = true; return next(); }
    return res.status(401).json({ ok: false, error: 'Invalid API key' });
  };

  // A field RUT pulls its own config from here (self-update). Auth with the
  // shared bootstrap key so the ingest key can be rotated centrally later.
  router.get('/device-config', (req, res) => {
    const key = req.headers['x-bootstrap-key'] || req.query.key;
    if (key !== config.BOOTSTRAP_KEY) return res.status(401).json({ ok: false, error: 'Invalid bootstrap key' });
    const deviceId = req.query.device || req.headers['x-device-id'];
    if (deviceId && !req.headers['x-bootstrap-key'] && req.query.key) warnLegacyBootstrap(deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device id required' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const cfg = store.deviceConfig(deviceId, ip);
    if (!cfg) return res.status(404).json({ ok: false, error: 'Device not registered — add it in Admin → Field Devices', device_id: deviceId });
    res.json(cfg);
  });

  function validateReading(r, ctx) {
    if (!r || typeof r !== 'object') return 'reading must be an object';
    if (!r.sensor_id) return 'sensor_id required';
    for (const k of ['sensor_id', 'coach_id', 'emu_id', 'tm_id']) {
      if (r[k] != null && r[k] !== '' && !ID_RE.test(String(r[k]))) return `invalid ${k} (letters, digits, space . _ : @ - only, max 64)`;
    }
    if (r.coach_id && !store.coaches.has(String(r.coach_id)) && store.coaches.size >= MAX_COACHES) return `coach limit reached (${MAX_COACHES}) - register coaches in Admin`;
    if (!(r.coach_id || ctx.coach_id)) return `coach_id required (sensor ${r.sensor_id})`;
    // Device <-> coach binding: a per-device key may only report readings for the coach that
    // device is registered against in Admin -> Field Devices (prevents a compromised or misused
    // device key from injecting or overwriting readings for a DIFFERENT coach).
    if (ctx.device) {
      const claimedCoach = r.coach_id || ctx.coach_id;
      if (!ctx.device.coach_id) return `device ${ctx.device.device_id} is not yet assigned to a coach (Admin -> Field Devices)`;
      if (claimedCoach && String(claimedCoach) !== String(ctx.device.coach_id)) {
        return `device ${ctx.device.device_id} is registered to coach ${ctx.device.coach_id}, not ${claimedCoach}`;
      }
    }
    const t = Number(r.temperature);
    if (r.temperature == null || !Number.isFinite(t)) return `temperature must be numeric (sensor ${r.sensor_id})`;
    // Reject clearly faulty readings (disconnected/short RTD). Tender range 0–120 °C;
    // a generous window is allowed, anything outside is treated as a sensor fault.
    if (t < -40 || t > 250) return `temperature out of range: ${t} (sensor ${r.sensor_id})`;
    if (r.ts && isReplay(r.sensor_id, r.ts, t)) return `duplicate reading rejected (same sensor, timestamp and value already received — possible replay)`;
    return null;
  }

  router.post('/ingest', apiKeyGate, (req, res) => {
    const body = req.body || {};
    const ctx = { coach_id: body.coach_id, emu_id: body.emu_id, device: req.ingestDevice || null };
    if (req.ingestLegacy) warnLegacy(body.coach_id);
    let readings;
    if (Array.isArray(body.readings)) readings = body.readings;
    else if (body.sensor_id) readings = [body];
    else return res.status(400).json({ ok: false, error: 'Send a single reading or a readings[] batch' });
    if (readings.length > MAX_BATCH) return res.status(413).json({ ok: false, error: `batch too large (max ${MAX_BATCH} readings)` });

    const accepted = [], errors = [];
    for (const raw of readings) {
      const merged = Object.assign({ coach_id: ctx.coach_id, emu_id: ctx.emu_id, position: body.position, sensor_type: 'wireless', ts: body.ts || body.timestamp }, raw);
      const err = validateReading(merged, ctx);
      if (err) { errors.push(err); continue; }
      accepted.push(store.ingestReading(merged).sensor_id);
    }
    const status = errors.length && !accepted.length ? 400 : 200;
    // Optional device/comm telemetry from the LTE module / concentrator.
    if (ctx.coach_id && (body.rssi != null || body.packet_loss != null || body.lte_signal != null ||
        body.network != null || body.data_usage != null || body.ip != null ||
        body.latency != null || body.retry_count != null || body.checksum_failures != null)) {
      store.updateComm(ctx.coach_id, { rssi: body.rssi, packet_loss: body.packet_loss,
        lte_signal: body.lte_signal, network: body.network, data_usage: body.data_usage, ip: body.ip,
        latency: body.latency, retry_count: body.retry_count, checksum_failures: body.checksum_failures });
    }
    return res.status(status).json({ ok: accepted.length > 0, accepted: accepted.length,
      sensor_ids: accepted, errors, server_time: new Date().toISOString() });
  });

  router.get('/ping', apiKeyGate, (req, res) => res.json({ ok: true, server_time: new Date().toISOString() }));
  return router;
}

module.exports = { ingestRouter };
