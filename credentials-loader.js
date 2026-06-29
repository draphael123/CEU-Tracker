// credentials-loader.js — Secure credential management
// Loads provider credentials from environment variables or secure credentials file
// Never commit actual credentials to git!

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');
const ENCRYPTED_FILE = path.join(__dirname, 'credentials.enc');
const PROVIDERS_FILE = path.join(__dirname, 'providers.json');
const EXCLUDED_FILE = path.join(__dirname, 'excluded-providers.json');

// ─── De-tracked providers ────────────────────────────────────────────────────
// Names listed in excluded-providers.json are skipped everywhere (scraper and
// dashboard) regardless of whether they still exist in the credentials source.
// Matching is case-insensitive and treats spaces/hyphens as equivalent, so a
// listed "Megan Ryan-Riffle" also matches "Megan Ryan Riffle, NP".

function normalizeName(s) {
  return String(s).toLowerCase().replace(/[\s\-]+/g, ' ').trim();
}

function loadExcludedNames() {
  try {
    if (!fs.existsSync(EXCLUDED_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(e => typeof e === 'string').map(normalizeName).filter(Boolean);
  } catch {
    return [];
  }
}

function nameMatches(name, excludedNorm) {
  if (!name) return false;
  const n = normalizeName(name);
  return excludedNorm.some(ex => n.includes(ex));
}

function isExcluded(name) {
  return nameMatches(name, loadExcludedNames());
}

// ─── Encryption at rest (AES-256-GCM) ────────────────────────────────────────
// Optional: encrypt credentials.json into credentials.enc with a passphrase held
// only in the CREDENTIALS_KEY env var, so no plaintext secret sits on disk. The
// blob layout is base64( salt[16] | iv[12] | authTag[16] | ciphertext ).

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32);
}

function encryptString(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

function decryptString(blobB64, passphrase) {
  const blob = Buffer.from(String(blobB64).trim(), 'base64');
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 28);
  const tag = blob.subarray(28, 44);
  const enc = blob.subarray(44);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

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

  // Option 2: Load from the encrypted credentials.enc file (needs CREDENTIALS_KEY)
  if (fs.existsSync(ENCRYPTED_FILE)) {
    if (!process.env.CREDENTIALS_KEY) {
      throw new Error('credentials.enc found but CREDENTIALS_KEY env var is not set — cannot decrypt.');
    }
    try {
      const blob = fs.readFileSync(ENCRYPTED_FILE, 'utf-8');
      return JSON.parse(decryptString(blob, process.env.CREDENTIALS_KEY));
    } catch (err) {
      throw new Error('Failed to decrypt credentials.enc (wrong CREDENTIALS_KEY or corrupt file): ' + err.message);
    }
  }

  // Option 3: Load from credentials.json file (gitignored)
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
  if (isExcluded(name)) return undefined;
  const credentials = loadCredentials();
  const excluded = loadExcludedNames();
  return credentials.find(p => p.name === name && !nameMatches(p.name, excluded));
}

/**
 * Get all providers with credentials (excluding de-tracked providers)
 */
function getAllProviders() {
  const excluded = loadExcludedNames();
  return loadCredentials().filter(p => !nameMatches(p.name, excluded));
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

/**
 * Encrypt credentials.json into credentials.enc using CREDENTIALS_KEY.
 * After verifying it loads, you can safely delete the plaintext credentials.json.
 */
function encryptCredentialsFile() {
  if (!process.env.CREDENTIALS_KEY) {
    console.error('Set the CREDENTIALS_KEY env var first (the passphrase to encrypt with).');
    return false;
  }
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error('credentials.json not found — nothing to encrypt.');
    return false;
  }
  const plaintext = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
  JSON.parse(plaintext); // validate it is JSON before encrypting
  fs.writeFileSync(ENCRYPTED_FILE, encryptString(plaintext, process.env.CREDENTIALS_KEY));
  console.log(`Encrypted → ${ENCRYPTED_FILE}`);
  console.log('Verify it loads (CREDENTIALS_KEY=... node -e "require(\'./credentials-loader\').loadCredentials()"),');
  console.log('then delete credentials.json so no plaintext secret remains on disk.');
  return true;
}

// CLI support
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'migrate') {
    migrateCredentials();
  } else if (cmd === 'template') {
    createCredentialsTemplate();
  } else if (cmd === 'encrypt') {
    encryptCredentialsFile();
  } else {
    console.log('Usage:');
    console.log('  node credentials-loader.js migrate  - Migrate providers.json to credentials.json');
    console.log('  node credentials-loader.js template - Create credentials template');
    console.log('  node credentials-loader.js encrypt  - Encrypt credentials.json -> credentials.enc (needs CREDENTIALS_KEY)');
  }
}

module.exports = {
  loadCredentials,
  getProvider,
  getAllProviders,
  getPlatformCredential,
  isExcluded,
  loadExcludedNames,
  migrateCredentials,
  createCredentialsTemplate,
  encryptCredentialsFile,
  encryptString,
  decryptString
};
