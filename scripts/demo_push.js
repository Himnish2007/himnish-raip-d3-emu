'use strict';

// End-to-end test: simulate one LTE module pushing a coach batch over HTTP
// to the running server. Usage:
//   BASE=http://localhost:8080 KEY=himnish_emu_key_2025 node scripts/demo_push.js

const BASE = process.env.BASE || 'http://localhost:8080';
const KEY = process.env.KEY || 'himnish_emu_key_2025';
const COACH = process.env.COACH || 'MC-201';
const EMU = process.env.EMU || 'EMU-02';

async function pushOnce() {
  const readings = [1, 2, 3, 4].map((n) => ({
    sensor_id: `${COACH}-TM${n}`,
    tm_id: `TM${n}`,
    temperature: +(50 + Math.random() * 45).toFixed(1), // some will breach thresholds
    battery_health: 90 + Math.round(Math.random() * 10),
    signal_strength: 70 + Math.round(Math.random() * 30),
  }));
  const res = await fetch(`${BASE}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify({ coach_id: COACH, emu_id: EMU, position: 1, readings }),
  });
  console.log(res.status, await res.json());
}

pushOnce().catch((e) => { console.error(e); process.exit(1); });
