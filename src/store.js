'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pw = require('./password');
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
    // "role" (optional) scopes escalation to people ASSIGNED to the alert's own coach/EMU who hold
    // that role — not the whole fleet. "emails"/"phones" are ADDITIONAL fixed recipients who see
    // every escalation at that level regardless of coach (e.g. a duty desk) — leave them empty for
    // pure coach-scoped escalation. Railway HQ is a global role by design (sees every coach already),
    // so L4 naturally reaches all HQ users without needing per-coach assignment.
    escalation_tiers: {
      L1: { name: 'Maintenance Engineer', role: 'maintenance_eng', emails: [], phones: [] },
      L2: { name: 'Depot Supervisor', role: 'depot_admin', emails: [], phones: [] },
      L3: { name: 'Depot Incharge', role: 'depot_admin', emails: [], phones: [] },
      L4: { name: 'Railway HQ', role: 'railway_hq', emails: [], phones: [] },
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
    this._deviceByKey = new Map();   // per-device api_key -> device (index for ingest auth; rebuilt on load, kept in sync on write)
    this._ingestCount = 0;
    this._startedAt = Date.now();
    this.thresholds = config.defaultThresholds();
    this.alertConfig = defaultAlertConfig();
    // ---- in-memory (live) ----
    this.sensors = new Map();      // sensor_id -> meta + latest reading
    this.series = new Map();       // sensor_id -> [{ t, temperature }]
    this.alerts = [];
    this.audit = [];
    this.secLog = [];              // sign-in / security events (kept across restarts, last 500)
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
    (s.devices || []).forEach((d) => { this.devices.set(d.device_id, d); this._indexDeviceKey(d); });
    if (s.thresholds) this.thresholds = Object.assign(config.defaultThresholds(), s.thresholds);
    if (s.alertConfig) this.alertConfig = Object.assign(defaultAlertConfig(), s.alertConfig);
    if (Array.isArray(s.audit) && !this.audit.length) this.audit = s.audit;
    if (Array.isArray(s.secLog) && !this.secLog.length) this.secLog = s.secLog;
    // Alerts used to live in memory only and vanished on every restart/redeploy, silently losing
    // active/unacknowledged alerts and all acknowledgement history. Now restored like everything else.
    if (Array.isArray(s.alerts) && !this.alerts.length) this.alerts = s.alerts;
    if (Array.isArray(s.notifications) && !this.notifications.length) this.notifications = s.notifications;
    if (s.alertSeq) this._alertSeq = Math.max(this._alertSeq, s.alertSeq);
    for (const a of this.alerts) if (a.id >= this._alertSeq) this._alertSeq = a.id + 1;   // never reuse an id even if alertSeq was stale
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
      const offlineCut = Date.now() - this.getThresholds().CFG_OFFLINE_SECONDS * 1000;
      let skipped = 0;
      for (const r of latest) {
        // A coach the admin deleted is gone from master data but its readings stay in the DB (history is kept).
        // Never rebuild live sensors for it, or the deleted coach re-appears on every restart/redeploy.
        if (r.coach_id && !this.coaches.has(r.coach_id)) { skipped++; continue; }
        const lastUpdate = new Date(r.ts).toISOString();
        this.sensors.set(r.sensor_id, {
          sensor_id: r.sensor_id, tm_id: r.tm_id, coach_id: r.coach_id, emu_id: r.emu_id,
          temperature: r.temperature == null ? null : Number(r.temperature),
          battery_health: r.battery == null ? null : Number(r.battery),
          signal_strength: r.signal == null ? null : Number(r.signal),
          // Already stale at startup -> restore as offline (silently) so a redeploy does not re-send
          // "offline" alerts/emails for coaches that were offline before the restart.
          sensor_type: 'wireless', status: Date.parse(lastUpdate) < offlineCut ? 'offline' : 'online', last_update: lastUpdate,
        });
      }
      const since = new Date(Date.now() - (hours || 6) * 3600 * 1000).toISOString();
      const rows = await this.db.recentSeries(since, 200000);
      for (const row of rows) {
        if (!this.sensors.has(row.sensor_id)) continue;   // skipped (deleted coach) or unknown sensor
        const buf = this.series.get(row.sensor_id) || [];
        buf.push({ t: new Date(row.ts).toISOString(), temperature: row.temperature == null ? null : Number(row.temperature) });
        if (buf.length > MAX_SERIES) buf.shift();
        this.series.set(row.sensor_id, buf);
      }
      console.log(`[store] backfilled ${latest.length - skipped} sensors and ${rows.length} samples from PostgreSQL` + (skipped ? ` (skipped ${skipped} sensor(s) of deleted coaches)` : ''));
    } catch (e) {
      console.error('[store] backfill failed:', e.message);
    }
  }

  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSync(), 200);
  }
  // For frequent, low-value changes (a device's "last seen" time): save at most every 5 minutes.
  // With 2000 field devices pulling config every 5 min, an immediate full save would rewrite ~1 MB
  // several times per second. A restart/shutdown still saves everything (flushSync on SIGTERM).
  _persistSlow() {
    if (this._slowTimer) return;
    this._slowTimer = setTimeout(() => { this._slowTimer = null; this.flushSync(); }, 5 * 60 * 1000);
    if (this._slowTimer.unref) this._slowTimer.unref();
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
      audit: this.audit.slice(0, 1500),
      secLog: this.secLog.slice(0, 500),
      alerts: this.alerts.slice(0, 5000),
      notifications: this.notifications.slice(0, 2000),
      alertSeq: this._alertSeq,
    };
  }

  flushSync() {
    const snapshot = this._snapshot();
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });   // contains password hashes: owner-only file // compact: ~35% smaller and faster than pretty-printed
      fs.renameSync(tmp, this._file); // atomic
    } catch (e) {
      console.error('[store] persist failed:', e.message);
    }
    if (this.db) this.db.saveState(snapshot).catch((e) => console.error('[db] saveState failed:', e.message));
  }

  // ===== Thresholds =======================================================
  getThresholds() { return this.thresholds; }
  setThresholds(patch, user) {
    const keys = ['CFG_WARN_TEMP', 'CFG_HIGH_TEMP', 'CFG_CRIT_TEMP', 'CFG_OFFLINE_SECONDS', 'CFG_LOW_BATTERY', 'CFG_RISE_RATE', 'CFG_LOG_INTERVAL', 'CFG_DB_LOG_INTERVAL'];
    // validate on a copy first so a bad request can never leave live thresholds half-applied
    const next = Object.assign({}, this.thresholds);
    for (const k of keys) if (patch[k] != null && Number.isFinite(Number(patch[k]))) next[k] = Number(patch[k]);
    if (next.CFG_LOG_INTERVAL < 5) next.CFG_LOG_INTERVAL = 5;
    if (!(next.CFG_DB_LOG_INTERVAL >= 0)) next.CFG_DB_LOG_INTERVAL = 0;
    if (!(next.CFG_WARN_TEMP < next.CFG_HIGH_TEMP && next.CFG_HIGH_TEMP < next.CFG_CRIT_TEMP)) throw new Error('Temperature limits must satisfy Warning < High < Critical');
    if (!(next.CFG_OFFLINE_SECONDS >= 30)) throw new Error('Offline after must be at least 30 seconds');
    if (!(next.CFG_LOW_BATTERY >= 0 && next.CFG_LOW_BATTERY <= 100)) throw new Error('Low battery % must be between 0 and 100');
    if (!(next.CFG_RISE_RATE > 0)) throw new Error('Rapid rise must be greater than 0');
    Object.assign(this.thresholds, next);
    this.logAudit({ user, action: 'set_thresholds', detail: JSON.stringify(this.thresholds) });
    this._persist();
    return this.thresholds;
  }

  // ===== Alert config (SMS/Email routing, escalation, templates) ==========
  getAlertConfig() {
    // Defensive normalisation, not just at dispatch time: SMS is a hard-disabled channel for the
    // "offline" severity (see notify.js), so the admin screen must never show it as ticked — even for
    // a config saved before this rule existed. This never mutates the stored config, only the view.
    const cfg = this.alertConfig;
    if (cfg.rules && cfg.rules.offline && (cfg.rules.offline.channels || []).includes('sms')) {
      return Object.assign({}, cfg, { rules: Object.assign({}, cfg.rules, {
        offline: Object.assign({}, cfg.rules.offline, { channels: cfg.rules.offline.channels.filter((c) => c !== 'sms') }) }) });
    }
    return cfg;
  }
  // Currently-active "offline" alerts — used by the hourly offline-reminder timer in server.js.
  activeOfflineAlerts() { return this.alerts.filter((a) => a.severity === 'offline' && a.state === 'active'); }
  setAlertConfig(patch, user) {
    // never let request keys such as "__proto__" reach Object.assign (prototype pollution)
    const unsafeKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    if (patch.rules) for (const sev of Object.keys(patch.rules)) {
      if (unsafeKey(sev)) continue;
      if (!own(this.alertConfig.rules, sev)) this.alertConfig.rules[sev] = { channels: [], emails: [], phones: [], escalate_to: '', escalate_after_min: 0 };
      Object.assign(this.alertConfig.rules[sev], patch.rules[sev]);
    }
    if (patch.escalation_tiers) for (const k of Object.keys(patch.escalation_tiers)) {
      if (unsafeKey(k)) continue;
      this.alertConfig.escalation_tiers[k] = Object.assign(own(this.alertConfig.escalation_tiers, k) ? this.alertConfig.escalation_tiers[k] : { name: k }, patch.escalation_tiers[k]);
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
    const CAL_INTERVAL_DAYS = Number(config.CALIBRATION_INTERVAL_DAYS) || 365;
    const WARN_WITHIN_DAYS = Number(config.WARRANTY_WARN_DAYS) || 60;
    const now = Date.now();
    return [...ids].sort().map((id) => {
      const s = this.sensors.get(id) || {};
      const r = this.sensorRegistry.get(id) || {};
      const out = {
        sensor_id: id, coach_id: s.coach_id || null, tm_id: s.tm_id || null,
        serial_no: r.serial_no || null, calibration_date: r.calibration_date || null,
        firmware: r.firmware || null, warranty: r.warranty || null, installation_date: r.installation_date || null,
        status: s.status || 'unknown',
        calibration_overdue: false, calibration_days_overdue: null,
        warranty_expiring: false, warranty_expired: false, warranty_days_left: null,
      };
      // "Overdue" = more than CAL_INTERVAL_DAYS since the last recorded calibration. No date on file
      // is treated as unknown, not overdue (nothing to warn about until a first date is entered).
      if (r.calibration_date) {
        const calMs = Date.parse(r.calibration_date);
        if (!isNaN(calMs)) {
          const daysSince = (now - calMs) / 86400000;
          if (daysSince > CAL_INTERVAL_DAYS) { out.calibration_overdue = true; out.calibration_days_overdue = Math.round(daysSince - CAL_INTERVAL_DAYS); }
        }
      }
      // "Warranty" is free text ("date or text" per the edit screen); only a value that parses as a
      // real date can be checked, so anything else (e.g. "5 years") is left alone rather than guessed at.
      if (r.warranty) {
        const wMs = Date.parse(r.warranty);
        if (!isNaN(wMs)) {
          const daysLeft = Math.round((wMs - now) / 86400000);
          out.warranty_days_left = daysLeft;
          if (daysLeft < 0) out.warranty_expired = true;
          else if (daysLeft <= WARN_WITHIN_DAYS) out.warranty_expiring = true;
        }
      }
      return out;
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
  // Scheduled, no admin action needed: writes a dated backup file and deletes ones older than
  // BACKUP_KEEP_DAYS (default 14). Runs from server.js on a timer. Failure here (e.g. disk full)
  // is logged but never throws — a backup problem must not take the live app down.
  autoBackup() {
    // Self-throttle (defense in depth, independent of whatever schedules this call): even if this is
    // ever invoked far too often — a bad interval, a future code path, anything — it will not write
    // more than one backup file per minute. This is what actually stops a runaway-timer bug from
    // filling the disk and pegging the CPU, regardless of where the runaway call is coming from.
    const now = Date.now();
    if (this._lastAutoBackupAt && now - this._lastAutoBackupAt < 60000) return null;
    this._lastAutoBackupAt = now;
    try {
      const dir = config.BACKUP_DIR || path.join(config.DATA_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `backup-${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify(this.exportBackup()), { mode: 0o600 });
      const keepMs = (Number(config.BACKUP_KEEP_DAYS) || 14) * 86400000;
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        if (!/^backup-.*\.json$/.test(f)) continue;
        const full = path.join(dir, f);
        try { if (now - fs.statSync(full).mtimeMs > keepMs) fs.unlinkSync(full); } catch (e) {}
      }
      console.log(`[backup] wrote ${file}`);
      return file;
    } catch (e) {
      console.error('[backup] auto backup failed:', e.message);
      return null;
    }
  }
  importBackup(snapshot, actor) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid backup');
    // Validate BEFORE touching live data: a wrong/empty file must never wipe users, coaches or field devices.
    if (!snapshot._backup_version) throw new Error('not a RAIP backup file (missing _backup_version)');
    if (!Array.isArray(snapshot.users) || !snapshot.users.some((u) => u && u.username && u.hash && u.role === 'super_admin')) {
      throw new Error('backup has no super_admin user - restoring it would lock everyone out');
    }
    for (const k of ['emus', 'coaches', 'devices', 'depots']) {
      if (snapshot[k] != null && !Array.isArray(snapshot[k])) throw new Error(`backup field "${k}" is malformed`);
    }
    const previous = this._snapshot();   // rollback point
    const wipe = () => {
      this.users.clear(); this.emus.clear(); this.coaches.clear(); this.assignment.clear();
      this.userAssets.clear(); this.depots.clear(); this.devices.clear(); this.sensorRegistry.clear();
      this.swaps = []; this.maintenance = [];
    };
    try {
      wipe();
      this._applySnapshot(snapshot);
    } catch (e) {
      wipe(); this._applySnapshot(previous);   // restore exactly what was there before
      throw new Error('restore failed, nothing was changed: ' + e.message);
    }
    this.logAudit({ user: actor, action: 'restore_backup', detail: 'master data restored from backup' });
    this.flushSync();
    return { users: this.users.size, emus: this.emus.size, coaches: this.coaches.size, depots: this.depots.size, devices: this.devices.size };
  }

  // ===== Field device registry (self-updating RUT config) ================
  listDevices() {
    // api_key is a live credential: mask it in the list (last 6 chars only, enough to tell devices
    // apart) so any GLOBAL-scoped viewer doesn't see every device's full key just by opening the page.
    return [...this.devices.values()].map((d) => {
      const o = Object.assign({}, d);
      if (o.api_key) { o.api_key_masked = 'dk_...' + o.api_key.slice(-6); delete o.api_key; }
      return o;
    });
  }
  // Random, high-entropy per-device credential (not a human password, so a fast hash is fine —
  // it only ever needs to be compared, never brute-force-resistant on top of its own 192 bits).
  _genDeviceKey() { return 'dk_' + crypto.randomBytes(24).toString('hex'); }
  _indexDeviceKey(d) { if (d.api_key) this._deviceByKey.set(d.api_key, d); }
  // Used by ingest to authenticate a request and bind it to the device's own registered coach.
  deviceByApiKey(key) { return key ? this._deviceByKey.get(key) || null : null; }

  upsertDevice(body, actor) {
    if (!body.device_id) throw new Error('device_id required');
    const cur = this.devices.get(body.device_id) || { device_id: body.device_id, last_seen: null, last_ip: null };
    if (!cur.api_key) { cur.api_key = this._genDeviceKey(); this._indexDeviceKey(cur); }   // every device gets its own key, existing or new
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
  // New key for a device that was physically replaced, or whose old key may have leaked.
  rotateDeviceKey(device_id, actor) {
    const d = this.devices.get(device_id); if (!d) throw new Error('device not found');
    if (d.api_key) this._deviceByKey.delete(d.api_key);
    d.api_key = this._genDeviceKey(); this._indexDeviceKey(d);
    this.logAudit({ user: actor, action: 'rotate_device_key', detail: device_id });
    this._persist();
    return { device_id, api_key: d.api_key };
  }
  deleteDevice(device_id, actor) {
    if (!this.devices.has(device_id)) throw new Error('device not found');
    const old = this.devices.get(device_id); if (old && old.api_key) this._deviceByKey.delete(old.api_key);
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
    // Zero-touch migration: a device registered before per-device keys existed gets one generated
    // right here, on its own next config pull. The self-update RUT script re-reads "api_key" from
    // this response every cycle and switches to it automatically — no site visit needed.
    if (!d.api_key) { d.api_key = this._genDeviceKey(); this._indexDeviceKey(d); this._persist(); }
    // note: last_seen is persisted lazily (at most every 5 min), see _persistSlow()
    this._persistSlow();
    return {
      ok: true,
      enabled: d.enabled !== false,
      device_id: d.device_id,
      coach_id: d.coach_id || null,
      emu_id: d.emu_id || null,
      ingest_path: '/api/v1/ingest',
      api_key: d.api_key,
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
        const tierDef = this.alertConfig.escalation_tiers[rule.escalate_to];
        if (tierDef) {
          // Coach/EMU-scoped: only people ASSIGNED to this alert's own coach, holding the tier's
          // role, are escalated to — plus the tier's fixed emails/phones (if any), which are meant
          // as fleet-wide extras (e.g. a duty desk), not the primary mechanism.
          const scoped = a.coach_id && tierDef.role ? this.usersForCoach(a.coach_id).filter((u) => u.role === tierDef.role) : [];
          const tier = { name: tierDef.name,
            emails: [...new Set([...(tierDef.emails || []), ...scoped.map((u) => u.email).filter(Boolean)])],
            phones: [...new Set([...(tierDef.phones || []), ...scoped.map((u) => u.phone).filter(Boolean)])] };
          out.push({ alert: a, tier });
        }
        this.logAudit({ user: 'system', action: 'escalate_alert', detail: `#${a.id} -> ${rule.escalate_to}${a.coach_id ? ' (scoped to coach ' + a.coach_id + ')' : ''}` });
      }
    }
    return out;
  }

  // ===== Users (CRUD) =====================================================
  seedUser({ username, password, role, depot_id, email, phone, must_change }) {
    this.users.set(username, { username, hash: pw.hashSync(password), role, depot_id: depot_id || null, email: email || null, phone: phone || null,
      must_change: !!must_change, token_version: 0, disabled: false, pw_changed_at: new Date().toISOString() });
    if (!this.userAssets.has(username)) this.userAssets.set(username, { emus: [], coaches: [] });
    this._persist();
  }
  getUser(username) { return this.users.get(username); }
  listUsers() {
    return [...this.users.values()].map((u) => {
      const global = config.GLOBAL_ROLES.includes(u.role);
      const a = this.userAssets.get(u.username) || { emus: [], coaches: [] };
      return { username: u.username, role: u.role, depot_id: u.depot_id, email: u.email || null, phone: u.phone || null,
        disabled: !!u.disabled, must_change: !!u.must_change, totp_enabled: !!(u.totp && u.totp.enabled),
        last_login: u.last_login || null, last_login_ip: u.last_login_ip || null, pw_changed_at: u.pw_changed_at || null,
        all_access: global, emus: global ? [] : a.emus, coaches: global ? [] : a.coaches };
    });
  }
  async createUser({ username, password, role, depot_id, email, phone }, actor) {
    username = String(username || '').trim();
    if (!username || !password || !role) throw new Error('username, password, role required');
    if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) throw new Error('username: 3-64 characters, letters, digits and . _ @ - only');
    const bad = pw.policyError(password, username); if (bad) throw new Error(bad);
    if ([...this.users.keys()].some((k) => k.toLowerCase() === username.toLowerCase())) throw new Error('user already exists');
    if (!config.ROLES.includes(role)) throw new Error('invalid role');
    const hash = await pw.hash(password);
    // the admin who typed this password must not be the one who knows the real password: the user must choose their own at first sign-in
    this.users.set(username, { username, hash, role, depot_id: depot_id || null, email: email || null, phone: phone || null,
      must_change: true, token_version: 0, disabled: false, pw_changed_at: new Date().toISOString() });
    this.userAssets.set(username, { emus: [], coaches: [] });
    this.logAudit({ user: actor, action: 'create_user', detail: username + ' (' + role + ')' });
    this._persist();
    return { username, role, depot_id: depot_id || null, email: email || null, phone: phone || null, must_change: true };
  }
  async updateUser(username, patch, actor) {
    const u = this.users.get(username);
    if (!u) throw new Error('user not found');
    if (patch.role) {
      if (!config.ROLES.includes(patch.role)) throw new Error('invalid role');
      if (u.role === 'super_admin' && patch.role !== 'super_admin' && [...this.users.values()].filter((x) => x.role === 'super_admin' && !x.disabled).length < 2) throw new Error('cannot demote the last active super admin');
      u.role = patch.role;
    }
    if (patch.depot_id !== undefined) u.depot_id = patch.depot_id || null;
    if (patch.email !== undefined) u.email = patch.email || null;
    if (patch.phone !== undefined) u.phone = patch.phone || null;
    if (patch.password) {
      const bad = pw.policyError(patch.password, username); if (bad) throw new Error(bad);
      u.hash = await pw.hash(patch.password); u.must_change = true; u.token_version = (u.token_version || 0) + 1; u.pw_changed_at = new Date().toISOString();
    }
    this.logAudit({ user: actor, action: 'update_user', detail: username + (patch.password ? ' (password reset)' : '') });
    this._persist();
    return { username: u.username, role: u.role, depot_id: u.depot_id, email: u.email, phone: u.phone };
  }
  deleteUser(username, actor) {
    if (!this.users.has(username)) throw new Error('user not found');
    if (username === actor) throw new Error('cannot delete your own account');
    const victim = this.users.get(username);
    if (victim.role === 'super_admin' && [...this.users.values()].filter((x) => x.role === 'super_admin' && !x.disabled).length < 2) throw new Error('cannot delete the last active super admin');
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

    // Per-channel calibration: compute the delta (new - old) BEFORE overwriting,
    // then instantly nudge the already-cached live reading (and its most recent
    // series point) by that same delta. This makes the dashboard reflect a
    // calibration change immediately, instead of waiting for the next reading
    // to arrive (which can be minutes away at low Log intervals).
    const calDeltas = {};
    ['cal_tm1', 'cal_tm2', 'cal_tm3', 'cal_tm4'].forEach((k) => {
      if (patch[k] === undefined) return;
      const newVal = Number(patch[k]) || 0;
      const oldVal = Number(c[k]) || 0;
      const delta = Math.round((newVal - oldVal) * 10) / 10;
      if (delta) calDeltas[k] = delta;
      c[k] = newVal;
    });
    if (Object.keys(calDeltas).length) {
      for (const s of this.sensors.values()) {
        if (s.coach_id !== coach_id || s.temperature == null || !s.tm_id) continue;
        const delta = calDeltas['cal_' + String(s.tm_id).toLowerCase()];
        if (!delta) continue;
        s.temperature = Math.round((s.temperature + delta) * 10) / 10;
        const buf = this.series.get(s.sensor_id);
        if (buf && buf.length) buf[buf.length - 1].temperature = s.temperature;
      }
    }

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
    const orphanDevices = [...this.devices.values()].filter((d) => d.coach_id === coach_id).map((d) => d.device_id);
    this.logAudit({ user: actor, action: 'delete_coach', detail: coach_id + (orphanDevices.length ? ` (field device(s) still registered: ${orphanDevices.join(', ')})` : '') });
    this._persist();
    return { orphan_devices: orphanDevices };
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
  // Target turnaround time, in hours, for a maintenance record — how "Overdue" is decided.
  // An explicit priority (critical/high/normal/low) always wins; otherwise the type decides.
  static SLA_HOURS_BY_TYPE = { corrective: 24, sensor_replacement: 48, battery_replacement: 48, work_order: 72, calibration: 168, preventive: 168 };
  static SLA_HOURS_BY_PRIORITY = { critical: 4, high: 24, normal: 72, low: 168 };
  slaHoursFor(rec) {
    if (rec.priority && Store.SLA_HOURS_BY_PRIORITY[rec.priority] != null) return Store.SLA_HOURS_BY_PRIORITY[rec.priority];
    return Store.SLA_HOURS_BY_TYPE[rec.type] || 72;
  }
  createMaintenance(body, actor) {
    if (!body.coach_id) throw new Error('coach_id required');
    if (!body.title) throw new Error('title required');
    const rec = {
      id: (this.maintenance[0] ? this.maintenance[0].id : 0) + 1,
      coach_id: body.coach_id,
      type: body.type || 'work_order',        // work_order | preventive | corrective | calibration | sensor_replacement | battery_replacement
      priority: ['critical', 'high', 'normal', 'low'].includes(body.priority) ? body.priority : null,   // null = SLA decided by type
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
    if (patch.priority !== undefined) m.priority = ['critical', 'high', 'normal', 'low'].includes(patch.priority) ? patch.priority : null;
    if (patch.status !== undefined) { m.status = patch.status; if (patch.status === 'closed' && !m.closed_at) m.closed_at = new Date().toISOString(); if (patch.status !== 'closed') m.closed_at = null; }
    this.logAudit({ user: actor, action: 'update_maintenance', detail: `#${id} -> ${m.status}` });
    this._persist();
    return m;
  }
  // Maintenance list with computed SLA fields (never stored, so tightening/loosening the SLA table
  // above takes effect immediately for every existing record, not just new ones).
  maintenanceWithSla(list) {
    const now = Date.now();
    return (list || this.maintenance).map((m) => {
      const targetH = this.slaHoursFor(m);
      const dueAt = new Date(Date.parse(m.created_at) + targetH * 3600000).toISOString();
      const endMs = m.closed_at ? Date.parse(m.closed_at) : now;
      const hoursOpen = +((endMs - Date.parse(m.created_at)) / 3600000).toFixed(1);
      const overdue = m.status !== 'closed' && now > Date.parse(dueAt);
      const closedLate = m.status === 'closed' && Date.parse(m.closed_at) > Date.parse(dueAt);
      return Object.assign({}, m, { sla_target_hours: targetH, sla_due_at: dueAt, hours_open: hoursOpen, overdue, closed_late: closedLate });
    });
  }
  maintenanceSlaSummary(list) {
    const withSla = this.maintenanceWithSla(list);
    const open = withSla.filter((m) => m.status !== 'closed');
    const closed = withSla.filter((m) => m.status === 'closed');
    return {
      open_total: open.length, open_on_track: open.filter((m) => !m.overdue).length, open_overdue: open.filter((m) => m.overdue).length,
      closed_total: closed.length, closed_on_time: closed.filter((m) => !m.closed_late).length, closed_late: closed.filter((m) => m.closed_late).length,
    };
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
  _shouldArchive(sensorId, eventTime) {
    const everyMs = (Number(this.getThresholds().CFG_DB_LOG_INTERVAL) || 0) * 1000;
    if (!everyMs) return true;
    if (!this._lastArchive) this._lastArchive = new Map();
    const ts = Date.parse(eventTime);
    const last = this._lastArchive.get(sensorId) || 0;
    // small tolerance so push-time jitter never skips a whole interval
    if (ts - last >= everyMs - Math.min(30000, everyMs * 0.25)) { this._lastArchive.set(sensorId, ts); return true; }
    return false;
  }

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
    const wasOffline = existing && existing.status === 'offline';

    this.sensors.set(r.sensor_id, meta);
    // The coach (or this sensor) is reporting again: close out its "offline" alert automatically —
    // otherwise it sits active forever until a human notices the coach came back and acknowledges it.
    if (wasOffline && r.coach_id) this._autoResolve((a) => a.severity === 'offline' && a.coach_id === r.coach_id, 'coach back online');
    const buf = this.series.get(r.sensor_id) || [];
    buf.push({ t: eventTime, temperature: meta.temperature, battery: meta.battery_health });
    if (buf.length > MAX_SERIES) buf.shift();
    this.series.set(r.sensor_id, buf);

    // Durable archive to PostgreSQL (never blocks or crashes the live path).
    // Live dashboard/alerts update on every push; the DB row is written only once
    // per CFG_DB_LOG_INTERVAL per sensor (0 = every push). Editable in Admin -> Thresholds.
    if (this.db && this._shouldArchive(meta.sensor_id, eventTime)) this.db.insertReading(meta).catch(() => {});

    // Predictive: rapid temperature-rise detection over the recent window.
    if (meta.temperature != null && meta.status !== 'offline') {
      const slope = this._slope(buf, 6); // deg C per minute
      if (slope != null && slope >= t.CFG_RISE_RATE && meta.temperature > 50) {
        this._raise({ severity: 'rapid_rise', sensor_id: meta.sensor_id, coach_id: meta.coach_id,
          emu_id: meta.emu_id, tm_id: meta.tm_id, value: meta.temperature,
          message: `Rapid rise on ${meta.tm_id || meta.sensor_id} (${slope.toFixed(1)} C/min) at ${meta.temperature.toFixed(1)}C` });
      } else {
        // The rise has slowed or the temperature dropped back under the "rapid rise" floor: this was
        // never auto-resolved before, so a rapid-rise alert would sit active forever otherwise.
        this._autoResolve((a) => a.sensor_id === meta.sensor_id && a.severity === 'rapid_rise', 'rate of rise back to normal');
      }
    }

    this._evaluateAlerts(meta, t);
    return meta;
  }

  sweepOffline() {
    const t = this.getThresholds();
    const cutoff = Date.now() - t.CFG_OFFLINE_SECONDS * 1000;
    const wentOffline = new Map(); // coach_id -> sensors that just went offline in this sweep
    for (const s of this.sensors.values()) {
      const wasOnline = s.status === 'online';
      if (Date.parse(s.last_update) < cutoff) {
        s.status = 'offline';
        if (wasOnline) {
          const key = s.coach_id || ('sensor:' + s.sensor_id);
          if (!wentOffline.has(key)) wentOffline.set(key, []);
          wentOffline.get(key).push(s);
        }
      }
    }
    // ONE offline alert per coach (not one per motor sensor -> no 4 duplicate emails/SMS).
    for (const list of wentOffline.values()) {
      const first = list[0];
      const coachId = first.coach_id;
      if (coachId) {
        // straggler guard: a sibling sensor of the same coach crossing the cutoff in the
        // very next sweep must not raise a second alert for the same outage.
        const dup = this.alerts.find((x) => x.severity === 'offline' && x.coach_id === coachId &&
          x.state === 'active' && (Date.now() - Date.parse(x.at)) < 120000);
        if (dup) continue;
      }
      const tms = list.map((x) => x.tm_id || x.sensor_id).sort().join(', ');
      let message;
      if (!coachId) {
        message = `Sensor ${first.sensor_id} offline (no data > ${t.CFG_OFFLINE_SECONDS}s)`;
      } else {
        const total = this.allSensors().filter((x) => x.coach_id === coachId).length;
        message = list.length >= total
          ? `Coach ${coachId} offline - all ${total} sensors (${tms}) sent no data > ${t.CFG_OFFLINE_SECONDS}s`
          : `Coach ${coachId}: ${list.length} of ${total} sensors offline (${tms}) - no data > ${t.CFG_OFFLINE_SECONDS}s`;
      }
      this._raise({ severity: 'offline', sensor_id: first.sensor_id, coach_id: coachId,
        emu_id: first.emu_id, tm_id: coachId ? tms : first.tm_id, message });
    }
  }

  // ===== Alerts ===========================================================
  _evaluateAlerts(s, t) {
    if (s.temperature == null) return;
    let sev = null;
    if (s.temperature > t.CFG_CRIT_TEMP) sev = 'critical';
    else if (s.temperature > t.CFG_HIGH_TEMP) sev = 'high';
    else if (s.temperature > t.CFG_WARN_TEMP) sev = 'warning';
    // Auto-resolve: at most one temperature severity is ever "true" for a sensor at a given moment.
    // Any OTHER active temperature-severity alert for this sensor is superseded (temp moved to a
    // different band, or back to normal) and is closed out automatically rather than sitting active
    // forever until someone manually acknowledges it.
    const TEMP_SEVS = ['warning', 'high', 'critical'];
    this._autoResolve((a) => a.sensor_id === s.sensor_id && TEMP_SEVS.includes(a.severity) && a.severity !== sev,
      sev ? `superseded — now ${sev}` : 'temperature back to normal');
    if (sev) this._raise({ severity: sev, sensor_id: s.sensor_id, coach_id: s.coach_id, emu_id: s.emu_id,
      tm_id: s.tm_id, value: s.temperature, message: `${s.tm_id || s.sensor_id} on ${s.coach_id}: ${s.temperature.toFixed(1)}C (${sev})` });
    if (s.battery_health != null && s.battery_health <= t.CFG_LOW_BATTERY) {
      this._raise({ severity: 'low_battery', sensor_id: s.sensor_id, coach_id: s.coach_id, emu_id: s.emu_id, tm_id: s.tm_id,
        value: s.battery_health, message: `Low battery on ${s.sensor_id}: ${s.battery_health}%` });
    } else if (s.battery_health != null) {
      this._autoResolve((a) => a.sensor_id === s.sensor_id && a.severity === 'low_battery', 'battery back above threshold');
    }
  }
  _raise(a) {
    // One active incident per sensor+severity: as long as an alert for this exact condition is
    // still 'active' (not yet auto-resolved or acknowledged/closed), a repeated reading of the same
    // severity does NOT create another row or send another email/SMS — it was previously re-created
    // (and re-notified) roughly every 60 seconds for as long as a fault lasted, flooding both the
    // alert list and everyone's inbox/phone for a single ongoing problem. Escalation (separate timer)
    // still re-notifies an unacknowledged alert after CFG escalate_after_min, so a genuinely ignored
    // problem is not silent forever — it just isn't spammed every minute either.
    const recent = this.alerts.find((x) => x.sensor_id === a.sensor_id && x.severity === a.severity && x.state === 'active');
    if (recent) return;
    const created = Object.assign({ id: this._alertSeq++ }, a, { state: 'active',
      at: new Date().toISOString(), acknowledged_by: null, acknowledged_at: null, escalated: false });
    this.alerts.unshift(created);
    if (this.alerts.length > 5000) this.alerts.pop();
    this._persistSlow();   // alerts are durable now (were memory-only before); throttled since this runs per reading
    this._logAlertEvent({ alert_id: created.id, event: 'raised', severity: created.severity,
      sensor_id: created.sensor_id, coach_id: created.coach_id, emu_id: created.emu_id, tm_id: created.tm_id,
      message: created.message });
    if (this._notifier) { try { Promise.resolve(this._notifier(this.alerts[0])).catch(() => {}); } catch (e) {} }
  }
  // Marks every currently-active alert matching `match` as resolved (condition cleared on its own —
  // distinct from "acknowledged": a resolved alert still shows in history for review/closure).
  // Fire-and-forget SQL alert-event logging. Guarded against ANY problem with the db object (missing
  // method, wrong shape, e.g. a test mock or a future db.js that doesn't implement it, or a thrown
  // error) so this NEVER crashes the live alert/ingest path — a monitoring-history write failing must
  // never take down actual monitoring.
  _logAlertEvent(e) {
    try { if (this.db && typeof this.db.logAlertEvent === 'function') Promise.resolve(this.db.logAlertEvent(e)).catch(() => {}); }
    catch (err) { /* never let alert-history logging break alerting itself */ }
  }
  _autoResolve(match, reason) {
    let n = 0;
    for (const a of this.alerts) {
      if (a.state !== 'active' || !match(a)) continue;
      a.state = 'resolved'; a.resolved_at = new Date().toISOString(); a.resolved_reason = reason; n++;
      this._logAlertEvent({ alert_id: a.id, event: 'resolved', severity: a.severity,
        sensor_id: a.sensor_id, coach_id: a.coach_id, emu_id: a.emu_id, tm_id: a.tm_id, detail: reason });
    }
    if (n) this._persistSlow();
    return n;
  }
  acknowledgeAlert(id, user) {
    const a = this.alerts.find((x) => x.id === Number(id)); if (!a) return null;
    if (a.state === 'closed') throw new Error('alert is already closed');
    a.state = 'acknowledged'; a.acknowledged_by = user; a.acknowledged_at = new Date().toISOString();
    this.logAudit({ user, action: 'ack_alert', detail: 'alert #' + id });
    this._logAlertEvent({ alert_id: a.id, event: 'acknowledged', severity: a.severity,
      sensor_id: a.sensor_id, coach_id: a.coach_id, emu_id: a.emu_id, tm_id: a.tm_id, actor: user });
    this._persist();
    return a;
  }
  // Final step of the alert lifecycle: what was done about it, by whom. A closed alert is done —
  // it no longer counts as active/pending review, but stays in history (never deleted).
  closeAlert(id, user, { action, reason } = {}) {
    const a = this.alerts.find((x) => x.id === Number(id)); if (!a) throw new Error('alert not found');
    if (a.state === 'closed') throw new Error('alert is already closed');
    if (!action || !String(action).trim()) throw new Error('action taken is required to close an alert');
    a.state = 'closed'; a.closed_by = user; a.closed_at = new Date().toISOString();
    a.action_taken = String(action).trim().slice(0, 500); a.closure_reason = reason ? String(reason).trim().slice(0, 500) : '';
    this.logAudit({ user, action: 'close_alert', detail: `alert #${id}: ${a.action_taken}` });
    this._logAlertEvent({ alert_id: a.id, event: 'closed', severity: a.severity,
      sensor_id: a.sensor_id, coach_id: a.coach_id, emu_id: a.emu_id, tm_id: a.tm_id, actor: user,
      message: a.action_taken, detail: a.closure_reason });
    this._persist();
    return a;
  }
  logSecurity(e) {
    this.secLog.unshift(Object.assign({ at: new Date().toISOString() }, e));
    if (this.secLog.length > 3000) this.secLog.length = 3000;
    this._persistSlow();
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
