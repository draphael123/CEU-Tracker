// scraper.js — Playwright login + CE Broker (Propelus) data scraping

const { chromium } = require('playwright');
const { logger, sleep, screenshotOnError } = require('./utils');

// ─── Browser Launch ──────────────────────────────────────────────────────────

async function launchBrowser() {
  logger.info('Launching browser...');
  return chromium.launch({
    headless: false,
    slowMo: 40,
    args: ['--start-maximized'],
  });
}

// ─── Login ───────────────────────────────────────────────────────────────────

/**
 * Two-step login on launchpad.cebroker.com/login:
 *   Step 1 → fill username → click Continue
 *   Step 2 → fill password → click Log in
 *
 * Returns an open page on the dashboard, throws on failure.
 */
async function loginProvider(browser, provider) {
  const { name, username, password } = provider;
  logger.info(`Logging in as ${name} (${username})...`);

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://launchpad.cebroker.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(1500);

    // Step 1 — username
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.fill('input[name="username"]', username);
    await sleep(400);
    await page.click('button[type="submit"]');   // "Continue"

    // Step 2 — password (same URL, SPA reveals the field)
    await page.waitForSelector('input[name="password"]', { timeout: 15000 });
    await sleep(400);
    await page.fill('input[name="password"]', password);
    await sleep(300);
    await page.click('button[type="submit"]');   // "Log in"

    // Wait for URL to reach the licensees dashboard (handles redirect via /login?redirect_to=...)
    await page.waitForURL(
      u => u.toString().includes('licensees.cebroker.com') && !u.toString().includes('/login'),
      { timeout: 25000 }
    );
    await sleep(2500);

    logger.success(`Logged in as ${name}`);
    return page;

  } catch (err) {
    await screenshotOnError(page, name, 'login_error');
    await context.close();
    throw err;
  }
}

// ─── Data Scraping ────────────────────────────────────────────────────────────

/**
 * Scrape all license records for the currently logged-in provider.
 * Iterates through every license in the selector dropdown.
 *
 * @param {import('playwright').Page} page
 * @param {{ name: string, type: string }} provider
 * @returns {Promise<LicenseRecord[]>}
 */
