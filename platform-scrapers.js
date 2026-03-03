// platform-scrapers.js — Scrapers for NetCE, CEUfast, and AANP Cert portals

'use strict';

const { logger, sleep, screenshotOnError } = require('./utils');
const { recordSuccess, recordFailure } = require('./credential-health');

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
    orders:         [],
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

    // ── Try to extract order history ────────────────────────────────────────
    let orders = [];
    try {
      // Try common billing/order URLs
      const orderUrls = [
        'https://www.netce.com/account.php',
        'https://www.netce.com/orders.php',
        'https://www.netce.com/order_history.php',
      ];

      for (const url of orderUrls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await sleep(1500);

          const pageOrders = await page.evaluate(() => {
            const results = [];
            // Look for order/receipt tables
            const rows = document.querySelectorAll('table tbody tr, .order-row, .receipt-row');
            for (const row of rows) {
              const text = (row.innerText || '').trim();
              // Look for price patterns
              const priceMatch = text.match(/\$(\d+\.?\d*)/);
              const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
              if (priceMatch && parseFloat(priceMatch[1]) > 0) {
                results.push({
                  date: dateMatch ? dateMatch[0] : '',
                  total: parseFloat(priceMatch[1]),
                  status: 'completed',
                });
              }
            }
            return results;
          });

          if (pageOrders.length > 0) {
            orders = pageOrders;
            break;
          }
        } catch (e) {
          // Try next URL
        }
      }
    } catch (orderErr) {
      // Order extraction is optional
    }

    const totalOrderCost = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const coursesWithPlatform = courses.map(c => ({ ...c, platform: 'NetCE' }));

    logger.success(`[NetCE] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned${totalOrderCost > 0 ? `, $${totalOrderCost.toFixed(2)} in orders` : ''}`);

    return {
      platform:       'NetCE',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        coursesWithPlatform.slice(0, 100),
      orders:         orders,
      totalSpent:     totalOrderCost > 0 ? totalOrderCost : null,
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

    // ── Try to extract order costs ─────────────────────────────────────────
    let orders = [];
    try {
      const orderUrls = [
        'https://www.ceufast.com/myaccount/orders',
        'https://www.ceufast.com/myaccount/billing',
      ];

      for (const url of orderUrls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await sleep(1500);

          const pageOrders = await page.evaluate(() => {
            const results = [];
            const rows = document.querySelectorAll('table tbody tr, .order-row');
            for (const row of rows) {
              const text = (row.innerText || '').trim();
              const priceMatch = text.match(/\$(\d+\.?\d*)/);
              const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
              if (priceMatch && parseFloat(priceMatch[1]) > 0) {
                results.push({
                  date: dateMatch ? dateMatch[0] : '',
                  total: parseFloat(priceMatch[1]),
                  status: 'completed',
                });
              }
            }
            return results;
          });

          if (pageOrders.length > 0) {
            orders = pageOrders;
            break;
          }
        } catch (e) {
          // Try next URL
        }
      }
    } catch (orderErr) {
      // Order extraction is optional
    }

    const totalOrderCost = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const coursesWithPlatform = courses.map(c => ({ ...c, platform: 'CEUfast' }));

    logger.success(`[CEUfast] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned${totalOrderCost > 0 ? `, $${totalOrderCost.toFixed(2)} in orders` : ''}`);

    return {
      platform:       'CEUfast',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        coursesWithPlatform.slice(0, 100),
      orders:         orders,
      totalSpent:     totalOrderCost > 0 ? totalOrderCost : null,
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

    const coursesWithPlatform = courses.map(c => ({ ...c, platform: 'AANP Cert' }));

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
      courses:        coursesWithPlatform.slice(0, 100),
      orders:         [],
      totalSpent:     null,
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

// ─── Exclamation CE ───────────────────────────────────────────────────────────

async function scrapeExclamationCE(browser, credentials, providerName) {
  const { username, password } = credentials;
  logger.info(`[ExclamationCE] ${providerName} — logging in as ${username}`);

  const context = await makeContext(browser);
  const page    = await context.newPage();

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    await page.goto('https://www.exclamationce.com/login', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(1500);

    // Find and fill login form
    const userSel = 'input[name="email"], input[type="email"], input[name="username"], #email, #username';
    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.fill(userSel, username);
    await sleep(300);
    await page.fill('input[name="password"], input[type="password"]', password);
    await sleep(300);
    await page.click('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In")');
    await sleep(3000);

    // Wait for redirect away from login
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 }).catch(() => {});
    await sleep(1500);

    // ── Navigate to transcript/completed courses ──────────────────────────────
    // Try common transcript URLs
    const transcriptUrls = [
      'https://www.exclamationce.com/my-courses',
      'https://www.exclamationce.com/transcript',
      'https://www.exclamationce.com/completed',
      'https://www.exclamationce.com/account/courses',
      'https://www.exclamationce.com/dashboard',
    ];

    let courses = [];
    for (const url of transcriptUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);
        courses = await extractCourseRows(page);
        if (courses.length > 0) break;
      } catch (e) {
        // Try next URL
      }
    }

    const totalHoursEarned = Math.round(courses.reduce((s, c) => s + (c.hours || 0), 0) * 10) / 10;

    const coursesWithPlatform = courses.map(c => ({ ...c, platform: 'ExclamationCE' }));

    logger.success(`[ExclamationCE] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned`);

    return {
      platform:       'ExclamationCE',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        coursesWithPlatform.slice(0, 100),
      orders:         [],
      totalSpent:     null,
      lastUpdated:    new Date().toLocaleDateString('en-US'),
      status:         'success',
      error:          null,
    };

  } catch (err) {
    await screenshotOnError(page, providerName, 'exclamationce_error');
    logger.error(`[ExclamationCE] ${providerName}: ${err.message}`);
    return emptyResult('ExclamationCE', providerName, err.message);
  } finally {
    await context.close();
  }
}

