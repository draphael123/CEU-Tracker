// notify-failure.js — sends a short alert email when a CI run fails, so a broken
// or skipped scrape is visible instead of silent. Invoked by the workflow's
// "if: failure()" step. Reads email-config.json (restored from the EMAIL_CONFIG
// secret), falling back to SMTP_* / EMAIL_* env vars. Run with: node notify-failure.js
'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

function loadConfig() {
  const p = path.join(__dirname, 'email-config.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* fall through */ }
  }
  return {
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    },
    from: process.env.EMAIL_FROM,
    recipients: (process.env.EMAIL_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

const cfg = loadConfig();
const recipients = cfg.recipients || [];

if (!cfg.smtp || !cfg.smtp.auth || !cfg.smtp.auth.user || !cfg.smtp.auth.pass || recipients.length === 0) {
  console.log('Failure notification skipped: email not configured.');
  process.exit(0);
}

const transporter = nodemailer.createTransport({
  host: cfg.smtp.host || 'smtp.gmail.com',
  port: cfg.smtp.port || 587,
  secure: !!cfg.smtp.secure,
  auth: cfg.smtp.auth,
});

const runUrl = process.env.RUN_URL || 'the GitHub Actions tab';

transporter.sendMail({
  from: cfg.from || `CEU Tracker <${cfg.smtp.auth.user}>`,
  to: recipients.join(', '),
  subject: '🚨 CEU Tracker — scheduled run FAILED',
  html: `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;">
      <h2 style="color:#dc2626;margin:0 0 12px;">CEU Tracker run did not complete</h2>
      <p>The scheduled scrape/email job failed. The dashboard may be showing
         <strong>stale data</strong> until this is resolved.</p>
      <p>Review the logs here: <a href="${runUrl}">${runUrl}</a></p>
      <p style="color:#94a3b8;font-size:12px;margin-top:20px;">
         Automated alert from the CEU Tracker GitHub Actions workflow.</p>
    </div>`,
})
  .then(() => console.log('Failure notification sent.'))
  .catch(err => { console.error('Could not send failure notification:', err.message); process.exit(1); });
