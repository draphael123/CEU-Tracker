// Quick rebuild script - regenerates dashboard from existing cached data
// Usage: node rebuild-dashboard.js
const fs = require('fs');
const path = require('path');
const { buildDashboard } = require('./dashboard-builder');

// Load cached data
const providers = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8'));
const history = JSON.parse(fs.readFileSync(path.join(__dirname, 'history.json'), 'utf8'));

// Get the latest snapshot
const lastSnapshot = history[history.length - 1] || {};
const providerData = lastSnapshot.providers || [];

// Group provider data by name to handle multiple licenses per provider
const providerRecordMap = {};
for (const p of providerData) {
  if (!providerRecordMap[p.name]) providerRecordMap[p.name] = [];
  const providerInfo = providers.find(pr => pr.name === p.name) || {};
  providerRecordMap[p.name].push({
    providerName: p.name,
    providerType: providerInfo.type,
    state: p.state,
    licenseType: providerInfo.type,
    hoursRequired: p.hoursRequired,
    hoursCompleted: p.hoursCompleted,
    hoursRemaining: p.hoursRemaining,
    renewalDeadline: p.renewalDeadline,
    lastUpdated: lastSnapshot.timestamp,
    subjectAreas: [],
  });
}

// Build allProviderRecords as array of arrays (one per provider)
const allRecords = Object.values(providerRecordMap);

// Build runResults
const runResults = providers.map(p => ({
  name: p.name,
  status: p.username && p.password ? 'success' : 'not_configured',
}));

// Platform data (empty for rebuild)
const platformData = [];

console.log('Rebuilding dashboard from cached data...');
console.log(`  Providers: ${allRecords.length}`);
console.log(`  Total licenses: ${providerData.length}`);
console.log(`  Last run: ${lastSnapshot.timestamp || 'unknown'}`);

const dashPath = buildDashboard(allRecords, runResults, platformData, null);
console.log(`Dashboard rebuilt: ${dashPath}`);
