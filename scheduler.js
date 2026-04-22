// scheduler.js — Run CEU scraper on a schedule with optional email digest
// Usage: node scheduler.js
// Leave this running and it will scrape daily at 10:30 PM
// Email digest and renewal reminders sent weekly on Mondays at 8:00 AM (if configured)

const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');
const { loadJson } = require('./utils');

// Check if email is configured
function isEmailConfigured() {
  const configPath = path.join(__dirname, 'email-config.json');
  const config = loadJson(configPath, null);
  if (config) {
    return config.smtp?.auth?.user && config.smtp?.auth?.pass && config.recipients?.length > 0;
  }
  return process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_RECIPIENTS;
}

console.log('═'.repeat(50));
console.log('  CEU Tracker Scheduler Started');
console.log('  Scraping will run daily at 10:30 PM EST');
if (isEmailConfigured()) {
  console.log('  Email digest & reminders: Mondays at 8:00 AM EST');
} else {
  console.log('  Email: Not configured');
  console.log('  (Run "node email-digest.js --setup" to configure)');
}
console.log('  Press Ctrl+C to stop');
console.log('═'.repeat(50));

// Schedule: 10:30 PM EST every day - Run scraper
cron.schedule('30 22 * * *', () => {
  console.log(`\n[${new Date().toLocaleString()}] Starting scheduled scrape...`);
  try {
    execSync('node index.js', {
      cwd: __dirname,
      stdio: 'inherit'
    });
    console.log(`[${new Date().toLocaleString()}] Scrape completed successfully`);
  } catch (err) {
    console.error(`[${new Date().toLocaleString()}] Scrape failed:`, err.message);
  }
}, {
  timezone: 'America/New_York'
});

// Schedule: 8:00 AM EST every Monday - Send email digest and renewal reminders (if configured)
cron.schedule('0 8 * * 1', async () => {
  if (!isEmailConfigured()) {
    console.log(`[${new Date().toLocaleString()}] Skipping emails (not configured)`);
    return;
  }

  console.log(`\n[${new Date().toLocaleString()}] Sending weekly email digest and renewal reminders...`);
  try {
    const { sendDigest, sendRenewalReminders } = require('./email-digest');

    // Send renewal reminders
    const reminderResult = await sendRenewalReminders();
    if (reminderResult) {
      console.log(`[${new Date().toLocaleString()}] Renewal reminders sent successfully`);
    } else {
      console.log(`[${new Date().toLocaleString()}] No renewal reminders needed`);
    }

    // Send digest
    await sendDigest();
    console.log(`[${new Date().toLocaleString()}] Email digest sent successfully`);
  } catch (err) {
    console.error(`[${new Date().toLocaleString()}] Email failed:`, err.message);
  }
}, {
  timezone: 'America/New_York'
});

console.log(`\nNext scrape: Tonight/Tomorrow at 10:30 PM EST`);
if (isEmailConfigured()) {
  // Calculate next Monday
  const now = new Date();
  const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  console.log(`Next email: Monday ${nextMonday.toLocaleDateString()} at 8:00 AM EST`);
}
console.log(`Current time: ${new Date().toLocaleString()}\n`);
