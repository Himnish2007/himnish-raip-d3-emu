# EMU Motor Coach TM Temperature Monitoring System

Wireless, self-powered traction-motor bearing temperature monitoring for EMU
motor coaches. Himnish-controlled ingestion (push or RUT200 IP pull), a RAIP D3
dashboard (light/dark), full master-data administration, per-user asset
visibility, runtime-editable thresholds and scoped CSV export.

## What's included

- **Ingestion** — `POST /api/v1/ingest` (X-API-Key) for LTE modules / RUT200 push,
  **plus RUT200 IP pull poller** for coaches configured with a RUT200 IP.
- **Dashboard** — Overview, Live EMU, Digital Twin, Heatmap, Alerts, Analytics,
  Coach Swap, Reports, and an Admin panel. Light theme default, dark toggle.
- **Administration (Super Admin)** — add/edit/delete users, EMUs and motor
  coaches; set RUT200 IP per coach; edit alert thresholds at runtime.
- **Per-user scope** — assign EMUs and/or coaches to a user; that user sees and
  exports only their assigned assets. Super Admin and Railway HQ see all.
- **Persistence** — master data is saved to a JSON file under `DATA_DIR` and
  restored on restart (attach a Railway Volume so it survives redeploys).

## Quick start (local)

```bash
npm install
set DEMO_MODE=true          # Windows;  on macOS/Linux:  DEMO_MODE=true npm start
npm start
```

Open `http://localhost:8080`. Sign in as `admin / himnish@2025` (change this).
Demo mode generates 2 EMUs of synthetic data and seeds scoped demo users
(`engineer` sees only EMU-02, `viewer` sees only coach MC-101).

## Deploy: GitHub → Railway

1. **Push to GitHub.** From the project folder:
   ```bash
   git init           # if not already a repo
   git add .
   git commit -m "RAIP D3 EMU monitoring"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   (If merging into an existing RAIP repo, copy files in — don't re-extract a
   zip over the folder — to preserve `.git`.)
2. **Railway → New Project → Deploy from GitHub repo** → pick the repo. Railway
   auto-detects Node, runs `npm install` then `npm start` (Procfile included).
3. **Add a Volume** (Railway → service → Volumes) mounted at e.g. `/data`.
4. **Set environment variables** (Railway → Variables) from `.env.example`:
   - `JWT_SECRET` — long random string
   - `DATA_API_KEY` — your ingestion key
   - `DATA_DIR=/data` — so users/EMUs/coaches persist across redeploys
   - `DEMO_MODE=false`
5. Railway gives a public URL. Point the LTE modules / RUT200 push at
   `https://<app>.up.railway.app/api/v1/ingest`, or configure each coach's
   RUT200 IP in Admin for pull mode (see `comm/PUSH_SPEC.md`).

`PORT` is provided by Railway automatically — no need to set it.

## Roles

| Role                 | Sees            | Can edit master data | Coach swap | Acknowledge |
|----------------------|-----------------|----------------------|------------|-------------|
| Super Admin          | all             | yes                  | yes        | yes         |
| Railway HQ           | all             | no (read-only Admin) | no         | yes         |
| Depot Admin          | assigned scope  | no                   | yes        | yes         |
| Maintenance Engineer | assigned scope  | no                   | yes        | yes         |
| Observer             | assigned scope  | no                   | no         | no          |

## API surface

Ingestion (X-API-Key): `POST /api/v1/ingest`, `GET /api/v1/ping`
Auth: `POST /api/v1/login`
Read (scoped): `/overview`, `/emus`, `/alerts`, `/series/:id`, `/coaches`,
`/coaches/:id/history`, `/thresholds`, `/export/readings.csv`
Actions: `POST /alerts/:id/ack`, `POST /coaches/:id/assign`
Admin: `/assets`, `/users` CRUD, `/users/:u/assets`, `/emus` CRUD, `/coach` CRUD,
`PUT /thresholds`, `/audit`

## Persistence & PostgreSQL

`src/store.js` is the only data-access surface. It persists master data to
`DATA_DIR/raip_state.json` and keeps live readings/alerts in memory. To move to
PostgreSQL/TimescaleDB, implement a class with the same methods backed by tables
(`users`, `emus`, `coaches`, `coach_assignment`, `coach_swaps`, `user_assets`,
`thresholds`, `readings` hypertable, `alerts`, `audit`) and swap `new Store()`
in `server.js`. No route changes required.

