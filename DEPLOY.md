# DEPLOY — EMU Motor Coach TM Temperature Monitoring
**HIMNISH LIMITED** · www.himnishprojects.com · sales@himnishindia.com · +91-8745012381, +91-9873909306

---

## STEP 1 — Put the files in the right place

1. Extract this zip into a **temp folder** (e.g. `C:\temp`).
2. You will get a folder named **`himnish-raip-d3-emu`**.
3. Open that folder — you should see `server.js`, `package.json`, `src`, `public` **directly** inside.
4. Copy **everything from inside that folder** and paste into **`C:\app\himnish-raip-d3-emu`**
   (choose **Replace the files in the destination**).

> **DO NOT delete `C:\app\himnish-raip-d3-emu`.** It contains a hidden `.git` folder.
> Keeping it means deployment is only 3 commands. Deleting it means 7 (see Step 2B).
> To see it: File Explorer → View → tick **Hidden items**.

> **CRITICAL:** `server.js` must end up at `C:\app\himnish-raip-d3-emu\server.js`
> — **NOT** at `C:\app\himnish-raip-d3-emu\himnish-raip-d3-emu\server.js`.
> Nested = Railway build fails.

---

## STEP 2A — Deploy (if `.git` still exists — the normal case)

Open CMD and run:

```
cd C:\app\himnish-raip-d3-emu
git add .
git commit -m "update"
git push
```

Done. Skip to Step 3.

---

## STEP 2B — Deploy (if you deleted the folder / `git push` says "No configured push destination")

```
cd C:\app\himnish-raip-d3-emu
git init
git add .
git commit -m "update"
git branch -M main
git remote add origin https://github.com/Himnish2007/himnish-raip-d3-emu.git
git push -u origin main --force
```

If it says `remote origin already exists`, just skip that line and run the last one.
When it asks to log in, choose **"Sign in with your browser"**.

Success looks like: `main -> main (forced update)`

---

## STEP 3 — Confirm

1. Open `https://github.com/Himnish2007/himnish-raip-d3-emu`
   → you must see `server.js`, `src/`, `public/` **directly** (not nested).
2. Railway → your service → **Deployments** → new build goes "Building → Active" (2–3 min).
   If it doesn't start on its own: **"⋮" → Redeploy**.
3. Open the app URL and press **Ctrl + F5** (hard refresh).

---

## STEP 4 — The 3 Railway settings that finish the job

See **GO-LIVE-CHECKLIST.md** in this folder for full detail. In short:

| # | What | Where |
|---|------|-------|
| 1 | **Add PostgreSQL** (most important — permanent history) | Railway → New → Database → Add PostgreSQL → link → redeploy → logs show `DB=PostgreSQL` |
| 2 | **Security variables** | Railway → Variables → `JWT_SECRET`, `DATA_API_KEY`, `BOOTSTRAP_KEY`, `DEMO_MODE=false` |
| 3 | **SMS / Email keys** (for real alerts) | Railway → Variables → `SMTP_*`, `SMS_PROVIDER`, `SMS_API_KEY` |

⚠️ If you change `DATA_API_KEY` or `BOOTSTRAP_KEY`, update the RUT200 script to match
or the field devices will stop reporting.

---

## Default login

```
username: admin
password: himnish@2025
```
**Change this after first login** (Admin → Users → Edit).

---

## What's in this folder

| Path | What |
|------|------|
| `server.js`, `src/`, `public/` | The application (this is what deploys) |
| `GO-LIVE-CHECKLIST.md` | The Railway steps you need to do |
| `comm/RUT200_Bootstrap_SelfUpdate.sh` | **Use this one** — self-updating gateway script |
| `comm/RUT200_Startup_Script_BUFFERED.sh` | Fallback — direct push + offline buffering |
| `comm/RUT200_Startup_Script_NEW.sh` | Fallback — simple direct push |
| `comm/PUSH_SPEC.md` | Ingestion API spec for integrators |
| `.env.example` | Every supported environment variable |
| `/docs` (in the running app) | Interactive API documentation |
