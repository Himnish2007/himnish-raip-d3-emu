'use strict';

// DEMO_MODE: seeds demo users (with scoped asset assignments to show per-user
// visibility) and generates synthetic readings so the dashboard is populated
// without live hardware.

function seedDemoUsers(store) {
  const demo = [
    { username: 'hq', password: 'hq@2025', role: 'railway_hq' },
    { username: 'depot', password: 'depot@2025', role: 'depot_admin', depot_id: 'DEP-MMCT' },
    { username: 'engineer', password: 'eng@2025', role: 'maintenance_eng', depot_id: 'DEP-MMCT' },
    { username: 'viewer', password: 'view@2025', role: 'observer' },
  ];
  demo.forEach((u) => { if (!store.getUser(u.username)) store.seedUser(u); });
}

function startDemo(store) {
  const emuCount = Number(process.env.DEMO_EMUS || 2);
  store.upsertEmu({ emu_id: 'EMU-01', name: 'EMU-01', depot_id: 'DEP-MMCT' });

  const sensors = [];
  let coachSeq = 101;
  for (let e = 1; e <= emuCount; e++) {
    const emu_id = `EMU-${String(e).padStart(2, '0')}`;
    store.upsertEmu({ emu_id, name: emu_id, depot_id: 'DEP-MMCT' });
    for (let pos = 1; pos <= 4; pos++) {
      const coach_id = `MC-${coachSeq++}`;
      store.upsertCoach({ coach_id, name: coach_id,
        concentrator_id: `DC-${coach_id}`,
        lte_imei: '8649' + String(100000000 + Math.floor(Math.random() * 800000000)),
        lte_sim: '8991' + String(10000000000 + Math.floor(Math.random() * 8000000000)),
        lte_ip: `10.${e}.${pos}.${10 + Math.floor(Math.random() * 200)}` });
      store.assignCoach({ coach_id, emu_id, position: pos, user: 'demo-seed', reason: 'initial' });
      for (let tm = 1; tm <= 4; tm++) {
        sensors.push({ sensor_id: `${coach_id}-TM${tm}`, tm_id: `TM${tm}`, coach_id,
          base: 48 + Math.random() * 12, drift: 0, hot: Math.random() < 0.06, battery: 90 + Math.random() * 10,
          ramp: (e === 1 && pos === 1 && tm === 1) ? 0 : undefined });
      }
    }
  }

  // Demonstrate scoping: engineer assigned only EMU-02; viewer assigned one coach.
  seedDemoUsers(store);
  if (emuCount >= 2) store.setUserAssets('engineer', { emus: ['EMU-02'], coaches: [] }, 'demo-seed');
  store.setUserAssets('viewer', { emus: [], coaches: ['MC-101'] }, 'demo-seed');

  function tick() {
    for (const s of sensors) {
      s.drift += (Math.random() - 0.48) * 1.2;
      s.drift = Math.max(-4, Math.min(6, s.drift));
      let temp = s.base + s.drift;
      if (s.hot) temp += 30 + Math.random() * 12;
      // one sensor ramps up steadily then resets — demonstrates predictive warning
      if (s.ramp !== undefined) { s.ramp += 1.5 + Math.random(); if (s.ramp > 55) s.ramp = 0; temp = 52 + s.ramp; }
      s.battery = Math.max(8, s.battery - Math.random() * 0.02);
      store.ingestReading({ sensor_id: s.sensor_id, tm_id: s.tm_id, coach_id: s.coach_id,
        temperature: +temp.toFixed(1), battery_health: +s.battery.toFixed(0),
        signal_strength: 60 + Math.round(Math.random() * 40), sensor_type: 'wireless' });
    }
    // device/comm telemetry per coach
    for (const c of store.coaches.values()) {
      store.updateComm(c.coach_id, {
        rssi: -(60 + Math.floor(Math.random() * 30)),
        packet_loss: +(Math.random() * 2).toFixed(1),
        latency: 40 + Math.floor(Math.random() * 120),
        retry_count: Math.floor(Math.random() * 3),
        checksum_failures: Math.floor(Math.random() * 2),
        lte_signal: 65 + Math.floor(Math.random() * 35),
        network: '4G LTE',
        data_usage: (10 + Math.random() * 40).toFixed(1) + ' MB',
      });
    }
  }
  tick();
  const interval = setInterval(tick, 5000);
  console.log(`[DEMO_MODE] ${sensors.length} sensors across ${emuCount} EMU(s); scoped demo users seeded`);
  return () => clearInterval(interval);
}

module.exports = { startDemo };
