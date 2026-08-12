'use strict';

const config = require('./config');

// ---------------------------------------------------------------------------
// RUT200 pull poller.
//
// For every coach that has poll_enabled = true and a rut200_ip configured, the
// server periodically GETs the RUT200's local data endpoint and ingests the
// readings. This is the "data through RUT200 via IP address" path, an
// alternative to the RUT200 pushing to /api/v1/ingest.
//
// Expected RUT200 JSON response (any of these shapes):
//   { "readings": [ { "sensor_id": "...", "tm_id": "TM1", "temperature": 58.4,
//                      "battery_health": 96, "signal_strength": 82 }, ... ] }
//   or a bare array of the same reading objects.
//
// NETWORKING NOTE: the server must be able to reach rut200_ip. On a cloud host
// (Railway) that means a public/static IP, DDNS or VPN/tunnel to the router.
// On an on-prem/LAN server the private 192.168.x.x address works directly.
// ---------------------------------------------------------------------------

function startPoller(store) {
  let stopped = false;
  let timer = null;

  async function pollCoach(c) {
    const url = `http://${c.rut200_ip}:${c.rut200_port || 80}${c.rut200_path || '/readings'}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const readings = Array.isArray(data) ? data : (data.readings || []);
      let n = 0;
      for (const r of readings) {
        if (!r.sensor_id || r.temperature == null) continue;
        store.ingestReading(Object.assign({ coach_id: c.coach_id, sensor_type: 'wireless' }, r));
        n++;
      }
      if (n) console.log(`[poller] ${c.coach_id} @ ${c.rut200_ip}: ${n} readings`);
    } catch (e) {
      console.warn(`[poller] ${c.coach_id} @ ${c.rut200_ip} failed: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  function currentIntervalSec() {
    const th = store.getThresholds ? store.getThresholds() : null;
    const v = th && th.CFG_LOG_INTERVAL;
    return (Number.isFinite(v) && v > 0) ? v : config.CFG_LOG_INTERVAL;
  }

  async function tick() {
    if (stopped) return;
    const interval = currentIntervalSec();
    if (interval > 0) {
      const coaches = store.pollableCoaches();
      for (const c of coaches) await pollCoach(c);
    }
    if (!stopped) timer = setTimeout(tick, Math.max(5, interval) * 1000);
  }

  const first = currentIntervalSec();
  if (!first) { console.log('[poller] disabled (Log interval = 0)'); return () => {}; }
  console.log(`[poller] polling RUT200-configured coaches every ${first}s (Admin → Thresholds → Log interval — changes apply live, no restart needed)`);
  timer = setTimeout(tick, first * 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = { startPoller };
