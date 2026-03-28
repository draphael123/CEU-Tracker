// credential-test.js — Bulk credential validation (login-only, no scraping)
// Run with: node credential-test.js [--platform=CEUfast] [--provider="Name"]

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { logger, sleep } = require('./utils');
const { recordSuccess, recordFailure, getHealthSummary } = require('./credential-health');
const { getAllProviders } = require('./credentials-loader');

const providers = getAllProviders();

// ─── Platform Registry ────────────────────────────────────────────────────────

const platformsPath = path.join(__dirname, 'platforms.json');
const platforms = JSON.parse(fs.readFileSync(platformsPath, 'utf8'));

/**
 * Get platform configuration by display name
 */
function getPlatformConfig(displayName) {
  const nameMap = {
    'CE Broker': 'cebroker',
    'NetCE': 'netce',
    'CEUfast': 'ceufast',
    'AANP Cert': 'aanpcert',
    'ExclamationCE': 'exclamationce',
    'Nursece4less': 'nursece4less',
    'Nursing CE Central': 'nursingcecentral',
  };
  const key = nameMap[displayName];
  return key ? platforms[key] : null;
}

/**
 * Check if a platform is enabled
 */
function isPlatformEnabled(displayName) {
  const config = getPlatformConfig(displayName);
  return config ? config.status === 'active' : false;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const LOGIN_TIMEOUT = 20000;  // 20 seconds max per login attempt

// ─── Platform Login Testers ───────────────────────────────────────────────────

/**
 * Test CE Broker login
 */
async function testCEBrokerLogin(browser, provider) {
  const platformConfig = getPlatformConfig('CE Broker');
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    // Step 1 — username
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    await page.fill('input[name="username"]', provider.username);
    await sleep(300);
    await page.click('button[type="submit"]');

    // Step 2 — password
    await page.waitForSelector('input[name="password"]', { timeout: 10000 });
    await page.fill('input[name="password"]', provider.password);
    await sleep(300);
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    const dashboardHost = platformConfig.urls.dashboard.replace('https://', '');
    await page.waitForURL(
      u => u.toString().includes(dashboardHost) && !u.toString().includes('/login'),
      { timeout: LOGIN_TIMEOUT }
    );

    return { success: true, platform: 'CE Broker' };
  } catch (err) {
    return { success: false, platform: 'CE Broker', error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Test NetCE login
 */
async function testNetCELogin(browser, creds) {
  const platformConfig = getPlatformConfig('NetCE');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    await page.fill('input[name="username"]', creds.username);
    await page.fill('input[name="password"]', creds.password);
    await page.click('input[type="submit"], button[type="submit"]');
    await sleep(2000);

    // Check for successful login (redirected away from login or account page loaded)
    const url = page.url();
    if (url.includes('login') && (await page.locator('.error, .alert-danger, .login-error').count()) > 0) {
      throw new Error('Invalid credentials');
    }

    return { success: true, platform: 'NetCE' };
  } catch (err) {
    return { success: false, platform: 'NetCE', error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Test CEUfast login
 */
async function testCEUfastLogin(browser, creds) {
  const platformConfig = getPlatformConfig('CEUfast');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    await page.waitForSelector('input[name="UserName"]:visible', { timeout: 10000 });
    await page.fill('input[name="UserName"]', creds.username);
    await page.fill('input[name="Password"]:visible', creds.password);
    await page.keyboard.press('Enter');
    await sleep(2000);

    // Wait for redirect away from login
    await page.waitForURL(
      u => !u.toString().includes('Account/Login'),
      { timeout: LOGIN_TIMEOUT }
    );

    return { success: true, platform: 'CEUfast' };
  } catch (err) {
    return { success: false, platform: 'CEUfast', error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Test AANP Cert login
 */
async function testAANPCertLogin(browser, creds) {
  const platformConfig = getPlatformConfig('AANP Cert');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    const userSel = 'input[name="username"], input[name="email"], input[type="email"], #username, #email';
    await page.waitForSelector(userSel, { timeout: 10000 });
    await page.fill(userSel, creds.username);
    await page.fill('input[name="password"], input[type="password"]', creds.password);
    await page.click('button[type="submit"], input[type="submit"]');
    await sleep(2000);

    // Wait for redirect away from signin
    await page.waitForURL(u => !u.toString().includes('/signin'), { timeout: LOGIN_TIMEOUT });

    return { success: true, platform: 'AANP Cert' };
  } catch (err) {
    return { success: false, platform: 'AANP Cert', error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Test ExclamationCE login
 */
async function testExclamationCELogin(browser, creds) {
  const platformConfig = getPlatformConfig('ExclamationCE');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    const userSel = 'input[name="email"], input[type="email"], input[name="username"]';
    await page.waitForSelector(userSel, { timeout: 10000 });
    await page.fill(userSel, creds.username);
    await page.fill('input[name="password"], input[type="password"]', creds.password);
    await page.click('button[type="submit"], input[type="submit"]');
    await sleep(2000);

    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: LOGIN_TIMEOUT });

    return { success: true, platform: 'ExclamationCE' };
  } catch (err) {
    return { success: false, platform: 'ExclamationCE', error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Test NurseCE4Less login
 */
async function testNurseCE4LessLogin(browser, creds) {
  const platformConfig = getPlatformConfig('Nursece4less');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    const userSel = 'input[name="username"], input#username, input[name="log"]';
    await page.waitForSelector(userSel, { timeout: 10000 });
    await page.fill(userSel, creds.username);
    await page.fill('input[name="password"], input#password', creds.password);
    await page.click('button[type="submit"], input[type="submit"]');
    await sleep(2000);

    return { success: true, platform: 'Nursece4less' };
  } catch (err) {
    return { success: false, platform: 'Nursece4less', error: err.message };
  } finally {
    await context.close();
  }
}

/**
 * Test Nursing CE Central login
 */
async function testNursingCECentralLogin(browser, creds) {
  const platformConfig = getPlatformConfig('Nursing CE Central');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(platformConfig.urls.login, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });
    await sleep(1000);

    const userSel = 'input[name="username"], input#username, input[name="log"]';
    await page.waitForSelector(userSel, { timeout: 10000 });
    await page.fill(userSel, creds.username);
    await page.fill('input[name="password"], input#password', creds.password);
    await page.click('button[type="submit"], input[type="submit"]');
    await sleep(2000);

    return { success: true, platform: 'Nursing CE Central' };
  } catch (err) {
    return { success: false, platform: 'Nursing CE Central', error: err.message };
  } finally {
    await context.close();
  }
}

// ─── Platform Tester Map ──────────────────────────────────────────────────────

const platformTesters = {
  'NetCE':             testNetCELogin,
  'CEUfast':           testCEUfastLogin,
  'AANP Cert':         testAANPCertLogin,
  'ExclamationCE':     testExclamationCELogin,
  'Nursece4less':      testNurseCE4LessLogin,
  'Nursing CE Central': testNursingCECentralLogin,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  let filterPlatform = null;
  let filterProvider = null;

  for (const arg of args) {
    if (arg.startsWith('--platform=')) {
      filterPlatform = arg.split('=')[1];
    } else if (arg.startsWith('--provider=')) {
      filterProvider = arg.split('=')[1];
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  BULK CREDENTIAL VALIDATION');
  if (filterPlatform) console.log(`  Filtering: platform=${filterPlatform}`);
  if (filterProvider) console.log(`  Filtering: provider=${filterProvider}`);
  console.log('═'.repeat(60) + '\n');

  const browser = await chromium.launch({ headless: true });

  const results = {
    ceBroker: { success: [], failed: [] },
    platforms: { success: [], failed: [] },
  };

  // ── Test CE Broker Credentials ──────────────────────────────────────────────
  if (!filterPlatform || filterPlatform.toLowerCase() === 'cebroker' || filterPlatform.toLowerCase() === 'ce broker') {
    logger.info('Testing CE Broker credentials...\n');

    for (const provider of providers) {
      if (filterProvider && !provider.name.toLowerCase().includes(filterProvider.toLowerCase())) continue;
      if (!provider.username || !provider.password) continue;

      process.stdout.write(`  ${provider.name}: `);
      const result = await testCEBrokerLogin(browser, provider);

      if (result.success) {
        console.log('\x1b[32m✓ OK\x1b[0m');
        results.ceBroker.success.push(provider.name);
        recordSuccess(provider.name, 'CE Broker');
      } else {
        console.log(`\x1b[31m✗ FAILED\x1b[0m - ${result.error.split('\n')[0]}`);
        results.ceBroker.failed.push({ name: provider.name, error: result.error });
        recordFailure(provider.name, 'CE Broker', result.error);
      }

      await sleep(1000);
    }
    console.log('');
  }

  // ── Test Platform Credentials ───────────────────────────────────────────────
  logger.info('Testing platform credentials...\n');

  for (const provider of providers) {
    if (filterProvider && !provider.name.toLowerCase().includes(filterProvider.toLowerCase())) continue;
    if (!provider.platforms || provider.platforms.length === 0) continue;

    for (const creds of provider.platforms) {
      if (filterPlatform && creds.platform.toLowerCase() !== filterPlatform.toLowerCase()) continue;

      // Skip disabled platforms
      if (!isPlatformEnabled(creds.platform)) {
        logger.info(`  Skipping disabled platform: ${creds.platform}`);
        continue;
      }

      const tester = platformTesters[creds.platform];
      if (!tester) {
        logger.warn(`  Unknown platform: ${creds.platform}`);
        continue;
      }

      process.stdout.write(`  ${provider.name} [${creds.platform}]: `);
      const result = await tester(browser, creds);

      if (result.success) {
        console.log('\x1b[32m✓ OK\x1b[0m');
        results.platforms.success.push({ name: provider.name, platform: creds.platform });
        recordSuccess(provider.name, creds.platform);
      } else {
        console.log(`\x1b[31m✗ FAILED\x1b[0m - ${result.error.split('\n')[0]}`);
        results.platforms.failed.push({ name: provider.name, platform: creds.platform, error: result.error });
        recordFailure(provider.name, creds.platform, result.error);
      }

      await sleep(1000);
    }
  }

  await browser.close();

  // ── Print Summary ───────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  VALIDATION SUMMARY');
  console.log('═'.repeat(60));

  if (!filterPlatform || filterPlatform.toLowerCase() === 'cebroker') {
    console.log('\n\x1b[36mCE Broker:\x1b[0m');
    console.log(`  ✓ ${results.ceBroker.success.length} passed`);
    console.log(`  ✗ ${results.ceBroker.failed.length} failed`);
    if (results.ceBroker.failed.length > 0) {
      console.log('  Failed:');
      results.ceBroker.failed.forEach(f => console.log(`    - ${f.name}`));
    }
  }

  console.log('\n\x1b[36mPlatforms:\x1b[0m');
  console.log(`  ✓ ${results.platforms.success.length} passed`);
  console.log(`  ✗ ${results.platforms.failed.length} failed`);
  if (results.platforms.failed.length > 0) {
    console.log('  Failed:');
    results.platforms.failed.forEach(f => console.log(`    - ${f.name} [${f.platform}]`));
  }

  // ── Health Summary ──────────────────────────────────────────────────────────
  const health = getHealthSummary();
  console.log('\n\x1b[36mCredential Health:\x1b[0m');
  console.log(`  Healthy:  ${health.healthy}`);
  console.log(`  Degraded: ${health.degraded}`);
  console.log(`  Warning:  ${health.warning}`);
  console.log(`  Critical: ${health.critical}`);

  console.log('\n' + '═'.repeat(60) + '\n');

  // Exit with error code if any failures
  const totalFailed = results.ceBroker.failed.length + results.platforms.failed.length;
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