## Roadmap

GIS India map view, PDF/Excel report generation, SMS/Email gateway wiring in
`store._raise`, and the disabled-by-default AI predictive module.

## Configurable SMS + Email alerting (Notify tab)

Super Admin configures everything from the **Notify** tab — no code changes:
- Per-severity routing: toggle Email / SMS, set email + phone recipients.
- Escalation matrix: L1 Maintenance → L2 Supervisor → L3 Incharge → L4 HQ, with
  a configurable "escalate after N minutes" per severity. Unacknowledged alerts
  auto-escalate to the configured tier.
- Editable SMS / email subject / email body templates with placeholders
  ({severity} {message} {emu} {coach} {tm} {temp} {time}).
- Delivery log + analytics (total SMS/email, success rate).
- "Send test" button to verify configuration.

**Channels work in dry-run until credentials are set** (so the system is fully
demonstrable). To send for real, set the environment variables:
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.
- SMS: `SMS_PROVIDER` = `fast2sms` | `msg91` | `generic`, plus `SMS_API_KEY`
  (and `SMS_SENDER`; for `generic`, `SMS_URL` with {to}{message}{key}).

## Other new features

- **Assigned-coach dropdown** in Live EMU: each user selects from the motor
  coaches assigned to them.
- **Over-threshold coaches float to the top** of the Live list (sorted by worst
  severity), with the EMU flagged "NEEDS ATTENTION".
- **Sensor architecture per coach**: wired / wireless / hybrid, editable any time.

## Exact deploy commands (GitHub → Railway)

From this project folder, in a terminal:

