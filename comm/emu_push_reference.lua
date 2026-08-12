-- ===========================================================================
-- HIMNISH RAIP D3 - EMU coach push reference (Lua / RUT-class router or module)
--
-- Reference for the Himnish LTE communication module firmware. One module per
-- motor coach; reads its 4 wireless TM sensors via the local concentrator and
-- POSTs a coach batch to the RAIP D3 cloud. Follows the same push pattern as
-- the D1/D2 RAIP scripts (curl + JSON + API key header).
--
-- Adapt read_sensors() to your concentrator's local interface (UART/Modbus/etc).
-- This file is a contract reference, not production firmware.
-- ===========================================================================

local ENDPOINT  = "https://himnish-raip-production.up.railway.app/api/v1/ingest"
local API_KEY   = "himnish_emu_key_2025"   -- must match server DATA_API_KEY
local COACH_ID  = "MC-101"                  -- identity of THIS coach
local EMU_ID    = "EMU-01"                  -- declared once; cloud tracks swaps
local POSITION  = 1                         -- coach position 1..4
local INTERVAL  = 30                        -- seconds between pushes (<60 per tender)

-- Read the 4 TM sensors from the local concentrator.
-- Replace the body with your real concentrator read. Returns a Lua table array.
local function read_sensors()
  -- EXAMPLE placeholder values:
  return {
    { sensor_id = COACH_ID.."-TM1", tm_id = "TM1", temperature = 58.4, battery_health = 96, signal_strength = 82 },
    { sensor_id = COACH_ID.."-TM2", tm_id = "TM2", temperature = 61.1, battery_health = 95, signal_strength = 80 },
    { sensor_id = COACH_ID.."-TM3", tm_id = "TM3", temperature = 54.7, battery_health = 97, signal_strength = 85 },
    { sensor_id = COACH_ID.."-TM4", tm_id = "TM4", temperature = 59.9, battery_health = 94, signal_strength = 79 },
  }
end

-- Minimal JSON builder for the fixed payload shape (no external json lib needed).
local function build_payload(readings)
  local parts = {}
  for _, r in ipairs(readings) do
    parts[#parts+1] = string.format(
      '{"sensor_id":"%s","tm_id":"%s","temperature":%.1f,"battery_health":%d,"signal_strength":%d}',
      r.sensor_id, r.tm_id, r.temperature, r.battery_health, r.signal_strength)
  end
  return string.format(
    '{"coach_id":"%s","emu_id":"%s","position":%d,"readings":[%s]}',
    COACH_ID, EMU_ID, POSITION, table.concat(parts, ","))
end

local function push(payload)
  local cmd = string.format(
    'curl -s -m 20 -X POST %q '..
    '-H "Content-Type: application/json" -H "X-API-Key: %s" '..
    '--data %q',
    ENDPOINT, API_KEY, payload)
  local h = io.popen(cmd)
  local resp = h:read("*a"); h:close()
  return resp
end

-- Main loop. On a real module run under a process supervisor / rc.local.
while true do
  local ok, err = pcall(function()
    local payload = build_payload(read_sensors())
    local resp = push(payload)
    print(os.date("%Y-%m-%d %H:%M:%S"), "push ->", resp)
  end)
  if not ok then print("push error:", err) end
  os.execute("sleep "..INTERVAL)
end
