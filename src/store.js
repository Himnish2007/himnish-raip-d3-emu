'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');

// ---------------------------------------------------------------------------
// HIMNISH RAIP D3 - Data store (persistent master data + in-memory live data)
//
// Master data (users, EMUs, coaches, coach<->EMU assignment, swap audit trail,
// per-user asset assignments, threshold overrides) is persisted to a JSON file
// so it survives restarts/redeploys when DATA_DIR points at a mounted volume.
//
// Live data (sensor readings, alerts, action audit) stays in memory: it is
// repopulated within seconds by the hardware after any restart.
//
// This is the only data-access surface in the app, so a PostgreSQL/TimescaleDB
// adapter can replace it later without touching the routes.
// ---------------------------------------------------------------------------

const MAX_SERIES = 2000;

// Default fully-configurable alert routing (admin edits at runtime, persisted).
function defaultAlertConfig() {
  const blank = (channels, esc, after) => ({ channels, emails: [], phones: [],
    escalate_to: esc || '', escalate_after_min: after || 0 });
  return {
    rules: {
      warning: blank(['email'], 'L2', 30),
      high: blank(['email', 'sms'], 'L3', 15),
      critical: blank(['email', 'sms'], 'L4', 5),
      offline: blank(['email'], '', 0),
      low_battery: blank(['email'], '', 0),
      rapid_rise: blank(['email', 'sms'], 'L3', 5),
    },
    escalation_tiers: {
      L1: { name: 'Maintenance Engineer', emails: [], phones: [] },
      L2: { name: 'Depot Supervisor', emails: [], phones: [] },
      L3: { name: 'Depot Incharge', emails: [], phones: [] },
      L4: { name: 'Railway HQ', emails: [], phones: [] },
    },
    templates: {
      sms: '[EMU-TM ALERT] {severity}: {tm} on {coach} = {temp}C @ {time}',
      email_subject: 'EMU Motor Coach TM Alert [{severity}] {coach}',
      email_body: 'EMU Motor Coach TM Temperature Monitoring System\nAlert Notification\n\nSeverity: {severity}\nMessage: {message}\nEMU: {emu}\nCoach: {coach}\nTraction Motor: {tm}\nTemperature: {temp} C\nTime: {time}\n\n- HIMNISH LIMITED',
    },
    report: { enabled: false, hour: 7, emails: [], base_url: '' },
  };
}


class Store {
  constructor() {
    // ---- persistent ----
    this.users = new Map();        // username -> { username, hash, role, depot_id }
    this.emus = new Map();         // emu_id   -> { emu_id, name, depot_id }
    this.coaches = new Map();      // coach_id -> { coach_id, name, rut200_ip, rut200_port, rut200_path, poll_enabled }
    this.assignment = new Map();   // coach_id -> { emu_id, position, since }
    this.swaps = [];               // coach swap audit trail
    this.userAssets = new Map();   // username -> { emus:[], coaches:[] }
    this.maintenance = [];         // work orders / service history (persisted)
    this.sensorRegistry = new Map(); // sensor_id -> { serial_no, calibration_date, firmware, warranty, installation_date }
    this.depots = new Map();         // depot_id -> { depot_id, name, region, lat, lng }
    this.devices = new Map();        // device_id -> field RUT config (self-update)
    this._ingestCount = 0;
    this._startedAt = Date.now();
    this.thresholds = config.defaultThresholds();
    this.alertConfig = defaultAlertConfig();
    // ---- in-memory (live) ----
    this.sensors = new Map();      // sensor_id -> meta + latest reading
    this.series = new Map();       // sensor_id -> [{ t, temperature }]
    this.alerts = [];
    this.audit = [];
    this.notifications = [];       // SMS/email delivery log, newest first
    this.comm = new Map();         // coach_id -> live comm telemetry (rssi, packet_loss, lte...)
    this._notifier = null;         // server sets: fn(alert) => dispatch
    this._alertSeq = 1;
    this._saveTimer = null;
    this._file = path.join(config.DATA_DIR, 'raip_state.json');
    this.db = null;             // optional PostgreSQL archive (set by server)
  }

  attachDb(db) { this.db = db; }

  // ===== Persistence ======================================================
  _applySnapshot(s) {
    (s.users || []).forEach((u) => this.users.set(u.username, u));
    (s.emus || []).forEach((e) => this.emus.set(e.emu_id, e));
    (s.coaches || []).forEach((c) => this.coaches.set(c.coach_id, c));
    Object.entries(s.assignment || {}).forEach(([k, v]) => this.assignment.set(k, v));
    this.swaps = s.swaps || [];
    Object.entries(s.userAssets || {}).forEach(([k, v]) => this.userAssets.set(k, v));
    this.maintenance = s.maintenance || [];
    Object.entries(s.sensorRegistry || {}).forEach(([k, v]) => this.sensorRegistry.set(k, v));
    (s.depots || []).forEach((d) => this.depots.set(d.depot_id, d));
    (s.devices || []).forEach((d) => this.devices.set(d.device_id, d));
    if (s.thresholds) this.thresholds = Object.assign(config.defaultThresholds(), s.thresholds);
    if (s.alertConfig) this.alertConfig = Object.assign(defaultAlertConfig(), s.alertConfig);
  }

  // Load master data. Prefers the DB state blob (most durable) when a DB is
  // attached; otherwise the local JSON file.
  async load() {
    try {
      if (this.db) {
        const s = await this.db.loadState();
        if (s) { this._applySnapshot(s); console.log('[store] loaded master state from PostgreSQL'); return; }
      }
      if (fs.existsSync(this._file)) {
        this._applySnapshot(JSON.parse(fs.readFileSync(this._file, 'utf8')));
        console.log(`[store] loaded master state from ${this._file}`);
      }
    } catch (e) {
      console.error('[store] load failed, starting fresh:', e.message);
    }
  }