```bash
git init
git add .
git commit -m "HIMNISH RAIP D3 EMU monitoring"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then on railway.app: **New Project → Deploy from GitHub repo → select the repo**.
Add a **Volume** (mount `/data`) and set Variables: `JWT_SECRET`, `DATA_API_KEY`,
`DATA_DIR=/data`, `DEMO_MODE=false`, and the SMTP_/SMS_ vars when ready. Railway
builds and gives a public HTTPS URL. First login `admin / himnish@2025` — change
the password immediately under Admin → Users.

## Reports, Health Index & Audit (new)

- **Reports tab** — one-click **Excel (.xlsx)** and **PDF (print)** for: Live
  Readings, Alarm, Sensor Health, Coach Health, EMU Health. All scoped to the
  user's assigned coaches. (CSV also available.)
- **Health Index tab** — 0–100 condition score per sensor → coach → EMU →
  fleet, worst assets first.
- **Audit tab** — full trail of config/alert/asset actions (global roles).

## Maintenance, Topology & Wallboard (new)

- **Maintenance tab** — work orders (preventive / corrective / calibration /
  sensor & battery replacement), status workflow open → in progress → closed,
  scoped to assigned coaches, persisted.
- **Topology tab** — per-coach network path: Sensor → Data Concentrator →
  LTE Gateway → Cloud, live colour-coded.
- **Wallboard button (⛶)** — fullscreen control-room mode that auto-rotates
  Overview → Active Alerts → Devices every 8s, for 55"/65" NOC displays.
- **Data source** per coach (modbus_tcp / modbus_rtu / mqtt / rest_push …) —
  config field so the protocol is never hardcoded.

## PostgreSQL / TimescaleDB (data permanence) — NEW

By default the app keeps live data in memory and master data in a JSON file.
For permanent history that survives restarts/redeploys, attach PostgreSQL:

1. On Railway: **New → Database → Add PostgreSQL**. Railway injects `DATABASE_URL`
   into your service automatically (link the DB to the app service).
2. Redeploy. On boot you'll see `DB=PostgreSQL` and, if the TimescaleDB extension
   is present, it is used automatically (else a plain indexed table — both work).
3. That's it. Every reading is now archived; after any restart the dashboard and
   trends are backfilled from the database.

How it works (safe by design):
- The real-time path stays in memory (correct for a live dashboard); Postgres is
  a durable archive written alongside — it never blocks or crashes the live path.
- If the database is unreachable, the app logs it and keeps running on
  memory + JSON — it never goes down because of the DB.
- Master data (users/coaches/thresholds/etc.) is also mirrored to Postgres, so it
  survives even without a mounted volume.

New endpoint: `GET /api/v1/history/:sensorId?hours=720` returns long-range
history from Postgres (downsampled for charting), falling back to in-memory
recent data when no DB is configured.

## Daily reports, Sensor Registry & Comm-health detail (new)

- **Daily report email** — Notify → Daily Report: set hour (UTC), recipients and
  public base URL. Once a day the system emails printable/PDF report links
  (valid ~3 days, no login needed via a signed token). "Send now" to test.
- **Sensor Registry** — Admin → Sensor Registry: per-sensor serial number,
  calibration date, firmware version and warranty (persisted).
- **Communication-health detail** — Devices → Concentrators now shows latency,
  retry count and checksum failures (populated when the hardware/LTE module
  reports them via the ingestion payload; shows "—" until then).

## Himnish branding + Predictive Early-Warning (new)

- **Himnish branding** — company logo on the login screen, top bar, wallboard and
  as the browser favicon (public/assets/himnish-logo.png).
- **Predict tab** — rate of temperature rise per traction motor (least-squares
  slope, °C/min) and an estimated time-to-critical projection, sorted soonest
  first, with urgent/watch/rising risk levels.
- **Rapid-rise alert** — a new alert severity fires when a TM heats faster than
  the admin-set rate (Admin → Thresholds → "Rapid rise ≥ °C/min", default 3).
  Configurable routing in Notify like any other alert.

## Fixes: refresh, offline coaches, footer (new)

- **No more flicker / threshold reset** — only live-data views auto-refresh;
  Admin, Notify, Analytics, Reports, Swap and Maintenance are left alone while
  you edit them (fixes the threshold fields resetting before save, and the
  Analytics chart flickering).
- **Offline coaches now visible** — coaches configured in Admin that are not
  reporting appear as OFFLINE (with 4 TM slots) alongside the online ones, so an
  operator can see exactly which coach has a problem.
- **Company footer** — HIMNISH LIMITED details on every page (edit address /
  phone / email / website in the footer block of public/index.html).

## Depots, System Status, CSV exports, Bulk import, Password policy (new)

- **Depot management** (Admin → Depots) — depot ID, name, region, and lat/lng
  (coordinates ready for a future map), with EMU/coach counts.
- **System Status** (Admin) — DB mode, uptime, readings ingested, online/offline
  sensors, active alerts, and per-coach last-communication time.
- **CSV exports** — Maintenance and Audit trail each export to CSV.
- **Bulk coach import** (Admin) — paste `coach_id, emu_id, position` lines to
  create many coaches at once.
- **Password policy** — minimum 8 characters enforced on create / change.

## Per-user scoped reporting & alerts (new)

- Users now have **email + mobile** (Admin → Users). Add/Edit prompts collect them.
- **Alerts are scoped**: when a coach crosses a threshold, only the users
  assigned that coach/EMU (plus Super Admin / Railway HQ, and any control-room
  recipients on the rule) receive the SMS/email — nobody gets alerts for coaches
  outside their assignment.
- **Daily report email is scoped**: each user receives a report link limited to
  their assigned assets (date-range selectable on the printable report).
- **Report downloads are scoped**: a user can only export (Excel/PDF/CSV) the
  coaches/EMUs assigned to them (others return 403).
- **Server-side history**: with PostgreSQL attached, every reading is stored
  permanently, so any date-range report can be regenerated at any time.

Company contact: www.himnishprojects.com · sales@himnishindia.com ·
+91-8745012381, +91-9873909306

## GIS Depot Map (new)

- **Map tab** — India map (Leaflet + OpenStreetMap, no API key) with a marker for
  each depot that has coordinates. Marker colour: green = all coaches healthy,
  red = any coach in alert/offline, grey = no coaches. Click a marker to see the
  depot's coaches and live status.
- Add each depot's **Latitude/Longitude in Admin → Depots** to place it on the map.
  Depots without coordinates are listed below the map.
- Scoped: a user only sees depots/coaches within their assignment.

## Prognostics, offline buffering, MQTT (new)

- **Prognostics** (Predict tab) — statistical battery-life projection from the
  observed discharge rate (%/day → estimated days left) and a thermal-degradation
  trend (baseline vs recent average → improving / stable / degrading), with a
  per-TM verdict. This is a transparent statistical method, not a trained ML model
  (a true bearing-failure ML model needs labelled failure data + vibration input).
- **Offline buffering** — the ingest API accepts an optional `ts` timestamp, so a
  gateway that buffered readings during a network outage can replay them with
  their original time; replayed (older) readings are archived to history without
  overwriting the live value or firing stale alerts. See
  `RUT200_Startup_Script_BUFFERED.sh` for a RUT200 script that buffers to a local
  file and replays on reconnect.
- **MQTT ingestion** (optional) — set `MQTT_URL` (+ topic/credentials) to ingest
  JSON messages from an MQTT broker, alongside the HTTP push path. Disabled and
  harmless when unset.
- **Redundancy/failover** is a hosting concern: on Railway, enable replicas +
  a managed PostgreSQL with backups. The app itself already degrades safely
  (DB errors never crash it; master data persists to disk).

## Self-updating field devices (RUT pulls its own config)

Register each RUT in **Admin → Field Devices** with a unique Device ID. Each RUT
runs a generic bootstrap script (`RUT200_Bootstrap_SelfUpdate.sh`) where only
`DEVICE_ID` and `BASE` (app URL) are set once. The RUT pulls its config
(assigned coach, Modbus tag mapping, API key, interval, enable/disable) from
`GET /api/v1/device-config?device=<id>&key=<BOOTSTRAP_KEY>` every few minutes and
reconfigures itself — change anything in the dashboard and the device updates on
its own, no site visit. `last_seen` shows the last check-in. Set `BOOTSTRAP_KEY`
in the server env (default himnish_bootstrap_2025).

## Retention, API docs, session timeout, backup/restore, assistant (new)

- **Data retention** — set `RETENTION_DAYS` (>0) to auto-purge readings older
  than N days once a day (needs PostgreSQL). Default 0 = keep forever.
- **API docs (Swagger)** — interactive OpenAPI docs at `/docs` (spec at
  `/openapi.json`), useful for tender technical review and integrators.
- **Session timeout** — the dashboard auto-signs-out after 30 minutes of
  inactivity, with a warning one minute before.
- **Backup & Restore** (Admin) — download all master data (users, EMUs, coaches,
  depots, devices, thresholds, config) as a JSON backup, and restore from it.
- **Fleet Assistant** (Assistant tab) — ask in plain words ("which coaches are
  critical", "show offline", "hottest TM", "lowest battery", "active alerts",
  "summary"); answers from live data. Rule-based over your own data — not an
  external AI service (a natural-language LLM copilot would need an LLM API key).

## Production security hardening (new)

- **Security headers** on every response: X-Content-Type-Options nosniff,
  X-Frame-Options SAMEORIGIN, Referrer-Policy no-referrer, HSTS.
- **Rate limiting** (in-memory, no dependency): login is brute-force protected
  (40 attempts / 15 min / IP); the dashboard API has a generous global cap
  (600/min/IP). Hardware **ingest and device-config are exempt** so RUT posting
  is never throttled.
- **Input validation**: readings outside −40…250 °C are rejected.
- **HTTPS enforcement**: optional `FORCE_HTTPS=true` redirects http→https.

## AI Copilot, anomaly detection, bilingual UI (new)

- **AI Copilot (LLM-ready)** — set `LLM_API_KEY` (+ `LLM_URL`, `LLM_MODEL`) to
  enable natural-language answers in the Assistant tab, powered by any
  OpenAI-compatible model. The model only receives your (scoped) fleet data.
  Without a key, the Assistant falls back to the built-in rule-based logic.
- **Peer anomaly detection** (Predict tab) — an unsupervised, no-labels-needed
  early warning: a motor running much hotter than its sibling motors on the same
  coach is flagged before it crosses an absolute threshold. (A trained ML
  failure/RUL model would additionally require labelled failure history and
  vibration sensors, which this system does not yet collect.)
- **Bilingual UI** — a हिं / EN toggle in the top bar translates the core
  navigation and section headings. (Deep dynamic labels remain English for now.)
- **Redundancy note** — the app already flushes state on SIGTERM (clean
  restarts). True multi-instance HA on Railway = enable replicas + managed
  PostgreSQL with backups; shared live state across replicas would need Redis.
