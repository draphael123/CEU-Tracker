// notify-failure.js — sends a short alert email when a CI run fails, so a broken
// or skipped scrape is visible instead of silent. Invoked by the workflow's
// "if: failure()" step. Run with: node notify-failure.js
'use strict';

const nodemailer = require('nodemailer');

const recipients = (process.env.EMAIL_RECIPIENTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!process.env.SMTP_USER || !process.env.SMTP_PASS || recipients.length === 0) {
  console.log('Failure notification skipped: email not configured.');
  process.exit(0);
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const runUrl = process.env.RUN_URL || 'the GitHub Actions tab';

transporter.sendMail({
  from: process.env.EMAIL_FROM || `CEU Tracker <${process.env.SMTP_USER}>`,
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
