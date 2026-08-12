# EMU Motor Coach TM Monitoring — Go-Live Checklist
**HIMNISH LIMITED** · what YOU need to do on Railway to make the deployed system fully production-grade.
The application code is complete and deployed. These are account/keys tasks only Claude cannot do for you.

---

## 1. PostgreSQL — permanent history (MOST IMPORTANT)
Without this, data lives in memory/JSON and can be lost on restart.

1. Railway → your project → **New** → **Database** → **Add PostgreSQL**
2. Open your **app service** → **Variables** → confirm a `DATABASE_URL` reference to the new DB
   (Railway usually links it automatically; if not, add `DATABASE_URL` = the Postgres connection string)
3. **Redeploy** the app service
4. Open the deploy **logs** → you should see: `DB=PostgreSQL`
   (if it still says `JSON+memory`, the variable isn't linked)

✅ Done when logs show `DB=PostgreSQL`.

---

## 2. Security variables (set before real tender use)
Railway → app service → **Variables** → add:

| Variable        | Value                                        |
|-----------------|----------------------------------------------|
| `JWT_SECRET`    | a long random string (40+ chars)             |
| `DATA_API_KEY`  | your own key (must match the RUT push key)   |
| `BOOTSTRAP_KEY` | your own key (must match the RUT bootstrap)  |
| `DEMO_MODE`     | `false`                                      |

⚠️ If you change `DATA_API_KEY` or `BOOTSTRAP_KEY`, update the RUT script(s) to match,
or the field devices will stop talking to the server.

✅ Done when the `[SECURITY] ... default` warnings disappear from the logs.

---

## 3. SMS / Email (only when you want real alerts to send)
Until set, alerts are computed and shown on the dashboard but SMS/email run in log/dry-run mode.

**Email (SMTP):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
**SMS:** `SMS_PROVIDER` (e.g. fast2sms/msg91), `SMS_API_KEY`, `SMS_SENDER`

Then in the dashboard → **Notify** → "Send test" to verify.

---

## 4. Optional extras
- **AI Copilot:** set `LLM_API_KEY` (+ `LLM_URL`, `LLM_MODEL`) to make the Assistant answer via a real LLM.
  Costs money per use. Without it, the rule-based Assistant works.
- **Data retention:** set `RETENTION_DAYS` (e.g. `1825` for 5 years) to auto-purge older readings (needs PostgreSQL).
- **Force HTTPS:** `FORCE_HTTPS=true` (Railway already serves https; usually not needed).

---

## 5. Field devices (RUT) — remote, no site visits
- Each RUT runs `RUT200_Bootstrap_SelfUpdate.sh` with only `DEVICE_ID` + `BASE` set once.
- Register the device in **Admin → Field Devices**, assign its coach + tags.
- Change anything there later → the RUT updates itself within ~5 min.
- "Last Seen" shows each device's last check-in.

---

## What is already DONE (no action needed)
Real-time monitoring · RBAC (5 roles) + scoped access · alerts + escalation · SMS/email framework ·
scoped reports (Excel/PDF/CSV + historical + daily email) · Predict + Prognostics + Peer Anomaly detection ·
GIS Depot Map · Digital Twin · Heatmap · Analytics · Topology · Devices · Coach Swap · Maintenance ·
Health Index · Audit (+CSV) · Sensor Registry · Depots · System Status · Backup/Restore · Bulk import ·
Wallboard · Fleet Assistant (rule-based, LLM-ready) · self-updating RUT · offline buffering · MQTT ·
data retention · API docs (/docs) · session timeout · security hardening · Hindi/English toggle.

Contact: www.himnishprojects.com · sales@himnishindia.com · +91-8745012381, +91-9873909306
