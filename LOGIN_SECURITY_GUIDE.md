# Login security guide - emu.himinsights.in

HIMNISH LIMITED. For the super admin and for anyone who signs in to the dashboard.
No passwords or keys are written in this file.

---------------------------------------------------------------------------
## 1. What protects the sign-in now

| Protection | What it does |
|---|---|
| Password rules | at least 10 characters, 3 of (small, CAPITAL, digit, symbol) or a passphrase of 16+; no username, no "password", "admin", "himnish", 1234, abcd |
| Own password only | a new or reset user must choose their own password at the first sign-in. The admin never knows it. |
| Account lock | 5 wrong passwords lock that account for 15 min (30, 60 ... up to 24 h if it repeats). A user name that does not exist behaves the same, so nobody can find out who has an account. |
| Address gate | 30 FAILED sign-ins per address per 15 min are refused. Successful sign-ins never count, so a whole depot behind one public IP can sign in every morning. |
| Two-step verification | password + a 6-digit code from Google / Microsoft Authenticator. Each code works once. 8 one-time recovery codes for a lost phone. |
| Real sign-out | logout, "sign out on all devices", password change, disable, delete and role change end sessions at once on the server. A stolen or copied token stops working. |
| Live role check | the role is read from the server on every request, so a demoted or deleted person loses access immediately. |
| Safe storage | passwords stored as scrypt hashes (old ones upgrade at the next sign-in); the state file is readable by the app user only. |
| Auto sign-out | 30 minutes without activity (not on the control-room wallboard). A sign-in lasts at most 8 hours. |
| Browser hardening | strict Content-Security-Policy, no caching of account data, no framing. |
| Records | Admin -> "Sign-in security events": wrong passwords, locks, resets, 2-step changes, forced sign-outs. |

Two things cannot be removed: someone who knows the password AND has the phone can sign in, and
someone who can log in to the server can run the recovery script (section 6).

---------------------------------------------------------------------------
## 2. First day after deploy (do in this order)

1. Deploy the update (commands in the chat / DEPLOY.md). Everyone is signed out once.
2. Sign in as `admin` with the current password. It is forced to be replaced right away.
   If the first-run default is still in use, the screen "Set a new password" appears.
3. Click the person icon (top bar) -> "Turn on 2-step". Scan/type the key in your authenticator app,
   type the code, and PRINT or write down the 8 recovery codes. Keep them in a locked drawer.
4. Create a SECOND super admin for yourself as a spare (Admin -> Users -> + Add user, role
   super_admin) and give that person 2-step too. Then one lost phone can never lock everyone out.
5. Give every other user a temporary password (+ Add user). They choose their own at the first sign-in.
6. Change the other secrets that were shown in chat (JWT_SECRET, database and mail passwords) -
   see the infrastructure file.
7. Optional, later: add `REQUIRE_2FA_ROLES=super_admin` to `.env` so admins cannot skip 2-step.
   Turn it on only after every admin has set 2-step up.

---------------------------------------------------------------------------
## 3. For every user

- Change my password: person icon -> "Change password". This signs out all my other devices.
- Turn 2-step on / off: person icon -> "Turn on 2-step". Turning it off needs the password and a code.
- Lost phone: type one recovery code instead of the 6-digit code (each works once), then set 2-step up again.
- No recovery code either: ask the super admin ("Reset 2-step").
- "Account is locked": wait the shown minutes, or ask the super admin to "Unlock".
- Never share a password. Never type it on someone else's phone. Sign out on shared PCs.

---------------------------------------------------------------------------
## 4. For the super admin (Admin page -> Users & Roles)

| Button | Use it when | What happens |
|---|---|---|
| Reset password | someone forgot it | a strong temporary password is shown ONCE; they are signed out everywhere; they must set a new one at the next sign-in. Give it by phone or in person, not in a group chat. |
| Unlock | account is locked and the user is sure of the password | lock removed at once |
| Disable / Enable | staff transferred, on leave, or you suspect misuse | disabled = signed out at once and cannot sign in; nothing is deleted |
| Sign out | a PC was left open | every session of that user ends |
| Reset 2-step | phone AND recovery codes lost | 2-step removed; the user sets it up again |
| Delete | person left the company | account removed, sessions end at once |

The last active super admin cannot be deleted, disabled or demoted.
Review "Sign-in security events" every week. Many "Wrong password" lines for one user or one address,
or an "Account LOCKED" line you did not expect, means someone is guessing passwords.

---------------------------------------------------------------------------
## 5. Settings in `.env` (all optional)

    LOGIN_MAX_FAILS=5         wrong passwords before an account locks
    LOGIN_LOCK_MINUTES=15     first lock length; doubles at each repeat (max 24 h)
    LOGIN_IP_MAX_FAILS=30     failed sign-ins per address per 15 min
    LOGIN_PARALLEL=4          password checks at the same moment (the rest wait a moment)
    JWT_TTL=8h                length of one sign-in
    REQUIRE_2FA_ROLES=        e.g. super_admin (see step 7 above)
    ADMIN_INITIAL_PASSWORD=   first start only; remove the line afterwards
    API_RATE_MAX=3000         dashboard API calls per minute per office address

After editing `.env`:  `pm2 restart all --update-env`

---------------------------------------------------------------------------
## 6. Break-glass: nobody can sign in (only for someone with server access)

Example: the only admin lost the phone and the recovery codes, or the account is locked.

    ssh to the server
    cd ~/himnish-raip-d3-emu
    pm2 stop emu-d3                        # the app MUST be stopped first
    node scripts/recover-admin.js admin    # prints a temporary password ONCE
    pm2 start emu-d3

The user is signed in with the temporary password, is forced to choose a new one, and has no
2-step until they set it up again. The recovery is written to the security events (address
"server-console") and to the audit trail. Never run the script while the app is running: the running
app would overwrite the change.

---------------------------------------------------------------------------
## 7. What was tested (28 Sep 2026)

- 31 unit tests: password rules, scrypt and old-bcrypt hashes, TOTP against the official RFC 6238 test values
- 78 server tests: forced password change, weak passwords, lock-out, unknown users, per-address gate,
  sign-out/revoke, live role checks, 2-step (replay, recovery codes, lock-out), backup and restore,
  30 people signing in at once while RUT data keeps flowing, timing of unknown vs known users
- 37 browser tests on a laptop and on a phone size: all new screens, no script errors, no policy violations
- upgrade of a state file written by the previous version; the recovery script on a locked admin with 2-step on

NOT tested: a real phone authenticator app (codes were computed by the same RFC 6238 code), a real
Postgres for the recovery script (same load/save code as the app, tested on the JSON state), and
the wallboard staying signed in past 30 minutes.