// ─── NurseCE4Less ─────────────────────────────────────────────────────────────

async function scrapeNurseCE4Less(browser, credentials, providerName) {
  const { username, password } = credentials;
  logger.info(`[NurseCE4Less] ${providerName} — logging in as ${username}`);

  const context = await makeContext(browser);
  const page    = await context.newPage();

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    await page.goto('https://nursece4less.com/my-account/', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(1500);

    // WordPress/WooCommerce login form
    const userSel = 'input[name="username"], input#username, input[name="log"]';
    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.fill(userSel, username);
    await sleep(300);
    await page.fill('input[name="password"], input#password, input[name="pwd"]', password);
    await sleep(300);
    await page.click('button[type="submit"], input[type="submit"], button[name="login"]');
    await sleep(3000);

    // Wait for login to complete
    await page.waitForURL(u => !u.toString().includes('login'), { timeout: 20000 }).catch(() => {});
    await sleep(1500);

    // ── Navigate to courses/transcript ──────────────────────────────────────
    // Try common course history URLs for WooCommerce/LearnDash sites
    const transcriptUrls = [
      'https://nursece4less.com/my-account/courses/',
      'https://nursece4less.com/my-courses/',
      'https://nursece4less.com/courses/',
      'https://nursece4less.com/my-account/orders/',
      'https://nursece4less.com/transcript/',
    ];

    let courses = [];
    for (const url of transcriptUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);

        // Try to extract courses from various page structures
        courses = await page.evaluate(() => {
          const results = [];

          // Try LearnDash course list
          const ldCourses = document.querySelectorAll('.ld-item-list-item, .learndash-course-item, .course-item');
          for (const item of ldCourses) {
            const name = (item.querySelector('.ld-item-name, .course-title, a')?.textContent || '').trim();
            const status = item.querySelector('.ld-status, .course-status')?.textContent || '';
            if (name && status.toLowerCase().includes('complete')) {
              const hoursMatch = name.match(/(\d+\.?\d*)\s*(?:hour|hr|credit|ceu|ce)/i);
              results.push({
                name: name.substring(0, 200),
                hours: hoursMatch ? parseFloat(hoursMatch[1]) : 1,
                date: '',
              });
            }
          }

          // Try WooCommerce orders table
          const orderRows = document.querySelectorAll('.woocommerce-orders-table tbody tr, .order-item');
          for (const row of orderRows) {
            const name = (row.querySelector('.order-name, .product-name, td:first-child')?.textContent || '').trim();
            const status = row.querySelector('.order-status, .woocommerce-orders-table__cell-order-status')?.textContent || '';
            if (name && status.toLowerCase().includes('complete')) {
              const hoursMatch = name.match(/(\d+\.?\d*)\s*(?:hour|hr|credit|ceu|ce)/i);
              results.push({
                name: name.substring(0, 200),
                hours: hoursMatch ? parseFloat(hoursMatch[1]) : 1,
                date: '',
              });
            }
          }

          // Generic table extraction
          if (results.length === 0) {
            const rows = document.querySelectorAll('table tbody tr, .course-row, .completed-course');
            for (const row of rows) {
              const text = (row.innerText || '').trim();
              const hoursMatch = text.match(/(\d+\.?\d*)\s*(?:hour|hr|credit|ceu|ce)/i);
              if (hoursMatch && text.length > 5) {
                results.push({
                  name: text.substring(0, 200),
                  hours: parseFloat(hoursMatch[1]),
                  date: '',
                });
              }
            }
          }

          return results;
        });

        if (courses.length > 0) break;
      } catch (e) {
        // Try next URL
      }
    }

    const totalHoursEarned = Math.round(courses.reduce((s, c) => s + (c.hours || 0), 0) * 10) / 10;

    // ── Extract order costs from /my-account/orders/ ──────────────────────────
    let orders = [];
    try {
      await page.goto('https://nursece4less.com/my-account/orders/', {
        waitUntil: 'domcontentloaded', timeout: 15000,
      });
      await sleep(2000);

      orders = await page.evaluate(() => {
        const results = [];
        // WooCommerce orders table structure
        const rows = document.querySelectorAll('.woocommerce-orders-table tbody tr, .woocommerce-MyAccount-orders tbody tr');
        for (const row of rows) {
          const orderNum = (row.querySelector('.woocommerce-orders-table__cell-order-number, td:first-child')?.textContent || '').trim();
          const dateCell = row.querySelector('.woocommerce-orders-table__cell-order-date, td:nth-child(2)');
          const totalCell = row.querySelector('.woocommerce-orders-table__cell-order-total, td:nth-child(4)');
          const statusCell = row.querySelector('.woocommerce-orders-table__cell-order-status, td:nth-child(3)');

          const dateText = (dateCell?.textContent || '').trim();
          const totalText = (totalCell?.textContent || '').trim();
          const status = (statusCell?.textContent || '').trim().toLowerCase();

          // Parse price (handle $XX.XX format)
          const priceMatch = totalText.match(/\$?([\d,]+\.?\d*)/);
          const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;

          // Parse date (various formats)
          const dateMatch = dateText.match(/(\w+\s+\d+,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
          const orderDate = dateMatch ? dateMatch[1] : dateText;

          if (price !== null && status.includes('complete')) {
            results.push({
              orderNumber: orderNum.replace('#', ''),
              date: orderDate,
              total: price,
              status: 'completed',
            });
          }
        }
        return results;
      });

      logger.info(`[NurseCE4Less] ${providerName}: Found ${orders.length} completed orders`);
    } catch (orderErr) {
      logger.warn(`[NurseCE4Less] ${providerName}: Could not extract orders: ${orderErr.message}`);
    }

    // Attach costs to courses if we can match them
    const totalOrderCost = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const coursesWithCosts = courses.map(c => ({
      ...c,
      platform: 'Nursece4less',
      cost: null, // Individual course costs not available from orders
    }));

    logger.success(`[NurseCE4Less] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned, $${totalOrderCost.toFixed(2)} in orders`);

    return {
      platform:       'Nursece4less',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        coursesWithCosts.slice(0, 100),
      orders:         orders,
      totalSpent:     totalOrderCost > 0 ? totalOrderCost : null,
      lastUpdated:    new Date().toLocaleDateString('en-US'),
      status:         'success',
      error:          null,
    };

  } catch (err) {
    await screenshotOnError(page, providerName, 'nursece4less_error');
    logger.error(`[NurseCE4Less] ${providerName}: ${err.message}`);
    return emptyResult('Nursece4less', providerName, err.message);
  } finally {
    await context.close();
  }
}

