/**
 * Change Detector - Automatically detects and logs changes to providers
 *
 * Detects:
 * - New providers added
 * - Providers removed
 * - New CE Broker credentials added
 * - New platform credentials added
 * - Credential changes
 */

const path = require('path');
const { loadJson, saveJson } = require('./utils');

const PROVIDERS_FILE = path.join(__dirname, 'providers.json');
const SNAPSHOT_FILE = path.join(__dirname, 'providers-snapshot.json');
const UPDATES_FILE = path.join(__dirname, 'updates.json');
const MANUAL_UPDATES_FILE = path.join(__dirname, 'manual-updates.json');

/**
 * Get current date in readable format
 */
function getDateString() {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Create a comparable fingerprint of a provider's credentials
 */
function getCredentialFingerprint(provider) {
  return {
    hasCEBroker: !!(provider.ceBroker?.username),
    cebrokerUser: provider.ceBroker?.username || null,
    platforms: (provider.platforms || [])
      .filter(p => p && p.name)
      .map(p => ({
        name: p.name,
        hasCredentials: !!(p.username || p.email)
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  };
}

/**
 * Compare two providers and detect credential changes
 */
function detectCredentialChanges(oldProvider, newProvider) {
  const changes = [];
  const oldFp = getCredentialFingerprint(oldProvider);
  const newFp = getCredentialFingerprint(newProvider);

  // CE Broker credential added
  if (!oldFp.hasCEBroker && newFp.hasCEBroker) {
    changes.push({
      type: 'new',
      title: `${newProvider.name} CE Broker credentials added`,
      desc: 'CE Broker login credentials have been configured for compliance tracking.'
    });
  }

  // CE Broker credential changed
  if (oldFp.hasCEBroker && newFp.hasCEBroker && oldFp.cebrokerUser !== newFp.cebrokerUser) {
    changes.push({
      type: 'changed',
      title: `${newProvider.name} CE Broker credentials updated`,
      desc: 'CE Broker login credentials have been updated.'
    });
  }

  // Check platform changes
  const oldPlatforms = new Map(oldFp.platforms.map(p => [p.name, p]));
  const newPlatforms = new Map(newFp.platforms.map(p => [p.name, p]));

  // New platforms added
  for (const [name, platform] of newPlatforms) {
    const oldPlatform = oldPlatforms.get(name);
    if (!oldPlatform && platform.hasCredentials) {
      changes.push({
        type: 'new',
        title: `${newProvider.name} ${name} credentials added`,
        desc: `Added ${name} platform login for ${newProvider.name}.`
      });
    } else if (oldPlatform && !oldPlatform.hasCredentials && platform.hasCredentials) {
      changes.push({
        type: 'new',
        title: `${newProvider.name} ${name} credentials added`,
        desc: `Added ${name} platform login for ${newProvider.name}.`
      });
    }
  }

  return changes;
}

/**
 * Detect all changes between old and new provider lists
 */
function detectChanges(oldProviders, newProviders) {
  const changes = [];
  const dateStr = getDateString();

  // Create maps for easy lookup
  const oldMap = new Map(oldProviders.map(p => [p.name, p]));
  const newMap = new Map(newProviders.map(p => [p.name, p]));

  // Detect new providers
  for (const [name, provider] of newMap) {
    if (!oldMap.has(name)) {
      changes.push({
        date: dateStr,
        type: 'new',
        title: `${name} added to tracking`,
        desc: `New provider added to the compliance dashboard.${provider.ceBroker?.username ? '' : ' Credentials pending setup.'}`
      });
    }
  }

  // Detect removed providers
  for (const [name, provider] of oldMap) {
    if (!newMap.has(name)) {
      changes.push({
        date: dateStr,
        type: 'removed',
        title: `${name} removed from tracking`,
        desc: 'Provider removed from active provider list.'
      });
    }
  }

  // Detect credential changes for existing providers
  for (const [name, newProvider] of newMap) {
    const oldProvider = oldMap.get(name);
    if (oldProvider) {
      const credChanges = detectCredentialChanges(oldProvider, newProvider);
      for (const change of credChanges) {
        changes.push({
          date: dateStr,
          ...change
        });
      }
    }
  }

  return changes;
}

/**
 * Run change detection and update the updates.json file
 */
function runChangeDetection() {
  console.log('Running change detection...');

  // Load current providers
  const currentProviders = loadJson(PROVIDERS_FILE, []);
  if (currentProviders.length === 0) {
    console.log('No providers found in providers.json');
    return { detected: 0, updates: [] };
  }

  // Load previous snapshot
  const previousProviders = loadJson(SNAPSHOT_FILE, []);

  // If no previous snapshot, this is the first run - just save snapshot
  if (previousProviders.length === 0) {
    console.log('No previous snapshot found. Creating initial snapshot...');
    saveJson(SNAPSHOT_FILE, currentProviders);
    return { detected: 0, updates: [], firstRun: true };
  }

  // Detect changes
  const newChanges = detectChanges(previousProviders, currentProviders);

  if (newChanges.length > 0) {
    console.log(`Detected ${newChanges.length} change(s)`);

    // Load existing updates
    const existingUpdates = loadJson(UPDATES_FILE, []);

    // Add new changes at the beginning (most recent first)
    const allUpdates = [...newChanges, ...existingUpdates];

    // Keep only last 50 updates to prevent file from growing too large
    const trimmedUpdates = allUpdates.slice(0, 50);

    // Save updates
    saveJson(UPDATES_FILE, trimmedUpdates);
    console.log('Updates saved to updates.json');
  } else {
    console.log('No changes detected');
  }

  // Save current state as new snapshot
  saveJson(SNAPSHOT_FILE, currentProviders);
  console.log('Snapshot updated');

  return { detected: newChanges.length, updates: newChanges };
}

/**
 * Get all updates (auto-detected + manual)
 */
function getAllUpdates(limit = 20) {
  const autoUpdates = loadJson(UPDATES_FILE, []);
  const manualUpdates = loadJson(MANUAL_UPDATES_FILE, []);

  // Combine and sort by date (most recent first)
  const allUpdates = [...autoUpdates, ...manualUpdates];

  // Sort by date descending
  allUpdates.sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);
    return dateB - dateA;
  });

  return allUpdates.slice(0, limit);
}

/**
 * Add a manual update entry
 */
function addManualUpdate(type, title, desc) {
  const manualUpdates = loadJson(MANUAL_UPDATES_FILE, []);

  manualUpdates.unshift({
    date: getDateString(),
    type: type, // 'new', 'changed', 'removed', 'info'
    title: title,
    desc: desc
  });

  // Keep only last 30 manual updates
  const trimmed = manualUpdates.slice(0, 30);
  saveJson(MANUAL_UPDATES_FILE, trimmed);

  console.log('Manual update added');
  return trimmed[0];
}

// Run if executed directly
if (require.main === module) {
  const result = runChangeDetection();
  console.log('\nChange detection complete:');
  console.log(`- Changes detected: ${result.detected}`);
  if (result.firstRun) {
    console.log('- First run: snapshot created');
  }
  if (result.updates.length > 0) {
    console.log('\nNew updates:');
    result.updates.forEach(u => console.log(`  [${u.type}] ${u.title}`));
  }
}

module.exports = {
  runChangeDetection,
  getAllUpdates,
  addManualUpdate,
  detectChanges,
};
