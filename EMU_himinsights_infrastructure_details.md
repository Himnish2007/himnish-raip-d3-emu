# emu.himinsights.in - Infrastructure Details (AWS + Railway + GitHub)

HIMNISH LIMITED - HIMNISH RAIP D3, EMU Motor Coach TM Monitoring
Prepared: 28 Sep 2026

CONFIDENTIAL. This file lists systems, IDs and default keys. Do NOT email it,
upload it to GitHub or share it outside the company. Real passwords and secrets are
NOT written here: keep them in a password manager (see section 8).

Lines marked  [TO CONFIRM]  were not verified. Fill them in from the AWS / Railway /
GitHub consoles.

---------------------------------------------------------------------------
## 1. How the system fits together

    Dashboard users (browser)
            |  https://emu.himinsights.in
            v
    AWS EC2 (Mumbai)  --  Nginx (HTTPS)  -->  Node app "emu-d3" on port 3000
                                                     |
                                                     v
                                       AWS RDS PostgreSQL "database-1"

    Field devices (Teltonika RUT200, one per motor coach)
        DEV-01, DEV-02, DEV-04  -> [TO CONFIRM which URL each one calls]
        DEV-03 (Kolkata)        -> https://himnish-raip-d3-emu-production.up.railway.app
                                   (Railway RELAY) -> forwards to https://emu.himinsights.in

    Code: GitHub  Himnish2007/himnish-raip-d3-emu  (branch main)
          PC push -> GitHub -> AWS server "git pull" ; Railway rebuilds from the same repo

Why Railway is still needed: DEV-03 in Kolkata is hard-coded to the Railway URL and
cannot be changed without a site visit. The Railway app only relays two calls
(/api/v1/device-config and /api/v1/ingest) to AWS. It holds no real data.

**Never delete the Railway service/project.** If its URL changes or disappears, DEV-03
can no longer reach the system.

---------------------------------------------------------------------------
## 2. Quick reference

Dashboard (production)   https://emu.himinsights.in
Health check             https://emu.himinsights.in/healthz   -> {"ok":true,"demo":false}
Railway relay URL        https://himnish-raip-d3-emu-production.up.railway.app
GitHub repo              https://github.com/Himnish2007/himnish-raip-d3-emu
AWS console region       Asia Pacific (Mumbai)  ap-south-1
AWS account              HIMNISH LIMITED  (account ID 667075222130)
EC2 public IP            35.154.98.154
RDS endpoint             database-1.c9wow4o44b1i.ap-south-1.rds.amazonaws.com : 5432

---------------------------------------------------------------------------
## 3. AWS

### 3.1 EC2 server (application)
- Region: ap-south-1 (Mumbai)
- Public IP: 35.154.98.154   [TO CONFIRM it is an Elastic IP; if not, it changes on stop/start]
- Private IP: 172.31.7.212  (hostname ip-172-31-7-212)
- OS: Ubuntu 26.04.1 LTS, kernel 7.0.0-1012-aws (x86_64)
- Disk: about 28 GB root volume (about 11% used on 25 Sep 2026)
- Instance ID / instance type: [TO CONFIRM - EC2 console]
- Login user: ubuntu
- SSH key file: himinsights-key.pem
    Stored on the office PC "Himnish" at C:\apps\himinsights-key.pem
    Working copy: C:\keys\himinsights-key.pem  (permissions set with icacls)
- Pending on server: "System restart required" + 4 package updates (as of 25 Sep 2026)

SSH from Windows CMD:
    ssh -i C:\keys\himinsights-key.pem ubuntu@35.154.98.154

### 3.2 Security group (EC2)  "launch-wizard-1"  sg-0027634c26b8ef878
Inbound rules:
    SSH   22   TCP   122.183.41.240/32   (office IP, set 25 Sep 2026; was 122.183.41.124/32)
    HTTP  80   TCP   0.0.0.0/0
    HTTPS 443  TCP   0.0.0.0/0
Rule IDs: SSH sgr-0268032c177abcaec, HTTP sgr-08c09887acbf182c6, HTTPS sgr-0bce21d532f5ec1a9

