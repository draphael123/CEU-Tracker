// index.js — Main entry point for CE Broker CEU automation
// Run with: node index.js

'use strict';

// Initialize Sentry first (before other imports)
const { initSentry, captureError, addBreadcrumb, flush } = require('./sentry');
initSentry();

const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');
const { launchBrowser, loginProvider, scrapeLicenseData, closePage } = require('./scraper');
const { runPlatformScrapers } = require('./platform-scrapers');
const { runLicenseVerification } = require('./license-scraper');
const { buildReport } = require('./exporter');
const { buildDashboard } = require('./dashboard-builder');
const { logger, randomDelay, printSummary, ensureScreenshotsDir, cleanupOldScreenshots } = require('./utils');
const { runChangeDetection } = require('./change-detector');
const { getAllProviders } = require('./credentials-loader');

// ─── Load Providers (from secure credentials source) ─────────────────────────
const providers = getAllProviders();

// ─── Parallel Processing Configuration ────────────────────────────────────────
const CONCURRENCY = parseInt(process.env.SCRAPER_CONCURRENCY, 10) || 5;

/**
 * Process a single provider (login + scrape)
 * Returns { result, records } for aggregation
 */
async function processProvider(browser, provider, index, total) {
  logger.info(`[${index + 1}/${total}] Processing: ${provider.name}`);

  // Check if CE Broker credentials are configured
  const hasCEBrokerCreds = provider.username && provider.password;

  if (!hasCEBrokerCreds) {
    logger.info(`${provider.name}: No CE Broker credentials configured (platform-only)`);
    return {
      result: { name: provider.name, status: 'not_configured' },
      records: [{
        providerName:    provider.name,
        providerType:    provider.type,
        state:           null,
        licenseType:     provider.type,
        renewalDeadline: null,
        hoursRequired:   null,
        hoursCompleted:  null,
        hoursRemaining:  null,
        lastUpdated:     null,
        subjectAreas:    [],
      }]
    };
  }

  let page = null;
  try {
    // Login
    page = await loginProvider(browser, provider);

    // Scrape
    const records = await scrapeLicenseData(page, provider);

    const licSummary = records.map((r) =>
      `${r.state || '??'} — ${r.hoursCompleted ?? '?'}/${r.hoursRequired ?? '?'} hrs`
    ).join(', ');
    logger.success(`${provider.name}: ${licSummary}`);

    return {
      result: { name: provider.name, status: 'success' },
      records
    };

  } catch (err) {
    logger.error(`Login error for ${provider.name}: ${err.message}`);

    // Send to Sentry with context
    captureError(err, {
      provider: provider.name,
      operation: 'ce_broker_scrape',
      providerType: provider.type,
    });

    return {
      result: { name: provider.name, status: 'login_error', error: err.message },
      records: [{
        providerName:    provider.name,
        providerType:    provider.type,
        state:           null,
        licenseType:     provider.type,
        renewalDeadline: null,
        hoursRequired:   null,
        hoursCompleted:  null,
        hoursRemaining:  null,
        lastUpdated:     null,
        subjectAreas:    [],
      }]
    };

  } finally {
    if (page) await closePage(page);
  }
}

/**
 * Process providers in parallel batches
 */
