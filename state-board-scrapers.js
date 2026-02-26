/**
 * State Board License Scrapers
 * Scrapes license status and expiration data from state licensing board portals
 */

const { logger, sleep, screenshotOnError } = require('./utils');

// State board portal configurations
const STATE_PORTALS = {
  // Washington State
  WA: {
    name: 'Washington DOH',
    url: 'https://fortress.wa.gov/doh/providercredentialsearch/',
    loginUrl: 'https://secureaccess.wa.gov/myAccess/saw/select.do',
    type: 'public_lookup', // Can look up by license number without login
    scraper: scrapeWashington
  },
  // Ohio
  OH: {
    name: 'Ohio eLicense',
    url: 'https://elicense.ohio.gov/',
    loginUrl: 'https://elicense.ohio.gov/oh_communitieslogin',
    type: 'authenticated',
    scraper: scrapeOhio
  },
  // Wisconsin
  WI: {
    name: 'Wisconsin DSPS',
    url: 'https://licensesearch.wi.gov/',
    loginUrl: 'https://online.drl.wi.gov/UserLogin.aspx',
    type: 'authenticated',
    scraper: scrapeWisconsin
  },
  // New Jersey
  NJ: {
    name: 'New Jersey Division of Consumer Affairs',
    url: 'https://newjersey.mylicense.com/verification/',
    loginUrl: 'https://newjersey.mylicense.com/MyLicense%20Enterprise/Login.aspx',
    type: 'authenticated',
    scraper: scrapeNewJersey
  },
  // Indiana
  IN: {
    name: 'Indiana PLA',
    url: 'https://mylicense.in.gov/EVerification/',
    loginUrl: 'https://mylicense.in.gov/MyLicense%20Enterprise/Login.aspx',
    type: 'authenticated',
    scraper: scrapeIndiana
  },
  // Michigan
  MI: {
    name: 'Michigan LARA',
    url: 'https://aca-prod.accela.com/MILARA/Default.aspx',
    loginUrl: 'https://miplus.michigan.gov/',
    type: 'authenticated',
    scraper: scrapeMichigan
  }
};

/**
 * Parse credentials from provider spreadsheet data
 */
function parseStateCredentials(providers, spreadsheetData) {
  const credentials = {};

  for (const [state, config] of Object.entries(STATE_PORTALS)) {
    credentials[state] = [];

    // Find credentials for this state from spreadsheet data
    for (const providerData of spreadsheetData) {
      const stateLogins = providerData.logins?.filter(login => {
        const portal = login.portal?.toUpperCase() || '';
        return portal === state ||
               portal.startsWith(state + ' ') ||
               portal.includes(state + ' BON') ||
               portal.includes(state + ' BOM');
      }) || [];

      if (stateLogins.length > 0) {
        credentials[state].push({
          provider: providerData.name,
          logins: stateLogins
        });
      }
    }
  }

  return credentials;
}

/**
 * Washington State - DOH License Lookup
 * Uses public verification (no login needed)
 */
