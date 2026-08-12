# HIMNISH RAIP D3 — LTE Communication Module Push Specification

This is the contract every Himnish LTE communication module follows to push
EMU traction-motor temperature data to the RAIP D3 cloud. One LTE module sits
in **one motor coach** and reports that coach's 4 traction-motor sensors.

Because the topology is *per coach* (1 concentrator + 1 LTE module + 4 sensors
travel together), a coach swap needs **no firmware change** — only a dashboard
reassignment. The module always reports its own `coach_id`; the cloud resolves
the current EMU from the live assignment table.

## Endpoint

```
POST  https://<your-railway-app>.up.railway.app/api/v1/ingest
```

Health check (optional, for connectivity verification on boot):

```
GET   https://<your-railway-app>.up.railway.app/api/v1/ping
```

## Authentication

Send the shared key in a header. Same family as D2's key convention.

```
X-API-Key: himnish_emu_key_2025
```

(The server value comes from the `DATA_API_KEY` env var — keep them in sync.)

## Content type

```
Content-Type: application/json
```

## Recommended payload — coach batch (one POST per coach per cycle)

Send all 4 TM readings of the coach in one request. Cheaper on the cellular
link and keeps the 4 readings time-aligned.

```json
{
  "coach_id": "MC-101",
  "emu_id": "EMU-01",
  "position": 1,
  "readings": [
    { "sensor_id": "MC-101-TM1", "tm_id": "TM1", "temperature": 58.4, "battery_health": 96, "signal_strength": 82 },
    { "sensor_id": "MC-101-TM2", "tm_id": "TM2", "temperature": 61.1, "battery_health": 95, "signal_strength": 80 },
    { "sensor_id": "MC-101-TM3", "tm_id": "TM3", "temperature": 54.7, "battery_health": 97, "signal_strength": 85 },
    { "sensor_id": "MC-101-TM4", "tm_id": "TM4", "temperature": 59.9, "battery_health": 94, "signal_strength": 79 }
  ]
}
```

## Alternative payload — single reading

```json
{
  "sensor_id": "MC-101-TM1",
  "tm_id": "TM1",
  "coach_id": "MC-101",
  "emu_id": "EMU-01",
  "temperature": 58.4,
  "battery_health": 96,
  "signal_strength": 82,
  "sensor_type": "wireless"
}
```

## Field reference

| Field            | Type    | Required | Notes                                                        |
|------------------|---------|----------|--------------------------------------------------------------|
| `coach_id`       | string  | yes      | Identity of the coach the module is mounted in.              |
| `emu_id`         | string  | optional | Only used the first time a coach is seen; thereafter the cloud uses the live assignment. |
| `position`       | int     | optional | Coach position 1–4 within the EMU.                           |
| `sensor_id`      | string  | yes      | Globally unique per sensor. Convention: `<coach>-TM<n>`.     |
| `tm_id`          | string  | optional | Traction motor label (`TM1`–`TM4`).                          |
| `temperature`    | number  | yes      | Degrees C, range 0–120 per tender.                           |
| `battery_health` | number  | optional | Percent 0–100. Drives the low-battery alert.                 |
| `signal_strength`| number  | optional | Percent 0–100.                                               |
| `sensor_type`    | string  | optional | `wireless` (default) or `wired`.                             |

## Cadence

Push at least once every 60 seconds per sensor (tender 4.3.5 / sensor update
interval). On a sudden temperature rise, push more frequently — the concentrator
already supports variable transmission interval (tender 4.2.5).

## Success response

```json
{ "ok": true, "accepted": 4, "sensor_ids": ["MC-101-TM1", "..."], "errors": [], "server_time": "2026-..." }
```

## Error responses

| HTTP | Meaning                          |
|------|----------------------------------|
| 401  | Missing or wrong `X-API-Key`.    |
| 400  | Bad payload (see `errors` array).|

## On-failure behaviour (recommended firmware logic)

1. Retry with backoff (e.g. 5s, 15s, 60s).
2. Buffer unsent readings locally; flush when connectivity returns.
3. The cloud auto-marks a sensor **offline** after `CFG_OFFLINE_SECONDS`
   (default 300s) of silence and raises an offline alert — so a clean reconnect
   is enough, no special "back online" message is needed.

---

## RUT200 pull mode (data fetched by IP address)

As an alternative to pushing, the server can **poll** a coach's RUT200 by its
IP address. Configure the coach in Admin → Motor Coaches with a RUT200 IP,
port, path and "Poll" enabled. Every `POLL_INTERVAL` seconds the server does:

```
GET  http://<rut200_ip>:<port><path>
```

The RUT200 must return JSON in either shape:

```json
{ "readings": [
  { "sensor_id": "MC-101-TM1", "tm_id": "TM1", "temperature": 58.4, "battery_health": 96, "signal_strength": 82 },
  ...
] }
```

or a bare array of those reading objects. The server tags them with the coach
it polled, so the RUT200 response does not need to repeat `coach_id`.

NETWORKING: the server must be able to reach the RUT200 IP. On Railway (cloud)
that needs a public/static IP, DDNS, or a VPN/tunnel to the router. On an
on-prem/LAN server the private 192.168.x.x address works directly. Push mode
avoids this entirely and is recommended when the server is in the cloud.
