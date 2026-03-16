// scheduler.js — Run CEU scraper on a schedule with optional email digest
// Usage: node scheduler.js
// Leave this running and it will scrape daily at 8:00 AM
// Email digest sent weekly on Mondays at 9:00 AM (if configured)

const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Check if email is configured
function isEmailConfigured() {
  const configPath = path.join(__dirname, 'email-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.smtp?.auth?.user && config.smtp?.auth?.pass && config.recipients?.length > 0;
    } catch {
      return false;
    }
  }
  return process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_RECIPIENTS;
}

console.log('═'.repeat(50));
console.log('  CEU Tracker Scheduler Started');
console.log('  Scraping will run daily at 10:30 PM EST');
if (isEmailConfigured()) {
  console.log('  Email digest will be sent Mondays at 9:00 AM EST');
  console.log('  Renewal reminders will be sent daily at 8:00 AM EST');
} else {
  console.log('  Email digest: Not configured');
  console.log('  Renewal reminders: Not configured');
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

// Schedule: 8:00 AM EST every day - Send renewal reminders (if configured)
cron.schedule('0 8 * * *', async () => {
  if (!isEmailConfigured()) {
    console.log(`[${new Date().toLocaleString()}] Skipping renewal reminders (not configured)`);
    return;
  }

  console.log(`\n[${new Date().toLocaleString()}] Checking for renewal reminders...`);
  try {
    const { sendRenewalReminders } = require('./email-digest');
    const result = await sendRenewalReminders();
    if (result) {
      console.log(`[${new Date().toLocaleString()}] Renewal reminders sent successfully`);
    } else {
      console.log(`[${new Date().toLocaleString()}] No renewal reminders needed today`);
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleString()}] Renewal reminders failed:`, err.message);
  }
}, {
  timezone: 'America/New_York'
});

// Schedule: 9:00 AM EST every Monday - Send email digest (if configured)
cron.schedule('0 9 * * 1', async () => {
  if (!isEmailConfigured()) {
    console.log(`[${new Date().toLocaleString()}] Skipping email digest (not configured)`);
    return;
  }

  console.log(`\n[${new Date().toLocaleString()}] Sending weekly email digest...`);
  try {
    const { sendDigest } = require('./email-digest');
    await sendDigest();
    console.log(`[${new Date().toLocaleString()}] Email digest sent successfully`);
  } catch (err) {
    console.error(`[${new Date().toLocaleString()}] Email digest failed:`, err.message);
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
  console.log(`Next email digest: Monday ${nextMonday.toLocaleDateString()}`);
}
console.log(`Current time: ${new Date().toLocaleString()}\n`);