async function scrapeWashington(page, credentials) {
  const results = [];

  for (const cred of credentials) {
    try {
      logger.info(`WA: Looking up ${cred.provider}`);

      // Navigate to public lookup
      await page.goto('https://fortress.wa.gov/doh/providercredentialsearch/', { waitUntil: 'networkidle' });
      await sleep(1000);

      // For public lookup, we'd need the license number
      // For authenticated access, use the login
      if (cred.logins[0]?.username && cred.logins[0]?.password) {
        // Try authenticated portal
        await page.goto('https://secureaccess.wa.gov/myAccess/saw/select.do', { waitUntil: 'networkidle' });

        // Fill login form
        await page.fill('input[name="username"], input[name="user"], input[type="email"], #username', cred.logins[0].username);
        await page.fill('input[name="password"], input[type="password"], #password', cred.logins[0].password);
        await page.click('button[type="submit"], input[type="submit"], .login-btn');

        await page.waitForLoadState('networkidle');
        await sleep(2000);

        // Extract license data from dashboard
        const licenseData = await page.evaluate(() => {
          const licenses = [];
          // Look for license info in common patterns
          const rows = document.querySelectorAll('table tr, .license-row, .credential-item');
          rows.forEach(row => {
            const text = row.textContent;
            const expMatch = text.match(/expires?:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
            const statusMatch = text.match(/(active|inactive|expired|pending)/i);
            const licNumMatch = text.match(/license\s*#?:?\s*([A-Z0-9]+)/i);

            if (expMatch || statusMatch || licNumMatch) {
              licenses.push({
                licenseNumber: licNumMatch?.[1] || '',
                expires: expMatch?.[1] || '',
                status: statusMatch?.[1] || 'Unknown'
              });
            }
          });
          return licenses;
        });

        results.push({
          provider: cred.provider,
          state: 'WA',
          status: 'success',
          licenses: licenseData
        });
      }
    } catch (err) {
      logger.error(`WA scrape failed for ${cred.provider}: ${err.message}`);
      await screenshotOnError(page, cred.provider, 'wa_error');
      results.push({
        provider: cred.provider,
        state: 'WA',
        status: 'failed',
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Ohio eLicense Portal
 */
async function scrapeOhio(page, credentials) {
  const results = [];

  for (const cred of credentials) {
    try {
      logger.info(`OH: Scraping ${cred.provider}`);

      await page.goto('https://elicense.ohio.gov/oh_communitieslogin', { waitUntil: 'networkidle' });
      await sleep(1000);

      // Fill login
      const login = cred.logins[0];
      if (!login?.username || !login?.password) continue;

      await page.fill('input[name="username"], input[name="userid"], input[type="email"], #username, #userid', login.username);
      await page.fill('input[name="password"], input[type="password"], #password', login.password);
      await page.click('button[type="submit"], input[type="submit"], .btn-login, #loginButton');

      await page.waitForLoadState('networkidle');
      await sleep(2000);

      // Extract license info
      const licenseData = await page.evaluate(() => {
        const licenses = [];
        document.querySelectorAll('.license-card, .credential-row, table tbody tr').forEach(el => {
          const text = el.textContent;
          const expMatch = text.match(/expir\w*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
          const statusMatch = text.match(/(active|inactive|expired|pending|valid)/i);
          const typeMatch = text.match(/(RN|NP|APRN|MD|DO|LPN)/i);

          if (expMatch || statusMatch) {
            licenses.push({
              type: typeMatch?.[1] || '',
              expires: expMatch?.[1] || '',
              status: statusMatch?.[1] || 'Unknown'
            });
          }
        });
        return licenses;
      });

      results.push({
        provider: cred.provider,
        state: 'OH',
        status: 'success',
        licenses: licenseData
      });

    } catch (err) {
      logger.error(`OH scrape failed for ${cred.provider}: ${err.message}`);
      await screenshotOnError(page, cred.provider, 'oh_error');
      results.push({
        provider: cred.provider,
        state: 'OH',
        status: 'failed',
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Wisconsin DSPS Portal
 */
async function scrapeWisconsin(page, credentials) {
  const results = [];

  for (const cred of credentials) {
    try {
      logger.info(`WI: Scraping ${cred.provider}`);

      await page.goto('https://online.drl.wi.gov/UserLogin.aspx', { waitUntil: 'networkidle' });
      await sleep(1000);

      const login = cred.logins[0];
      if (!login?.username || !login?.password) continue;

      // Wisconsin uses specific input IDs
      await page.fill('#ctl00_MainContent_txtUserName, input[name*="UserName"], #UserName', login.username);
      await page.fill('#ctl00_MainContent_txtPassword, input[name*="Password"], #Password', login.password);
      await page.click('#ctl00_MainContent_btnLogin, input[type="submit"], .login-button');

      await page.waitForLoadState('networkidle');
      await sleep(2000);

      // Navigate to credentials/licenses section if needed
      const credLink = await page.$('a:has-text("Credentials"), a:has-text("My Licenses"), a:has-text("License")');
      if (credLink) {
        await credLink.click();
        await page.waitForLoadState('networkidle');
        await sleep(1000);
      }

      const licenseData = await page.evaluate(() => {
        const licenses = [];
        document.querySelectorAll('table tr, .license-item, .credential-row').forEach(el => {
          const text = el.textContent;
          const expMatch = text.match(/expir\w*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
          const statusMatch = text.match(/(active|inactive|expired|pending|current)/i);
          const numMatch = text.match(/(\d{6,})/);

          if (expMatch || statusMatch) {
            licenses.push({
              licenseNumber: numMatch?.[1] || '',
              expires: expMatch?.[1] || '',
              status: statusMatch?.[1] || 'Unknown'
            });
          }
        });
        return licenses;
      });

      results.push({
        provider: cred.provider,
        state: 'WI',
        status: 'success',
        licenses: licenseData
      });

    } catch (err) {
      logger.error(`WI scrape failed for ${cred.provider}: ${err.message}`);
      await screenshotOnError(page, cred.provider, 'wi_error');
      results.push({
        provider: cred.provider,
        state: 'WI',
        status: 'failed',
        error: err.message
      });
    }
  }

  return results;
}

/**
 * New Jersey MyLicense Portal
 */
async function scrapeNewJersey(page, credentials) {
  const results = [];

  for (const cred of credentials) {
    try {
      logger.info(`NJ: Scraping ${cred.provider}`);

      await page.goto('https://newjersey.mylicense.com/MyLicense%20Enterprise/Login.aspx', { waitUntil: 'networkidle' });
      await sleep(1000);

      const login = cred.logins[0];
      if (!login?.username || !login?.password) continue;

      await page.fill('input[name*="UserName"], #UserName, input[type="text"]', login.username);
      await page.fill('input[name*="Password"], #Password, input[type="password"]', login.password);
      await page.click('input[type="submit"], button[type="submit"], .login-btn');

      await page.waitForLoadState('networkidle');
      await sleep(2000);

      const licenseData = await page.evaluate(() => {
        const licenses = [];
        document.querySelectorAll('.license-row, table tr, .grid-row').forEach(el => {
          const text = el.textContent;
          const expMatch = text.match(/expir\w*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
          const statusMatch = text.match(/(active|inactive|expired|pending)/i);

          if (expMatch || statusMatch) {
            licenses.push({
              expires: expMatch?.[1] || '',
              status: statusMatch?.[1] || 'Unknown'
            });
          }
        });
        return licenses;
      });

      results.push({
        provider: cred.provider,
        state: 'NJ',
        status: 'success',
        licenses: licenseData
      });

    } catch (err) {
      logger.error(`NJ scrape failed for ${cred.provider}: ${err.message}`);
      await screenshotOnError(page, cred.provider, 'nj_error');
      results.push({
        provider: cred.provider,
        state: 'NJ',
        status: 'failed',
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Indiana MyLicense Portal
 */
async function scrapeIndiana(page, credentials) {
  const results = [];

  for (const cred of credentials) {
    try {
      logger.info(`IN: Scraping ${cred.provider}`);

      await page.goto('https://mylicense.in.gov/MyLicense%20Enterprise/Login.aspx', { waitUntil: 'networkidle' });
      await sleep(1000);

      const login = cred.logins[0];
      if (!login?.username || !login?.password) continue;

      await page.fill('input[name*="UserName"], #UserName, input[type="text"]', login.username);
      await page.fill('input[name*="Password"], #Password, input[type="password"]', login.password);
      await page.click('input[type="submit"], button[type="submit"]');

      await page.waitForLoadState('networkidle');
      await sleep(2000);

      const licenseData = await page.evaluate(() => {
        const licenses = [];
        document.querySelectorAll('.license-row, table tr, .credential-item').forEach(el => {
          const text = el.textContent;
          const expMatch = text.match(/expir\w*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
          const statusMatch = text.match(/(active|inactive|expired|pending|valid)/i);

          if (expMatch || statusMatch) {
            licenses.push({
              expires: expMatch?.[1] || '',
              status: statusMatch?.[1] || 'Unknown'
            });
          }
        });
        return licenses;
      });

      results.push({
        provider: cred.provider,
        state: 'IN',
        status: 'success',
        licenses: licenseData
      });

    } catch (err) {
      logger.error(`IN scrape failed for ${cred.provider}: ${err.message}`);
      await screenshotOnError(page, cred.provider, 'in_error');
      results.push({
        provider: cred.provider,
        state: 'IN',
        status: 'failed',
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Michigan MiPLUS Portal
 */
async function scrapeMichigan(page, credentials) {
  const results = [];

  for (const cred of credentials) {
    try {
      logger.info(`MI: Scraping ${cred.provider}`);

      await page.goto('https://miplus.michigan.gov/', { waitUntil: 'networkidle' });
      await sleep(1000);

      const login = cred.logins[0];
      if (!login?.username || !login?.password) continue;

      // Michigan uses MILogin portal
      await page.fill('input[name="username"], input[name="user"], #username, input[type="email"]', login.username);
      await page.fill('input[name="password"], #password, input[type="password"]', login.password);
      await page.click('button[type="submit"], input[type="submit"], .sign-in-btn');

      await page.waitForLoadState('networkidle');
      await sleep(2000);

      const licenseData = await page.evaluate(() => {
        const licenses = [];
        document.querySelectorAll('.license-card, table tr, .credential-row').forEach(el => {
          const text = el.textContent;
          const expMatch = text.match(/expir\w*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
          const statusMatch = text.match(/(active|inactive|expired|pending|valid)/i);

          if (expMatch || statusMatch) {
            licenses.push({
              expires: expMatch?.[1] || '',
              status: statusMatch?.[1] || 'Unknown'
            });
          }
        });
        return licenses;
      });

      results.push({
        provider: cred.provider,
        state: 'MI',
        status: 'success',
        licenses: licenseData
      });

    } catch (err) {
      logger.error(`MI scrape failed for ${cred.provider}: ${err.message}`);
      await screenshotOnError(page, cred.provider, 'mi_error');
      results.push({
        provider: cred.provider,
        state: 'MI',
        status: 'failed',
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Extract state board credentials from spreadsheet
 */
async function extractStateBoardCredentials(spreadsheetPath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(spreadsheetPath);

  const credentials = {};

  // Provider sheet name to full name mapping
  const PROVIDER_SHEETS = {
    'Ashley G': 'Ashley Grout, NP',
    'Bill C, NP': 'Bill Carbonneau, NP',
    'Doron S, MD': 'Doron Stember, MD',
    'Lindsay B, NP': 'Lindsay Burden, NP',
    'Bryana A, NP': 'Bryana Anderson, NP',
    'Martin V, NP': 'Martin Van Dongen, NP',
    'Summer D, NP': 'Summer Denny, NP',
    'Terray H, NP': 'Terray Humphrey, NP',
    'Tim M, NP': 'Tim Mack, NP',
    'Priya C, NP': 'Priya Chaudhari, NP',
    'Tzvi D, DO': 'Tzvi Doron, DO',
    'Victor L, NP': 'Victor Lopez, NP',
    'Vivien L, NP': 'Vivien Lee, NP',
    'Liz G, NP': 'Liz Gloor, NP',
    'Bryce A, NP': 'Bryce Amos, NP'
  };

  for (const [sheetName, providerName] of Object.entries(PROVIDER_SHEETS)) {
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) continue;

    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // Skip header

      const portal = String(row.getCell(9).value || '').trim();
      const username = String(row.getCell(10).value || '').trim();
      const password = String(row.getCell(11).value || '').trim();

      if (!portal || !username || !password) return;

      // Determine which state this portal belongs to
      let state = null;
      const portalUpper = portal.toUpperCase();

      // Check for state abbreviation
      for (const st of Object.keys(STATE_PORTALS)) {
        if (portalUpper === st ||
            portalUpper.startsWith(st + ' ') ||
            portalUpper.includes(st + ' BON') ||
            portalUpper.includes(st + ' BOM')) {
          state = st;
          break;
        }
      }

      if (state) {
        if (!credentials[state]) credentials[state] = [];

        // Check if provider already exists for this state
        let providerEntry = credentials[state].find(c => c.provider === providerName);
        if (!providerEntry) {
          providerEntry = { provider: providerName, logins: [] };
          credentials[state].push(providerEntry);
        }

        providerEntry.logins.push({ portal, username, password });
      }
    });
  }

  return credentials;
}

/**
 * Main function to run all state board scrapers
 */
async function runStateBoardScrapers(browser, spreadsheetPath) {
  const path = require('path');
  const actualPath = spreadsheetPath || path.join(__dirname, 'Source Doc', 'Provider _ Compliance Dashboard (2).xlsx');

  logger.info('Extracting state board credentials from spreadsheet...');
  const credentials = await extractStateBoardCredentials(actualPath);

  const allResults = [];
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  for (const [state, config] of Object.entries(STATE_PORTALS)) {
    const stateCreds = credentials[state] || [];
    if (stateCreds.length === 0) {
      logger.info(`${state}: No credentials found, skipping`);
      continue;
    }

    logger.info(`\n── Scraping ${config.name} (${stateCreds.length} providers) ──`);

    try {
      const results = await config.scraper(page, stateCreds);
      allResults.push(...results);
    } catch (err) {
      logger.error(`${state} scraper error: ${err.message}`);
    }

    // Delay between states
    await sleep(2000);
  }

  await context.close();

  // Summary
  const success = allResults.filter(r => r.status === 'success').length;
  const failed = allResults.filter(r => r.status === 'failed').length;
  logger.success(`State board scraping complete: ${success} succeeded, ${failed} failed`);

  return allResults;
}

module.exports = {
  runStateBoardScrapers,
  extractStateBoardCredentials,
  STATE_PORTALS
};
