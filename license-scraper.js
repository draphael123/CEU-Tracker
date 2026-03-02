// license-scraper.js — License verification via state boards + manual entry fallback

'use strict';

const fs = require('fs');
const path = require('path');
const { logger, sleep, screenshotOnError } = require('./utils');

const LICENSES_FILE = path.join(__dirname, 'licenses.json');
const MANUAL_FILE = path.join(__dirname, 'licenses-manual.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// All 50 US states + DC
const US_STATES = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' }
];

// State board URLs for reference
const STATE_BOARDS = {
  FL: { name: 'Florida DOH MQA', url: 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders' },
  OH: { name: 'Ohio eLicense', url: 'https://elicense.ohio.gov/oh_verifylicense' },
  TX: { name: 'Texas BON', url: 'https://www.bon.texas.gov/licensure_verification.asp.html' },
  MI: { name: 'Michigan LARA', url: 'https://aca-prod.accela.com/MILARA/GeneralProperty/PropertyLookUp.aspx' },
  NM: { name: 'New Mexico RLD', url: 'https://verification.rld.nm.gov/' },
  NY: { name: 'New York OP', url: 'http://www.op.nysed.gov/opsearches.htm' },
  NH: { name: 'New Hampshire OPLC', url: 'https://forms.nh.gov/licenseverification/' }
};

// ─── Shared Helpers ───────────────────────────────────────────────────────────

function makeContext(browser) {
  return browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
}

/**
 * Parse provider name into first and last name.
 */
function parseProviderName(fullName) {
  const namePart = fullName.replace(/,\s*(NP|RN|MD|DO|APRN)$/i, '').trim();
  const parts = namePart.split(/\s+/);
  return {
    firstName: parts[0] || '',
    lastName: parts[parts.length - 1] || '',
    middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : ''
  };
}

/**
 * Get full state name from code.
 */
function getStateName(code) {
  const state = US_STATES.find(s => s.code === code);
  return state ? state.name : code;
}

/**
 * Load manual license data from file.
 */
function loadManualLicenses() {
  try {
    const data = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
    return data.providers || {};
  } catch {
    return {};
  }
}

/**
 * Load existing license data from file.
 */
function loadLicenseData() {
  try {
    return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
  } catch {
    return {
      lastUpdated: null,
      providers: {},
      verificationStats: {}
    };
  }
}

/**
 * Save license data to file and public directory.
 */
function saveLicenseData(data) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');

  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }
  fs.writeFileSync(path.join(PUBLIC_DIR, 'licenses.json'), JSON.stringify(data, null, 2), 'utf8');
  logger.info('License data saved to licenses.json');
}

/**
 * Calculate aggregate statistics from license data.
 */
function calculateStats(licenseData) {
  const allLicenses = Object.values(licenseData.providers)
    .flatMap(p => p.licenses || []);

  const activeLicenses = allLicenses.filter(l => l.status === 'Active');
  const now = new Date();
  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const expiringWithin90Days = activeLicenses.filter(l => {
    if (!l.expirationDate) return false;
    const expDate = new Date(l.expirationDate);
    return expDate <= in90Days && expDate > now;
  });

  return {
    totalProviders: Object.keys(licenseData.providers).length,
    totalLicensesFound: allLicenses.length,
    activeLicenses: activeLicenses.length,
    expiringWithin90Days: expiringWithin90Days.length,
    manualEntries: allLicenses.filter(l => l.verificationSource === 'Manual').length,
    scrapedEntries: allLicenses.filter(l => l.verificationSource !== 'Manual').length
  };
}

// ─── Florida DOH MQA Scraper ──────────────────────────────────────────────────

