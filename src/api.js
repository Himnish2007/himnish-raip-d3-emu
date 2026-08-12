'use strict';

const express = require('express');
const config = require('./config');
const { requireAuth, requireRole } = require('./auth');
const reports = require('./reports');

function apiRouter(store, notifier) {
  const router = express.Router();
  router.use(requireAuth);

  const ADMIN = config.ADMIN_ROLES;            // super_admin
  const GLOBAL = config.GLOBAL_ROLES;          // super_admin, railway_hq
  const admin = requireRole(...ADMIN);

  // sensors the requesting user is allowed to see (by coach scope)
  function scopedSensors(user) {
    const scope = store.scopeFor(user);
    const all = store.allSensors();
    if (scope.all) return all;
    return all.filter((s) => s.coach_id && scope.coaches.has(s.coach_id));
  }

  // ---- Overview KPIs (scoped) -------------------------------------------
  router.get('/overview', (req, res) => {
    const sensors = scopedSensors(req.user);
    const emuIds = new Set(), coachIds = new Set();
    let online = 0, offline = 0, normal = 0, warning = 0, high = 0, critical = 0, tempSum = 0, tempN = 0;
    for (const s of sensors) {
      if (s.emu_id) emuIds.add(s.emu_id);
      if (s.coach_id) coachIds.add(s.coach_id);
      if (s.status === 'online') online++; else offline++;
      const cls = store.classify(s.status === 'offline' ? null : s.temperature);
      if (cls === 'normal') normal++; else if (cls === 'warning') warning++;
      else if (cls === 'high') high++; else if (cls === 'critical') critical++;
      if (s.temperature != null && s.status === 'online') { tempSum += s.temperature; tempN++; }
    }
    const today = new Date().toISOString().slice(0, 10);
    const scope = store.scopeFor(req.user);
    const visible = (a) => scope.all || (a.coach_id && scope.coaches.has(a.coach_id));
    const alerts = store.alerts.filter(visible);
    const t = store.getThresholds();
    res.json({
      total_emus: emuIds.size, total_coaches: coachIds.size, total_tms: sensors.length, total_sensors: sensors.length,
      online_sensors: online, offline_sensors: offline, healthy_tms: normal, warning_tms: warning + high, critical_tms: critical,
      active_alerts: alerts.filter((a) => a.state === 'active').length,
      acknowledged_alerts: alerts.filter((a) => a.state === 'acknowledged').length,
      todays_alerts: alerts.filter((a) => a.at.slice(0, 10) === today).length,
      avg_fleet_temp: tempN ? +(tempSum / tempN).toFixed(1) : null,
      thresholds: { warn: t.CFG_WARN_TEMP, high: t.CFG_HIGH_TEMP, crit: t.CFG_CRIT_TEMP,
        offline_seconds: t.CFG_OFFLINE_SECONDS, low_battery: t.CFG_LOW_BATTERY },
    });
  });

  // ---- Live EMU tree (scoped) -------------------------------------------
  router.get('/emus', (req, res) => {
    const sensors = scopedSensors(req.user);
    const emus = new Map();
    const ensureEmu = (emu_id) => {
      if (!emus.has(emu_id)) {
        const meta = store.emus.get(emu_id) || {};
        emus.set(emu_id, { emu_id, name: meta.name || emu_id, depot_id: meta.depot_id || null, coaches: new Map() });
      }
      return emus.get(emu_id);
    };
    // 1) Coaches that are actively reporting (live sensors).
    for (const s of sensors) {
      if (!s.emu_id) continue;
      const emu = ensureEmu(s.emu_id);
      if (!emu.coaches.has(s.coach_id)) {
        const a = store.assignment.get(s.coach_id) || {};
        emu.coaches.set(s.coach_id, { coach_id: s.coach_id, position: a.position || null, since: a.since || null, tms: [] });
      }
      emu.coaches.get(s.coach_id).tms.push({
        sensor_id: s.sensor_id, tm_id: s.tm_id, temperature: s.temperature, status: s.status,
        classification: store.classify(s.status === 'offline' ? null : s.temperature),
        battery_health: s.battery_health, signal_strength: s.signal_strength, last_update: s.last_update,
      });
    }
    // 2) Configured coaches that are NOT reporting — shown as OFFLINE so an
    //    operator can see which coaches have a problem (not just the healthy ones).
    for (const [coach_id, asg] of store.assignment) {
      if (!asg || !asg.emu_id) continue;
      if (!store.canSeeCoach(req.user, coach_id)) continue;
      const emu = ensureEmu(asg.emu_id);
      if (emu.coaches.has(coach_id)) continue;
      const tms = [1, 2, 3, 4].map((n) => ({
        sensor_id: `${coach_id}-TM${n}`, tm_id: `TM${n}`, temperature: null, status: 'offline',
        classification: 'offline', battery_health: null, signal_strength: null, last_update: null,
      }));
      emu.coaches.set(coach_id, { coach_id, position: asg.position || null, since: asg.since || null, tms });
    }
    res.json([...emus.values()].map((e) => ({ ...e,
      coaches: [...e.coaches.values()].sort((a, b) => (a.position || 99) - (b.position || 99))
        .map((c) => ({ ...c, tms: c.tms.sort((x, y) => String(x.tm_id).localeCompare(String(y.tm_id))) })),
    })).sort((a, b) => a.emu_id.localeCompare(b.emu_id)));
  });

  // ---- Alerts (scoped) ---------------------------------------------------
  router.get('/alerts', (req, res) => {
    const scope = store.scopeFor(req.user);
    let list = store.alerts.filter((a) => scope.all || (a.coach_id && scope.coaches.has(a.coach_id)));
    if (req.query.state) list = list.filter((a) => a.state === req.query.state);
    res.json(list.slice(0, 200));
  });
  router.post('/alerts/:id/ack', requireRole('super_admin', 'railway_hq', 'depot_admin', 'maintenance_eng'), (req, res) => {
    const al = store.alerts.find((x) => x.id === Number(req.params.id));
    if (!al) return res.status(404).json({ error: 'Alert not found' });
    if (!store.canSeeCoach(req.user, al.coach_id)) return res.status(403).json({ error: 'Not in your assigned scope' });
    res.json(store.acknowledgeAlert(req.params.id, req.user.sub));
  });

  // ---- Series (scoped) ---------------------------------------------------
  router.get('/series/:sensorId', (req, res) => {
    const s = store.sensors.get(req.params.sensorId);
    if (s && !store.canSeeCoach(req.user, s.coach_id)) return res.status(403).json({ error: 'Not in your assigned scope' });
    res.json(store.seriesFor(req.params.sensorId));
  });

  // ---- Long-range history (from PostgreSQL archive when available) -------
  router.get('/history/:sensorId', async (req, res) => {
    const s = store.sensors.get(req.params.sensorId);
    if (s && !store.canSeeCoach(req.user, s.coach_id)) return res.status(403).json({ error: 'Not in your assigned scope' });
    const hours = Math.min(Number(req.query.hours) || 24, 24 * 400);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    if (store.db) {
      try {
        const rows = await store.db.historyRange(req.params.sensorId, from.toISOString(), to.toISOString(), 20000);
        // downsample to ~1000 points for the chart
        const step = Math.ceil(rows.length / 1000) || 1;
        const out = rows.filter((_, i) => i % step === 0).map((r) => ({ t: new Date(r.ts).toISOString(), temperature: r.temperature == null ? null : Number(r.temperature) }));
        return res.json({ source: 'postgres', hours, points: out });
      } catch (e) { /* fall through to memory */ }
    }
    // Fallback: in-memory series (recent only)
    res.json({ source: 'memory', hours, points: store.seriesFor(req.params.sensorId) });
  });

  // ---- Coaches list + swap (scoped) -------------------------------------
  router.get('/coaches', (req, res) => {
    const scope = store.scopeFor(req.user);
    const out = [...store.coaches.values()]
      .filter((c) => scope.all || scope.coaches.has(c.coach_id))
      .map((c) => { const a = store.assignment.get(c.coach_id) || {};
        return { coach_id: c.coach_id, name: c.name, emu_id: a.emu_id || null, position: a.position || null, since: a.since || null }; });
    res.json(out);
  });
  router.post('/coaches/:coachId/assign', requireRole('super_admin', 'depot_admin', 'maintenance_eng'), (req, res) => {
    const { emu_id, position, reason } = req.body || {};
    if (!emu_id) return res.status(400).json({ error: 'emu_id required' });
    if (!store.canSeeCoach(req.user, req.params.coachId)) return res.status(403).json({ error: 'Not in your assigned scope' });
    res.json({ ok: true, assignment: store.assignCoach({ coach_id: req.params.coachId, emu_id, position, user: req.user.sub, reason }) });
  });
  router.get('/coaches/:coachId/history', (req, res) => {
    if (!store.canSeeCoach(req.user, req.params.coachId)) return res.status(403).json({ error: 'Not in your assigned scope' });
    res.json(store.coachHistory(req.params.coachId));
  });

  // ---- Thresholds (admin edits, everyone reads) -------------------------
  router.get('/thresholds', (req, res) => res.json(store.getThresholds()));
  router.put('/thresholds', requireRole(...ADMIN), (req, res) => res.json(store.setThresholds(req.body || {}, req.user.sub)));

  // ---- Scoped CSV export (every user, only their assigned coaches) ------
  router.get('/export/readings.csv', (req, res) => {
    const sensors = scopedSensors(req.user);
    const rows = [['sensor_id', 'tm_id', 'coach_id', 'emu_id', 'temperature_C', 'classification',
      'battery_pct', 'signal_pct', 'status', 'last_update']];
    for (const s of sensors) rows.push([s.sensor_id, s.tm_id || '', s.coach_id || '', s.emu_id || '',
      s.temperature == null ? '' : s.temperature, store.classify(s.status === 'offline' ? null : s.temperature),
      s.battery_health == null ? '' : s.battery_health, s.signal_strength == null ? '' : s.signal_strength, s.status, s.last_update]);
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    store.logAudit({ user: req.user.sub, action: 'export_csv', detail: `${sensors.length} sensors` });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="raip_d3_readings.csv"');
    res.send(csv);
  });

  const toCsv = (rows) => rows.map((r) => r.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  router.get('/export/maintenance.csv', (req, res) => {
    const list = store.listMaintenance(store.scopeFor(req.user));
    const rows = [['id', 'type', 'coach_id', 'title', 'status', 'assigned_to', 'created_by', 'created_at', 'closed_at', 'notes']];
    list.forEach((m) => rows.push([m.id, m.type, m.coach_id, m.title, m.status, m.assigned_to || '', m.created_by || '', m.created_at, m.closed_at || '', m.notes || '']));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="maintenance.csv"');
    res.send(toCsv(rows));
  });
  router.get('/export/audit.csv', requireRole(...GLOBAL), (req, res) => {
    const rows = [['time', 'user', 'action', 'detail']];
    store.audit.slice(0, 5000).forEach((a) => rows.push([a.at, a.user, a.action, a.detail || '']));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.send(toCsv(rows));
  });

  // ---- Depot management --------------------------------------------------
  router.get('/depots', (req, res) => res.json(store.listDepots()));
  router.post('/depots', admin, (req, res) => { try { res.json(store.upsertDepot(req.body || {}, req.user.sub)); } catch (e) { res.status(400).json({ error: e.message }); } });
  router.put('/depots/:id', admin, (req, res) => { try { res.json(store.upsertDepot({ ...req.body, depot_id: req.params.id }, req.user.sub)); } catch (e) { res.status(400).json({ error: e.message }); } });
  router.delete('/depots/:id', admin, (req, res) => { try { store.deleteDepot(req.params.id, req.user.sub); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

  // ---- Field device registry (self-updating RUT config), admin ----------
  router.get('/devices-registry', requireRole(...GLOBAL), (req, res) => res.json(store.listDevices()));
  router.post('/devices-registry', admin, (req, res) => { try { res.json(store.upsertDevice(req.body || {}, req.user.sub)); } catch (e) { res.status(400).json({ error: e.message }); } });
  router.put('/devices-registry/:id', admin, (req, res) => { try { res.json(store.upsertDevice({ ...req.body, device_id: req.params.id }, req.user.sub)); } catch (e) { res.status(400).json({ error: e.message }); } });
  router.delete('/devices-registry/:id', admin, (req, res) => { try { store.deleteDevice(req.params.id, req.user.sub); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

  // ---- System status / diagnostics --------------------------------------
  router.get('/system-status', requireRole(...GLOBAL), (req, res) => res.json(store.systemStatus()));

  // ---- Master-data backup / restore (super admin) -----------------------
  router.get('/backup', admin, (req, res) => {
    store.logAudit({ user: req.user.sub, action: 'download_backup', detail: '' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="raip_backup_${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(store.exportBackup(), null, 2));
  });
  router.post('/restore', admin, (req, res) => {
    try { res.json({ ok: true, restored: store.importBackup(req.body || {}, req.user.sub) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- Bulk coach import -------------------------------------------------
  router.post('/coaches/bulk', admin, (req, res) => {
    try { res.json(store.bulkCreateCoaches((req.body || {}).coaches || [], req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Full master data view
  router.get('/assets', requireRole(...GLOBAL), (req, res) => {
    res.json({
      emus: [...store.emus.values()],
      coaches: [...store.coaches.values()].map((c) => { const a = store.assignment.get(c.coach_id) || {};
        return { ...c, emu_id: a.emu_id || null, position: a.position || null }; }),
      sensors: store.allSensors().map((s) => ({ sensor_id: s.sensor_id, tm_id: s.tm_id, coach_id: s.coach_id,
        emu_id: s.emu_id, sensor_type: s.sensor_type, status: s.status, temperature: s.temperature,
        battery_health: s.battery_health, signal_strength: s.signal_strength, last_update: s.last_update })),
    });
  });

  // Users
  router.get('/users', requireRole(...GLOBAL), (req, res) => res.json(store.listUsers()));
  router.post('/users', admin, (req, res) => { try { res.json(store.createUser(req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.put('/users/:username', admin, (req, res) => { try { res.json(store.updateUser(req.params.username, req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.delete('/users/:username', admin, (req, res) => { try { store.deleteUser(req.params.username, req.user.sub); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.put('/users/:username/assets', admin, (req, res) => { try { res.json(store.setUserAssets(req.params.username, req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });

  // EMUs
  router.post('/emus', admin, (req, res) => { try { res.json(store.createEmu(req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.put('/emus/:id', admin, (req, res) => { try { res.json(store.updateEmu(req.params.id, req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.delete('/emus/:id', admin, (req, res) => { try { store.deleteEmu(req.params.id, req.user.sub); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); } });

  // Coaches
  router.post('/coach', admin, (req, res) => { try { res.json(store.createCoach(req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.put('/coach/:id', admin, (req, res) => { try { res.json(store.updateCoach(req.params.id, req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); } });
  router.delete('/coach/:id', admin, (req, res) => { try { store.deleteCoach(req.params.id, req.user.sub); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); } });

  router.get('/audit', requireRole(...GLOBAL), (req, res) => res.json(store.audit.slice(0, 200)));

  // ---- Sensor registry (serial / calibration / firmware / warranty) -----
  router.get('/sensor-registry', requireRole(...GLOBAL), (req, res) => res.json(store.listSensorRegistry()));
  router.put('/sensor-registry/:id', admin, (req, res) => {
    try { res.json(store.setSensorRegistry(req.params.id, req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- Send the daily report now (test) ---------------------------------
  router.post('/report-email/test', admin, async (req, res) => {
    const cfg = store.getAlertConfig().report || {};
    if (!cfg.emails || !cfg.emails.length) return res.status(400).json({ error: 'No report recipients configured' });
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ sub: 'report-link', role: 'railway_hq' }, config.JWT_SECRET, { expiresIn: '3d' });
    const n = await notifier.sendReportEmail(cfg.base_url || config.REPORT_BASE_URL || '', token, cfg.emails, store);
    res.json({ ok: true, sent: n });
  });

  // ---- Notification / alert routing config ------------------------------
  router.get('/alert-config', requireRole(...GLOBAL), (req, res) => res.json(store.getAlertConfig()));
  router.put('/alert-config', admin, (req, res) => res.json(store.setAlertConfig(req.body || {}, req.user.sub)));
  router.get('/notifications', requireRole(...GLOBAL), (req, res) => res.json(store.notifications.slice(0, 200)));
  router.get('/notifications/stats', requireRole(...GLOBAL), (req, res) => res.json(store.notificationStats()));
  router.post('/alert-config/test', admin, async (req, res) => {
    const { channel, to } = req.body || {};
    if (!channel || !to) return res.status(400).json({ error: 'channel and to required' });
    try { res.json(await notifier.sendTest(channel, to, store)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- Health Index (scoped) --------------------------------------------
  router.get('/health-index', (req, res) => {
    const sensors = scopedSensors(req.user);
    res.json(reports.healthIndex(store, sensors, store.scopeFor(req.user)));
  });

  // ---- Reports: Excel + printable (PDF via browser), scoped --------------
  router.get('/report/:type/xlsx', async (req, res, next) => {
    if (req.params.type === 'history') return next();
    const sensors = scopedSensors(req.user);
    try {
      const buf = await reports.toXlsx(req.params.type, store, sensors, store.scopeFor(req.user));
      store.logAudit({ user: req.user.sub, action: 'report_xlsx', detail: req.params.type });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="raip_${req.params.type}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.get('/report/:type/print', (req, res, next) => {
    if (req.params.type === 'history') return next();
    const sensors = scopedSensors(req.user);
    store.logAudit({ user: req.user.sub, action: 'report_print', detail: req.params.type });
    res.setHeader('Content-Type', 'text/html');
    res.send(reports.toHtml(req.params.type, store, sensors, store.scopeFor(req.user)));
  });

  // ---- Historical report: any coach, any date range ---------------------
  async function historyRows(req) {
    const coach = req.query.coach;
    if (!coach) throw new Error('coach required');
    if (!store.canSeeCoach(req.user, coach)) { const e = new Error('Coach not in your scope'); e.code = 403; throw e; }
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to + 'T23:59:59') : new Date();
    let rows = [];
    let source = 'memory';
    if (store.db) {
      try { rows = await store.db.historyForCoach(coach, from.toISOString(), to.toISOString(), 50000); source = 'postgres'; }
      catch (e) { rows = store.recentRowsForCoach(coach); }
    } else {
      rows = store.recentRowsForCoach(coach).filter((r) => { const t = new Date(r.ts); return t >= from && t <= to; });
    }
    return { coach, from, to, rows, source };
  }
  router.get('/report/history/xlsx', async (req, res) => {
    try {
      const h = await historyRows(req);
      const buf = await reports.toHistoryXlsx(h.coach, h.from, h.to, h.rows);
      store.logAudit({ user: req.user.sub, action: 'report_history_xlsx', detail: `${h.coach} (${h.rows.length} rows)` });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="history_${h.coach}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (e) { res.status(e.code || 400).json({ error: e.message }); }
  });
  router.get('/report/history/print', async (req, res) => {
    try {
      const h = await historyRows(req);
      store.logAudit({ user: req.user.sub, action: 'report_history_print', detail: h.coach });
      res.setHeader('Content-Type', 'text/html');
      res.send(reports.toHistoryHtml(h.coach, h.from, h.to, h.rows));
    } catch (e) { res.status(e.code || 400).json({ error: e.message }); }
  });

  // ---- Maintenance management (scoped view; edit by admin/depot/eng) -----
  const MAINT = ['super_admin', 'depot_admin', 'maintenance_eng'];
  router.get('/maintenance', (req, res) => res.json(store.listMaintenance(store.scopeFor(req.user))));
  router.post('/maintenance', requireRole(...MAINT), (req, res) => {
    try {
      if (!store.canSeeCoach(req.user, (req.body || {}).coach_id)) return res.status(403).json({ error: 'Coach not in your scope' });
      res.json(store.createMaintenance(req.body || {}, req.user.sub));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.put('/maintenance/:id', requireRole(...MAINT), (req, res) => {
    try { res.json(store.updateMaintenance(req.params.id, req.body || {}, req.user.sub)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.delete('/maintenance/:id', requireRole('super_admin', 'depot_admin'), (req, res) => {
    try { store.deleteMaintenance(req.params.id, req.user.sub); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- Predictive early-warning (scoped) --------------------------------
  router.get('/predict', (req, res) => {
    res.json(store.computePredictions(scopedSensors(req.user)));
  });

  // ---- GIS map data (depots + coaches, scoped) --------------------------
  router.get('/map-data', (req, res) => res.json(store.mapData(req.user)));

  // ---- Prognostics (battery life + thermal trend, scoped) ---------------
  router.get('/prognostics', (req, res) => res.json(store.computePrognostics(scopedSensors(req.user))));
  router.get('/anomalies', (req, res) => res.json(store.computeAnomalies(scopedSensors(req.user))));

  // ---- AI Copilot (LLM-ready; falls back to rule-based on the client) ----
  const copilot = require('./copilot');
  router.get('/assistant/status', (req, res) => res.json({ ai: copilot.isEnabled() }));
  router.post('/assistant/ask', async (req, res) => {
    const question = String((req.body || {}).question || '').slice(0, 500);
    if (!copilot.isEnabled()) return res.json({ mode: 'rule-based' });
    const sensors = scopedSensors(req.user);
    const cls = (s) => store.classify(s.status === 'offline' ? null : s.temperature);
    const online = sensors.filter((s) => s.status !== 'offline');
    const temps = online.map((s) => s.temperature).filter((t) => t != null);
    const overview = {
      total_emus: new Set(sensors.map((s) => s.emu_id)).size,
      total_coaches: new Set(sensors.map((s) => s.coach_id)).size,
      total_tms: sensors.length,
      online_sensors: online.length, offline_sensors: sensors.length - online.length,
      warning_tms: sensors.filter((s) => ['warning', 'high'].includes(cls(s))).length,
      critical_tms: sensors.filter((s) => cls(s) === 'critical').length,
      active_alerts: store.alerts.filter((a) => a.state === 'active').length,
      avg_fleet_temp: temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null,
    };
    const tms = sensors.map((s) => ({ tm: s.tm_id || s.sensor_id, coach: s.coach_id, emu: s.emu_id, temp: s.temperature, cls: cls(s), status: s.status, batt: s.battery_health }));
    const r = await copilot.ask(question, { overview, tms });
    if (r.ok) return res.json({ mode: 'ai', answer: r.answer });
    return res.json({ mode: 'rule-based', note: r.reason });
  });

  // ---- Communication devices (concentrators + LTE modules), scoped -------
  router.get('/devices', (req, res) => {
    const scope = store.scopeFor(req.user);
    const d = store.getDevices();
    const vis = (x) => scope.all || (x.coach_id && scope.coaches.has(x.coach_id));
    res.json({ concentrators: d.concentrators.filter(vis), lte: d.lte.filter(vis) });
  });

  return router;
}

module.exports = { apiRouter };
