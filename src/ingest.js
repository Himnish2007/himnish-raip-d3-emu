'use strict';

const express = require('express');
const config = require('./config');

// ---------------------------------------------------------------------------
// Himnish-controlled ingestion API. One LTE module / RUT200 per motor coach
// POSTs its coach's readings here, authenticated with X-API-Key (RAIP family).
// Accepts a single reading or a coach batch (recommended).
// ---------------------------------------------------------------------------

function ingestRouter(store) {
  const router = express.Router();

  const apiKeyGate = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== config.DATA_API_KEY) return res.status(401).json({ ok: false, error: 'Invalid API key' });
    next();
  };

  // A field RUT pulls its own config from here (self-update). Auth with the
  // shared bootstrap key so the ingest key can be rotated centrally later.
  router.get('/device-config', (req, res) => {
    const key = req.headers['x-bootstrap-key'] || req.query.key;
    if (key !== config.BOOTSTRAP_KEY) return res.status(401).json({ ok: false, error: 'Invalid bootstrap key' });
    const deviceId = req.query.device || req.headers['x-device-id'];
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device id required' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const cfg = store.deviceConfig(deviceId, ip);
    if (!cfg) return res.status(404).json({ ok: false, error: 'Device not registered — add it in Admin → Field Devices', device_id: deviceId });
    res.json(cfg);
  });

  function validateReading(r, ctx) {
    if (!r || typeof r !== 'object') return 'reading must be an object';
    if (!r.sensor_id) return 'sensor_id required';
    if (!(r.coach_id || ctx.coach_id)) return `coach_id required (sensor ${r.sensor_id})`;
    const t = Number(r.temperature);
    if (r.temperature == null || !Number.isFinite(t)) return `temperature must be numeric (sensor ${r.sensor_id})`;
    // Reject clearly faulty readings (disconnected/short RTD). Tender range 0–120 °C;
    // a generous window is allowed, anything outside is treated as a sensor fault.
    if (t < -40 || t > 250) return `temperature out of range: ${t} (sensor ${r.sensor_id})`;
    return null;
  }

  router.post('/ingest', apiKeyGate, (req, res) => {
    const body = req.body || {};
    const ctx = { coach_id: body.coach_id, emu_id: body.emu_id };
    let readings;
    if (Array.isArray(body.readings)) readings = body.readings;
    else if (body.sensor_id) readings = [body];
    else return res.status(400).json({ ok: false, error: 'Send a single reading or a readings[] batch' });

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