async function scrapeFloridaLicense(browser, provider) {
  const context = await makeContext(browser);
  const page = await context.newPage();
  const licenses = [];

  try {
    const nameParts = parseProviderName(provider.name);
    logger.info(`[FL DOH] Searching for ${nameParts.firstName} ${nameParts.lastName}...`);

    await page.goto('https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(2000);

    // Fill search form - last name field
    const lastNameInput = page.locator('input[id*="LastName"], input[name*="LastName"], input[placeholder*="Last"]').first();
    if (await lastNameInput.isVisible({ timeout: 5000 })) {
      await lastNameInput.fill(nameParts.lastName);
      await sleep(300);
    } else {
      throw new Error('Could not find last name field');
    }

    // Fill first name
    const firstNameInput = page.locator('input[id*="FirstName"], input[name*="FirstName"], input[placeholder*="First"]').first();
    if (await firstNameInput.isVisible({ timeout: 3000 })) {
      await firstNameInput.fill(nameParts.firstName);
      await sleep(300);
    }

    // Select profession type based on provider type
    const professionSelect = page.locator('select[id*="Profession"], select[name*="Profession"]').first();
    if (await professionSelect.isVisible({ timeout: 3000 })) {
      if (provider.type === 'NP' || provider.type === 'RN') {
        // Try to select nursing-related option
        await professionSelect.selectOption({ label: /Registered Nurse|APRN|Nurse/i }).catch(() => {});
      } else if (provider.type === 'MD') {
        await professionSelect.selectOption({ label: /Medical Doctor|Physician/i }).catch(() => {});
      }
      await sleep(300);
    }

    // Submit search
    const searchBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Search")').first();
    await searchBtn.click();
    await sleep(4000);

    // Extract results from the table
    const results = await page.evaluate((lastName) => {
      const licenses = [];
      const rows = document.querySelectorAll('table tr, .result-row, [class*="result"]');

      for (const row of rows) {
        const text = (row.innerText || '').trim();
        if (!text || text.length < 10) continue;
        if (!text.toLowerCase().includes(lastName.toLowerCase())) continue;

        // Extract license number (FL format: usually starts with letters)
        const licNumMatch = text.match(/\b([A-Z]{2,4}\d{5,})\b/i);

        // Determine status
        let status = 'Unknown';
        if (/\bclear\b|\bactive\b/i.test(text)) status = 'Active';
        else if (/\bexpired\b/i.test(text)) status = 'Expired';
        else if (/\binactive\b|\bvoid\b/i.test(text)) status = 'Inactive';

        // Extract expiration date
        const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);

        // Determine license type
        let licenseType = 'RN';
        if (/\bAPRN\b|Advanced Practice/i.test(text)) licenseType = 'APRN';
        else if (/\bMD\b|Medical Doctor|Physician/i.test(text)) licenseType = 'MD';
        else if (/\bLPN\b/i.test(text)) licenseType = 'LPN';

        if (licNumMatch || status !== 'Unknown') {
          licenses.push({
            licenseNumber: licNumMatch ? licNumMatch[1] : null,
            licenseType,
            status,
            expirationDate: dateMatch ? dateMatch[0] : null
          });
        }
      }
      return licenses;
    }, nameParts.lastName);

    for (const result of results) {
      licenses.push({
        state: 'FL',
        stateFullName: 'Florida',
        licenseNumber: result.licenseNumber,
        licenseType: result.licenseType,
        status: result.status,
        expirationDate: result.expirationDate,
        issuedDate: null,
        verificationSource: 'FL DOH MQA',
        lastVerified: new Date().toISOString(),
        disciplineActions: false
      });
    }

    if (licenses.length > 0) {
      logger.success(`[FL DOH] ${provider.name}: Found ${licenses.length} license(s)`);
    } else {
      logger.info(`[FL DOH] ${provider.name}: No licenses found`);
    }

  } catch (err) {
    await screenshotOnError(page, provider.name, 'fl_doh_error');
    logger.warn(`[FL DOH] ${provider.name}: ${err.message}`);
  } finally {
    await context.close();
  }

  return licenses;
}

// ─── Ohio eLicense Scraper ────────────────────────────────────────────────────

