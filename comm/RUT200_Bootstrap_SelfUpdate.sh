#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════
# HIMNISH LIMITED — EMU Motor Coach TM Monitoring
# RUT200 SELF-UPDATING Bootstrap Script
# System -> Maintenance -> Custom Scripts -> Startup Script
#
# Paste this ONCE at installation. Only change DEVICE_ID (unique per RUT)
# and BASE (your app URL). Everything else — which coach, tag mapping,
# API key, interval, enable/disable — is pulled from the dashboard every
# few minutes. Change it in Admin -> Field Devices; the RUT updates itself.
# No need to ever visit the RUT again.
#
# Also buffers readings locally when offline and replays them on reconnect.
# ═══════════════════════════════════════════════════════════════════════

sleep 20

# ---- SET ONCE PER DEVICE ----
DEVICE_ID="DEV-01"                                   # UNIQUE per RUT (e.g. DEV-01, DEV-02...)
BASE="https://REPLACE-WITH-YOUR-APP.up.railway.app"  # your app URL (no trailing slash)
BOOTSTRAP_KEY="himnish_bootstrap_2025"               # must match BOOTSTRAP_KEY on the server

CONFIG_REFRESH=300                                   # re-pull config every 5 min
BUFFER="/tmp/emu_buffer.jsonl"

post() { curl -s -f -m 15 -X POST "$1" -H "Content-Type: application/json" -H "X-API-Key: $2" -d "$3" >/dev/null 2>&1; }
flush() {
  [ -s "$BUFFER" ] || return 0
  TMP="${BUFFER}.t"; : > "$TMP"; OK=1
  while IFS= read -r ln; do
    if [ "$OK" = "1" ] && post "$SERVER" "$KEY" "$ln"; then :; else OK=0; echo "$ln" >> "$TMP"; fi
  done < "$BUFFER"; mv "$TMP" "$BUFFER"
}

while true; do
  # ---- pull my config from the dashboard ----
  CFG=$(curl -s -m 15 "$BASE/api/v1/device-config?device=$DEVICE_ID&key=$BOOTSTRAP_KEY")
  ENABLED=$(echo "$CFG" | sed -n 's/.*"enabled":\([a-z]*\).*/\1/p')
  COACH=$(echo "$CFG"   | sed -n 's/.*"coach_id":"\([^"]*\)".*/\1/p')
  EMU=$(echo "$CFG"     | sed -n 's/.*"emu_id":"\([^"]*\)".*/\1/p')
  KEY=$(echo "$CFG"     | sed -n 's/.*"api_key":"\([^"]*\)".*/\1/p')
  IPATH=$(echo "$CFG"   | sed -n 's/.*"ingest_path":"\([^"]*\)".*/\1/p')
  INTERVAL=$(echo "$CFG"| sed -n 's/.*"post_interval":\([0-9]*\).*/\1/p')
  TAGS=$(echo "$CFG"    | sed -n 's/.*"tags":\[\([^]]*\)\].*/\1/p')
  T1=$(echo "$TAGS" | cut -d, -f1 | tr -d '" '); T2=$(echo "$TAGS" | cut -d, -f2 | tr -d '" ')
  T3=$(echo "$TAGS" | cut -d, -f3 | tr -d '" '); T4=$(echo "$TAGS" | cut -d, -f4 | tr -d '" ')
  [ -z "$INTERVAL" ] && INTERVAL=10
  [ -z "$IPATH" ] && IPATH="/api/v1/ingest"
  SERVER="$BASE$IPATH"

  # not registered / disabled / unassigned -> wait and re-check
  if [ "$ENABLED" = "false" ] || [ -z "$COACH" ] || [ -z "$KEY" ]; then
    sleep 60; continue
  fi

  # ---- run the read+push loop until next config refresh ----
  E=0
  while [ "$E" -lt "$CONFIG_REFRESH" ]; do
    V1=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$T1\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
    V2=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$T2\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
    V3=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$T3\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
    V4=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$T4\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
    if [ -n "$V1" ]; then
      A1=$(awk "BEGIN{printf \"%.1f\",$V1/10}"); A2=$(awk "BEGIN{printf \"%.1f\",$V2/10}")
      A3=$(awk "BEGIN{printf \"%.1f\",$V3/10}"); A4=$(awk "BEGIN{printf \"%.1f\",$V4/10}")
      TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      BODY="{\"coach_id\":\"$COACH\",\"emu_id\":\"$EMU\",\"ts\":\"$TS\",\"readings\":[\
{\"sensor_id\":\"$COACH-TM1\",\"tm_id\":\"TM1\",\"temperature\":$A1},\
{\"sensor_id\":\"$COACH-TM2\",\"tm_id\":\"TM2\",\"temperature\":$A2},\
{\"sensor_id\":\"$COACH-TM3\",\"tm_id\":\"TM3\",\"temperature\":$A3},\
{\"sensor_id\":\"$COACH-TM4\",\"tm_id\":\"TM4\",\"temperature\":$A4}]}"
      if post "$SERVER" "$KEY" "$BODY"; then flush; else
        echo "$BODY" >> "$BUFFER"
        L=$(wc -l < "$BUFFER" 2>/dev/null || echo 0); [ "$L" -gt 5000 ] && tail -n 5000 "$BUFFER" > "${BUFFER}.x" && mv "${BUFFER}.x" "$BUFFER"
      fi
    fi
    sleep "$INTERVAL"; E=$((E+INTERVAL))
  done
done &
