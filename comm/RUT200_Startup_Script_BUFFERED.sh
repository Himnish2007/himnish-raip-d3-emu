#!/bin/sh
# ═══════════════════════════════════════════════════════════════════
# HIMNISH LIMITED - EMU Motor Coach TM Monitoring
# RUT200 Startup Script  (with OFFLINE BUFFERING)
# System -> Maintenance -> Custom Scripts -> Startup Script
#
# If the cloud is unreachable, readings are saved to a local buffer with
# their timestamp and replayed (in order) once the network returns. The
# server stores replayed readings in history without disturbing live values.
# ═══════════════════════════════════════════════════════════════════

sleep 20

SERVER="https://REPLACE-WITH-YOUR-APP.up.railway.app/api/v1/ingest"
KEY="himnish_emu_key_2025"
COACH="MC-01"
EMU="EMU-01"
BUFFER="/tmp/emu_buffer.jsonl"       # local buffer (survives until reboot)
POST_INTERVAL=10

TAG1="1.3"; TAG2="1.4"; TAG3="1.5"; TAG4="1.6"   # -> TM1..TM4

post() {  # $1 = json body ; returns 0 on success
  curl -s -f -m 15 -X POST "$SERVER" -H "Content-Type: application/json" -H "X-API-Key: $KEY" -d "$1" >/dev/null 2>&1
}

flush_buffer() {
  [ -s "$BUFFER" ] || return 0
  TMP="${BUFFER}.tmp"; : > "$TMP"; OK=1
  while IFS= read -r line; do
    if [ "$OK" = "1" ] && post "$line"; then :; else OK=0; echo "$line" >> "$TMP"; fi
  done < "$BUFFER"
  mv "$TMP" "$BUFFER"
}

while true; do
  V1=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG1\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
  V2=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG2\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
  V3=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG3\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
  V4=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG4\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')

  if [ -n "$V1" ]; then
    T1=$(awk "BEGIN{printf \"%.1f\",$V1/10}")
    T2=$(awk "BEGIN{printf \"%.1f\",$V2/10}")
    T3=$(awk "BEGIN{printf \"%.1f\",$V3/10}")
    T4=$(awk "BEGIN{printf \"%.1f\",$V4/10}")
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    BODY="{\"coach_id\":\"$COACH\",\"emu_id\":\"$EMU\",\"ts\":\"$TS\",\"readings\":[\
{\"sensor_id\":\"$COACH-TM1\",\"tm_id\":\"TM1\",\"temperature\":$T1},\
{\"sensor_id\":\"$COACH-TM2\",\"tm_id\":\"TM2\",\"temperature\":$T2},\
{\"sensor_id\":\"$COACH-TM3\",\"tm_id\":\"TM3\",\"temperature\":$T3},\
{\"sensor_id\":\"$COACH-TM4\",\"tm_id\":\"TM4\",\"temperature\":$T4}]}"

    if post "$BODY"; then
      flush_buffer            # network is up -> replay anything buffered
    else
      echo "$BODY" >> "$BUFFER"   # offline -> buffer with timestamp
      # keep buffer from growing without bound (last ~5000 readings)
      LINES=$(wc -l < "$BUFFER" 2>/dev/null || echo 0)
      [ "$LINES" -gt 5000 ] && tail -n 5000 "$BUFFER" > "${BUFFER}.t" && mv "${BUFFER}.t" "$BUFFER"
    fi
  fi
  sleep $POST_INTERVAL
done &
