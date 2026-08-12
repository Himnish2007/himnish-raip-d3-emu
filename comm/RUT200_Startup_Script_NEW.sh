#!/bin/sh
# ═══════════════════════════════════════════════════════════════════
# HIMNISH LIMITED - EMU Motor Coach TM Temperature Monitoring System
# RUT200 Startup Script  (NEW cloud app format)
# Path: System -> Maintenance -> Custom Scripts -> Startup Script
#
# Modbus/SELEC read logic is UNCHANGED from your working script.
# Only the cloud endpoint, API key and JSON payload format are updated.
# ═══════════════════════════════════════════════════════════════════

sleep 20

# ─── 1) CONNECTION CONFIG ────────────────────────────────────────────
# Replace with YOUR Railway URL (the https://...up.railway.app you generated)
SERVER="https://REPLACE-WITH-YOUR-APP.up.railway.app/api/v1/ingest"
KEY="himnish_emu_key_2025"      # must match DATA_API_KEY on Railway

# ─── 2) THIS COACH ───────────────────────────────────────────────────
# Change per Motor Coach. Keep COACH unique; EMU is which EMU it sits in.
COACH="MC-01"
EMU="EMU-01"

# ─── 3) MODBUS TAG IDs (SELEC PLC) ───────────────────────────────────
# Defaults below MATCH your currently-working script (1.3 .. 1.6).
# NOTE: your Tag-ID file lists Motor1=1.2, Motor2=1.3, Motor3=1.5, Motor4=1.6.
# If a physical check shows TM1 is wrong, set TAG1="1.2" etc. here.
TAG1="1.3"   # -> TM1
TAG2="1.4"   # -> TM2
TAG3="1.5"   # -> TM3
TAG4="1.6"   # -> TM4

POST_INTERVAL=10   # seconds between pushes (tender requires < 60s)

# ─── MAIN LOOP ───────────────────────────────────────────────────────
while true; do
  V1=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG1\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
  V2=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG2\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
  V3=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG3\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')
  V4=$(ubus call modbus_client.rpc get_tag_value "{\"id\":\"$TAG4\",\"index\":0,\"count\":1}" 2>/dev/null | awk -F'"' '/values/{getline; print $2}')

  if [ -n "$V1" ]; then
    # Raw value x 0.1 = deg C  (same formula as before)
    T1=$(awk "BEGIN{printf \"%.1f\",$V1/10}")
    T2=$(awk "BEGIN{printf \"%.1f\",$V2/10}")
    T3=$(awk "BEGIN{printf \"%.1f\",$V3/10}")
    T4=$(awk "BEGIN{printf \"%.1f\",$V4/10}")

    # Optional: 4G signal % for the Devices screen (safe if command absent)
    SIG=$(gsmctl -q 2>/dev/null | awk '{printf "%d", ($1+113)/2*100/30}')
    [ -z "$SIG" ] && SIG=0

    BODY="{\"coach_id\":\"$COACH\",\"emu_id\":\"$EMU\",\"lte_signal\":$SIG,\"network\":\"4G LTE\",\"readings\":[\
{\"sensor_id\":\"$COACH-TM1\",\"tm_id\":\"TM1\",\"temperature\":$T1},\
{\"sensor_id\":\"$COACH-TM2\",\"tm_id\":\"TM2\",\"temperature\":$T2},\
{\"sensor_id\":\"$COACH-TM3\",\"tm_id\":\"TM3\",\"temperature\":$T3},\
{\"sensor_id\":\"$COACH-TM4\",\"tm_id\":\"TM4\",\"temperature\":$T4}]}"

    curl -s -X POST "$SERVER" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $KEY" \
      -d "$BODY" >/dev/null 2>&1

    # ─── OPTIONAL: also keep feeding the OLD D3 dashboard during transition ──
    # Uncomment these 3 lines to push to both apps at the same time:
    # curl -s -X POST "https://web-production-39799-emu-mc-temp.up.railway.app/api/push" \
    #   -H "Content-Type: application/json" \
    #   -d "{\"apiKey\":\"himnish_rut200_key_2024\",\"coachId\":\"$COACH\",\"motors\":[$T1,$T2,$T3,$T4]}" >/dev/null 2>&1
  fi
  sleep $POST_INTERVAL
done &
