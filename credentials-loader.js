// credentials-loader.js — Secure credential management
// Loads provider credentials from environment variables or secure credentials file
// Never commit actual credentials to git!

'use strict';

const fs = require('fs');
const path = require('path');

const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');
const PROVIDERS_FILE = path.join(__dirname, 'providers.json');

/**
 * Load credentials from environment variable or credentials file
 * Priority: ENV var > credentials.json > providers.json (legacy fallback)
 */
function loadCredentials() {
  // Option 1: Load from CREDENTIALS_JSON environment variable (base64 encoded)
  if (process.env.CREDENTIALS_JSON) {
    try {
      const decoded = Buffer.from(process.env.CREDENTIALS_JSON, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch (err) {
      console.error('Failed to parse CREDENTIALS_JSON env var:', err.message);
    }
  }

  // Option 2: Load from credentials.json file (gitignored)
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const data = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Failed to load credentials.json:', err.message);
    }
  }

  // Option 3: Legacy fallback - load from providers.json (not recommended)
  console.warn('WARNING: Loading credentials from providers.json - migrate to credentials.json!');
  if (fs.existsSync(PROVIDERS_FILE)) {
    return JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf-8'));
  }

  throw new Error('No credentials source found. Create credentials.json or set CREDENTIALS_JSON env var.');
}

/**
 * Get provider by name with credentials
 */
function getProvider(name) {
  const credentials = loadCredentials();
  return credentials.find(p => p.name === name);
}

/**
 * Get all providers with credentials
 */
function getAllProviders() {
  return loadCredentials();
}

/**
 * Get provider credential for a specific platform
 */
function getPlatformCredential(providerName, platform) {
  const provider = getProvider(providerName);
  if (!provider || !provider.platforms) return null;
  return provider.platforms.find(p => p.platform === platform);
}

/**
 * Create a credentials.json template from providers.json (strips passwords)
 */
function createCredentialsTemplate() {
  if (!fs.existsSync(PROVIDERS_FILE)) {
    console.error('providers.json not found');
    return;
  }

  const providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf-8'));
  const template = providers.map(p => ({
    name: p.name,
    type: p.type,
    email: p.email || null,
    username: p.username ? '<<CE_BROKER_USERNAME>>' : undefined,
    password: p.password ? '<<CE_BROKER_PASSWORD>>' : undefined,
    noCredentials: p.noCredentials || undefined,
    platforms: p.platforms?.map(plat => ({
      platform: plat.platform,
      username: '<<PLATFORM_USERNAME>>',
      password: '<<PLATFORM_PASSWORD>>'
    }))
  }));

  const templatePath = path.join(__dirname, 'credentials.template.json');
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
  console.log(`Template created: ${templatePath}`);
  console.log('Copy to credentials.json and fill in actual credentials.');
}

/**
 * Migrate from providers.json to credentials.json (one-time operation)
 */
function migrateCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    console.log('credentials.json already exists. Aborting migration.');
    return false;
  }

  if (!fs.existsSync(PROVIDERS_FILE)) {
    console.error('providers.json not found');
    return false;
  }

  // Copy providers.json to credentials.json
  const providers = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf-8'));
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(providers, null, 2));
  console.log('Created credentials.json from providers.json');

  // Create sanitized providers.json (no passwords)
  const sanitized = providers.map(p => ({
    name: p.name,
    type: p.type,
    email: p.email || null,
    hasCEBrokerCreds: !!(p.username && p.password),
    noCredentials: p.noCredentials || false,
    platforms: p.platforms?.map(plat => plat.platform) || []
  }));

  const sanitizedPath = path.join(__dirname, 'providers-public.json');
  fs.writeFileSync(sanitizedPath, JSON.stringify(sanitized, null, 2));
  console.log(`Created sanitized ${sanitizedPath} (safe to commit)`);

  return true;
}

// CLI support
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'migrate') {
    migrateCredentials();
  } else if (cmd === 'template') {
    createCredentialsTemplate();
  } else {
    console.log('Usage:');
    console.log('  node credentials-loader.js migrate  - Migrate providers.json to credentials.json');
    console.log('  node credentials-loader.js template - Create credentials template');
  }
}

module.exports = {
  loadCredentials,
  getProvider,
  getAllProviders,
  getPlatformCredential,
  migrateCredentials,
  createCredentialsTemplate
};
