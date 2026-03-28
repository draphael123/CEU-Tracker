// database.js — SQLite database for CEU Tracker
// Provides persistent storage for providers, compliance records, and course history

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'ceu_tracker.db');

let db = null;

/**
 * Initialize the database connection and create tables
 */
function initDatabase() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL'); // Better concurrent read performance

  // Create tables
  db.exec(`
    -- Providers table
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      email TEXT,
      has_ce_broker_creds INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Compliance records (snapshots from CE Broker)
    CREATE TABLE IF NOT EXISTS compliance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      state TEXT,
      license_type TEXT,
      renewal_deadline TEXT,
      hours_required REAL,
      hours_completed REAL,
      hours_remaining REAL,
      scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    -- Subject area requirements
    CREATE TABLE IF NOT EXISTS subject_areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compliance_record_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      hours_required REAL,
      hours_completed REAL,
      FOREIGN KEY (compliance_record_id) REFERENCES compliance_records(id)
    );

    -- Course history
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      platform TEXT,
      course_name TEXT NOT NULL,
      hours REAL,
      completion_date TEXT,
      category TEXT,
      certificate_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_id, course_name, completion_date),
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    -- Platform scrape results
    CREATE TABLE IF NOT EXISTS platform_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      status TEXT,
      hours_earned REAL,
      total_spent REAL,
      course_count INTEGER,
      scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    -- Credential health tracking
    CREATE TABLE IF NOT EXISTS credential_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      status TEXT DEFAULT 'healthy',
      consecutive_failures INTEGER DEFAULT 0,
      last_success TEXT,
      last_failure TEXT,
      last_error TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_id, platform),
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    -- Run history (audit log)
    CREATE TABLE IF NOT EXISTS run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      providers_processed INTEGER,
      providers_succeeded INTEGER,
      providers_failed INTEGER,
      duration_seconds REAL,
      status TEXT
    );

    -- Create indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_compliance_provider ON compliance_records(provider_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_scraped ON compliance_records(scraped_at);
    CREATE INDEX IF NOT EXISTS idx_courses_provider ON courses(provider_id);
    CREATE INDEX IF NOT EXISTS idx_courses_date ON courses(completion_date);
    CREATE INDEX IF NOT EXISTS idx_platform_results_provider ON platform_results(provider_id);
  `);

  console.log('[Database] Initialized:', DB_PATH);
  return db;
}

/**
 * Get or create a provider by name
 */
function getOrCreateProvider(name, type, email = null, hasCEBrokerCreds = false) {
  const db = initDatabase();

  let provider = db.prepare('SELECT * FROM providers WHERE name = ?').get(name);

  if (!provider) {
    const result = db.prepare(`
      INSERT INTO providers (name, type, email, has_ce_broker_creds)
      VALUES (?, ?, ?, ?)
    `).run(name, type, email, hasCEBrokerCreds ? 1 : 0);

    provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(result.lastInsertRowid);
  }

  return provider;
}

/**
 * Save compliance record for a provider
 */
function saveComplianceRecord(providerId, record) {
  const db = initDatabase();

  const result = db.prepare(`
    INSERT INTO compliance_records (
      provider_id, state, license_type, renewal_deadline,
      hours_required, hours_completed, hours_remaining
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    providerId,
    record.state,
    record.licenseType,
    record.renewalDeadline,
    record.hoursRequired,
    record.hoursCompleted,
    record.hoursRemaining
  );

  // Save subject areas
  if (record.subjectAreas && record.subjectAreas.length > 0) {
    const insertSubject = db.prepare(`
      INSERT INTO subject_areas (compliance_record_id, subject, hours_required, hours_completed)
      VALUES (?, ?, ?, ?)
    `);

    for (const subject of record.subjectAreas) {
      insertSubject.run(
        result.lastInsertRowid,
        subject.subject || subject.name,
        subject.hoursRequired || subject.required,
        subject.hoursCompleted || subject.completed
      );
    }
  }

  return result.lastInsertRowid;
}

/**
 * Save course to history (with deduplication)
 */
function saveCourse(providerId, course) {
  const db = initDatabase();

  try {
    db.prepare(`
      INSERT OR IGNORE INTO courses (
        provider_id, platform, course_name, hours, completion_date, category, certificate_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      providerId,
      course.platform,
      course.name || course.courseName,
      course.hours,
      course.date || course.completionDate,
      course.category,
      course.certificateUrl
    );
    return true;
  } catch (err) {
    // Duplicate entry - ignore
    return false;
  }
}

/**
 * Save platform scrape result
 */