async function scrapeLicenseData(page, provider) {
  logger.info(`Scraping CEU data for ${provider.name}...`);
  const records = [];

  try {
    // ── Collect all license IDs from the selector dropdown ────────────────
    // The dropdown button shows "LicenseID + LicenseType + State | LicNum"
    // Clicking it reveals A.eui-dropdown-item options.
    const licenseIds = await getLicenseIds(page);

    if (licenseIds.length === 0) {
      // Scrape whatever is currently showing
      const rec = await scrapeCurrentLicense(page, provider);
      if (rec) records.push(rec);
    } else {
      for (const licId of licenseIds) {
        // Navigate to that license's overview page
        const licUrl = `https://licensees.cebroker.com/license/${licId}/overview`;
        await page.goto(licUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(2500);
        const rec = await scrapeCurrentLicense(page, provider);
        if (rec) records.push(rec);
      }
    }
  } catch (err) {
    await screenshotOnError(page, provider.name, 'scrape_error');
    logger.error(`Scrape error for ${provider.name}: ${err.message}`);
  }

  if (records.length === 0) {
    logger.warn(`No records found for ${provider.name} — using placeholder`);
    records.push(emptyRecord(provider));
  }
  return records;
}

/**
 * Get all license IDs visible in the license selector dropdown.
 * Returns an empty array if there's only one license or the dropdown isn't found.
 */
async function getLicenseIds(page) {
  const ids = [];
  try {
    // The license selector is a button.eui-select-trigger near the license header
    // Its text is like "11558574Certified Nurse PractitionerNew Mexico| 56614"
    // Clicking it opens a dropdown with A.eui-dropdown-item options whose href
    // contains the license path.
    const trigger = page.locator('.lic-navbar .eui-select-trigger, [class*="license-selector"] .eui-select-trigger').first();
    if (!await trigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Try the current URL for the single license ID
      const urlMatch = page.url().match(/\/license\/(\d+)\//);
      if (urlMatch) ids.push(urlMatch[1]);
      return ids;
    }

    await trigger.click();
    await sleep(600);

    const options = await page.locator('a.eui-dropdown-item[href*="/license/"]').all();
    for (const opt of options) {
      const href = await opt.getAttribute('href').catch(() => null);
      if (href) {
        const m = href.match(/\/license\/(\d+)/);
        if (m) ids.push(m[1]);
      }
    }
    // Close dropdown
    await page.keyboard.press('Escape');
    await sleep(400);

    if (ids.length === 0) {
      const urlMatch = page.url().match(/\/license\/(\d+)\//);
      if (urlMatch) ids.push(urlMatch[1]);
    }
  } catch (err) {
    logger.warn(`getLicenseIds: ${err.message}`);
    const urlMatch = page.url().match(/\/license\/(\d+)\//);
    if (urlMatch) ids.push(urlMatch[1]);
  }
  return ids;
}

/**
 * Scrape the license currently shown on screen (Overview tab must be active).
 */
async function scrapeCurrentLicense(page, provider) {
  // ── Provider name ─────────────────────────────────────────────────────────
  let providerName = provider.name;
  try {
    // The name appears in e.g. <span class="lic-navbar-name">Bryana Anderson</span>
    // or in a top-level heading — try a few selectors
    const nameEl = page.locator('.lic-navbar-name, h1.provider-name, [data-testid="provider-name"]').first();
    if (await nameEl.isVisible({ timeout: 2000 }).catch(() => false)) {
      providerName = (await nameEl.textContent() || '').trim() || providerName;
    }
  } catch { /* keep default */ }

  // ── Extract Overview body text for state / CE cycle / license # ──────────
  const body = await page.locator('body').innerText().catch(() => '');

  const stateMatch   = body.match(/State\s*\n([\w ]+)\n/);
  const cycleMatch   = body.match(/CE Cycle\s*\n([\d/]+ - [\d/]+)/);
  const licNumMatch  = body.match(/License #\s*\n(\S+)/);

  const state           = stateMatch  ? stateMatch[1].trim()  : null;
  const cycleStr        = cycleMatch  ? cycleMatch[1].trim()  : null;
  const renewalDeadline = cycleStr ? cycleStr.split(' - ')[1] : null; // end of CE cycle
  const licenseNumber   = licNumMatch ? licNumMatch[1].trim() : null;

  // ── License ID from the current page URL ──────────────────────────────────
  const urlLicMatch = page.url().match(/\/license\/(\d+)\//);
  const licenseId   = urlLicMatch ? urlLicMatch[1] : null;

  // ── License type from the page sub-header ─────────────────────────────────
  let licenseType = provider.type;
  try {
    // "Certified Nurse Practitioner" appears just below the provider name
    const ltEl = page.locator('.lic-navbar-credential, .credential-title, h2.license-type').first();
    if (await ltEl.isVisible({ timeout: 2000 }).catch(() => false)) {
      licenseType = (await ltEl.textContent() || '').trim() || licenseType;
    }
  } catch { /* keep default */ }

  // ── Requirements tab — get required hours & subject areas ─────────────────
  let hoursRequired  = null;
  const subjectAreas = [];

  try {
    // Dismiss any Pendo tutorial overlay that intercepts clicks
    await dismissPendo(page);

    // Both Basic ("REQUIREMENTS") and Professional ("TRANSCRIPT") accounts link to
    // the same transcript page — just the tab label differs.
    await page.waitForSelector('a:has-text("REQUIREMENTS"), a:has-text("TRANSCRIPT")', { timeout: 15000 });
    const tabLink = page.locator('a:has-text("REQUIREMENTS"), a:has-text("TRANSCRIPT")').first();
    const tabHref = await tabLink.getAttribute('href').catch(() => null);
    if (tabHref) {
      await page.goto('https://licensees.cebroker.com' + tabHref, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } else {
      await tabLink.click({ force: true });
    }
    await sleep(2000);

    // ── Professional accounts: summary numbers shown at top of transcript ──
    // Layout: "24\nHours Required\n45\nHours Posted\n6\nHours Needed"
    const transcriptBody = await page.locator('body').innerText().catch(() => '');
    const proSummaryMatch = transcriptBody.match(
      /(\d+(?:\.\d+)?)\s*\n\s*Hours Required\s*\n\s*(\d+(?:\.\d+)?)\s*\n\s*Hours Posted\s*\n\s*(\d+(?:\.\d+)?)\s*\n\s*Hours Needed/i
    );
    if (proSummaryMatch) {
      hoursRequired = parseFloat(proSummaryMatch[1]);
      // For Professional accounts use the transcript's own Posted & Needed values;
      // they're more accurate than summing raw course history.
      const postedOverride  = parseFloat(proSummaryMatch[2]);
      const neededOverride  = parseFloat(proSummaryMatch[3]);
      // We'll store these on the record after this block via the outer scope vars.
      // Pass them out via a small side-channel on the subjectAreas array.
      subjectAreas._proHoursCompleted = postedOverride;
      subjectAreas._proHoursRemaining = neededOverride;
    }

    // ── Subject area table rows ────────────────────────────────────────────
    // Basic:        TD[0]=name  TD[1]=required   TD[2]= (empty)  TD[3]= (empty)
    // Professional: TD[0]=name  TD[1]=required   TD[2]=posted    TD[3]=needed
    const reqRows = await page.locator('table tbody tr').all();
    for (const row of reqRows) {
      const tds = await row.locator('td').all();
      if (tds.length < 2) continue;
      const rawName  = (await tds[0].textContent().catch(() => '')).trim();
      // The name cell may contain course sub-rows — keep only the first line
      const subjectName = rawName.split('\n')[0].trim();
      const reqHoursStr = (await tds[1].textContent().catch(() => '')).trim();
      const reqH        = parseFloat(reqHoursStr);
      if (!subjectName || subjectName.toLowerCase().startsWith('total') || isNaN(reqH)) continue;

      const postedStr = tds[2] ? (await tds[2].textContent().catch(() => '')).trim() : '';
      const neededStr = tds[3] ? (await tds[3].textContent().catch(() => '')).trim() : '';
      const posted    = parseFloat(postedStr);
      const needed    = parseFloat(neededStr);

      subjectAreas.push({
        topicName:      subjectName,
        hoursRequired:  reqH,
        hoursCompleted: isNaN(posted) ? null : posted,
        hoursNeeded:    isNaN(needed) ? null : needed,
      });
    }

    // ── Total hours — prefer the summary row over individual sums ─────────
    if (hoursRequired === null) {
      // Basic accounts: parse "Total Hours:\t50\t-\t-" from page text
      const totalMatch = transcriptBody.match(/Total Hours:\s*([\d.]+)/i);
      if (totalMatch) hoursRequired = parseFloat(totalMatch[1]);
    }
    // Still null → sum from subject areas
    if (hoursRequired === null && subjectAreas.length > 0) {
      hoursRequired = subjectAreas.reduce((s, a) => s + (a.hoursRequired || 0), 0);
    }

  } catch (reqErr) {
    logger.warn(`Requirements tab error for ${provider.name}: ${reqErr.message}`);
  }

  // ── Navigate back to Overview for course history ──────────────────────────
  try {
    await page.waitForSelector('a:has-text("OVERVIEW")', { timeout: 10000 });
    const ovHref = await page.locator('a:has-text("OVERVIEW")').first()
      .getAttribute('href').catch(() => null);
    if (ovHref) {
      await page.goto('https://licensees.cebroker.com' + ovHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      await page.locator('a:has-text("OVERVIEW")').first().click({ force: true });
    }
    await sleep(2000);
  } catch { /* may already be on overview */ }

  // ── Scrape course history ─────────────────────────────────────────────────
  // For Professional accounts the transcript already gives accurate totals.
  // We still attempt to collect individual course records for both account types.
  let hoursCompleted = subjectAreas._proHoursCompleted ?? null;
  let hoursRemaining = subjectAreas._proHoursRemaining ?? null;
  let completedCourses = [];

  if (hoursCompleted === null) {
    // Basic account — navigate to Overview first, then paginate course history
    try {
      const result = await scrapeCourseHistory(page);
      hoursCompleted   = result.total;
      completedCourses = result.courses;
    } catch (histErr) {
      logger.warn(`Course history error for ${provider.name}: ${histErr.message}`);
    }
  } else {
    logger.info(`  Using Professional transcript totals (skipping course history pagination)`);
    // Professional: try to collect courses from the transcript page we're already on
    try {
      const result = await scrapeCourseHistory(page);
      if (result.courses.length > 0) completedCourses = result.courses;
    } catch { /* not available on this page — ok */ }
  }

  if (hoursRemaining === null && hoursRequired !== null && hoursCompleted !== null) {
    hoursRemaining = Math.max(0, hoursRequired - hoursCompleted);
  }

  logger.info(
    `  ${state || '?'} — Req: ${hoursRequired ?? '?'}h  Completed: ${hoursCompleted ?? '?'}h  Remaining: ${hoursRemaining ?? '?'}h`
  );

  return {
    providerName,
    providerType:  provider.type,
    state,
    licenseType,
    licenseNumber,
    licenseId,
    renewalDeadline,
    hoursRequired,
    hoursCompleted,
    hoursRemaining,
    lastUpdated:   new Date().toLocaleDateString('en-US'),
    subjectAreas,
    completedCourses,
    providerEmail: provider.email || (provider.username?.includes('@') ? provider.username : null),
    providerPhone: provider.phone || null,
  };
}

/**
 * Paginate through course history and collect individual course records.
 * Returns { total: number, courses: Array<{ name, hours, date, category }> }
 */
async function scrapeCourseHistory(page) {
  let total = 0;
  const courses = [];

  await dismissPendo(page);

  // Try to set page size to 100
  try {
    const pageSizeTrigger = page.locator('.eui-pager .eui-select-trigger').first();
    if (await pageSizeTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pageSizeTrigger.click();
      await sleep(500);
      const opt100 = page.locator('a.eui-dropdown-item:has-text("100")').first();
      if (await opt100.isVisible({ timeout: 2000 }).catch(() => false)) {
        await opt100.click();
        await sleep(2000);
      } else {
        await page.keyboard.press('Escape');
      }
    }
  } catch { /* ok */ }

  let page_num = 1;
  while (true) {
    // Extract course records in one evaluate call to minimise round-trips
    const pageCourses = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('p.course-hours').forEach(hoursEl => {
        const hours = parseFloat((hoursEl.textContent || '').trim());
        if (isNaN(hours)) return;

        // Walk up to find a block element that wraps one course entry
        let block = hoursEl.parentElement;
        for (let i = 0; i < 7 && block; i++) {
          const tag = block.tagName.toLowerCase();
          const cls = (block.className || '').toLowerCase();
          if (tag === 'li' || tag === 'article' || tag === 'section' ||
              cls.includes('course') || cls.includes('card') ||
              cls.includes('history') || cls.includes('record') ||
              cls.includes('item')) break;
          block = block.parentElement;
        }
        if (!block) { items.push({ name: '', hours, date: '', category: '' }); return; }

        // Course name = longest leaf-node text that isn't just a number or short label
        const leaves = Array.from(block.querySelectorAll('*'))
          .filter(el => el.children.length === 0 && el !== hoursEl)
          .map(el => (el.textContent || '').trim())
          .filter(t => t.length > 8 && !/^\d+\.?\d*$/.test(t));
        const name = leaves.sort((a, b) => b.length - a.length)[0] || '';

        // Date: look for MM/DD/YYYY pattern anywhere in the block
        const blockText = block.innerText || block.textContent || '';
        const dateMatch = blockText.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
        const date = dateMatch ? dateMatch[0] : '';

        // Category: look for a "category", "topic", or "subject" labelled element
        const catEl = block.querySelector(
          '[class*="category"], [class*="topic"], [class*="subject"], [class*="type"]'
        );
        const category = catEl ? (catEl.textContent || '').trim().split('\n')[0].trim() : '';

        items.push({ name: name.substring(0, 200), hours, date, category });
      });
      return items;
    });

    const pageTotal = pageCourses.reduce((s, c) => s + c.hours, 0);
    total += pageTotal;
    courses.push(...pageCourses);
    logger.info(`    Page ${page_num}: found ${pageCourses.length} courses, ${pageTotal}h`);

    const nextBtn = page.locator('button.eui-pager-btn-next').first();
    const isDisabled = await nextBtn.isDisabled({ timeout: 2000 }).catch(() => true);
    if (isDisabled) break;
    await nextBtn.click({ force: true }).catch(() =>
      page.evaluate(() => document.querySelector('button.eui-pager-btn-next')?.click())
    );
    await sleep(1800);
    page_num++;
    if (page_num > 20) break;
  }

  return { total, courses };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Dismiss any Pendo in-app guidance overlay that intercepts pointer events.
 * Tries Escape key first, then removes the DOM nodes via JS.
 */
async function dismissPendo(page) {
  try {
    // Press Escape — Pendo usually respects this
    await page.keyboard.press('Escape');
    await sleep(400);
    // If the backdrop is still there, remove it via JS
    const pendoPresent = await page.locator('#pendo-base, .pendo-backdrop-region-right').first()
      .isVisible({ timeout: 1000 }).catch(() => false);
    if (pendoPresent) {
      await page.evaluate(() => {
        document.querySelectorAll('[id^="pendo"], [class*="pendo-backdrop"]').forEach(el => el.remove());
      });
      await sleep(300);
    }
  } catch { /* ok */ }
}

function emptyRecord(provider) {
  return {
    providerName:     provider.name,
    providerType:     provider.type,
    state:            null,
    licenseType:      provider.type,
    licenseNumber:    null,
    licenseId:        null,
    renewalDeadline:  null,
    hoursRequired:    null,
    hoursCompleted:   null,
    hoursRemaining:   null,
    lastUpdated:      null,
    subjectAreas:     [],
    completedCourses: [],
    providerEmail:    provider.email || (provider.username?.includes('@') ? provider.username : null),
    providerPhone:    provider.phone || null,
  };
}

async function closePage(page) {
  try { await page.context().close(); } catch { /* ignore */ }
}

module.exports = { launchBrowser, loginProvider, scrapeLicenseData, closePage };