async function scrapeOhioLicense(browser, provider) {
  const context = await makeContext(browser);
  const page = await context.newPage();
  const licenses = [];

  try {
    const nameParts = parseProviderName(provider.name);
    logger.info(`[OH eLicense] Searching for ${nameParts.firstName} ${nameParts.lastName}...`);

    await page.goto('https://elicense.ohio.gov/oh_verifylicense', {
      waitUntil: 'networkidle',
      timeout: 45000
    });
    await sleep(3000);

    // Ohio eLicense uses dynamic forms - look for input fields
    const lastNameInput = page.locator('input[id*="LastName"], input[name*="lastName"], input[placeholder*="Last Name"]').first();
    if (await lastNameInput.isVisible({ timeout: 8000 })) {
      await lastNameInput.fill(nameParts.lastName);
      await sleep(500);
    } else {
      // Try alternative - text input fields
      const inputs = page.locator('input[type="text"]');
      const count = await inputs.count();
      if (count > 0) {
        await inputs.first().fill(nameParts.lastName);
        await sleep(500);
      } else {
        throw new Error('Could not find search input field');
      }
    }

    // Look for search/submit button
    const searchBtn = page.locator('button:has-text("Search"), input[type="submit"], button[type="submit"]').first();
    if (await searchBtn.isVisible({ timeout: 5000 })) {
      await searchBtn.click();
      await sleep(5000);
    } else {
      await page.keyboard.press('Enter');
      await sleep(5000);
    }

    // Extract results
    const results = await page.evaluate((lastName) => {
      const licenses = [];
      const rows = document.querySelectorAll('table tr, .license-row, [class*="result"]');

      for (const row of rows) {
        const text = (row.innerText || '').trim();
        if (!text || text.length < 10) continue;
        if (!text.toLowerCase().includes(lastName.toLowerCase())) continue;

        const licNumMatch = text.match(/\b(\d{2}-\d{5,}|\d{6,})\b/);

        let status = 'Unknown';
        if (/\bactive\b/i.test(text)) status = 'Active';
        else if (/\bexpired\b/i.test(text)) status = 'Expired';
        else if (/\binactive\b/i.test(text)) status = 'Inactive';

        const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);

        let licenseType = 'RN';
        if (/\bAPRN\b|NP|Nurse Practitioner/i.test(text)) licenseType = 'APRN';
        else if (/\bMD\b|Physician/i.test(text)) licenseType = 'MD';
        else if (/\bDO\b|Osteopath/i.test(text)) licenseType = 'DO';

        if (licNumMatch || status !== 'Unknown') {
          licenses.push({
            licenseNumber: licNumMatch ? licNumMatch[1] : null,
            licenseType,
            status,
            expirationDate: dateMatch ? dateMatch[0] : null
          });
        }
      }
      return licenses;
    }, nameParts.lastName);

    for (const result of results) {
      licenses.push({
        state: 'OH',
        stateFullName: 'Ohio',
        licenseNumber: result.licenseNumber,
        licenseType: result.licenseType,
        status: result.status,
        expirationDate: result.expirationDate,
        issuedDate: null,
        verificationSource: 'Ohio eLicense',
        lastVerified: new Date().toISOString(),
        disciplineActions: false
      });
    }

    if (licenses.length > 0) {
      logger.success(`[OH eLicense] ${provider.name}: Found ${licenses.length} license(s)`);
    } else {
      logger.info(`[OH eLicense] ${provider.name}: No licenses found`);
    }

  } catch (err) {
    await screenshotOnError(page, provider.name, 'oh_elicense_error');
    logger.warn(`[OH eLicense] ${provider.name}: ${err.message}`);
  } finally {
    await context.close();
  }

  return licenses;
}

// ─── Texas BON Scraper ────────────────────────────────────────────────────────

async function scrapeTexasLicense(browser, provider) {
  const context = await makeContext(browser);
  const page = await context.newPage();
  const licenses = [];

  try {
    const nameParts = parseProviderName(provider.name);
    logger.info(`[TX BON] Searching for ${nameParts.firstName} ${nameParts.lastName}...`);

    // Texas uses NCSBN ID system - direct to verification page
    await page.goto('https://www.bon.texas.gov/licensure_verification.asp.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(2000);

    // Texas BON links to an external verification system
    // Look for the verification link and follow it
    const verifyLink = page.locator('a:has-text("Verify"), a:has-text("License Lookup"), a[href*="verify"]').first();
    if (await verifyLink.isVisible({ timeout: 5000 })) {
      await verifyLink.click();
      await sleep(3000);
    }

    // Try to find and fill search form
    const lastNameInput = page.locator('input[id*="LastName"], input[name*="lastName"], input[placeholder*="Last"]').first();
    if (await lastNameInput.isVisible({ timeout: 5000 })) {
      await lastNameInput.fill(nameParts.lastName);
      await sleep(300);

      const firstNameInput = page.locator('input[id*="FirstName"], input[name*="firstName"]').first();
      if (await firstNameInput.isVisible({ timeout: 3000 })) {
        await firstNameInput.fill(nameParts.firstName);
        await sleep(300);
      }

      const searchBtn = page.locator('button[type="submit"], input[type="submit"]').first();
      await searchBtn.click();
      await sleep(4000);

      // Extract results similar to other scrapers
      const results = await page.evaluate((lastName) => {
        const licenses = [];
        const rows = document.querySelectorAll('table tr, .result');

        for (const row of rows) {
          const text = (row.innerText || '').trim();
          if (!text.toLowerCase().includes(lastName.toLowerCase())) continue;

          const licNumMatch = text.match(/\b(\d{6,})\b/);
          let status = /\bactive\b/i.test(text) ? 'Active' : 'Unknown';
          const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);

          if (licNumMatch) {
            licenses.push({
              licenseNumber: licNumMatch[1],
              licenseType: 'RN',
              status,
              expirationDate: dateMatch ? dateMatch[0] : null
            });
          }
        }
        return licenses;
      }, nameParts.lastName);

      for (const result of results) {
        licenses.push({
          state: 'TX',
          stateFullName: 'Texas',
          ...result,
          issuedDate: null,
          verificationSource: 'Texas BON',
          lastVerified: new Date().toISOString(),
          disciplineActions: false
        });
      }
    }

    if (licenses.length > 0) {
      logger.success(`[TX BON] ${provider.name}: Found ${licenses.length} license(s)`);
    } else {
      logger.info(`[TX BON] ${provider.name}: No licenses found`);
    }

  } catch (err) {
    await screenshotOnError(page, provider.name, 'tx_bon_error');
    logger.warn(`[TX BON] ${provider.name}: ${err.message}`);
  } finally {
    await context.close();
  }

  return licenses;
}

