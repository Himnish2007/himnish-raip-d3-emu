'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');

// ---------------------------------------------------------------------------
// Notification dispatcher: configurable SMS + Email alerting.
//
// Channels are driven by the admin-editable alert config in the store (rules
// per severity, recipients, escalation tiers, templates). Transport credentials
// come from environment variables. When credentials are absent the dispatcher
// runs in DRY-RUN mode: it records what *would* be sent into the notification
// log (ok=true, note="dry-run") so the system is fully demonstrable without a
// live SMTP/SMS account, and starts sending for real the moment creds are set.
// ---------------------------------------------------------------------------

function createNotifier() {
  let transport = null;
  const smtpReady = !!(config.SMTP_HOST && config.SMTP_USER);
  if (smtpReady) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST, port: config.SMTP_PORT || 587,
      secure: (config.SMTP_PORT || 587) === 465,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    });
  }

  function fill(tpl, ctx) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? ctx[k] : ''));
  }
  function ctxFor(alert) {
    return {
      severity: (alert.severity || '').toUpperCase(), message: alert.message || '',
      coach: alert.coach_id || '', emu: alert.emu_id || '', tm: alert.tm_id || alert.sensor_id || '',
      temp: alert.value != null ? alert.value : '', time: new Date(alert.at || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) + ' IST',
    };
  }

  async function sendEmail(to, subject, body, store) {
    const rec = { channel: 'email', to, at: new Date().toISOString(), subject };
    try {
      if (!smtpReady) { rec.ok = true; rec.note = 'dry-run (no SMTP configured)'; }
      else {
        await transport.sendMail({ from: config.SMTP_FROM || config.SMTP_USER, to, subject, text: body });
        rec.ok = true;
      }
    } catch (e) { rec.ok = false; rec.error = e.message; }
    if (store) store.addNotification(rec);
    return rec;
  }

  // ---- DLT SMS content: which approved template + which variable values --------------------------
  // Values go into {#var#} slots. DLT rule: each variable <= 30 characters; Fast2SMS separates them with "|".
  const dlt = {
    clean: (v, max) => String(v == null ? '' : v).replace(/[|<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 30),
    shortTime(at) { // "28/09 17:40" in IST
      const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(new Date(at || Date.now())).forEach((x) => { p[x.type] = x.value; });
      return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
    },
    build(alert, escalated) {
      const sev = String(alert.severity || '');
      const coach = dlt.clean(alert.coach_id || alert.sensor_id, 30), when = dlt.shortTime(alert.at);
      if (sev === 'offline') {
        const list = String(alert.tm_id || '').split(',').map((x) => x.trim()).filter(Boolean);
        let sensors = list.join(',');
        if (!sensors || sensors.length > 30) sensors = list.length ? `${list.length} sensors` : 'sensors';
        return { kind: 'OFFLINE', vars: [coach, sensors, when] };
      }
      if (sev === 'low_battery') {
        return { kind: 'BATT', vars: [coach, dlt.clean(alert.tm_id || alert.sensor_id, 30), alert.value != null ? Math.round(alert.value) : '?'] };
      }
      const label = (escalated ? 'ESCALATED ' : '') + sev.replace(/_/g, ' ').toUpperCase();
      const temp = alert.value != null && Number.isFinite(Number(alert.value)) ? Number(alert.value).toFixed(1) : '?';
      return { kind: 'TEMP', vars: [dlt.clean(label, 30), coach, dlt.clean(alert.tm_id || alert.sensor_id, 30), temp, when] };
    },
  };
  const dltTemplateFor = (kind) => ({ TEMP: config.SMS_DLT_TPL_TEMP, OFFLINE: config.SMS_DLT_TPL_OFFLINE, BATT: config.SMS_DLT_TPL_BATT }[kind] || '');

  // Read the provider's own answer: an HTTP 200 alone does NOT mean the SMS was accepted
  // (wrong key, empty wallet, unapproved template ... all come back as {"return":false,...}).
  async function readProviderReply(res, rec) {
    let body = null, raw = '';
    try { raw = await res.text(); body = JSON.parse(raw); } catch (e) { /* not JSON */ }
    if (body && typeof body === 'object' && 'return' in body) {
      rec.ok = res.ok && body.return === true;
      const msg = Array.isArray(body.message) ? body.message.join('; ') : (body.message || '');
      if (rec.ok) { if (body.request_id) rec.note = 'accepted by Fast2SMS, request ' + body.request_id; }
      else rec.error = String(msg || ('provider refused (HTTP ' + res.status + ')')).slice(0, 200);
      return;
    }
    rec.ok = res.ok;
    if (!res.ok) rec.error = 'HTTP ' + res.status + (raw ? ': ' + raw.slice(0, 120) : '');
  }

  async function sendSMS(to, message, store, payload) {
    const rec = { channel: 'sms', to, at: new Date().toISOString(), message };
    const provider = (config.SMS_PROVIDER || 'log').toLowerCase();
    try {
      if (provider === 'log' || !config.SMS_API_KEY) { rec.ok = true; rec.note = 'dry-run (SMS provider not configured)'; }
      else if (provider === 'fast2sms_dlt') {
        // India DLT route: an approved template's ID + the variable values (no free text allowed)
        const kind = payload && payload.kind, tpl = dltTemplateFor(kind);
        if (!config.SMS_SENDER) { rec.ok = false; rec.error = 'SMS_SENDER (DLT header, 6 letters) is not set'; }
        else if (!tpl) { rec.ok = false; rec.error = `no DLT template configured for "${kind}" alerts (set SMS_DLT_TPL_${kind})`; }
        else {
          rec.message = `[DLT ${kind} template ${tpl}] ` + (message || '');
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(config.SMS_API_BASE + '/dev/bulkV2', {
            method: 'POST', signal: ctrl.signal,
            headers: { authorization: config.SMS_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ route: 'dlt', sender_id: config.SMS_SENDER, message: String(tpl), variables_values: payload.vars.map((v) => dlt.clean(v)).join('|'), numbers: String(to).replace(/\D/g, '').slice(-10), flash: 0 }),
          });
          clearTimeout(t); await readProviderReply(res, rec);
        }
      }
      else {
        let url;
        if (provider === 'fast2sms') {
          url = `${config.SMS_API_BASE}/dev/bulkV2?authorization=${config.SMS_API_KEY}&route=q&message=${encodeURIComponent(message)}&numbers=${encodeURIComponent(to)}`;
        } else if (provider === 'msg91') {
          url = `https://api.msg91.com/api/sendhttp.php?authkey=${config.SMS_API_KEY}&mobiles=${encodeURIComponent(to)}&message=${encodeURIComponent(message)}&sender=${config.SMS_SENDER || 'HMNISH'}&route=4&country=91`;
        } else { // generic: SMS_URL template with {to} {message} {key}
          url = fill(config.SMS_URL, { to: encodeURIComponent(to), message: encodeURIComponent(message), key: config.SMS_API_KEY });
        }
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, { signal: ctrl.signal }); clearTimeout(t);
        await readProviderReply(res, rec);
      }
    } catch (e) { rec.ok = false; rec.error = e.message; }
    if (store) store.addNotification(rec);
    return rec;
  }

  // Dispatch one alert through its configured rule.
  async function dispatchForAlert(alert, store) {
    const cfg = store.getAlertConfig();
    const rule = cfg.rules[alert.severity];
    if (!rule) return;
    const ctx = ctxFor(alert);
    const subject = fill(cfg.templates.email_subject, ctx);
    const body = fill(cfg.templates.email_body, ctx);
    // Offline alerts have no temperature, so the temperature SMS template would read
    // "OFFLINE: TM.. on 128298 = C". Use a message-based text instead (still ONE sms per recipient).
    const sms = alert.severity === 'offline'
      ? fill(cfg.templates.sms_offline || '[EMU-TM ALERT] {severity}: {message} @ {time}', ctx)
      : fill(cfg.templates.sms, ctx);
    // HARD RULE (not admin-configurable): an offline TM/coach is a communication problem, not
    // necessarily a hazard, and stays "active" for as long as the outage lasts — so it must never
    // spam SMS. Email only, and only once an hour while it persists (see the offline-reminder timer
    // in server.js, which relies on the emailSend throttle below for that hourly cadence).
    const channels = (rule.channels || []).filter((c) => !(c === 'sms' && alert.severity === 'offline'));
    const dltPayload = dlt.build(alert, false);
    // SMS costs money and a sensor that stays hot re-raises its alert every minute: send the same
    // recipient / coach / severity again only after SMS_REPEAT_MIN minutes (0 = always send).
    const smsLast = dispatchForAlert.smsLast || (dispatchForAlert.smsLast = new Map());
    // Forget entries older than the repeat window: without this the map grows for as long as the
    // server runs (every distinct severity+coach+number combo ever alerted stays in memory forever).
    if (!dispatchForAlert._smsGcAt || Date.now() - dispatchForAlert._smsGcAt > 3600000) {
      dispatchForAlert._smsGcAt = Date.now();
      const maxAge = Math.max((Number(config.SMS_REPEAT_MIN) || 0) * 60000, 3600000) * 2;
      for (const [k, t] of smsLast) if (Date.now() - t > maxAge) smsLast.delete(k);
    }
    const smsSend = async (to) => {
      const every = (Number(config.SMS_REPEAT_MIN) || 0) * 60000;
      const key = `${alert.severity}|${alert.coach_id || alert.sensor_id}|${to}`;
      const last = smsLast.get(key) || 0;
      if (every && Date.now() - last < every) {
        console.log(`[sms] not repeated to ${to} (${key.split('|').slice(0, 2).join(' ')}): last SMS ${Math.round((Date.now() - last) / 60000)} min ago, limit ${config.SMS_REPEAT_MIN} min`);
        return;
      }
      const rec = await sendSMS(to, sms, store, dltPayload);
      if (rec.ok) smsLast.set(key, Date.now());
    };

    // Safety net (the _raise() dedup above should already stop a sustained fault from re-notifying,
    // but this catches any edge case — e.g. a manual re-trigger) so one address is not emailed again
    // for the same coach+severity within EMAIL_REPEAT_MIN minutes (0 = always send).
    const emailLast = dispatchForAlert.emailLast || (dispatchForAlert.emailLast = new Map());
    const emailSend = async (to) => {
      const every = (Number(config.EMAIL_REPEAT_MIN) || 0) * 60000;
      const ekey = `${alert.severity}|${alert.coach_id || alert.sensor_id}|${to}`;
      const last = emailLast.get(ekey) || 0;
      if (every && Date.now() - last < every) { console.log(`[email] not repeated to ${to} (${ekey.split('|').slice(0, 2).join(' ')}): last sent ${Math.round((Date.now() - last) / 60000)} min ago, limit ${config.EMAIL_REPEAT_MIN} min`); return; }
      const rec = await sendEmail(to, subject, body, store);
      if (rec.ok) emailLast.set(ekey, Date.now());
    };

    // 1) Control-room recipients configured on the rule (see everything).
    if (channels.includes('email')) for (const to of (rule.emails || [])) await emailSend(to);
    if (channels.includes('sms')) for (const to of (rule.phones || [])) await smsSend(to);

    // 2) Assigned users — each user is notified ONLY for coaches/EMUs assigned
    //    to them (global-role users get everything). Uses each user's own
    //    email/phone, de-duplicated against the rule recipients above.
    if (alert.coach_id) {
      const sentEmail = new Set(rule.emails || []);
      const sentSms = new Set(rule.phones || []);
      for (const u of store.usersForCoach(alert.coach_id)) {
        if (channels.includes('email') && u.email && !sentEmail.has(u.email)) { await emailSend(u.email); sentEmail.add(u.email); }
        if (channels.includes('sms') && u.phone && !sentSms.has(u.phone)) { await smsSend(u.phone); sentSms.add(u.phone); }
      }
    }
  }

  // Escalation send to a tier's contacts.
  async function sendEscalation(alert, tier, store) {
    if (!tier) return;
    const ctx = ctxFor(alert); ctx.severity = 'ESCALATED ' + ctx.severity;
    const cfg = store.getAlertConfig();
    const subject = '[ESCALATION] ' + fill(cfg.templates.email_subject, ctx);
    const body = 'ESCALATED (' + (tier.name || '') + ')\n' + fill(cfg.templates.email_body, ctx);
    for (const to of (tier.emails || [])) await sendEmail(to, subject, body, store);
    // Same hard rule as the main dispatch: offline never sends SMS, escalation included.
    if (alert.severity === 'offline') return;
    const sms = 'ESCALATED: ' + fill(cfg.templates.sms, ctx);
    const escPayload = dlt.build(alert, true);
    for (const to of (tier.phones || [])) await sendSMS(to, sms, store, escPayload);
  }

  async function sendTest(channel, to, store) {
    if (channel === 'sms') {
      // On the DLT route a test must also use an approved template: send a clearly marked TEMP-template test.
      const test = { kind: 'TEMP', vars: ['TEST', 'TEST', 'TM1', '0.0', dlt.shortTime()] };
      return sendSMS(to, '[HIMNISH RAIP] Test SMS alert. System configured correctly.', store, test);
    }
    return sendEmail(to, 'HIMNISH RAIP test email', 'This is a test alert email from EMU Motor Coach TM Monitoring. Configuration OK.', store);
  }

  // Daily scheduled report: emails print/PDF links (valid 3 days) to recipients.
  async function sendReportEmail(baseUrl, token, emails, store) {
    const types = [['readings', 'Live Readings'], ['alarms', 'Alarm Report'],
      ['sensor-health', 'Sensor Health'], ['coach-health', 'Coach Health']];
    let body = 'EMU Motor Coach TM Temperature Monitoring System\nDaily Report — ' + new Date().toLocaleDateString('en-GB') + '\n\n';
    if (baseUrl) {
      body += 'Open any report below (links valid ~3 days, printable to PDF):\n\n';
      for (const [t, name] of types) body += `${name}: ${baseUrl}/api/v1/report/${t}/print?token=${token}\n`;
    } else {
      body += 'Set the public Base URL in Notify -> Daily Report to include direct links.\nOtherwise log in and open the Reports tab.';
    }
    body += '\n\n- HIMNISH LIMITED';
    for (const to of emails) await sendEmail(to, 'EMU Motor Coach TM — Daily Report', body, store);
    return emails.length;
  }

  return { dispatchForAlert, sendEscalation, sendTest, sendReportEmail, smtpReady,
    smsProvider: (config.SMS_PROVIDER || 'log') };
}

module.exports = { createNotifier };