function savePlatformResult(providerId, platform, result) {
  const db = initDatabase();

  db.prepare(`
    INSERT INTO platform_results (
      provider_id, platform, status, hours_earned, total_spent, course_count
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    providerId,
    platform,
    result.status,
    result.hoursEarned,
    result.totalSpent,
    result.courses?.length || 0
  );
}

/**
 * Update credential health for a provider/platform
 */
function updateCredentialHealth(providerId, platform, success, error = null) {
  const db = initDatabase();

  const existing = db.prepare(`
    SELECT * FROM credential_health WHERE provider_id = ? AND platform = ?
  `).get(providerId, platform);

  if (existing) {
    if (success) {
      db.prepare(`
        UPDATE credential_health SET
          status = 'healthy',
          consecutive_failures = 0,
          last_success = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE provider_id = ? AND platform = ?
      `).run(providerId, platform);
    } else {
      const newFailures = existing.consecutive_failures + 1;
      let status = 'healthy';
      if (newFailures >= 3) status = 'critical';
      else if (newFailures >= 2) status = 'degraded';

      db.prepare(`
        UPDATE credential_health SET
          status = ?,
          consecutive_failures = ?,
          last_failure = CURRENT_TIMESTAMP,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE provider_id = ? AND platform = ?
      `).run(status, newFailures, error, providerId, platform);
    }
  } else {
    db.prepare(`
      INSERT INTO credential_health (provider_id, platform, status, consecutive_failures, last_success, last_failure, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      providerId,
      platform,
      success ? 'healthy' : 'degraded',
      success ? 0 : 1,
      success ? new Date().toISOString() : null,
      success ? null : new Date().toISOString(),
      error
    );
  }
}

/**
 * Get latest compliance status for all providers
 */
function getLatestComplianceStatus() {
  const db = initDatabase();

  return db.prepare(`
    SELECT
      p.id, p.name, p.type,
      cr.state, cr.license_type, cr.renewal_deadline,
      cr.hours_required, cr.hours_completed, cr.hours_remaining,
      cr.scraped_at
    FROM providers p
    LEFT JOIN compliance_records cr ON cr.id = (
      SELECT id FROM compliance_records
      WHERE provider_id = p.id
      ORDER BY scraped_at DESC
      LIMIT 1
    )
    ORDER BY p.name
  `).all();
}

/**
 * Get course history for a provider
 */
function getCourseHistory(providerId, limit = 100) {
  const db = initDatabase();

  return db.prepare(`
    SELECT * FROM courses
    WHERE provider_id = ?
    ORDER BY completion_date DESC
    LIMIT ?
  `).all(providerId, limit);
}

/**
 * Get credential health summary
 */
function getCredentialHealthSummary() {
  const db = initDatabase();

  const summary = db.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM credential_health
    GROUP BY status
  `).all();

  const details = db.prepare(`
    SELECT
      p.name as provider_name,
      ch.platform,
      ch.status,
      ch.consecutive_failures,
      ch.last_success,
      ch.last_failure,
      ch.last_error
    FROM credential_health ch
    JOIN providers p ON p.id = ch.provider_id
    WHERE ch.status != 'healthy'
    ORDER BY ch.consecutive_failures DESC
  `).all();

  return { summary, unhealthyCredentials: details };
}

/**
 * Start a new run and return run ID
 */
function startRun() {
  const db = initDatabase();

  const result = db.prepare(`
    INSERT INTO run_history (started_at, status)
    VALUES (CURRENT_TIMESTAMP, 'running')
  `).run();

  return result.lastInsertRowid;
}

/**
 * Complete a run with results
 */
function completeRun(runId, results) {
  const db = initDatabase();

  const succeeded = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status !== 'success').length;

  db.prepare(`
    UPDATE run_history SET
      completed_at = CURRENT_TIMESTAMP,
      providers_processed = ?,
      providers_succeeded = ?,
      providers_failed = ?,
      status = ?
    WHERE id = ?
  `).run(
    results.length,
    succeeded,
    failed,
    failed > 0 ? 'completed_with_errors' : 'completed',
    runId
  );
}

/**
 * Close database connection
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Migrate data from JSON files to SQLite
 */
function migrateFromJson() {
  const db = initDatabase();

  // Migrate providers
  const providersPath = path.join(__dirname, 'providers-public.json');
  if (fs.existsSync(providersPath)) {
    const providers = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));

    const insertProvider = db.prepare(`
      INSERT OR IGNORE INTO providers (name, type, email, has_ce_broker_creds)
      VALUES (?, ?, ?, ?)
    `);

    for (const p of providers) {
      insertProvider.run(p.name, p.type, p.email, p.hasCEBrokerCreds ? 1 : 0);
    }
    console.log(`[Database] Migrated ${providers.length} providers`);
  }

  // Migrate course history
  const courseHistoryPath = path.join(__dirname, 'course-history.json');
  if (fs.existsSync(courseHistoryPath)) {
    const courseHistory = JSON.parse(fs.readFileSync(courseHistoryPath, 'utf-8'));

    let courseCount = 0;
    for (const [providerName, courses] of Object.entries(courseHistory)) {
      const provider = db.prepare('SELECT id FROM providers WHERE name = ?').get(providerName);
      if (provider && Array.isArray(courses)) {
        for (const course of courses) {
          if (saveCourse(provider.id, course)) {
            courseCount++;
          }
        }
      }
    }
    console.log(`[Database] Migrated ${courseCount} courses`);
  }

  console.log('[Database] Migration complete');
}

// CLI support
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'init') {
    initDatabase();
    console.log('Database initialized');
  } else if (cmd === 'migrate') {
    migrateFromJson();
  } else {
    console.log('Usage:');
    console.log('  node database.js init    - Initialize database');
    console.log('  node database.js migrate - Migrate from JSON files');
  }
}

module.exports = {
  initDatabase,
  getOrCreateProvider,
  saveComplianceRecord,
  saveCourse,
  savePlatformResult,
  updateCredentialHealth,
  getLatestComplianceStatus,
  getCourseHistory,
  getCredentialHealthSummary,
  startRun,
  completeRun,
  closeDatabase,
  migrateFromJson,
};