async function processProvidersInParallel(browser, providers, concurrency) {
  const allResults = [];
  const allRecords = [];
  const total = providers.length;

  // Process in batches
  for (let i = 0; i < providers.length; i += concurrency) {
    const batch = providers.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(providers.length / concurrency);

    logger.info(`\n── Batch ${batchNum}/${totalBatches} (${batch.length} providers) ──────────────────`);

    // Process batch in parallel
    const batchPromises = batch.map((provider, batchIndex) =>
      processProvider(browser, provider, i + batchIndex, total)
    );

    const batchResults = await Promise.all(batchPromises);

    // Aggregate results
    for (const { result, records } of batchResults) {
      allResults.push(result);
      allRecords.push(records);
    }

    // Delay between batches (skip after the last batch)
    if (i + concurrency < providers.length) {
      logger.info('Waiting between batches...');
      await randomDelay(2000, 4000);
    }
  }

  return { allResults, allRecords };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  CE Broker CEU Tracker — Starting Run');
  console.log(`  Providers to process: ${providers.length}`);
  console.log(`  Parallel concurrency: ${CONCURRENCY}`);
  console.log('═'.repeat(60) + '\n');

  ensureScreenshotsDir();
  cleanupOldScreenshots(7); // Clean up screenshots older than 7 days

  const browser = await launchBrowser();

  // Process all providers in parallel batches
  const { allResults, allRecords } = await processProvidersInParallel(browser, providers, CONCURRENCY);

  // ── Platform scrapers (CEUfast, AANP Cert, NetCE) ─────────────────────────
  let platformData = [];
  try {
    logger.info('\n── Running platform CEU scrapers ────────────────────────────');
    platformData = await runPlatformScrapers(browser, providers);
    const pOk   = platformData.filter(r => r.status === 'success').length;
    const pFail = platformData.filter(r => r.status === 'failed').length;
    logger.success(`Platform scrapers done: ${pOk} succeeded, ${pFail} failed`);

    // Save platform data with costs
    const platformDataFile = path.join(__dirname, 'platform-data.json');
    const costSummary = platformData
      .filter(r => r.status === 'success' && r.totalSpent)
      .map(r => ({ provider: r.providerName, platform: r.platform, spent: r.totalSpent }));

    if (costSummary.length > 0) {
      logger.info(`Cost data found: ${costSummary.length} platform(s) with spending`);
      costSummary.forEach(c => logger.info(`  ${c.provider} - ${c.platform}: $${c.spent.toFixed(2)}`));
    }

    fs.writeFileSync(platformDataFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      results: platformData.map(r => ({
        providerName: r.providerName,
        platform: r.platform,
        status: r.status,
        hoursEarned: r.hoursEarned,
        totalSpent: r.totalSpent,
        courseCount: r.courses?.length || 0,
        orderCount: r.orders?.length || 0,
      }))
    }, null, 2));
  } catch (platformErr) {
    logger.error(`Platform scraper error: ${platformErr.message}`);
  }

  // ── License verification (DISABLED - CEU scraping only) ─────────────────
  let licenseData = null;
  // License verification skipped - only scraping for CEUs
  // To re-enable, uncomment the following:
  // try {
  //   const { licenseData: verifiedLicenses } = await runLicenseVerification(browser, providers);
  //   licenseData = verifiedLicenses;
  // } catch (licenseErr) {
  //   logger.error(`License verification error: ${licenseErr.message}`);
  // }

  // ── Close browser ──────────────────────────────────────────────────────────
  await browser.close();
  logger.info('Browser closed');

  // ── Export to Excel ────────────────────────────────────────────────────────
  try {
    const outputPath = await buildReport(allRecords, platformData);
    logger.success(`Excel report saved: ${outputPath}`);
  } catch (exportErr) {
    logger.error(`Excel export failed: ${exportErr.message}`);
  }

  // ── Run change detection ────────────────────────────────────────────────────
  try {
    const changeResult = runChangeDetection();
    if (changeResult.detected > 0) {
      logger.success(`Change detection: ${changeResult.detected} change(s) logged`);
    } else if (changeResult.firstRun) {
      logger.info('Change detection: Initial snapshot created');
    } else {
      logger.info('Change detection: No changes detected');
    }
  } catch (changeErr) {
    logger.error(`Change detection failed: ${changeErr.message}`);
  }

  // ── Build HTML dashboard ───────────────────────────────────────────────────
  try {
    const dashPath = buildDashboard(allRecords, allResults, platformData, licenseData);
    logger.success(`Dashboard saved: ${dashPath}`);
  } catch (dashErr) {
    logger.error(`Dashboard build failed: ${dashErr.message}`);
  }

  // ── Print run summary ──────────────────────────────────────────────────────
  printSummary(allResults);

  // ── Auto-publish to Vercel via GitHub push ─────────────────────────────────
  try {
    execSync('git add public/index.html public/history.json public/licenses.json', { cwd: __dirname, stdio: 'pipe' });
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    execSync(`git commit -m "chore: dashboard update ${ts}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push', { cwd: __dirname, stdio: 'pipe' });
    logger.success('Dashboard published → Vercel will redeploy automatically');
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.message;
    // "nothing to commit" is not an error
    if (msg.includes('nothing to commit')) {
      logger.info('No dashboard changes to publish');
    } else {
      logger.warn(`Auto-publish skipped: ${msg.split('\n')[0]}`);
      logger.warn('Run "git push" manually to publish.');
    }
  }
}

main()
  .then(async () => {
    // Flush Sentry events before exit
    await flush();
  })
  .catch(async (err) => {
    logger.error(`Fatal error: ${err.message}`);
    console.error(err);

    // Capture and flush before exit
    captureError(err, { operation: 'main', fatal: true });
    await flush();

    process.exit(1);
  });