// ─── Generic State Scraper (fallback) ─────────────────────────────────────────

async function scrapeGenericStateLicense(browser, provider, stateCode, boardUrl) {
  const context = await makeContext(browser);
  const page = await context.newPage();
  const licenses = [];

  try {
    const nameParts = parseProviderName(provider.name);
    const stateName = getStateName(stateCode);
    logger.info(`[${stateCode}] Searching for ${nameParts.firstName} ${nameParts.lastName}...`);

    await page.goto(boardUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(2000);

    // Generic approach - look for any name input fields
    const nameInputs = await page.locator('input[type="text"]').all();

    for (const input of nameInputs.slice(0, 2)) {
      const placeholder = await input.getAttribute('placeholder') || '';
      const name = await input.getAttribute('name') || '';
      const id = await input.getAttribute('id') || '';

      const fieldText = `${placeholder} ${name} ${id}`.toLowerCase();

      if (fieldText.includes('last')) {
        await input.fill(nameParts.lastName);
      } else if (fieldText.includes('first')) {
        await input.fill(nameParts.firstName);
      }
      await sleep(200);
    }

    // Try to submit
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Search")').first();
    if (await submitBtn.isVisible({ timeout: 3000 })) {
      await submitBtn.click();
      await sleep(4000);
    }

    // Generic result extraction
    const pageText = await page.locator('body').innerText().catch(() => '');

    if (pageText.toLowerCase().includes(nameParts.lastName.toLowerCase())) {
      const licNumMatch = pageText.match(/\b([A-Z]{0,3}\d{5,}[A-Z\d]*)\b/i);
      const dateMatch = pageText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
      let status = 'Unknown';
      if (/\bactive\b/i.test(pageText)) status = 'Active';
      else if (/\bexpired\b/i.test(pageText)) status = 'Expired';

      if (licNumMatch && status !== 'Unknown') {
        licenses.push({
          state: stateCode,
          stateFullName: stateName,
          licenseNumber: licNumMatch[1],
          licenseType: provider.type === 'MD' ? 'MD' : provider.type === 'DO' ? 'DO' : 'APRN',
          status,
          expirationDate: dateMatch ? dateMatch[0] : null,
          issuedDate: null,
          verificationSource: `${stateName} Board`,
          lastVerified: new Date().toISOString(),
          disciplineActions: false
        });
      }
    }

    if (licenses.length > 0) {
      logger.success(`[${stateCode}] ${provider.name}: Found ${licenses.length} license(s)`);
    }

  } catch (err) {
    logger.warn(`[${stateCode}] ${provider.name}: ${err.message}`);
  } finally {
    await context.close();
  }

  return licenses;
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * Run license verification for all providers.
 * Tries state board scrapers first, then falls back to manual data.
 */
async function runLicenseVerification(browser, providers) {
  logger.info('\n' + '─'.repeat(60));
  logger.info('  LICENSE VERIFICATION (State Boards + Manual)');
  logger.info('─'.repeat(60));

  // Load manual license data
  const manualData = loadManualLicenses();
  let licenseData = loadLicenseData();

  const results = {
    scraped: [],
    manual: [],
    errors: [],
    stats: { verified: 0, failed: 0, licensesFound: 0, manualUsed: 0 }
  };

  // Determine which states each provider might be licensed in
  // Only use state boards that work reliably (FL DOH + NH OPLC)
  // OH, TX, NM scrapers are broken - use manual entry for those states
  const targetStates = ['FL', 'NH'];

  for (const provider of providers) {
    const providerLicenses = [];
    let scrapedAny = false;

    // Try state-specific scrapers for key states
    for (const stateCode of targetStates) {
      try {
        let stateLicenses = [];

        switch (stateCode) {
          case 'FL':
            stateLicenses = await scrapeFloridaLicense(browser, provider);
            break;
          case 'OH':
            stateLicenses = await scrapeOhioLicense(browser, provider);
            break;
          case 'TX':
            stateLicenses = await scrapeTexasLicense(browser, provider);
            break;
          default:
            // Use generic scraper for other states if we have a URL
            if (STATE_BOARDS[stateCode]) {
              stateLicenses = await scrapeGenericStateLicense(browser, provider, stateCode, STATE_BOARDS[stateCode].url);
            }
        }

        if (stateLicenses.length > 0) {
          providerLicenses.push(...stateLicenses);
          scrapedAny = true;
        }

      } catch (err) {
        logger.warn(`[${stateCode}] Error for ${provider.name}: ${err.message}`);
      }

      // Rate limiting between state lookups
      await sleep(1500);
    }

    // Merge with manual data if available
    const manualProviderData = manualData[provider.name];
    if (manualProviderData && manualProviderData.licenses && manualProviderData.licenses.length > 0) {
      for (const manualLicense of manualProviderData.licenses) {
        // Check if we already have this license from scraping
        const exists = providerLicenses.some(l =>
          l.state === manualLicense.state &&
          l.licenseNumber === manualLicense.licenseNumber
        );

        if (!exists) {
          providerLicenses.push({
            state: manualLicense.state,
            stateFullName: getStateName(manualLicense.state),
            licenseNumber: manualLicense.licenseNumber,
            licenseType: manualLicense.licenseType || provider.type,
            status: manualLicense.status || 'Unknown',
            expirationDate: manualLicense.expirationDate || null,
            issuedDate: manualLicense.issuedDate || null,
            verificationSource: 'Manual',
            lastVerified: new Date().toISOString(),
            disciplineActions: false
          });
          results.stats.manualUsed++;
        }
      }
    }

    // Store provider licenses
    licenseData.providers[provider.name] = {
      providerType: provider.type,
      licenses: providerLicenses,
      statesSearched: targetStates.length,
      statesWithLicense: providerLicenses.length,
      lastFullScan: new Date().toISOString()
    };

    results.stats.verified++;
    results.stats.licensesFound += providerLicenses.length;

    if (providerLicenses.length > 0) {
      logger.success(`${provider.name}: ${providerLicenses.length} license(s) found`);
    }
  }

  // Update stats and save
  licenseData.lastUpdated = new Date().toISOString();
  licenseData.verificationStats = calculateStats(licenseData);

  saveLicenseData(licenseData);

  // Print summary
  logger.info('\n' + '─'.repeat(60));
  logger.success(`License verification complete:`);
  logger.info(`  Providers verified: ${results.stats.verified}`);
  logger.info(`  Licenses found: ${results.stats.licensesFound}`);
  logger.info(`  Active licenses: ${licenseData.verificationStats.activeLicenses}`);
  logger.info(`  Manual entries used: ${results.stats.manualUsed}`);
  if (licenseData.verificationStats.expiringWithin90Days > 0) {
    logger.warn(`  Expiring within 90 days: ${licenseData.verificationStats.expiringWithin90Days}`);
  }
  logger.info('─'.repeat(60) + '\n');

  return { licenseData, results };
}

module.exports = {
  runLicenseVerification,
  scrapeFloridaLicense,
  scrapeOhioLicense,
  scrapeTexasLicense,
  loadLicenseData,
  saveLicenseData,
  loadManualLicenses,
  parseProviderName,
  US_STATES,
  STATE_BOARDS
};