  // After a restart, repopulate live sensors + recent trend history from the DB
  // so the dashboard and graphs are not empty until hardware pushes again.
  async backfillFromDb(hours) {
    if (!this.db) return;
    try {
      const latest = await this.db.latestPerSensor();
      for (const r of latest) {
        this.sensors.set(r.sensor_id, {
          sensor_id: r.sensor_id, tm_id: r.tm_id, coach_id: r.coach_id, emu_id: r.emu_id,
          temperature: r.temperature == null ? null : Number(r.temperature),
          battery_health: r.battery == null ? null : Number(r.battery),
          signal_strength: r.signal == null ? null : Number(r.signal),
          sensor_type: 'wireless', status: 'online', last_update: new Date(r.ts).toISOString(),
        });
      }
      const since = new Date(Date.now() - (hours || 6) * 3600 * 1000).toISOString();
      const rows = await this.db.recentSeries(since, 200000);
      for (const row of rows) {
        const buf = this.series.get(row.sensor_id) || [];
        buf.push({ t: new Date(row.ts).toISOString(), temperature: row.temperature == null ? null : Number(row.temperature) });
        if (buf.length > MAX_SERIES) buf.shift();
        this.series.set(row.sensor_id, buf);
      }
      console.log(`[store] backfilled ${latest.length} sensors and ${rows.length} samples from PostgreSQL`);
    } catch (e) {
      console.error('[store] backfill failed:', e.message);
    }
  }

  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSync(), 200);
  }

  _snapshot() {
    return {
      users: [...this.users.values()],
      emus: [...this.emus.values()],
      coaches: [...this.coaches.values()],
      assignment: Object.fromEntries(this.assignment),
      swaps: this.swaps.slice(0, 5000),
      userAssets: Object.fromEntries(this.userAssets),
      maintenance: this.maintenance.slice(0, 5000),
      sensorRegistry: Object.fromEntries(this.sensorRegistry),
      depots: [...this.depots.values()],
      devices: [...this.devices.values()],
      thresholds: this.thresholds,
      alertConfig: this.alertConfig,
    };
  }

  flushSync() {
    const snapshot = this._snapshot();
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmp, this._file); // atomic
    } catch (e) {
      console.error('[store] persist failed:', e.message);
    }
    if (this.db) this.db.saveState(snapshot).catch((e) => console.error('[db] saveState failed:', e.message));
  }

  // ===== Thresholds =======================================================
  getThresholds() { return this.thresholds; }
  setThresholds(patch, user) {
    const keys = ['CFG_WARN_TEMP', 'CFG_HIGH_TEMP', 'CFG_CRIT_TEMP', 'CFG_OFFLINE_SECONDS', 'CFG_LOW_BATTERY', 'CFG_RISE_RATE', 'CFG_LOG_INTERVAL'];
    for (const k of keys) if (patch[k] != null && Number.isFinite(Number(patch[k]))) this.thresholds[k] = Number(patch[k]);
    if (this.thresholds.CFG_LOG_INTERVAL < 5) this.thresholds.CFG_LOG_INTERVAL = 5;
    this.logAudit({ user, action: 'set_thresholds', detail: JSON.stringify(this.thresholds) });
    this._persist();
    return this.thresholds;
  }

  // ===== Alert config (SMS/Email routing, escalation, templates) ==========
  getAlertConfig() { return this.alertConfig; }
  setAlertConfig(patch, user) {
    if (patch.rules) for (const sev of Object.keys(patch.rules)) {
      if (!this.alertConfig.rules[sev]) this.alertConfig.rules[sev] = { channels: [], emails: [], phones: [], escalate_to: '', escalate_after_min: 0 };
      Object.assign(this.alertConfig.rules[sev], patch.rules[sev]);
    }
    if (patch.escalation_tiers) for (const k of Object.keys(patch.escalation_tiers)) {
      this.alertConfig.escalation_tiers[k] = Object.assign(this.alertConfig.escalation_tiers[k] || { name: k }, patch.escalation_tiers[k]);
    }
    if (patch.templates) Object.assign(this.alertConfig.templates, patch.templates);
    if (patch.report) this.alertConfig.report = Object.assign(this.alertConfig.report || {}, patch.report);
    this.logAudit({ user, action: 'set_alert_config', detail: 'notification routing updated' });
    this._persist();
    return this.alertConfig;
  }

  // ===== Sensor registry (serial / calibration / firmware / warranty) =====
  listSensorRegistry() {
    // Known sensors (live or in DB backfill) merged with any registry metadata.
    const ids = new Set([...this.sensors.keys(), ...this.sensorRegistry.keys()]);
    return [...ids].sort().map((id) => {
      const s = this.sensors.get(id) || {};
      const r = this.sensorRegistry.get(id) || {};
      return {
        sensor_id: id, coach_id: s.coach_id || null, tm_id: s.tm_id || null,
        serial_no: r.serial_no || null, calibration_date: r.calibration_date || null,
        firmware: r.firmware || null, warranty: r.warranty || null, installation_date: r.installation_date || null,
        status: s.status || 'unknown',
      };
    });
  }
  setSensorRegistry(sensor_id, patch, actor) {
    if (!sensor_id) throw new Error('sensor_id required');
    const cur = this.sensorRegistry.get(sensor_id) || {};
    ['serial_no', 'calibration_date', 'firmware', 'warranty', 'installation_date'].forEach((k) => { if (patch[k] !== undefined) cur[k] = patch[k]; });
    this.sensorRegistry.set(sensor_id, cur);
    this.logAudit({ user: actor, action: 'set_sensor_registry', detail: sensor_id });
    this._persist();
    return cur;
  }

  // ===== Depot management =================================================
  listDepots() {
    const depots = [...this.depots.values()];
    // annotate with EMU + coach counts
    return depots.map((d) => {
      const emus = [...this.emus.values()].filter((e) => e.depot_id === d.depot_id).map((e) => e.emu_id);
      const coaches = [...this.assignment.entries()].filter(([, a]) => emus.includes(a.emu_id)).length;
      return { ...d, emu_count: emus.length, coach_count: coaches };
    });
  }
  upsertDepot(body, actor) {
    if (!body.depot_id) throw new Error('depot_id required');
    const d = {
      depot_id: body.depot_id, name: body.name || body.depot_id, region: body.region || null,
      lat: body.lat != null && body.lat !== '' ? Number(body.lat) : null,
      lng: body.lng != null && body.lng !== '' ? Number(body.lng) : null,
    };
    const isNew = !this.depots.has(d.depot_id);
    this.depots.set(d.depot_id, d);
    this.logAudit({ user: actor, action: isNew ? 'create_depot' : 'update_depot', detail: d.depot_id });
    this._persist();
    return d;
  }
  deleteDepot(depot_id, actor) {
    if (!this.depots.has(depot_id)) throw new Error('depot not found');
    this.depots.delete(depot_id);
    this.logAudit({ user: actor, action: 'delete_depot', detail: depot_id });
    this._persist();
  }

  // ===== Master-data backup / restore ====================================
  exportBackup() {
    return Object.assign({ _backup_version: 1, _exported_at: new Date().toISOString() }, this._snapshot());
  }
  importBackup(snapshot, actor) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('invalid backup');
    this.users.clear(); this.emus.clear(); this.coaches.clear(); this.assignment.clear();
    this.userAssets.clear(); this.depots.clear(); this.devices.clear(); this.sensorRegistry.clear();
    this.swaps = []; this.maintenance = [];
    this._applySnapshot(snapshot);
    this.logAudit({ user: actor, action: 'restore_backup', detail: 'master data restored from backup' });
    this.flushSync();
    return { users: this.users.size, emus: this.emus.size, coaches: this.coaches.size, depots: this.depots.size, devices: this.devices.size };
  }

  // ===== Field device registry (self-updating RUT config) ================
  listDevices() {
    return [...this.devices.values()].map((d) => Object.assign({}, d));
  }
  upsertDevice(body, actor) {
    if (!body.device_id) throw new Error('device_id required');
    const cur = this.devices.get(body.device_id) || { device_id: body.device_id, last_seen: null, last_ip: null };
    ['name', 'coach_id', 'emu_id', 'tag1', 'tag2', 'tag3', 'tag4'].forEach((k) => { if (body[k] !== undefined) cur[k] = body[k] || null; });
    // Optional per-device interval override, in seconds. Leave unset (null) to
    // follow the global "Log interval (s)" from Admin -> Thresholds.
    if (body.post_interval_override !== undefined) {
      cur.post_interval_override = body.post_interval_override ? Number(body.post_interval_override) || null : null;
    } else if (body.post_interval !== undefined) {
      // back-compat with older clients/imports still sending post_interval
      cur.post_interval_override = Number(body.post_interval) || null;
    }
    if (body.enabled !== undefined) cur.enabled = !!body.enabled;
    if (cur.enabled === undefined) cur.enabled = true;
    // sensible defaults for tag mapping
    cur.tag1 = cur.tag1 || '1.3'; cur.tag2 = cur.tag2 || '1.4'; cur.tag3 = cur.tag3 || '1.5'; cur.tag4 = cur.tag4 || '1.6';
    this.devices.set(body.device_id, cur);
    this.logAudit({ user: actor, action: 'set_device', detail: body.device_id + ' -> ' + (cur.coach_id || 'unassigned') });
    this._persist();
    return cur;
  }
  deleteDevice(device_id, actor) {
    if (!this.devices.has(device_id)) throw new Error('device not found');
    this.devices.delete(device_id);
    this.logAudit({ user: actor, action: 'delete_device', detail: device_id });
    this._persist();
  }
  // Config a field RUT pulls to configure itself. Records check-in time.
  deviceConfig(device_id, ip) {
    const d = this.devices.get(device_id);
    if (!d) return null;
    d.last_seen = new Date().toISOString();
    if (ip) d.last_ip = ip;
    // note: last_seen change is persisted lazily (debounced)
    this._persist();
    return {
      ok: true,
      enabled: d.enabled !== false,
      device_id: d.device_id,
      coach_id: d.coach_id || null,
      emu_id: d.emu_id || null,
      ingest_path: '/api/v1/ingest',
      api_key: config.DATA_API_KEY,
      tags: [d.tag1 || '1.3', d.tag2 || '1.4', d.tag3 || '1.5', d.tag4 || '1.6'],
      // Post interval is centrally controlled from Admin → Thresholds → "Log
      // interval (s)" — one setting governs every push-mode field device.
      // A per-device override (rare) still wins if explicitly set.
      post_interval: d.post_interval_override || this.thresholds.CFG_LOG_INTERVAL || 20,
    };
  }
  systemStatus() {
    const sensors = [...this.sensors.values()];
    const online = sensors.filter((s) => s.status !== 'offline').length;
    const coaches = [...this.assignment.keys()];
    const coachStatus = coaches.map((cid) => {
      const cs = sensors.filter((s) => s.coach_id === cid);
      const last = cs.map((s) => s.last_update).filter(Boolean).sort().pop() || null;
      const anyOnline = cs.some((s) => s.status !== 'offline');
      return { coach_id: cid, emu_id: (this.assignment.get(cid) || {}).emu_id || null,
        status: cs.length ? (anyOnline ? 'online' : 'offline') : 'no-data', last_comm: last, sensors: cs.length };
    });
    return {
      db: this.db ? 'PostgreSQL' : 'JSON + memory',
      demo_mode: config.DEMO_MODE,
      server_time: new Date().toISOString(),
      uptime_seconds: Math.floor((Date.now() - this._startedAt) / 1000),
      total_readings_ingested: this._ingestCount,
      sensors_total: sensors.length, sensors_online: online, sensors_offline: sensors.length - online,
      emus: this.emus.size, coaches: coaches.length, users: this.users.size,
      active_alerts: this.alerts.filter((a) => a.state === 'active').length,
      coach_status: coachStatus,
    };
  }

  // ===== Map data (depots + their coaches with status), scoped ===========
  mapData(user) {
    const scope = this.scopeFor(user);
    const rank = { normal: 0, offline: 1, warning: 2, high: 3, critical: 4 };
    const rankName = ['normal', 'offline', 'warning', 'high', 'critical'];
    const depots = [...this.depots.values()].map((d) => {
      const emus = [...this.emus.values()].filter((e) => e.depot_id === d.depot_id).map((e) => e.emu_id);
      const coaches = [];
      for (const [cid, asg] of this.assignment) {
        if (!emus.includes(asg.emu_id)) continue;
        if (!(scope.all || scope.coaches.has(cid))) continue;
        const cs = [...this.sensors.values()].filter((s) => s.coach_id === cid);
        const anyOnline = cs.some((s) => s.status !== 'offline');
        const worst = cs.length ? rankName[Math.max.apply(null, cs.map((s) => rank[this.classify(s.status === 'offline' ? null : s.temperature)] || 0))] : 'no-data';
        coaches.push({ coach_id: cid, emu_id: asg.emu_id, status: cs.length ? (anyOnline ? 'online' : 'offline') : 'no-data', worst });
      }
      return { depot_id: d.depot_id, name: d.name, region: d.region, lat: d.lat, lng: d.lng,
        emu_count: emus.length, coaches };
    });
    return depots;
  }
  bulkCreateCoaches(list, actor) {
    if (!Array.isArray(list)) throw new Error('expected an array of coaches');
    const created = []; const errors = [];
    for (const row of list) {
      try {
        if (!row.coach_id) throw new Error('coach_id required');
        const c = this.createCoach(row, actor); // createCoach assigns EMU when emu_id present
        created.push(c.coach_id);
      } catch (e) { errors.push({ coach_id: row.coach_id || '(blank)', error: e.message }); }
    }
    return { created: created.length, coaches: created, errors };
  }

  setNotifier(fn) { this._notifier = fn; }
  addNotification(rec) {
    this.notifications.unshift(rec);
    if (this.notifications.length > 2000) this.notifications.pop();
  }
  notificationStats() {
    const stats = { total: this.notifications.length, sms: 0, email: 0, ok: 0, failed: 0 };
    for (const n of this.notifications) {
      if (n.channel === 'sms') stats.sms++; else if (n.channel === 'email') stats.email++;
      if (n.ok) stats.ok++; else stats.failed++;
    }
    stats.success_rate = stats.total ? Math.round((stats.ok / stats.total) * 100) : 100;
    return stats;
  }

  // Returns alerts whose escalation delay has elapsed without acknowledgement,
  // marking them escalated. Server sends to the configured tier.
  dueEscalations() {
    const out = [];
    const now = Date.now();
    for (const a of this.alerts) {
      if (a.state !== 'active' || a.escalated) continue;
      const rule = this.alertConfig.rules[a.severity];
      if (!rule || !rule.escalate_to || !rule.escalate_after_min) continue;
      if (now - Date.parse(a.at) >= rule.escalate_after_min * 60000) {
        a.escalated = true;
        const tier = this.alertConfig.escalation_tiers[rule.escalate_to];
        if (tier) out.push({ alert: a, tier });
        this.logAudit({ user: 'system', action: 'escalate_alert', detail: `#${a.id} -> ${rule.escalate_to}` });
      }
    }
    return out;
  }

  // ===== Users (CRUD) =====================================================
  seedUser({ username, password, role, depot_id, email, phone }) {
    this.users.set(username, { username, hash: bcrypt.hashSync(password, 10), role, depot_id: depot_id || null, email: email || null, phone: phone || null });
    if (!this.userAssets.has(username)) this.userAssets.set(username, { emus: [], coaches: [] });
    this._persist();
  }
  getUser(username) { return this.users.get(username); }
  listUsers() {
    return [...this.users.values()].map((u) => {
      const global = config.GLOBAL_ROLES.includes(u.role);
      const a = this.userAssets.get(u.username) || { emus: [], coaches: [] };
      return { username: u.username, role: u.role, depot_id: u.depot_id, email: u.email || null, phone: u.phone || null,
        all_access: global, emus: global ? [] : a.emus, coaches: global ? [] : a.coaches };
    });
  }
  createUser({ username, password, role, depot_id, email, phone }, actor) {
    if (!username || !password || !role) throw new Error('username, password, role required');
    if (String(password).length < 8) throw new Error('password must be at least 8 characters');
    if (this.users.has(username)) throw new Error('user already exists');
    if (!config.ROLES.includes(role)) throw new Error('invalid role');
    this.users.set(username, { username, hash: bcrypt.hashSync(password, 10), role, depot_id: depot_id || null, email: email || null, phone: phone || null });
    this.userAssets.set(username, { emus: [], coaches: [] });
    this.logAudit({ user: actor, action: 'create_user', detail: username + ' (' + role + ')' });
    this._persist();
    return { username, role, depot_id: depot_id || null, email: email || null, phone: phone || null };
  }
  updateUser(username, patch, actor) {
    const u = this.users.get(username);
    if (!u) throw new Error('user not found');
    if (patch.role) { if (!config.ROLES.includes(patch.role)) throw new Error('invalid role'); u.role = patch.role; }
    if (patch.depot_id !== undefined) u.depot_id = patch.depot_id || null;
    if (patch.email !== undefined) u.email = patch.email || null;
    if (patch.phone !== undefined) u.phone = patch.phone || null;
    if (patch.password) { if (String(patch.password).length < 8) throw new Error('password must be at least 8 characters'); u.hash = bcrypt.hashSync(patch.password, 10); }
    this.logAudit({ user: actor, action: 'update_user', detail: username });
    this._persist();
    return { username: u.username, role: u.role, depot_id: u.depot_id, email: u.email, phone: u.phone };
  }
  deleteUser(username, actor) {
    if (!this.users.has(username)) throw new Error('user not found');
    if (username === actor) throw new Error('cannot delete your own account');
    this.users.delete(username);
    this.userAssets.delete(username);
    this.logAudit({ user: actor, action: 'delete_user', detail: username });
    this._persist();
  }
  setUserAssets(username, { emus, coaches }, actor) {
    const u = this.users.get(username);
    if (!u) throw new Error('user not found');
    if (config.GLOBAL_ROLES.includes(u.role)) throw new Error('Super Admin / Railway HQ already have access to all EMUs and coaches — no assignment needed');
    this.userAssets.set(username, {
      emus: Array.isArray(emus) ? emus : [],
      coaches: Array.isArray(coaches) ? coaches : [],
    });
    this.logAudit({ user: actor, action: 'assign_assets', detail: `${username}: ${(emus||[]).length} EMU, ${(coaches||[]).length} coach` });
    this._persist();
    return this.userAssets.get(username);
  }

  // ===== Scoping ==========================================================
  // Returns { all:true } for global roles, else the set of visible EMU/coach ids.
  // Rule: assigning an EMU reveals ALL its coaches; assigning a single coach
  // reveals ONLY that coach (its parent EMU is included for grouping context
  // but does not pull in sibling coaches).
  scopeFor(user) {
    if (config.GLOBAL_ROLES.includes(user.role)) return { all: true };
    const a = this.userAssets.get(user.sub || user.username) || { emus: [], coaches: [] };
    const assignedEmus = new Set(a.emus);
    const coaches = new Set(a.coaches);
    // Coaches currently in a directly-assigned EMU are visible.
    for (const [cid, asg] of this.assignment) if (assignedEmus.has(asg.emu_id)) coaches.add(cid);
    // EMU set, for grouping/context only (NOT used to widen coach visibility).
    const emus = new Set(assignedEmus);
    for (const cid of coaches) { const asg = this.assignment.get(cid); if (asg && asg.emu_id) emus.add(asg.emu_id); }
    return { all: false, emus, coaches };
  }
  canSeeCoach(user, coach_id) { const s = this.scopeFor(user); return s.all || s.coaches.has(coach_id); }
  canSeeEmu(user, emu_id) { const s = this.scopeFor(user); return s.all || s.emus.has(emu_id); }

  // Users who should be notified about an event on a given coach:
  // global-role users (see everything) + users assigned that coach/EMU.
  // Returns only those with a contact method (email/phone).
  usersForCoach(coach_id) {
    const out = [];
    for (const u of this.users.values()) {
      const canSee = this.canSeeCoach({ role: u.role, sub: u.username }, coach_id);
      if (canSee && (u.email || u.phone)) out.push({ username: u.username, email: u.email, phone: u.phone, role: u.role });
    }
    return out;
  }

  // ===== EMU / Coach master data (CRUD) ===================================
  upsertEmu(e) { this.emus.set(e.emu_id, Object.assign({}, this.emus.get(e.emu_id), e)); this._persist(); }
  upsertCoach(c) { this.coaches.set(c.coach_id, Object.assign({}, this.coaches.get(c.coach_id), c)); this._persist(); }

  createEmu({ emu_id, name, depot_id }, actor) {
    if (!emu_id) throw new Error('emu_id required');
    if (this.emus.has(emu_id)) throw new Error('EMU already exists');
    this.emus.set(emu_id, { emu_id, name: name || emu_id, depot_id: depot_id || null });
    this.logAudit({ user: actor, action: 'create_emu', detail: emu_id });
    this._persist();
    return this.emus.get(emu_id);
  }
  updateEmu(emu_id, patch, actor) {
    const e = this.emus.get(emu_id); if (!e) throw new Error('EMU not found');
    if (patch.name !== undefined) e.name = patch.name;
    if (patch.depot_id !== undefined) e.depot_id = patch.depot_id || null;
    this.logAudit({ user: actor, action: 'update_emu', detail: emu_id });
    this._persist(); return e;
  }
  deleteEmu(emu_id, actor) {
    if (!this.emus.has(emu_id)) throw new Error('EMU not found');
    this.emus.delete(emu_id);
    // Unassign coaches that pointed at it.
    for (const [cid, asg] of this.assignment) if (asg.emu_id === emu_id) this.assignment.delete(cid);
    this.logAudit({ user: actor, action: 'delete_emu', detail: emu_id });
    this._persist();
  }

  createCoach(body, actor) {
    if (!body.coach_id) throw new Error('coach_id required');
    if (this.coaches.has(body.coach_id)) throw new Error('coach already exists');
    this.coaches.set(body.coach_id, {
      coach_id: body.coach_id, name: body.name || body.coach_id,
      architecture: body.architecture || 'wireless',
      data_source: body.data_source || 'rest_push',
      oem: body.oem || null, installation_date: body.installation_date || null,
      concentrator_id: body.concentrator_id || null,
      lte_imei: body.lte_imei || null, lte_sim: body.lte_sim || null, lte_ip: body.lte_ip || null,
      rut200_ip: body.rut200_ip || null, rut200_port: body.rut200_port || 80,
      rut200_path: body.rut200_path || '/readings', poll_enabled: !!body.poll_enabled,
      // Per-channel calibration offset in °C, added to the raw sensor reading
      // before it is classified/stored/displayed. e.g. gun reads 50°C but the
      // sensor reports 46°C -> set tm1_offset = 4.
      cal_tm1: Number(body.cal_tm1) || 0, cal_tm2: Number(body.cal_tm2) || 0,
      cal_tm3: Number(body.cal_tm3) || 0, cal_tm4: Number(body.cal_tm4) || 0,
    });
    if (body.emu_id) this.assignCoach({ coach_id: body.coach_id, emu_id: body.emu_id, position: body.position, user: actor, reason: 'created' });
    this.logAudit({ user: actor, action: 'create_coach', detail: body.coach_id });
    this._persist();
    return this.coaches.get(body.coach_id);
  }
  updateCoach(coach_id, patch, actor) {
    const c = this.coaches.get(coach_id); if (!c) throw new Error('coach not found');
    ['name', 'rut200_ip', 'rut200_path', 'architecture', 'data_source', 'oem', 'installation_date', 'concentrator_id', 'lte_imei', 'lte_sim', 'lte_ip'].forEach((k) => { if (patch[k] !== undefined) c[k] = patch[k]; });
    if (patch.rut200_port !== undefined) c.rut200_port = Number(patch.rut200_port) || 80;
    if (patch.poll_enabled !== undefined) c.poll_enabled = !!patch.poll_enabled;
    ['cal_tm1', 'cal_tm2', 'cal_tm3', 'cal_tm4'].forEach((k) => { if (patch[k] !== undefined) c[k] = Number(patch[k]) || 0; });
    this.logAudit({ user: actor, action: 'update_coach', detail: coach_id });
    this._persist(); return c;
  }
  deleteCoach(coach_id, actor) {
    if (!this.coaches.has(coach_id)) throw new Error('coach not found');
    this.coaches.delete(coach_id);
    this.assignment.delete(coach_id);
    this.comm.delete(coach_id);
    // Remove the coach's live sensors/series so it stops appearing in views.
    for (const s of [...this.sensors.values()]) if (s.coach_id === coach_id) { this.sensors.delete(s.sensor_id); this.series.delete(s.sensor_id); }
    this.logAudit({ user: actor, action: 'delete_coach', detail: coach_id });
    this._persist();
  }
  pollableCoaches() {
    return [...this.coaches.values()].filter((c) => c.poll_enabled && c.rut200_ip);
  }

  // ===== Maintenance management ===========================================
  listMaintenance(scope) {
    const all = this.maintenance;
    if (!scope || scope.all) return all.slice(0, 500);
    return all.filter((m) => m.coach_id && scope.coaches.has(m.coach_id)).slice(0, 500);
  }
  createMaintenance(body, actor) {
    if (!body.coach_id) throw new Error('coach_id required');
    if (!body.title) throw new Error('title required');
    const rec = {
      id: (this.maintenance[0] ? this.maintenance[0].id : 0) + 1,
      coach_id: body.coach_id,
      type: body.type || 'work_order',        // work_order | preventive | corrective | calibration | sensor_replacement | battery_replacement
      title: body.title,
      status: body.status || 'open',          // open | in_progress | closed
      assigned_to: body.assigned_to || null,
      notes: body.notes || '',
      created_by: actor, created_at: new Date().toISOString(), closed_at: null,
    };
    this.maintenance.unshift(rec);
    this.logAudit({ user: actor, action: 'create_maintenance', detail: `${rec.type} on ${rec.coach_id}: ${rec.title}` });
    this._persist();
    return rec;
  }
  updateMaintenance(id, patch, actor) {
    const m = this.maintenance.find((x) => x.id === Number(id));
    if (!m) throw new Error('record not found');
    ['title', 'type', 'assigned_to', 'notes'].forEach((k) => { if (patch[k] !== undefined) m[k] = patch[k]; });
    if (patch.status !== undefined) { m.status = patch.status; if (patch.status === 'closed' && !m.closed_at) m.closed_at = new Date().toISOString(); if (patch.status !== 'closed') m.closed_at = null; }
    this.logAudit({ user: actor, action: 'update_maintenance', detail: `#${id} -> ${m.status}` });
    this._persist();
    return m;
  }
  deleteMaintenance(id, actor) {
    const i = this.maintenance.findIndex((x) => x.id === Number(id));
    if (i < 0) throw new Error('record not found');
    this.maintenance.splice(i, 1);
    this.logAudit({ user: actor, action: 'delete_maintenance', detail: '#' + id });
    this._persist();
  }

  // ===== Communication devices (concentrators + LTE modules) ==============
  updateComm(coach_id, data) {
    if (!coach_id) return;
    const cur = this.comm.get(coach_id) || {};
    this.comm.set(coach_id, Object.assign(cur, data, { updated: new Date().toISOString() }));
  }
  // One concentrator + one LTE module per coach (per the per-coach topology).
  getDevices() {
    const t = this.getThresholds();
    const offlineMs = t.CFG_OFFLINE_SECONDS * 1000;
    const concentrators = [], lte = [];
    for (const c of this.coaches.values()) {
      const sensors = this.allSensors().filter((s) => s.coach_id === c.coach_id);
      const reporting = sensors.filter((s) => s.status === 'online').length;
      const lastComm = sensors.reduce((m, s) => Math.max(m, Date.parse(s.last_update) || 0), 0);
      const online = lastComm && (Date.now() - lastComm) < offlineMs;
      const sig = sensors.filter((s) => s.signal_strength != null);
      const avgSignal = sig.length ? Math.round(sig.reduce((a, s) => a + s.signal_strength, 0) / sig.length) : null;
      const a = this.assignment.get(c.coach_id) || {};
      const cm = this.comm.get(c.coach_id) || {};
      const lastIso = lastComm ? new Date(lastComm).toISOString() : null;
      concentrators.push({
        id: c.concentrator_id || ('DC-' + c.coach_id), coach_id: c.coach_id, emu_id: a.emu_id || null,
        status: online ? 'online' : 'offline', last_comm: lastIso,
        sensors_reporting: reporting, total_sensors: sensors.length || 4,
        avg_signal: avgSignal, rssi: cm.rssi != null ? cm.rssi : null,
        packet_loss: cm.packet_loss != null ? cm.packet_loss : null,
        latency: cm.latency != null ? cm.latency : null,
        retry_count: cm.retry_count != null ? cm.retry_count : null,
        checksum_failures: cm.checksum_failures != null ? cm.checksum_failures : null,
      });
      lte.push({
        id: c.lte_imei || ('LTE-' + c.coach_id), coach_id: c.coach_id, emu_id: a.emu_id || null,
        imei: c.lte_imei || null, sim: c.lte_sim || null, ip: c.lte_ip || cm.ip || null,
        signal: cm.lte_signal != null ? cm.lte_signal : avgSignal,
        network: cm.network || (online ? '4G LTE' : '—'), data_usage: cm.data_usage || null,
        last_comm: lastIso, status: online ? 'online' : 'offline',
      });
    }
    return { concentrators, lte };
  }

  // ===== Dynamic coach <-> EMU assignment =================================
  assignCoach({ coach_id, emu_id, position, user, reason }) {
    const prev = this.assignment.get(coach_id);
    const now = new Date().toISOString();
    this.assignment.set(coach_id, { emu_id, position: Number(position) || null, since: now });
    this.swaps.unshift({ coach_id, from_emu: prev ? prev.emu_id : null, to_emu: emu_id,
      position: Number(position) || null, user: user || 'system', reason: reason || '', at: now });
    this.logAudit({ user: user || 'system', action: 'coach_assign',
      detail: `${coach_id}: ${prev ? prev.emu_id : '(none)'} -> ${emu_id} pos ${position}` });
    this._persist();
    return this.assignment.get(coach_id);
  }
  currentEmuOfCoach(coach_id) { const a = this.assignment.get(coach_id); return a ? a.emu_id : null; }
  coachHistory(coach_id) { return this.swaps.filter((s) => s.coach_id === coach_id); }

  // ===== Ingestion ========================================================
  ingestReading(r) {
    this._ingestCount++;
    const t = this.getThresholds();
    const now = new Date().toISOString();
    // Offline buffering: a replayed reading may carry its original timestamp.
    let eventTime = now;
    const provided = r.ts || r.timestamp;
    if (provided) { const p = new Date(provided); if (!isNaN(p.getTime()) && p.getTime() <= Date.now() + 60000) eventTime = p.toISOString(); }
    const resolvedEmu = this.currentEmuOfCoach(r.coach_id) || r.emu_id || null;

    if (r.coach_id && !this.coaches.has(r.coach_id)) this.upsertCoach({ coach_id: r.coach_id, name: r.coach_id });
    if (resolvedEmu && !this.emus.has(resolvedEmu)) this.upsertEmu({ emu_id: resolvedEmu, name: resolvedEmu });
    if (r.coach_id && resolvedEmu && !this.assignment.has(r.coach_id)) {
      this.assignCoach({ coach_id: r.coach_id, emu_id: resolvedEmu, position: r.position || null,
        user: 'auto-provision', reason: 'first contact' });
    }

    const rawTemperature = Number(r.temperature);
    let temperature = Number.isFinite(rawTemperature) ? rawTemperature : null;
    if (temperature != null && r.coach_id && r.tm_id) {
      const coach = this.coaches.get(r.coach_id);
      const calKey = 'cal_' + String(r.tm_id).toLowerCase(); // e.g. tm_id "TM1" -> cal_tm1
      const offset = coach && Number.isFinite(coach[calKey]) ? coach[calKey] : 0;
      if (offset) temperature = Math.round((temperature + offset) * 10) / 10;
    }
    const meta = {
      sensor_id: r.sensor_id, tm_id: r.tm_id || null, coach_id: r.coach_id || null, emu_id: resolvedEmu,
      temperature,
      battery_health: r.battery_health != null ? Number(r.battery_health) : null,
      signal_strength: r.signal_strength != null ? Number(r.signal_strength) : null,
      sensor_type: r.sensor_type || 'wireless', status: 'online', last_update: eventTime,
    };

    // Backfilled (older than the current live reading): archive to history only,
    // do NOT overwrite the live value or fire alerts for stale data.
    const existing = this.sensors.get(r.sensor_id);
    const isBackfill = existing && existing.last_update && eventTime < existing.last_update;
    if (isBackfill) {
      if (this.db) this.db.insertReading(meta).catch(() => {});
      return meta;
    }

    this.sensors.set(r.sensor_id, meta);
    const buf = this.series.get(r.sensor_id) || [];
    buf.push({ t: eventTime, temperature: meta.temperature, battery: meta.battery_health });
    if (buf.length > MAX_SERIES) buf.shift();
    this.series.set(r.sensor_id, buf);

    // Durable archive to PostgreSQL (never blocks or crashes the live path).
    if (this.db) this.db.insertReading(meta).catch(() => {});

    // Predictive: rapid temperature-rise detection over the recent window.
    if (meta.temperature != null && meta.status !== 'offline') {
      const slope = this._slope(buf, 6); // deg C per minute
      if (slope != null && slope >= t.CFG_RISE_RATE && meta.temperature > 50) {
        this._raise({ severity: 'rapid_rise', sensor_id: meta.sensor_id, coach_id: meta.coach_id,
          emu_id: meta.emu_id, tm_id: meta.tm_id, value: meta.temperature,
          message: `Rapid rise on ${meta.tm_id || meta.sensor_id} (${slope.toFixed(1)} C/min) at ${meta.temperature.toFixed(1)}C` });
      }
    }

    this._evaluateAlerts(meta, t);
    return meta;
  }

  sweepOffline() {
    const t = this.getThresholds();
    const cutoff = Date.now() - t.CFG_OFFLINE_SECONDS * 1000;
    for (const s of this.sensors.values()) {
      const wasOnline = s.status === 'online';
      if (Date.parse(s.last_update) < cutoff) {
        s.status = 'offline';
        if (wasOnline) this._raise({ severity: 'offline', sensor_id: s.sensor_id, coach_id: s.coach_id,
          emu_id: s.emu_id, tm_id: s.tm_id, message: `Sensor ${s.sensor_id} offline (no data > ${t.CFG_OFFLINE_SECONDS}s)` });
      }
    }
  }

  // ===== Alerts ===========================================================
  _evaluateAlerts(s, t) {
    if (s.temperature == null) return;
    let sev = null;
    if (s.temperature > t.CFG_CRIT_TEMP) sev = 'critical';
    else if (s.temperature > t.CFG_HIGH_TEMP) sev = 'high';
    else if (s.temperature > t.CFG_WARN_TEMP) sev = 'warning';
    if (sev) this._raise({ severity: sev, sensor_id: s.sensor_id, coach_id: s.coach_id, emu_id: s.emu_id,
      tm_id: s.tm_id, value: s.temperature, message: `${s.tm_id || s.sensor_id} on ${s.coach_id}: ${s.temperature.toFixed(1)}C (${sev})` });
    if (s.battery_health != null && s.battery_health <= t.CFG_LOW_BATTERY) this._raise({ severity: 'low_battery',
      sensor_id: s.sensor_id, coach_id: s.coach_id, emu_id: s.emu_id, tm_id: s.tm_id, value: s.battery_health,
      message: `Low battery on ${s.sensor_id}: ${s.battery_health}%` });
  }
  _raise(a) {
    const recent = this.alerts.find((x) => x.sensor_id === a.sensor_id && x.severity === a.severity &&
      x.state === 'active' && (Date.now() - Date.parse(x.at)) < 60000);
    if (recent) return;
    this.alerts.unshift(Object.assign({ id: this._alertSeq++ }, a, { state: 'active',
      at: new Date().toISOString(), acknowledged_by: null, acknowledged_at: null, escalated: false }));
    if (this.alerts.length > 5000) this.alerts.pop();
    if (this._notifier) { try { Promise.resolve(this._notifier(this.alerts[0])).catch(() => {}); } catch (e) {} }
  }
  acknowledgeAlert(id, user) {
    const a = this.alerts.find((x) => x.id === Number(id)); if (!a) return null;
    a.state = 'acknowledged'; a.acknowledged_by = user; a.acknowledged_at = new Date().toISOString();
    this.logAudit({ user, action: 'ack_alert', detail: 'alert #' + id }); return a;
  }
  logAudit({ user, action, detail }) {
    this.audit.unshift({ user, action, detail, at: new Date().toISOString() });
    if (this.audit.length > 5000) this.audit.pop();
  }

  // ===== Read helpers =====================================================
  classify(temp) {
    const t = this.getThresholds();
    if (temp == null) return 'offline';
    if (temp > t.CFG_CRIT_TEMP) return 'critical';
    if (temp > t.CFG_HIGH_TEMP) return 'high';
    if (temp > t.CFG_WARN_TEMP) return 'warning';
    return 'normal';
  }
  allSensors() { return [...this.sensors.values()]; }
  seriesFor(sensor_id) { return this.series.get(sensor_id) || []; }

  // Fallback (no DB): recent in-memory rows for a coach's sensors.
  recentRowsForCoach(coach_id) {
    const rows = [];
    for (const s of this.sensors.values()) {
      if (s.coach_id !== coach_id) continue;
      for (const p of (this.series.get(s.sensor_id) || [])) {
        rows.push({ sensor_id: s.sensor_id, tm_id: s.tm_id, ts: p.t, temperature: p.temperature });
      }
    }
    return rows;
  }

  // Least-squares slope (deg C per minute) over the last n valid samples.
  _slope(buf, n) {
    const pts = (buf || []).filter((p) => p.temperature != null).slice(-n);
    if (pts.length < 3) return null;
    const t0 = Date.parse(pts[0].t);
    const xs = pts.map((p) => (Date.parse(p.t) - t0) / 60000);
    const ys = pts.map((p) => p.temperature);
    const m = xs.length;
    const sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0);
    const sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, b, i) => a + xs[i] * ys[i], 0);
    const denom = m * sxx - sx * sx;
    if (denom === 0) return null;
    return (m * sxy - sx * sy) / denom;
  }

  // Unsupervised anomaly detection (no labels needed): a motor running much
  // hotter than its sibling motors on the SAME coach is an early warning even
  // before it crosses an absolute threshold. Complements the statistical
  // prognostics; a true trained ML failure model would need labelled failure
  // history + vibration input, which this system does not yet collect.
  computeAnomalies(sensors, marginC) {
    const margin = marginC || 8;
    const byCoach = {};
    sensors.forEach((s) => { if (s.status === 'offline' || s.temperature == null) return; (byCoach[s.coach_id] = byCoach[s.coach_id] || []).push(s); });
    const out = [];
    Object.entries(byCoach).forEach(([coach, arr]) => {
      if (arr.length < 2) return;
      const temps = arr.map((s) => s.temperature).slice().sort((a, b) => a - b);
      const median = temps[Math.floor(temps.length / 2)];
      arr.forEach((s) => {
        const dev = +(s.temperature - median).toFixed(1);
        if (dev >= margin) out.push({ sensor_id: s.sensor_id, tm_id: s.tm_id, coach_id: coach, emu_id: s.emu_id,
          temperature: s.temperature, peer_median: median, deviation: dev,
          reason: `runs ${dev}\u00b0C hotter than sibling motors on the same coach` });
      });
    });
    out.sort((a, b) => b.deviation - a.deviation);
    return out;
  }

  // Predictive prognostics (statistical, not trained-ML): battery-life
  // projection from real discharge rate + thermal-degradation trend.
  computePrognostics(sensors) {
    const lsq = (xs, ys) => {
      const n = xs.length; const sx = xs.reduce((a, b) => a + b, 0); const sy = ys.reduce((a, b) => a + b, 0);
      const sxx = xs.reduce((a, b) => a + b * b, 0); const sxy = xs.reduce((a, b, i) => a + xs[i] * ys[i], 0);
      const d = n * sxx - sx * sx; return d === 0 ? 0 : (n * sxy - sx * sy) / d;
    };
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const out = [];
    for (const s of sensors) {
      const buf = this.series.get(s.sensor_id) || [];
      const bp = buf.filter((p) => p.battery != null);
      let batt_rate_per_day = null; let batt_days_left = null;
      if (bp.length >= 5) {
        const t0 = Date.parse(bp[0].t); const tN = Date.parse(bp[bp.length - 1].t);
        const spanDays = (tN - t0) / 86400000;
        if (spanDays >= 0.02) { // need at least ~30 min of history to project meaningfully
          const xs = bp.map((p) => (Date.parse(p.t) - t0) / 86400000);
          const slope = lsq(xs, bp.map((p) => p.battery));
          batt_rate_per_day = +slope.toFixed(2);
          if (slope < -0.01 && s.battery_health != null) batt_days_left = Math.max(0, +((s.battery_health - 5) / -slope).toFixed(1));
        }
      }
      const tp = buf.filter((p) => p.temperature != null);
      let thermal_trend = 'insufficient-data'; let recent_avg = null; let base_avg = null; let peak = null;
      if (tp.length >= 10) {
        const half = Math.floor(tp.length / 2);
        base_avg = +avg(tp.slice(0, half).map((p) => p.temperature)).toFixed(1);
        recent_avg = +avg(tp.slice(half).map((p) => p.temperature)).toFixed(1);
        peak = +Math.max.apply(null, tp.map((p) => p.temperature)).toFixed(1);
        const d = recent_avg - base_avg;
        thermal_trend = d > 2 ? 'degrading' : (d < -2 ? 'improving' : 'stable');
      }
      let verdict = 'healthy';
      if (thermal_trend === 'degrading') verdict = 'watch';
      if (batt_days_left != null && batt_days_left < 30) verdict = 'battery-low';
      if (peak != null && peak >= this.getThresholds().CFG_CRIT_TEMP) verdict = 'thermal-risk';
      if (s.status === 'offline') verdict = 'offline';
      out.push({ sensor_id: s.sensor_id, tm_id: s.tm_id, coach_id: s.coach_id, emu_id: s.emu_id,
        battery: s.battery_health, batt_rate_per_day, batt_days_left,
        base_avg, recent_avg, peak, thermal_trend, verdict });
    }
    const order = { 'thermal-risk': 0, 'battery-low': 1, watch: 2, offline: 3, healthy: 4 };
    out.sort((a, b) => (order[a.verdict] || 5) - (order[b.verdict] || 5));
    return out;
  }

  // Predictive projection: rate of rise + estimated minutes to critical.
  computePredictions(sensors) {
    const t = this.getThresholds();
    const out = [];
    for (const s of sensors) {
      if (s.status === 'offline' || s.temperature == null) continue;
      const slope = this._slope(this.series.get(s.sensor_id) || [], 8);
      if (slope == null) continue;
      const rate = +slope.toFixed(2);
      let mins_to_crit = null;
      if (rate > 0.1 && s.temperature < t.CFG_CRIT_TEMP) {
        mins_to_crit = +((t.CFG_CRIT_TEMP - s.temperature) / rate).toFixed(1);
      }
      let risk = 'stable';
      if (rate >= t.CFG_RISE_RATE) risk = 'rising';
      if (mins_to_crit != null && mins_to_crit <= 60) risk = 'watch';
      if (mins_to_crit != null && mins_to_crit <= 15) risk = 'urgent';
      if (rate < -0.2) risk = 'cooling';
      out.push({ sensor_id: s.sensor_id, tm_id: s.tm_id, coach_id: s.coach_id, emu_id: s.emu_id,
        temperature: s.temperature, rate, mins_to_crit, risk });
    }
    out.sort((a, b) => (a.mins_to_crit == null ? 1e9 : a.mins_to_crit) - (b.mins_to_crit == null ? 1e9 : b.mins_to_crit));
    return out;
  }
}

module.exports = { Store };
