// utils.js — Shared helpers: logging, delays, error handling

const fs = require('fs');
const path = require('path');

// ─── Logging ────────────────────────────────────────────────────────────────

const LOG_LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR', SUCCESS: 'SUCCESS' };

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(level, message) {
  const icons = { INFO: '→', WARN: '⚠', ERROR: '✗', SUCCESS: '✓' };
  const colors = {
    INFO:    '\x1b[36m',  // cyan
    WARN:    '\x1b[33m',  // yellow
    ERROR:   '\x1b[31m',  // red
    SUCCESS: '\x1b[32m',  // green
  };
  const reset = '\x1b[0m';
  const icon = icons[level] || '·';
  const color = colors[level] || '';
  console.log(`${color}[${timestamp()}] ${icon} ${message}${reset}`);
}

const logger = {
  info:    (msg) => log('INFO',    msg),
  warn:    (msg) => log('WARN',    msg),
  error:   (msg) => log('ERROR',   msg),
  success: (msg) => log('SUCCESS', msg),
};

// ─── Delays ─────────────────────────────────────────────────────────────────

/**
 * Sleep for a random number of milliseconds between min and max.
 * Default: 3–7 seconds between provider logins.
 */
function randomDelay(minMs = 3000, maxMs = 7000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  logger.info(`Waiting ${(ms / 1000).toFixed(1)}s before next login...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a fixed number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Screenshots ─────────────────────────────────────────────────────────────

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

/**
 * Ensure the /screenshots directory exists.
 */
function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    logger.info('Created /screenshots directory');
  }
}

/**
 * Take a screenshot for error debugging.
 * @param {import('playwright').Page} page
 * @param {string} providerName
 * @param {string} [suffix]
 */
async function screenshotOnError(page, providerName, suffix = 'error') {
  try {
    ensureScreenshotsDir();
    const safeName = providerName.replace(/[^a-z0-9]/gi, '_');
    const filename = `${safeName}_${suffix}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    logger.warn(`Screenshot saved: screenshots/${filename}`);
    return filepath;
  } catch (screenshotErr) {
    logger.error(`Could not save screenshot: ${screenshotErr.message}`);
    return null;
  }
}

// ─── Date Utilities ──────────────────────────────────────────────────────────

/**
 * Parse a date string into a JS Date, returning null if unparseable.
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Return the number of days between today and a future date.
 * Negative if the date has passed.
 */
function daysUntil(date) {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

/**
 * Determine traffic-light status for a provider license.
 * @param {number|null} hoursRemaining
 * @param {number|null} daysToDeadline
 * @returns {'Complete'|'At Risk'|'In Progress'|'Unknown'}
 */
function getStatus(hoursRemaining, daysToDeadline) {
  if (hoursRemaining === null || hoursRemaining === undefined) return 'Unknown';
  if (hoursRemaining <= 0) return 'Complete';
  if (daysToDeadline !== null && daysToDeadline <= 60) return 'At Risk';
  return 'In Progress';
}

/**
 * Build the course-search URL for a given state + license type.
 */
function courseSearchUrl(state, licenseType) {
  const s = (state || '').toUpperCase();
  const lt = (licenseType || '').toUpperCase();
  return `https://cebroker.com/#!/courses/search?state=${s}&licenseType=${lt}`;
}

// ─── Run Summary ─────────────────────────────────────────────────────────────

/**
 * Print a formatted end-of-run summary table to the console.
 * @param {{ name: string, status: 'success'|'failed', error?: string }[]} results
 */
function printSummary(results) {
  console.log('\n' + '═'.repeat(60));
  console.log('  RUN SUMMARY');
  console.log('═'.repeat(60));

  const succeeded = results.filter((r) => r.status === 'success');
  const failed    = results.filter((r) => r.status === 'failed');

  if (succeeded.length) {
    console.log('\x1b[32m\nSucceeded:\x1b[0m');
    succeeded.forEach((r) => console.log(`  ✓ ${r.name}`));
  }

  if (failed.length) {
    console.log('\x1b[31m\nFailed:\x1b[0m');
    failed.forEach((r) => console.log(`  ✗ ${r.name}${r.error ? ` — ${r.error}` : ''}`));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Total: ${results.length}  |  ✓ ${succeeded.length}  |  ✗ ${failed.length}`);
  console.log('═'.repeat(60) + '\n');
}

module.exports = {
  logger,
  randomDelay,
  sleep,
  screenshotOnError,
  ensureScreenshotsDir,
  parseDate,
  daysUntil,
  getStatus,
  courseSearchUrl,
  printSummary,
};
