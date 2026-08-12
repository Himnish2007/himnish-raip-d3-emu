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
      temp: alert.value != null ? alert.value : '', time: new Date(alert.at || Date.now()).toLocaleString('en-GB'),
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

  async function sendSMS(to, message, store) {
    const rec = { channel: 'sms', to, at: new Date().toISOString(), message };
    const provider = (config.SMS_PROVIDER || 'log').toLowerCase();
    try {
      if (provider === 'log' || !config.SMS_API_KEY) { rec.ok = true; rec.note = 'dry-run (SMS provider not configured)'; }
      else {
        let url;
        if (provider === 'fast2sms') {
          url = `https://www.fast2sms.com/dev/bulkV2?authorization=${config.SMS_API_KEY}&route=q&message=${encodeURIComponent(message)}&numbers=${encodeURIComponent(to)}`;
        } else if (provider === 'msg91') {
          url = `https://api.msg91.com/api/sendhttp.php?authkey=${config.SMS_API_KEY}&mobiles=${encodeURIComponent(to)}&message=${encodeURIComponent(message)}&sender=${config.SMS_SENDER || 'HMNISH'}&route=4&country=91`;
        } else { // generic: SMS_URL template with {to} {message} {key}
          url = fill(config.SMS_URL, { to: encodeURIComponent(to), message: encodeURIComponent(message), key: config.SMS_API_KEY });
        }
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, { signal: ctrl.signal }); clearTimeout(t);
        rec.ok = res.ok; if (!res.ok) rec.error = 'HTTP ' + res.status;
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
    const sms = fill(cfg.templates.sms, ctx);
    const channels = rule.channels || [];

    // 1) Control-room recipients configured on the rule (see everything).
    if (channels.includes('email')) for (const to of (rule.emails || [])) await sendEmail(to, subject, body, store);
    if (channels.includes('sms')) for (const to of (rule.phones || [])) await sendSMS(to, sms, store);

    // 2) Assigned users — each user is notified ONLY for coaches/EMUs assigned
    //    to them (global-role users get everything). Uses each user's own
    //    email/phone, de-duplicated against the rule recipients above.
    if (alert.coach_id) {
      const sentEmail = new Set(rule.emails || []);
      const sentSms = new Set(rule.phones || []);
      for (const u of store.usersForCoach(alert.coach_id)) {
        if (channels.includes('email') && u.email && !sentEmail.has(u.email)) { await sendEmail(u.email, subject, body, store); sentEmail.add(u.email); }
        if (channels.includes('sms') && u.phone && !sentSms.has(u.phone)) { await sendSMS(u.phone, sms, store); sentSms.add(u.phone); }
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
    const sms = 'ESCALATED: ' + fill(cfg.templates.sms, ctx);
    for (const to of (tier.emails || [])) await sendEmail(to, subject, body, store);
    for (const to of (tier.phones || [])) await sendSMS(to, sms, store);
  }

  async function sendTest(channel, to, store) {
    if (channel === 'sms') return sendSMS(to, '[HIMNISH RAIP] Test SMS alert. System configured correctly.', store);
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