IMPORTANT: SSH is locked to ONE IP. When the office ISP IP changes, SSH times out
("Connection timed out") while the website keeps working. Fix: EC2 -> Security Groups
-> sg-0027634c26b8ef878 -> Edit inbound rules -> update the SSH source to the new
IP (find it with: curl -s https://api.ipify.org) and add /32.

### 3.3 Application on the server
- App folder: /home/ubuntu/himnish-raip-d3-emu
- Process manager: PM2, process name  emu-d3  (id 0, fork mode)
- App port: 3000 (behind Nginx)
- Environment file: /home/ubuntu/himnish-raip-d3-emu/.env   (never commit; see section 6)
- Old env template moved out of the repo: ~/env-backup-2026-09-25.save
  (contains a weak JWT secret - treat as compromised, do not reuse)
- Logs: ~/.pm2/logs/emu-d3-out.log and ~/.pm2/logs/emu-d3-error.log
- Local data fallback folder: /home/ubuntu/himnish-raip-d3-emu/data
- Reverse proxy / SSL: Nginx + Let's Encrypt (Certbot) [TO CONFIRM - verify with the
  commands in section 9]
- Node.js version on server: [TO CONFIRM  - run: node -v]

### 3.4 Database - Amazon RDS  "database-1"
- Engine: PostgreSQL (standard RDS instance, NOT Aurora)
- Class: db.t3.micro   AZ: ap-south-1a   Port: 5432
- Endpoint: database-1.c9wow4o44b1i.ap-south-1.rds.amazonaws.com
- Master user: postgres      Database name: himinsights_emu  [TO CONFIRM against live .env]
- Master password: in password manager / live .env (NOT written here)
- Engine version: [TO CONFIRM - RDS -> database-1 -> Configuration]
- Network: NOT publicly accessible. Security group "default" (sg-0f72759f462f4818d)
  accepts connections only from the EC2 security group sg-0027634c26b8ef878.
  => pg_dump / psql only work from the EC2 server, not from a PC.
- Tables created by the app: readings (time series), app_state (master data JSON)
- TimescaleDB: not used (plain table)
- App setting for RDS SSL:  PGSSL=require   (and DATABASE_URL in .env)

Backups / snapshots
- Live DB manual snapshot: [TO CONFIRM - RDS -> Snapshots -> Manual, look for one whose
  ARN contains ":snapshot:" (not ":cluster-snapshot:")]
- Automated backups + retention (7 days or more) + Deletion protection: [TO CONFIRM]
- Two OLD snapshots exist from earlier, deleted database clusters created and deleted
  on 15 Sep 2026. They hold no live data (kept only as records):
    himinsights-db-final-snapshot   (cluster snapshot, 15 Sep 2026 13:21)
    database-1-final-snapshot       (Aurora PostgreSQL 17.9, 15 Sep 2026 12:40, 0 GiB)
  Do not restore them. They can be deleted later to avoid storage charges.

### 3.5 DNS / domain
- Domain: himinsights.in ; host name used: emu.himinsights.in
- Must point (A record) to the EC2 public IP 35.154.98.154
- Registrar / DNS provider: [TO CONFIRM]
- Alert mail sender (SMTP): piyush@himnishindia.com (GoDaddy-hosted mailbox)

---------------------------------------------------------------------------
## 4. Railway

- Project: EMU-TEMP-HYBRID      Environment: production
- Service: himnish-raip-d3-emu  (connected to the GitHub repo above)
- Project ID:  7dade52c-f7dc-4043-b584-f2cdcc2fc43d
- Service ID:  fe7db993-bb92-424f-97ae-db057169403b
- Public URL:  https://himnish-raip-d3-emu-production.up.railway.app
- Last known deployment: 250a82d8, Active, 16 Sep 2026 13:14 IST
- Variable that makes it a relay (the ONLY one set by hand):
      RELAY_TARGET = https://emu.himinsights.in
  (8 more variables are added automatically by Railway.)
- Deploy log line proving relay is active:
      [relay] field-device traffic (/api/v1/device-config, /api/v1/ingest) -> https://emu.himinsights.in
- Container port 8080, data folder /app/data, DB mode "JSON+memory" (temporary, not used).
- Also seen in an old script comment (status unknown):
      web-production-39799-emu-mc-temp.up.railway.app
- Security: this public app also seeds the default admin login and default keys.
  Set its own JWT_SECRET and change the admin password (Railway -> Variables) even
  though it holds no real data.

Rules for Railway
1. Do not delete or rename the service, do not regenerate the domain.
2. Keep RELAY_TARGET set. If it is removed, DEV-03 goes offline silently.
3. A push to the GitHub main branch normally redeploys it automatically. Confirm it
   still shows "Online" after every push.

---------------------------------------------------------------------------
## 5. GitHub

