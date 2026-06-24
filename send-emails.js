// send-emails.js — CI entry point: send the weekly digest + renewal reminders.
// Mirrors the Monday block of scheduler.js so the email is no longer coupled to a
// long-running local process. Run with: node send-emails.js
'use strict';

const { sendDigest, sendRenewalReminders } = require('./email-digest');

(async () => {
  try {
    const reminder = await sendRenewalReminders();
    console.log(reminder ? 'Renewal reminders sent.' : 'No renewal reminders needed.');

    await sendDigest();
    console.log('Weekly digest sent.');
  } catch (err) {
    console.error('Email step failed:', err.message);
    process.exit(1); // non-zero exit triggers the workflow failure notification
  }
})();
