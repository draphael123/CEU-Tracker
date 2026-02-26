// index.js — Main entry point for CE Broker CEU automation
// Run with: node index.js

'use strict';

const path      = require('path');
const { execSync } = require('child_process');
const { launchBrowser, loginProvider, scrapeLicenseData, closePage } = require('./scraper');
const { runPlatformScrapers } = require('./platform-scrapers');
const { buildReport } = require('./exporter');
const { buildDashboard } = require('./dashboard-builder');
const { parseLicenseData } = require('./license-parser');
const { runStateBoardScrapers } = require('./state-board-scrapers');
const { logger, randomDelay, printSummary, ensureScreenshotsDir } = require('./utils');

// ─── Load Providers ──────────────────────────────────────────────────────────
const providers = require('./providers.json');

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  CE Broker CEU Tracker — Starting Run');
  console.log(`  Providers to process: ${providers.length}`);
  console.log('═'.repeat(60) + '\n');

  ensureScreenshotsDir();

  const browser = await launchBrowser();
  const allResults = [];     // { name, status, error? }
  const allRecords = [];     // LicenseRecord[][] per provider

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    logger.info(`\n[${i + 1}/${providers.length}] Processing: ${provider.name}`);

    // ── Check if CE Broker credentials are configured ───────────────────────
    const hasCEBrokerCreds = provider.username && provider.password;

    if (!hasCEBrokerCreds) {
      logger.info(`${provider.name}: No CE Broker credentials configured (platform-only)`);
      allResults.push({ name: provider.name, status: 'not_configured' });
      allRecords.push([{
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
      }]);
      continue;
    }

    let page = null;
    try {
      // ── Login ──────────────────────────────────────────────────────────────
      page = await loginProvider(browser, provider);

      // ── Scrape ────────────────────────────────────────────────────────────
      const records = await scrapeLicenseData(page, provider);
      allRecords.push(records);

      const licSummary = records.map((r) =>
        `${r.state || '??'} — ${r.hoursCompleted ?? '?'}/${r.hoursRequired ?? '?'} hrs`
      ).join(', ');
      logger.success(`${provider.name}: ${licSummary}`);

      allResults.push({ name: provider.name, status: 'success' });

    } catch (err) {
      logger.error(`Login error for ${provider.name}: ${err.message}`);
      allResults.push({ name: provider.name, status: 'login_error', error: err.message });

      // Push an empty placeholder so the export still shows the provider
      allRecords.push([{
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
      }]);

    } finally {
      // Always close the page/context to free memory
      if (page) await closePage(page);
    }

    // ── Delay between logins (skip after the last provider) ───────────────
    if (i < providers.length - 1) {
      await randomDelay(3000, 7000);
    }
  }

  // ── Platform scrapers (CEUfast, AANP Cert, NetCE) ─────────────────────────
  let platformData = [];
  try {
    logger.info('\n── Running platform CEU scrapers ────────────────────────────');
    platformData = await runPlatformScrapers(browser, providers);
    const pOk   = platformData.filter(r => r.status === 'success').length;
    const pFail = platformData.filter(r => r.status === 'failed').length;
    logger.success(`Platform scrapers done: ${pOk} succeeded, ${pFail} failed`);
  } catch (platformErr) {
    logger.error(`Platform scraper error: ${platformErr.message}`);
  }

  // ── State board scrapers (WA, OH, WI, NJ, IN, MI) ───────────────────────────
  let stateBoardData = [];
  try {
    logger.info('\n── Running state board license scrapers ─────────────────────');
    stateBoardData = await runStateBoardScrapers(browser);
    const sbOk   = stateBoardData.filter(r => r.status === 'success').length;
    const sbFail = stateBoardData.filter(r => r.status === 'failed').length;
    logger.success(`State board scrapers done: ${sbOk} succeeded, ${sbFail} failed`);
  } catch (stateBoardErr) {
    logger.error(`State board scraper error: ${stateBoardErr.message}`);
  }

  // ── Close browser ──────────────────────────────────────────────────────────
  await browser.close();
  logger.info('Browser closed');

  // ── Parse license data from spreadsheet ───────────────────────────────────
  let licenseData = { licenses: [], applications: [], renewals: [], stats: {} };
  try {
    logger.info('\n── Parsing license data from spreadsheet ───────────────────');
    licenseData = await parseLicenseData();
  } catch (licenseErr) {
    logger.error(`License data parse error: ${licenseErr.message}`);
  }

  // ── Export to Excel ────────────────────────────────────────────────────────
  try {
    const outputPath = await buildReport(allRecords);
    logger.success(`Excel report saved: ${outputPath}`);
  } catch (exportErr) {
    logger.error(`Excel export failed: ${exportErr.message}`);
  }

  // ── Build HTML dashboard ───────────────────────────────────────────────────
  try {
    const dashPath = buildDashboard(allRecords, allResults, platformData, licenseData, stateBoardData);
    logger.success(`Dashboard saved: ${dashPath}`);
  } catch (dashErr) {
    logger.error(`Dashboard build failed: ${dashErr.message}`);
  }

  // ── Print run summary ──────────────────────────────────────────────────────
  printSummary(allResults);

  // ── Auto-publish to Vercel via GitHub push ─────────────────────────────────
  try {
    execSync('git add public/index.html public/history.json', { cwd: __dirname, stdio: 'pipe' });
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

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