// ─── Nursing CE Central ───────────────────────────────────────────────────────

async function scrapeNursingCECentral(browser, credentials, providerName) {
  const { username, password } = credentials;
  logger.info(`[Nursing CE Central] ${providerName} — logging in as ${username}`);

  const context = await makeContext(browser);
  const page    = await context.newPage();

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    await page.goto('https://nursingcecentral.com/my-account/', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(1500);

    // WordPress/WooCommerce login form
    const userSel = 'input[name="username"], input#username, input[name="log"], input[name="email"]';
    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.fill(userSel, username);
    await sleep(300);
    await page.fill('input[name="password"], input#password, input[name="pwd"]', password);
    await sleep(300);
    await page.click('button[type="submit"], input[type="submit"], button[name="login"]');
    await sleep(3000);

    // Wait for login to complete
    await page.waitForURL(u => !u.toString().includes('login'), { timeout: 20000 }).catch(() => {});
    await sleep(1500);

    // ── Navigate to courses/transcript ──────────────────────────────────────
    const transcriptUrls = [
      'https://nursingcecentral.com/my-account/courses/',
      'https://nursingcecentral.com/my-courses/',
      'https://nursingcecentral.com/my-account/',
      'https://nursingcecentral.com/transcript/',
      'https://nursingcecentral.com/completed-courses/',
    ];

    let courses = [];
    for (const url of transcriptUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);

        // Extract courses
        courses = await page.evaluate(() => {
          const results = [];

          // Try LearnDash/course list structures
          const courseItems = document.querySelectorAll(
            '.ld-item-list-item, .learndash-course-item, .course-item, ' +
            '.my-course-item, .completed-course, .course-card'
          );
          for (const item of courseItems) {
            const name = (item.querySelector('.ld-item-name, .course-title, .entry-title, h3, h4, a')?.textContent || '').trim();
            const statusEl = item.querySelector('.ld-status, .course-status, .status');
            const status = statusEl?.textContent || item.className || '';
            const isComplete = status.toLowerCase().includes('complete') ||
                              item.classList.contains('completed') ||
                              item.querySelector('.complete, .completed, [class*="complete"]');

            if (name && (isComplete || !statusEl)) {
              const hoursMatch = name.match(/(\d+\.?\d*)\s*(?:hour|hr|credit|ceu|ce)/i);
              results.push({
                name: name.substring(0, 200),
                hours: hoursMatch ? parseFloat(hoursMatch[1]) : 1,
                date: '',
              });
            }
          }

          // Try table-based transcript
          if (results.length === 0) {
            const rows = document.querySelectorAll('table tbody tr');
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll('td'));
              const text = (row.innerText || '').trim();
              const hoursMatch = text.match(/(\d+\.?\d*)\s*(?:hour|hr|credit|ceu|ce)/i);
              if (hoursMatch && cells.length >= 2) {
                const name = (cells[0]?.textContent || text).trim();
                results.push({
                  name: name.substring(0, 200),
                  hours: parseFloat(hoursMatch[1]),
                  date: '',
                });
              }
            }
          }

          return results;
        });

        if (courses.length > 0) break;
      } catch (e) {
        // Try next URL
      }
    }

    const totalHoursEarned = Math.round(courses.reduce((s, c) => s + (c.hours || 0), 0) * 10) / 10;

    // ── Extract order costs from /my-account/orders/ ──────────────────────────
    let orders = [];
    try {
      await page.goto('https://nursingcecentral.com/my-account/orders/', {
        waitUntil: 'domcontentloaded', timeout: 15000,
      });
      await sleep(2000);

      orders = await page.evaluate(() => {
        const results = [];
        // WooCommerce orders table structure
        const rows = document.querySelectorAll('.woocommerce-orders-table tbody tr, .woocommerce-MyAccount-orders tbody tr');
        for (const row of rows) {
          const orderNum = (row.querySelector('.woocommerce-orders-table__cell-order-number, td:first-child')?.textContent || '').trim();
          const dateCell = row.querySelector('.woocommerce-orders-table__cell-order-date, td:nth-child(2)');
          const totalCell = row.querySelector('.woocommerce-orders-table__cell-order-total, td:nth-child(4)');
          const statusCell = row.querySelector('.woocommerce-orders-table__cell-order-status, td:nth-child(3)');

          const dateText = (dateCell?.textContent || '').trim();
          const totalText = (totalCell?.textContent || '').trim();
          const status = (statusCell?.textContent || '').trim().toLowerCase();

          // Parse price (handle $XX.XX format)
          const priceMatch = totalText.match(/\$?([\d,]+\.?\d*)/);
          const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;

          // Parse date (various formats)
          const dateMatch = dateText.match(/(\w+\s+\d+,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
          const orderDate = dateMatch ? dateMatch[1] : dateText;

          if (price !== null && status.includes('complete')) {
            results.push({
              orderNumber: orderNum.replace('#', ''),
              date: orderDate,
              total: price,
              status: 'completed',
            });
          }
        }
        return results;
      });

      logger.info(`[Nursing CE Central] ${providerName}: Found ${orders.length} completed orders`);
    } catch (orderErr) {
      logger.warn(`[Nursing CE Central] ${providerName}: Could not extract orders: ${orderErr.message}`);
    }

    // Attach platform to courses
    const totalOrderCost = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const coursesWithCosts = courses.map(c => ({
      ...c,
      platform: 'Nursing CE Central',
      cost: null, // Individual course costs not available from orders
    }));

    logger.success(`[Nursing CE Central] ${providerName}: ${courses.length} courses, ${totalHoursEarned}h earned, $${totalOrderCost.toFixed(2)} in orders`);

    return {
      platform:       'Nursing CE Central',
      providerName,
      hoursEarned:    totalHoursEarned || null,
      hoursRequired:  null,
      hoursRemaining: null,
      certExpires:    null,
      certStatus:     null,
      courses:        coursesWithCosts.slice(0, 100),
      orders:         orders,
      totalSpent:     totalOrderCost > 0 ? totalOrderCost : null,
      lastUpdated:    new Date().toLocaleDateString('en-US'),
      status:         'success',
      error:          null,
    };

  } catch (err) {
    await screenshotOnError(page, providerName, 'nursingcecentral_error');
    logger.error(`[Nursing CE Central] ${providerName}: ${err.message}`);
    return emptyResult('Nursing CE Central', providerName, err.message);
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
          case 'ExclamationCE':
            result = await scrapeExclamationCE(browser, creds, provider.name);
            break;
          case 'Nursece4less':
            result = await scrapeNurseCE4Less(browser, creds, provider.name);
            break;
          case 'Nursing CE Central':
            result = await scrapeNursingCECentral(browser, creds, provider.name);
            break;
          default:
            logger.warn(`[Platform] Unknown platform "${creds.platform}" for ${provider.name}`);
            continue;
        }
      } catch (err) {
        result = emptyResult(creds.platform, provider.name, err.message);
      }

      // Track credential health
      if (result.status === 'success') {
        recordSuccess(provider.name, creds.platform);
      } else {
        recordFailure(provider.name, creds.platform, result.error || 'Unknown error');
      }

      results.push(result);
      await sleep(2000);
    }
  }

  return results;
}

module.exports = { runPlatformScrapers };