- Account: Himnish2007
- Repository: himnish-raip-d3-emu   (branch: main)
- Clone URL: https://github.com/Himnish2007/himnish-raip-d3-emu.git
- Repository visibility (public / private): [TO CONFIRM]
- Known commits: 4d3de3e "remove leaked SSH key, add .gitignore for .pem files"
                 758fe0f (earlier main)   cbd41f4 "fix: alert email time IST mein"
- Working copies:
    Office PC "Himnish":  C:\app\himnish-raip-d3-emu-UPDATED\himnish-raip-d3-emu   (push from here)
    AWS server:           /home/ubuntu/himnish-raip-d3-emu                          (git pull here)

WARNING - key in git history
A commit message says a leaked SSH key was removed from the repo. A removed file is
still readable in git history. And the current .gitignore does NOT list *.pem or
.env.save (checked 28 Sep 2026; only node_modules, .env, *.log, data/ are ignored).
Actions: (a) rotate the EC2 key pair (section 10), (b) add these lines to .gitignore:
    *.pem
    *.key
    .env.*
    *.save
(c) if the repo is public, treat the old key as exposed.

---------------------------------------------------------------------------
## 6. Application settings (.env on the server) - names only

Variable            Purpose
PORT                3000 on AWS (Railway uses 8080)
DATABASE_URL        postgresql://postgres:<password>@<RDS endpoint>:5432/himinsights_emu
PGSSL               require  (RDS connection over SSL)
JWT_SECRET          signs login tokens - must be a long random value
JWT_TTL             login token life (default 12h)
DATA_API_KEY        key the RUTs use to POST readings (default is public - rotate)
BOOTSTRAP_KEY       key the RUTs use to pull their config (default is public - rotate)
DEMO_MODE           false in production
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM     alert e-mail (GoDaddy mailbox)
SMS_PROVIDER / SMS_API_KEY / SMS_SENDER / SMS_URL                 SMS ('log' = no real SMS)
REPORT_BASE_URL     https://emu.himinsights.in  (links in daily report e-mails)
CFG_*               starting defaults for thresholds (editable later in the dashboard)
RELAY_TARGET        Railway ONLY (never set on AWS)
MAX_COACHES         optional, default 2000
BACKFILL_HOURS, RETENTION_DAYS, FORCE_HTTPS, MQTT_*, LLM_*   optional

The live .env has 12 variables loaded (seen in the PM2 log: "injected env (12)").
After editing .env run:   pm2 restart all --update-env

---------------------------------------------------------------------------
## 7. Field devices and alerts

EMU: 32338     Modbus tags per coach: 1.3, 1.4, 1.5, 1.6 (TM1 to TM4)
Ingest path: /api/v1/ingest      Config pull: /api/v1/device-config?device=<ID>&key=<BOOTSTRAP_KEY>

Device   Coach     Notes
DEV-01   128296    online on 25 Sep 2026
DEV-02   128297    online on 25 Sep 2026
DEV-03   128298    Kolkata. Calls the Railway URL. Last data 19 Sep 2026 06:55:19 IST.
                   Jio prepaid SIM, Rs 349 / 28 days, recharged 5 Sep 2026 -> expires about 3 Oct 2026.
                   Powered from the coach supply (77-130 VDC). Current status: [TO CONFIRM]
DEV-04   128299    online on 25 Sep 2026

Recommended thresholds (Admin -> Thresholds):
    Device push interval 20 s | Offline after 90 s | Data logging interval 600 s (10 min)
    Warning > 70, High > 80, Critical > 90 deg C
    Do not set "Offline after" below about 3 x the push interval, or coaches flap offline.

Alert e-mail recipients (offline rule): emu.hwh.divn.tm.temp.alert@gmail.com, piyush@himnishindia.com
SMS: real SMS needs SMS_PROVIDER + SMS_API_KEY in .env [TO CONFIRM if configured]

---------------------------------------------------------------------------
## 8. Secrets register  (fill from your password manager - do NOT type real values here)

Item                              Where it lives                    Value
EC2 SSH key (.pem)                C:\apps\ and C:\keys (office PC)  keep the file, not text
RDS master password               server .env (DATABASE_URL)        [password manager]
JWT_SECRET                        server .env                       [password manager]
DATA_API_KEY                      server .env + RUT scripts         currently DEFAULT: himnish_emu_key_2025
BOOTSTRAP_KEY                     server .env + RUT scripts         currently DEFAULT: himnish_bootstrap_2025
Dashboard admin login             app database                      seeded default admin / himnish@2025 - MUST be changed
SMTP password (GoDaddy mailbox)   server .env                       [password manager]
SMS API key                       server .env                       [password manager]
AWS console login                 -                                 [password manager]
Railway login                     -                                 [password manager]
GitHub login / token              -                                 [password manager]

