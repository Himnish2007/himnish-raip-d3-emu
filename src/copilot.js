'use strict';

// ---------------------------------------------------------------------------
// LLM-ready Copilot. Activated only when LLM_API_KEY (+ LLM_URL) are configured.
// Works with any OpenAI-compatible chat-completions endpoint (OpenAI, Azure,
// local vLLM/Ollama gateway, etc.). When not configured, isEnabled() is false
// and the dashboard falls back to the built-in rule-based Fleet Assistant.
//
// The model is given a compact, factual snapshot of the (scoped) fleet plus the
// user's question, and asked to answer concisely for a railway operator.
// ---------------------------------------------------------------------------

const config = require('./config');

function isEnabled() {
  return !!(config.LLM_API_KEY && config.LLM_URL);
}

function buildContext(snapshot) {
  // snapshot: { overview, tms:[{tm,coach,emu,temp,cls,status,batt}] }
  const ov = snapshot.overview || {};
  const lines = [];
  lines.push(`Fleet: ${ov.total_emus || 0} EMUs, ${ov.total_coaches || 0} coaches, ${ov.total_tms || 0} traction motors.`);
  lines.push(`Online ${ov.online_sensors || 0}, offline ${ov.offline_sensors || 0}. Warning ${ov.warning_tms || 0}, critical ${ov.critical_tms || 0}. Active alerts ${ov.active_alerts || 0}. Avg temp ${ov.avg_fleet_temp}\u00b0C.`);
  const notable = (snapshot.tms || [])
    .filter((t) => t.status === 'offline' || t.cls === 'critical' || t.cls === 'high' || t.cls === 'warning')
    .slice(0, 40)
    .map((t) => `${t.tm}@${t.coach}: ${t.status === 'offline' ? 'OFFLINE' : t.temp + '\u00b0C/' + t.cls}${t.batt != null ? ', batt ' + t.batt + '%' : ''}`);
  if (notable.length) lines.push('Notable TMs:\n' + notable.join('\n'));
  else lines.push('All motors within normal range.');
  return lines.join('\n');
}

async function ask(question, snapshot) {
  if (!isEnabled()) return { ok: false, reason: 'not-configured' };
  const system = 'You are the assistant for HIMNISH EMU traction-motor temperature monitoring for Indian Railways. '
    + 'Answer briefly and factually for a railway operator, using ONLY the fleet data provided. '
    + 'If asked about something not in the data, say you can only report on the monitored fleet. Prefer short, clear answers.';
  const body = {
    model: config.LLM_MODEL || 'gpt-4o-mini',
    max_tokens: 500,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'FLEET DATA:\n' + buildContext(snapshot) + '\n\nQUESTION: ' + question },
    ],
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const resp = await fetch(config.LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.LLM_API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, reason: 'llm-http-' + resp.status };
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return { ok: false, reason: 'empty' };
    return { ok: true, answer: String(text).trim() };
  } catch (e) {
    return { ok: false, reason: 'error: ' + e.message };
  }
}

module.exports = { isEnabled, ask, buildContext };
