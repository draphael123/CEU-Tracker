// platform-scrapers.js — Scrapers for NetCE, CEUfast, and AANP Cert portals

'use strict';

const { logger, sleep, screenshotOnError } = require('./utils');

// ─── Shared helpers ───────────────────────────────────────────────────────────

function emptyResult(platform, providerName, error) {
  return {
    platform,
    providerName,
    hoursEarned:    null,
    hoursRequired:  null,
    hoursRemaining: null,
    certExpires:    null,
    certStatus:     null,
    courses:        [],
    lastUpdated:    null,
    status:         'failed',
    error:          String(error || 'Unknown error'),
  };
}

function makeContext(browser) {
  return browser.newContext({
    viewport:  { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
}

/**
 * Pull course rows out of whatever transcript table is on the current page.
 * Tries several common selector patterns as fallbacks.
 */
async function extractCourseRows(page) {
  return page.evaluate(() => {
    const courses = [];
    const rows = Array.from(document.querySelectorAll(
      'table tbody tr, .transcript-row, .course-row, .completed-course, .activity-row'
    ));
    for (const row of rows) {
      const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 5) continue;
      const hoursMatch = text.match(/(\d+\.?\d*)\s*(?:hour|hr|credit|ceu)/i);
      const dateMatch  = text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
      if (!hoursMatch) continue;
      const cells = Array.from(row.querySelectorAll('td'));
      const name  = (cells[0]?.innerText || cells[0]?.textContent || text).trim().substring(0, 200);
      if (name.length < 3) continue;
      courses.push({
        name,
        hours: parseFloat(hoursMatch[1]),
        date:  dateMatch ? dateMatch[0] : '',
      });
    }
    return courses;
  });
}

// ─── NetCE ────────────────────────────────────────────────────────────────────

async function scrapeNetCE(browser, credentials, providerName) {
  const { username, password } = credentials;
  logger.info(`[NetCE] ${providerName} — logging in as ${username}`);

  const context = await makeContext(browser);
  const page    = await context.newPage();

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    await page.goto('https://www.netce.com/login.php', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(1500);

    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.fill('input[name="username"]', username);
    await sleep(300);
    await page.fill('input[name="password"]', password);
    await sleep(300);
    await page.click('input[type="submit"], button[type="submit"]');
    await sleep(3000);

    // ── Navigate to transcript ────────────────────────────────────────────────
    // Probe confirmed the transcript is at transcript.php (linked from account.php)
    await page.goto('https://www.netce.com/transcript.php', {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await sleep(2000);

    // ── Extract data ─────────────────────────────────────────────────────────
    // transcript.php table: No. | Title | Credits | Completed | Print
    // cells[0]=course#, cells[1]=title, cells[2]=credits(number), cells[3]=date
    // transcript.php columns: No. | Title | Credits | Completed | Print
    // Only count rows with a real completion date (not "Take Test" / "Complete for Credit")
    const courses = await page.evaluate(function() {
      var results = [];
      var rows = document.querySelectorAll('table.order-table tbody tr');
      var dateRe = /\d{1,2}\/\d{1,2}\/\d{4}/;
      for (var i = 0; i < rows.length; i++) {
        var cells = Array.from(rows[i].querySelectorAll('td'));
        if (cells.length < 4) continue;
        var title   = (cells[1].textContent || '').trim();
        var credits = (cells[2].textContent || '').trim();
        var date    = (cells[3].textContent || '').trim();
        var hours   = parseFloat(credits);
        // Skip rows that are not yet completed
        if (!title || isNaN(hours) || !dateRe.test(date)) continue;
        results.push({ name: title, hours: hours, date: date });
      }
      return results;
    });
    const totalHoursEarned = Math.round(courses.reduce(function(s, c) { return s + (c.hours || 0); }, 0) * 10) / 10;

    logger.success(`[NetCE] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned`);

    return {
      platform:       'NetCE',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        courses.slice(0, 100),
      lastUpdated:    new Date().toLocaleDateString('en-US'),
      status:         'success',
      error:          null,
    };

  } catch (err) {
    await screenshotOnError(page, providerName, 'netce_error');
    logger.error(`[NetCE] ${providerName}: ${err.message}`);
    return emptyResult('NetCE', providerName, err.message);
  } finally {
    await context.close();
  }
}

// ─── CEUfast ─────────────────────────────────────────────────────────────────

async function scrapeCEUfast(browser, credentials, providerName) {
  const { username, password } = credentials;
  logger.info(`[CEUfast] ${providerName} — logging in as ${username}`);

  const context = await makeContext(browser);
  const page    = await context.newPage();

  try {
    // ── Login via the dedicated login page ───────────────────────────────────
    // Navigating to /myaccount/ redirects to Account/Login?ReturnUrl=%2fmyaccount%2f
    // That page has a visible form: input[name="UserName"] + input[name="Password"]
    await page.goto('https://www.ceufast.com/myaccount/', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(1500);

    // Wait for the visible login form (not the hidden nav-dropdown form)
    await page.waitForSelector('input[name="UserName"]:visible', { timeout: 15000 });
    await page.fill('input[name="UserName"]', username);
    await sleep(300);
    await page.fill('input[name="Password"]:visible', password);
    await sleep(300);
    // Submit by pressing Enter (works regardless of button selector)
    await page.keyboard.press('Enter');
    await sleep(3000);

    // Wait for redirect to myaccount (away from login page)
    await page.waitForURL(
      function(u) { return !u.toString().includes('Account/Login'); },
      { timeout: 20000 }
    ).catch(function() {});
    await sleep(1500);

    // ── Extract data ─────────────────────────────────────────────────────────
    const courses          = await extractCourseRows(page);
    const totalHoursEarned = Math.round(courses.reduce((s, c) => s + (c.hours || 0), 0) * 10) / 10;

    logger.success(`[CEUfast] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned`);

    return {
      platform:       'CEUfast',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        courses.slice(0, 100),
      lastUpdated:    new Date().toLocaleDateString('en-US'),
      status:         'success',
      error:          null,
    };

  } catch (err) {
    await screenshotOnError(page, providerName, 'ceufast_error');
    logger.error(`[CEUfast] ${providerName}: ${err.message}`);
    return emptyResult('CEUfast', providerName, err.message);
  } finally {
    await context.close();
  }
}

// ─── AANP Cert ────────────────────────────────────────────────────────────────

async function scrapeAANPCert(browser, credentials, providerName) {
  const { username, password } = credentials;
  logger.info(`[AANP Cert] ${providerName} — logging in as ${username}`);

  const context = await makeContext(browser);
  const page    = await context.newPage();

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    await page.goto('https://www.aanpcert.org/signin', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(1500);

    const userSel = [
      'input[name="username"]', 'input[name="email"]', 'input[type="email"]',
      '#username', '#email',
      'input[placeholder*="Email" i]', 'input[placeholder*="Username" i]',
    ].join(', ');
    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.fill(userSel, username);
    await sleep(300);
    await page.fill('input[name="password"], input[type="password"]', password);
    await sleep(300);
    await page.click(
      'button[type="submit"], input[type="submit"], ' +
      'button:has-text("Sign In"), button:has-text("Log In")'
    );
    await sleep(3000);

    // Wait for redirect away from signin
    await page.waitForURL(u => !u.toString().includes('/signin'), { timeout: 20000 }).catch(() => {});
    await sleep(1500);

    // ── Navigate directly to /myce (probe confirmed this URL) ────────────────
    await page.goto('https://www.aanpcert.org/myce', {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await sleep(2000);

    // ── Parse CE progress from /myce ─────────────────────────────────────────
    const body = await page.locator('body').innerText().catch(() => '');

    // Also fetch /mycertifications for cert expiry + status
    await page.goto('https://www.aanpcert.org/mycertifications', {
      waitUntil: 'domcontentloaded', timeout: 15000,
    }).catch(() => {});
    await sleep(1500);
    const certBody = await page.locator('body').innerText().catch(() => '');

    // ── Parse cert info from CERTIFICATIONS* table in /mycertifications ────────
    // Probe layout: "...CERTIFICATIONS*\n...Active\n07/01/2024\n06/30/2029..."
    // We isolate the CERTIFICATIONS* section (before WALL CERTIFICATES) to avoid
    // false-matching "PENDING CERTIFICATION APPLICATIONS" for status.
    const certsSectionMatch = certBody.match(/CERTIFICATIONS\*[\s\S]*?(?=WALL CERTIFICATES|MY AANPCB|$)/i);
    const certsSection = certsSectionMatch ? certsSectionMatch[0] : certBody;

    // Status: Active/Inactive/Expired within certs section
    const statusMatch = certsSection.match(/\b(active|inactive|expired|lapsed)\b/i);
    const certStatus  = statusMatch
      ? statusMatch[1].charAt(0).toUpperCase() + statusMatch[1].slice(1).toLowerCase()
      : null;

    // Expiry: last date in certs section = "Current End" column
    const allCertDates = certsSection.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    const certExpires  = allCertDates.length > 0 ? allCertDates[allCertDates.length - 1] : null;

    // Go back to /myce to extract CE hours from the course table
    await page.goto('https://www.aanpcert.org/myce', {
      waitUntil: 'domcontentloaded', timeout: 15000,
    }).catch(() => {});
    await sleep(1500);

    // ── Extract CE hours from /myce ───────────────────────────────────────────
    // Probe confirmed: CE entries are fieldset > div.row (not <table>).
    // Children of each row: [0]=Program name, [3]=Date, [4]=Hrs/Phrm/EPS.
    // Total is in a separate "Total Current CE Hours:" element (first number).
    const ceData = await page.evaluate(function() {
      var fieldsets   = document.querySelectorAll('fieldset');
      var courses     = [];
      var totalHours  = 0;

      // Grab authoritative total from "Total Current CE Hours" element
      for (var i = 0; i < fieldsets.length; i++) {
        var m = (fieldsets[i].textContent || '').match(
          /Total Current CE Hours[\s\S]{0,40}?(\d+\.\d+)\//
        );
        if (m) { totalHours = parseFloat(m[1]); break; }
      }

      // Extract individual course rows from first fieldset (current cycle)
      if (fieldsets.length > 0) {
        var rows = fieldsets[0].querySelectorAll('div.row');
        for (var j = 0; j < rows.length; j++) {
          var children = Array.from(rows[j].children);
          if (children.length < 5) continue;
          var name = (children[0].textContent || '').trim();
          var date = (children[3] ? children[3].textContent || '' : '').trim();
          var hrs  = (children[4] ? children[4].textContent || '' : '').trim();
          var hm   = hrs.match(/^(\d+\.?\d*)/);
          if (!hm || name.length < 3) continue;
          courses.push({ name: name, hours: parseFloat(hm[1]), date: date });
        }
      }

      return { courses: courses, totalHours: totalHours };
    });

    const hoursCompleted = ceData.totalHours > 0 ? ceData.totalHours : null;
    const hoursRequired  = 100; // AANP standard: 100 CE credits per 5-year cycle
    const hoursRemaining = hoursCompleted !== null ? Math.max(0, hoursRequired - hoursCompleted) : null;

    const courses = ceData.courses;

    logger.success(
      `[AANP Cert] ${providerName}: ${hoursCompleted ?? '?'}/${hoursRequired} credits, ` +
      `status ${certStatus || 'unknown'}, expires ${certExpires || '?'}`
    );

    return {
      platform:       'AANP Cert',
      providerName,
      hoursEarned:    hoursCompleted,
      hoursRequired:  hoursRequired ?? 100,
      hoursRemaining: hoursRemaining,
      certExpires,
      certStatus,
      courses:        courses.slice(0, 100),
      lastUpdated:    new Date().toLocaleDateString('en-US'),
      status:         'success',
      error:          null,
    };

  } catch (err) {
    await screenshotOnError(page, providerName, 'aanpcert_error');
    logger.error(`[AANP Cert] ${providerName}: ${err.message}`);
    return emptyResult('AANP Cert', providerName, err.message);
  } finally {
    await context.close();
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all configured platform scrapers for every provider that has a
 * `platforms` array in providers.json.
 *
 * @param {object} browser   Playwright browser instance (already launched)
 * @param {Array}  providers Entries from providers.json
 * @returns {Promise<Array>} Flat array of platform result objects
 */
async function runPlatformScrapers(browser, providers) {
  const results = [];

  for (const provider of providers) {
    if (!provider.platforms || provider.platforms.length === 0) continue;

    for (const creds of provider.platforms) {
      let result;
      try {
        switch (creds.platform) {
          case 'NetCE':
            result = await scrapeNetCE(browser, creds, provider.name);
            break;
          case 'CEUfast':
            result = await scrapeCEUfast(browser, creds, provider.name);
            break;
          case 'AANP Cert':
            result = await scrapeAANPCert(browser, creds, provider.name);
            break;
          default:
            logger.warn(`[Platform] Unknown platform "${creds.platform}" for ${provider.name}`);
            continue;
        }
      } catch (err) {
        result = emptyResult(creds.platform, provider.name, err.message);
      }
      results.push(result);
      await sleep(2000);
    }
  }

  return results;
}

module.exports = { runPlatformScrapers };
