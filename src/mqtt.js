'use strict';

// ---------------------------------------------------------------------------
// Optional MQTT ingestion. Activated only when MQTT_URL is set.
// Subscribes to a topic and feeds JSON messages into the same ingestion path
// used by the HTTP push API, so MQTT-based sensors/gateways are supported
// alongside the RUT200 HTTP push.
//
// Expected message payload (JSON), same shape as the HTTP /ingest body:
//   { "coach_id":"MC-01","emu_id":"EMU-01",
//     "readings":[{"sensor_id":"MC-01-TM1","tm_id":"TM1","temperature":63.5}] }
// A single-reading object is also accepted.
//
// Safe by design: any error is logged and never crashes the app. If MQTT_URL
// is not configured, this module does nothing.
// ---------------------------------------------------------------------------

function startMqtt(store, config) {
  if (!config.MQTT_URL) return null;
  let client;
  try {
    const mqtt = require('mqtt');
    const topic = config.MQTT_TOPIC || 'himnish/emu/+/readings';
    client = mqtt.connect(config.MQTT_URL, {
      username: config.MQTT_USERNAME || undefined,
      password: config.MQTT_PASSWORD || undefined,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
    });
    client.on('connect', () => {
      client.subscribe(topic, (err) => {
        if (err) console.error('[mqtt] subscribe failed:', err.message);
        else console.log(`[mqtt] connected, subscribed to "${topic}"`);
      });
    });
    client.on('message', (t, payload) => {
      try {
        const body = JSON.parse(payload.toString());
        const ctx = { coach_id: body.coach_id, emu_id: body.emu_id };
        const readings = Array.isArray(body.readings) ? body.readings : (body.sensor_id ? [body] : []);
        for (const raw of readings) {
          const merged = Object.assign({ coach_id: ctx.coach_id, emu_id: ctx.emu_id, sensor_type: 'wireless', ts: body.ts || body.timestamp }, raw);
          if (merged.sensor_id && (merged.coach_id || ctx.coach_id) && merged.temperature != null) {
            const tv = Number(merged.temperature);
            if (Number.isFinite(tv) && tv >= -40 && tv <= 250) store.ingestReading(merged);
          }
        }
      } catch (e) { console.error('[mqtt] bad message:', e.message); }
    });
    client.on('error', (e) => console.error('[mqtt] error:', e.message));
    client.on('reconnect', () => console.log('[mqtt] reconnecting...'));
  } catch (e) {
    console.error('[mqtt] init failed — continuing without MQTT:', e.message);
    return null;
  }
  return client;
}

module.exports = { startMqtt };
