# SMS alerts on the India DLT route (Fast2SMS) - setup guide

HIMNISH RAIP D3 - EMU Motor Coach TM Monitoring.
No secrets in this file. Keep API keys only in the server `.env`.

Why DLT: TRAI requires every business SMS in India to use a registered sender ID (header)
and a pre-approved message template. The app therefore does not send free text on this
route. It sends the ID of an approved template plus the values for its `{#var#}` slots.

---------------------------------------------------------------------------
## 1. What you need to get (in this order)

1. **Principal Entity (PE) registration** on any operator's DLT portal (Jio, Airtel, Vi, BSNL).
   One registration works for all operators. Usual documents: company PAN, GST or
   certificate of incorporation, authorised signatory ID + authorisation letter,
   business address, mobile and e-mail for OTP. Fee and documents change: check the portal.
   Fast2SMS advertises free help with DLT registration. Ask their support first.
2. **Header (sender ID)**: 6 letters, category **Service Implicit**. Example: `HMNISH`.
   It must be unique across India, so keep 2 or 3 alternatives ready (e.g. HIMNSH, HMNSHL).
   Approval usually takes 2 to 3 days.
3. **Content templates**: register the 3 texts in section 2 as type **Service Implicit**
   (not "Transactional": that is reserved for bank OTPs) and link them to your header.
   Approval usually takes 1 to 3 days.
4. **Fast2SMS account** (wallet recharged), then in the Fast2SMS panel add your DLT details
   (entity ID, header, templates). Fast2SMS shows a **Message ID** for each template.
   Those Message IDs (short numbers) go into the server `.env`.
   (PE-TM linking: Fast2SMS is your telemarketer; their panel guides you through it.)

DLT template rules to remember:
- variable format is exactly `{#var#}` (case sensitive)
- each variable can hold at most 30 characters (the app already cuts values to 30)
- no `<` or `>` characters, no double spaces
- your brand name must be at the end (kept as `-HIMNISH LIMITED` below)
- write the text EXACTLY as below, otherwise the operator will block the SMS

---------------------------------------------------------------------------
## 2. The three templates to register (copy exactly)

### Template 1 - TEMP  (warning / high / critical / rapid rise / escalations)
```
EMU ALERT {#var#}: Coach {#var#} motor {#var#} temperature {#var#} C at {#var#}. Please check immediately. -HIMNISH LIMITED
```
Variables in order: 1 severity (CRITICAL, HIGH, WARNING, RAPID RISE, ESCALATED CRITICAL ...),
2 coach id, 3 motor (TM1..TM4), 4 temperature (95.3), 5 time in IST (28/09 17:40)

### Template 2 - OFFLINE  (coach stopped sending data)
```
EMU ALERT OFFLINE: Coach {#var#} is OFFLINE, sensors {#var#}, detected at {#var#}. Please check power and SIM. -HIMNISH LIMITED
```
Variables in order: 1 coach id, 2 sensors (TM1,TM2,TM3,TM4), 3 time in IST (28/09 17:40)

### Template 3 - BATT  (optional: low sensor battery)
```
EMU ALERT: Coach {#var#} sensor {#var#} battery is low at {#var#} percent. Please replace it. -HIMNISH LIMITED
```
Variables in order: 1 coach id, 2 sensor (TM1), 3 battery percent (18)

If you skip Template 3, low-battery alerts stay e-mail only (the log shows
"no DLT template configured for BATT alerts").

---------------------------------------------------------------------------
## 3. Server settings (`~/himnish-raip-d3-emu/.env`)

```
SMS_PROVIDER=fast2sms_dlt
SMS_API_KEY=<Fast2SMS Dev API key>
SMS_SENDER=<your approved 6-letter header, e.g. HMNISH>
SMS_DLT_TPL_TEMP=<Fast2SMS message ID of Template 1>
SMS_DLT_TPL_OFFLINE=<Fast2SMS message ID of Template 2>
SMS_DLT_TPL_BATT=<Fast2SMS message ID of Template 3, optional>
SMS_REPEAT_MIN=30
```
Then:  `pm2 restart all --update-env`  and  `pm2 logs --lines 20`.

Keep the key out of chat and out of git: the `.env` file is git-ignored. Never paste it.

---------------------------------------------------------------------------
## 4. Dashboard settings (Admin login)

Notify tab -> "Alert Routing Rules" -> Edit for each severity you want by SMS:
- "Send SMS?" -> OK
- "Phone recipients" -> 10-digit numbers, comma separated: `9876543210,9123456780`
  (+91 and spaces are removed automatically)
Recommended: Offline, Critical, High, Rapid rise by SMS; Warning and Low battery by e-mail.

---------------------------------------------------------------------------
## 5. Test

1. Notify tab -> "Send Test" -> Channel SMS -> your number -> Send test.
   It uses Template 1 with the word TEST, so it also proves the template is approved.
2. Look at the Delivery Log: it must say delivered and show a Fast2SMS request id.
   A red "failed" row shows the provider's reason (empty wallet, unapproved template,
   wrong sender ID ...).
3. Power off one coach: after "Offline after" seconds exactly ONE SMS per number arrives
   (not one per sensor).

Important: a "delivered" row means Fast2SMS ACCEPTED the message. The real handset delivery
report is in the Fast2SMS panel.

---------------------------------------------------------------------------
## 6. Rules built into the app

- One offline alert (and one SMS) per coach, never one per sensor.
- Repeat limit: the same number gets the same coach + severity again only after
  SMS_REPEAT_MIN minutes (default 30). Without this a motor that stays hot would trigger
  an SMS every minute. Acknowledge the alert in the dashboard when you have seen it.
  Set SMS_REPEAT_MIN=0 to switch the limit off. Escalation SMS are separate and are not limited.
- A failed SMS is not counted as sent, so the next alert tries again.
- E-mail alerts are not limited by SMS_REPEAT_MIN.
- Cost is charged by Fast2SMS per SMS part; each of the templates above fits in one part.

Quick-SMS route (no DLT, `SMS_PROVIDER=fast2sms`) still exists for testing. Fast2SMS charges
more for it and reviews such messages manually, so it is not recommended for real alerts.