---------------------------------------------------------------------------
## 9. Everyday commands

Deploy a code update
  Office PC (CMD):
      cd C:\app\himnish-raip-d3-emu-UPDATED\himnish-raip-d3-emu
      git status
      git add -A
      git commit -m "describe the change"
      git push
  AWS server (after ssh):
      cd ~/himnish-raip-d3-emu
      git pull
      pm2 restart all --update-env
      pm2 logs --lines 30
  (If git pull says "local changes would be overwritten": git checkout -- <that file>, then pull again.)

Check that everything is alive
      curl -s https://emu.himinsights.in/healthz
      curl -s https://himnish-raip-d3-emu-production.up.railway.app/healthz
  Server:
      pm2 status
      sudo nginx -t
      sudo certbot renew --dry-run
      df -h /
      node -v

Test the DEV-03 path (replace the key)
      curl -s "https://himnish-raip-d3-emu-production.up.railway.app/api/v1/device-config?device=DEV-03&key=<BOOTSTRAP_KEY>"
  A JSON reply with "enabled":true means relay, AWS and the registration are fine. If DEV-03
  still shows offline, the fault is on site: power, SIM or signal.

Backup the whole server (run on the server, then download the .tar.gz)
      bash aws_backup.sh      (script provided separately: aws_backup.sh)
  It collects app + .env, Nginx, SSL certs, PM2 and a pg_dump of RDS.

---------------------------------------------------------------------------
## 10. Priority to-do list

1. Rotate the EC2 SSH key pair (the .pem was uploaded to a chat and a leaked key was once
   committed to GitHub). Create a new key pair, add its public key to ~/.ssh/authorized_keys,
   test login, then remove the old line.
2. Add *.pem, *.key, .env.*, *.save to .gitignore; check whether the GitHub repo is public.
3. Change the dashboard admin password (both AWS app and Railway app).
4. Set a new random JWT_SECRET on the AWS server and on Railway
   (generate: openssl rand -hex 32). All users must log in again.
5. Take a manual snapshot of RDS "database-1" and turn on automated backups + deletion protection.
6. Run aws_backup.sh and store the .tar.gz outside the server.
7. DEV-03: check power, LEDs and SIM. Jio plan ends about 3 Oct 2026 - recharge in time.
8. Rotate DATA_API_KEY and BOOTSTRAP_KEY ONLY after every RUT (incl. DEV-03) can self-update,
   otherwise devices go offline permanently.
9. Nginx must set:  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   (check: grep -rn "X-Forwarded-For" /etc/nginx/)
10. Reboot the AWS server in a quiet window for the pending update, then run:
    pm2 status   (the app must be online again; PM2 must be set to auto-start).
11. Consider restricting SSH further (AWS Systems Manager Session Manager) instead of a single IP.

---------------------------------------------------------------------------
## 11. Recovery cheat-sheet

AWS server lost:   launch a new Ubuntu EC2, attach Elastic IP, install Node + Nginx + PM2 +
                   Certbot, clone the GitHub repo, restore .env from the backup archive,
                   restore Nginx config + certificates, pm2 start server.js --name emu-d3.
Database lost:     restore RDS from the latest ":snapshot:" (RDS -> Snapshots -> Restore).
                   Update DATABASE_URL if the endpoint changes.
Railway lost:      DEV-03 cannot be reached again without a site visit. Recreate a service
                   from the same repo with RELAY_TARGET=https://emu.himinsights.in and hope the
                   domain can be recovered - so protect it (do not delete).
Site not opening:  1) healthz  2) pm2 status  3) sudo nginx -t  4) pm2 logs.
SSH timeout:       office IP changed - update the SSH source in the security group.
One coach offline: 1) Admin -> Field Devices -> Last Seen  2) System Status -> Last Comm
                   3) if Last Seen updates but Last Comm never does: RUT is up, sensor/Modbus
                      is not sending. If neither updates: RUT power, SIM or signal.

---------------------------------------------------------------------------
## 12. Application changes shipped in the latest update (zip dated 28 Sep 2026)

- Alert e-mail time now shows IST (was UTC).
- Editable "Data logging interval" (default 10 min) separate from "Device push interval".
- One offline alert (one e-mail, one SMS) per coach instead of one per sensor.
- Deleted coaches no longer re-appear after redeploy; no "offline" alert storm at restart.
- Security fixes: escaped dashboard output, validated device IDs, login rate-limit fix,
  report-link tokens limited to reports, threshold validation, safe backup restore.
