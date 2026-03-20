// dashboard-builder.js — Generates dashboard.html from scraped records

const fs   = require('fs');
const path = require('path');
const { daysUntil, parseDate, getStatus, courseSearchUrl, calculateSubjectHoursWithLookback, formatLookbackCutoff } = require('./utils');
const { getHealthSummary } = require('./credential-health');
const { loadCosts, calculateAllProviderSpending, calculateRolling12MonthSpending } = require('./cost-utils');
const { getAllUpdates } = require('./change-detector');

// ─── Platform Registry ────────────────────────────────────────────────────────

const platformsPath = path.join(__dirname, 'platforms.json');
const platformsConfig = JSON.parse(fs.readFileSync(platformsPath, 'utf8'));

const OUTPUT_HTML    = path.join(__dirname, 'dashboard.html');

// Load state-specific CE requirements with lookback periods
let STATE_REQUIREMENTS = {};
try {
  STATE_REQUIREMENTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-requirements.json'), 'utf8'));
} catch (e) {
  // File not found or invalid - continue without state requirements
}
const LAST_RUN_FILE  = path.join(__dirname, 'last_run.json');
const HISTORY_FILE   = path.join(__dirname, 'history.json');
const COURSE_HISTORY_FILE = path.join(__dirname, 'course-history.json');
const PUBLIC_DIR     = path.join(__dirname, 'public');

function ensurePublicDir() {
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

/**
 * Load existing course history from file.
 * Returns an object keyed by provider name, each containing an array of courses.
 */
function loadCourseHistory() {
  try {
    return JSON.parse(fs.readFileSync(COURSE_HISTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Merge new courses into existing history, deduplicating by date+name+hours.
 * Returns the merged history object.
 */
function mergeCourseHistory(existingHistory, newCourses) {
  const merged = { ...existingHistory };

  for (const [providerName, courses] of Object.entries(newCourses)) {
    if (!merged[providerName]) {
      merged[providerName] = { courses: [], deadlines: [], platformSpend: {} };
    }

    // Build index of existing courses for fast lookup
    const existingCourseIndex = new Map();
    (merged[providerName].courses || []).forEach((c, idx) => {
      existingCourseIndex.set(`${c.date}|${c.name}|${c.hours}`, idx);
    });

    // Merge courses (dedupe by date+name+hours, but update cost/platform if new data available)
    for (const course of (courses.courses || [])) {
      const key = `${course.date}|${course.name}|${course.hours}`;
      if (existingCourseIndex.has(key)) {
        // Update existing course with cost/platform if available
        const idx = existingCourseIndex.get(key);
        if (course.cost && !merged[providerName].courses[idx].cost) {
          merged[providerName].courses[idx].cost = course.cost;
        }
        if (course.platform && !merged[providerName].courses[idx].platform) {
          merged[providerName].courses[idx].platform = course.platform;
        }
      } else {
        merged[providerName].courses.push(course);
        existingCourseIndex.set(key, merged[providerName].courses.length - 1);
      }
    }

    // Update deadlines (replace with latest)
    if (courses.deadlines && courses.deadlines.length > 0) {
      merged[providerName].deadlines = courses.deadlines;
    }

    // Store provider type
    if (courses.type) {
      merged[providerName].type = courses.type;
    }

    // Merge platform spend data
    if (courses.platformSpend) {
      merged[providerName].platformSpend = merged[providerName].platformSpend || {};
      for (const [platform, spend] of Object.entries(courses.platformSpend)) {
        merged[providerName].platformSpend[platform] = spend;
      }
    }
  }

  // Sort courses by date (newest first) for each provider
  for (const providerName of Object.keys(merged)) {
    if (merged[providerName].courses) {
      merged[providerName].courses.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
  }

  return merged;
}

/**
 * Save course history to file.
 */
function saveCourseHistory(history) {
  fs.writeFileSync(COURSE_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  // Mirror to public directory
  ensurePublicDir();
  fs.writeFileSync(path.join(PUBLIC_DIR, 'course-history.json'), JSON.stringify(history, null, 2), 'utf8');
}

/**
 * Flatten provider records, using runResults names as fallback if providerName is missing.
 */
function flattenRecords(allProviderRecords, runResults) {
  const flat = [];
  for (let i = 0; i < allProviderRecords.length; i++) {
    const providerNameFallback = runResults[i]?.name || 'Unknown';
    for (const rec of allProviderRecords[i]) {
      flat.push({
        ...rec,
        providerName: rec.providerName || providerNameFallback,
      });
    }
  }
  return flat;
}

/**
 * Append the current run snapshot to history.json so progress can be
 * tracked across multiple scrape runs over time.
 */
function saveHistory(allProviderRecords, runResults) {
  const flat = flattenRecords(allProviderRecords, runResults);
  const succeeded    = (runResults || []).filter(r => r.status === 'success').length;
  const notConfigured = (runResults || []).filter(r => r.status === 'not_configured').length;
  const loginErrors  = (runResults || []).filter(r => r.status === 'login_error' || r.status === 'failed').length;

  // Build a lean snapshot — just the numbers we need for charts
  const snapshot = {
    timestamp: new Date().toISOString(),
    succeeded,
    failed: loginErrors,  // Keep 'failed' key for backward compatibility
    notConfigured,
    providers: flat.map(rec => ({
      name:            rec.providerName,
      state:           rec.state,
      hoursRequired:   rec.hoursRequired,
      hoursCompleted:  rec.hoursCompleted,
      hoursRemaining:  rec.hoursRemaining,
      renewalDeadline: rec.renewalDeadline,
    })),
  };

  // Load existing history (or start fresh)
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }

  history.push(snapshot);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

  // Mirror to public/ so Vercel serves the latest history
  ensurePublicDir();
  fs.writeFileSync(path.join(PUBLIC_DIR, 'history.json'), JSON.stringify(history, null, 2), 'utf8');

  // Also save a simple last_run.json for the server's health check
  fs.writeFileSync(LAST_RUN_FILE, JSON.stringify({
    timestamp: snapshot.timestamp, total: flat.length, succeeded, failed: loginErrors,
  }, null, 2), 'utf8');

  return history;
}

/**
 * Build history log HTML from history array
 */
function buildHistoryLog(history) {
  return history.slice(-20).reverse().map((run, i) => {
    const runTime = new Date(run.timestamp);
    const dateStr = runTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = runTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const provCount = run.providers?.length || 0;
    const successCount = run.results?.filter(r => r.status === 'success').length || 0;
    const failCount = run.results?.filter(r => r.status === 'login_error' || r.status === 'failed').length || 0;
    const isLatest = i === 0;
    const latestClass = isLatest ? 'history-latest' : '';
    const failHtml = failCount > 0 ? '<span class="history-stat history-stat-fail">' + failCount + ' ✗</span>' : '';
    const latestBadge = isLatest ? '<span class="history-badge-latest">Latest</span>' : '';

    return '<div class="history-item ' + latestClass + '">' +
      '<div class="history-time">' +
        '<span class="history-date">' + dateStr + '</span>' +
        '<span class="history-clock">' + timeStr + '</span>' +
      '</div>' +
      '<div class="history-stats">' +
        '<span class="history-stat history-stat-ok">' + successCount + ' ✓</span>' +
        failHtml +
        '<span class="history-stat history-stat-total">' + provCount + ' providers</span>' +
      '</div>' +
      latestBadge +
    '</div>';
  }).join('');
}

/**
 * Build and write dashboard.html.
 * @param {LicenseRecord[][]} allProviderRecords
 * @param {{ name:string, status:string, error?:string }[]} [runResults]
 */
function buildDashboard(allProviderRecords, runResults = [], platformData = [], licenseData = null) {
  const history = saveHistory(allProviderRecords, runResults);
  const flat    = flattenRecords(allProviderRecords, runResults);
  const runDate = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const runIso  = new Date().toISOString();

  // Load providers.json early for credential checks
  const providers = require('./providers.json');
  const noCredentialsProviders = providers.filter(p => p.noCredentials === true).map(p => p.name);

  // ── Get credential health summary ─────────────────────────────────────────
  const healthSummary = getHealthSummary();

  // ── Group platform results by provider name ──────────────────────────────
  const platformByProvider = {};
  for (const pr of platformData) {
    if (!platformByProvider[pr.providerName]) platformByProvider[pr.providerName] = [];
    platformByProvider[pr.providerName].push(pr);
  }

  // ── Aggregate platform hours by provider (for platform-only providers) ───
  const platformTotalsByProvider = {};
  for (const [providerName, platforms] of Object.entries(platformByProvider)) {
    const successfulPlatforms = platforms.filter(p => p.status === 'success');
    const totalHours = successfulPlatforms.reduce((sum, p) => sum + (p.hoursEarned || 0), 0);
    const totalCourses = successfulPlatforms.reduce((sum, p) => sum + (p.courses?.length || 0), 0);
    const platformNames = successfulPlatforms.map(p => p.platform);
    platformTotalsByProvider[providerName] = {
      totalHours,
      totalCourses,
      platformCount: successfulPlatforms.length,
      platforms: platformNames,
      details: successfulPlatforms.map(p => ({ platform: p.platform, hours: p.hoursEarned || 0, courses: p.courses?.length || 0 }))
    };
  }

  // ── Filter credential gaps to only show providers with NO credentials at all ───
  // (exclude those who have platform credentials like NetCE, CEUfast, etc.)
  const trulyNoCredentialsProviders = noCredentialsProviders.filter(name => {
    const hasPlatformData = platformByProvider[name] && platformByProvider[name].some(p => p.status === 'success');
    return !hasPlatformData;
  });

  // ── Platform overview data (loaded from platforms.json) ────────────────────
  const ALL_PLATFORMS = Object.entries(platformsConfig)
    .filter(([key, p]) => p.type === 'ceu-source')
    .map(([key, p]) => ({
      name: p.name,
      url: p.urls.login.replace(/\/login.*$|\/signin.*$|\/my-account.*$/, ''),
      slug: p.slug,
      desc: p.description,
      status: p.status,
    }));
  const platformStats = {};
  for (const pr of platformData) {
    if (!platformStats[pr.platform]) platformStats[pr.platform] = { providers: [], totalHours: 0 };
    platformStats[pr.platform].providers.push(pr.providerName);
    if (pr.status === 'success' && pr.hoursEarned) platformStats[pr.platform].totalHours += pr.hoursEarned;
  }

  // ── Load cost data and calculate spending stats ────────────────────────────
  const costData = loadCosts();
  const courseHistory = loadCourseHistory();
  const spendingStats = calculateAllProviderSpending(courseHistory, costData);

  // Aggregate orders from platform data
  const ordersByProvider = {};
  for (const pr of platformData) {
    if (pr.orders && pr.orders.length > 0) {
      if (!ordersByProvider[pr.providerName]) ordersByProvider[pr.providerName] = [];
      ordersByProvider[pr.providerName].push(...pr.orders);
    }
  }

  // ── Aggregate stats ──────────────────────────────────────────────────────
  const getS = (rec) => getStatus(rec.hoursRemaining, daysUntil(parseDate(rec.renewalDeadline)), rec.hoursRequired);
  const total    = flat.length;
  const complete = flat.filter(r => getS(r) === 'Complete').length;
  const atRisk   = flat.filter(r => getS(r) === 'At Risk').length;
  const inProg   = flat.filter(r => getS(r) === 'In Progress').length;

  // ── Upcoming deadlines (30/60/90 days) ─────────────────────────────────
  const upcomingDeadlines = flat
    .map(r => ({ ...r, days: daysUntil(parseDate(r.renewalDeadline)), status: getS(r) }))
    .filter(r => r.days !== null && r.days >= 0 && r.days <= 90)
    .sort((a, b) => a.days - b.days);
  const deadlines30 = upcomingDeadlines.filter(r => r.days <= 30);
  const deadlines60 = upcomingDeadlines.filter(r => r.days > 30 && r.days <= 60);
  const deadlines90 = upcomingDeadlines.filter(r => r.days > 60 && r.days <= 90);

  // ── Compliance metrics for quick filters ─────────────────────────────────
  const uniqueProviders = new Set(flat.map(r => r.providerName)).size;
  const totalProviders = uniqueProviders || flat.length;
  const completeCount = complete;
  const atRiskCount = atRisk;
  const urgentCount = deadlines30.length;
  const complianceScore = totalProviders > 0 ? Math.round((complete / Math.max(total, 1)) * 100) : 0;

  // ── Login errors from run results ─────────────────────────────────────
  const loginErrors = (runResults || []).filter(r => r.status === 'login_error' || r.status === 'failed');

  // ── Chart data (for embedded bar chart) ─────────────────────────────────
  const chartData = { labels: [], completed: [], required: [], colors: [] };
  for (const rec of flat) {
    const sameProvider = flat.filter(r => r.providerName === rec.providerName);
    const label = sameProvider.length > 1
      ? `${rec.providerName} (${rec.state || 'N/A'})` : (rec.providerName || 'Unknown');
    chartData.labels.push(label);
    chartData.completed.push(rec.hoursCompleted ?? 0);
    chartData.required.push(rec.hoursRequired ?? 0);
    const st = getS(rec);
    chartData.colors.push(
      st === 'Complete'     ? 'rgba(16,185,129,0.9)'
    : st === 'At Risk'     ? 'rgba(239,68,68,0.9)'
    : st === 'In Progress' ? 'rgba(245,158,11,0.9)'
    :                        'rgba(100,116,139,0.5)'
    );
  }

  // ── Provider profile cards ───────────────────────────────────────────────
  // Group records by providerName so each person gets one card
  const providerMap = {};
  for (const rec of flat) {
    const key = rec.providerName || 'Unknown';
    if (!providerMap[key]) providerMap[key] = { type: rec.providerType, licenses: [] };
    providerMap[key].licenses.push(rec);
  }

  // All unique states for the state filter chips
  const allStates = [...new Set(flat.map(r => r.state).filter(Boolean))].sort();

  // ── State-by-State Summary ──────────────────────────────────────────────
  const stateStats = {};
  for (const rec of flat) {
    const state = rec.state || 'Unknown';
    if (!stateStats[state]) stateStats[state] = { total: 0, complete: 0, atRisk: 0, inProgress: 0, unknown: 0 };
    stateStats[state].total++;
    const st = getS(rec);
    if (st === 'Complete') stateStats[state].complete++;
    else if (st === 'At Risk') stateStats[state].atRisk++;
    else if (st === 'In Progress') stateStats[state].inProgress++;
    else stateStats[state].unknown++;
  }

  // ── AANP Certification Tracking ─────────────────────────────────────────
  const aanpCertData = platformData.filter(p => p.platform === 'AANP Cert' && p.status === 'success');
  const aanpCertByProvider = {};
  for (const cert of aanpCertData) {
    aanpCertByProvider[cert.providerName] = {
      status: cert.certStatus || 'Unknown',
      expirationDate: cert.certExpires,
      hoursEarned: cert.hoursEarned,
      hoursRequired: cert.hoursRequired,
      pharmacyHours: cert.pharmacyHoursEarned,
      pharmacyRequired: cert.pharmacyHoursRequired
    };
  }

  // ── Deadline urgency buckets with provider cards ────────────────────────
  const deadlineProviders30 = [];
  const deadlineProviders60 = [];
  const deadlineProviders90 = [];
  for (const [name, info] of Object.entries(providerMap)) {
    const earliestDeadline = Math.min(...info.licenses.map(l => daysUntil(parseDate(l.renewalDeadline)) ?? 9999));
    if (earliestDeadline >= 0 && earliestDeadline <= 30) deadlineProviders30.push([name, info, earliestDeadline]);
    else if (earliestDeadline > 30 && earliestDeadline <= 60) deadlineProviders60.push([name, info, earliestDeadline]);
    else if (earliestDeadline > 60 && earliestDeadline <= 90) deadlineProviders90.push([name, info, earliestDeadline]);
  }
  deadlineProviders30.sort((a, b) => a[2] - b[2]);
  deadlineProviders60.sort((a, b) => a[2] - b[2]);
  deadlineProviders90.sort((a, b) => a[2] - b[2]);

  // ── Providers grouped by state ──────────────────────────────────────────
  const providersByState = {};
  for (const [name, info] of Object.entries(providerMap)) {
    const states = [...new Set(info.licenses.map(l => l.state).filter(Boolean))];
    for (const state of states) {
      if (!providersByState[state]) providersByState[state] = [];
      providersByState[state].push([name, info]);
    }
  }

  // ── Providers grouped by license type ─────────────────────────────────────
  const providersByType = { NP: [], MD: [], DO: [], RN: [], Other: [] };
  for (const [name, info] of Object.entries(providerMap)) {
    const type = info.type || 'Other';
    if (providersByType[type]) {
      providersByType[type].push([name, info]);
    } else {
      providersByType.Other.push([name, info]);
    }
  }

  // ── Action Items (Priority Queue) ───────────────────────────────────────
  const actionItems = {
    critical: [], // At Risk providers
    urgent: [],   // Deadlines within 30 days
    warning: [],  // Deadlines within 60 days
    info: []      // Missing credentials
  };

  // ── Priority Groups (for Priority View) ─────────────────────────────────
  const priorityGroups = {
    critical: [],    // At Risk status
    attention: [],   // Deadline within 60 days, not complete
    onTrack: [],     // In Progress, plenty of time
    complete: [],    // All complete
    unknown: []      // No data/credentials needed
  };

  for (const [name, info] of Object.entries(providerMap)) {
    const worstStatus = info.licenses.some(l => getS(l) === 'At Risk') ? 'At Risk'
                      : info.licenses.some(l => getS(l) === 'In Progress') ? 'In Progress'
                      : info.licenses.every(l => getS(l) === 'Complete') ? 'Complete'
                      : 'Unknown';
    const earliestDeadline = Math.min(...info.licenses.map(l => daysUntil(parseDate(l.renewalDeadline)) ?? 9999));
    const hoursNeeded = info.licenses.reduce((sum, l) => sum + (l.hoursRemaining || 0), 0);

    // Action items (existing logic)
    if (worstStatus === 'At Risk') {
      actionItems.critical.push({ name, info, deadline: earliestDeadline, hoursNeeded, reason: 'At Risk - CE requirements behind schedule' });
    } else if (earliestDeadline >= 0 && earliestDeadline <= 30 && worstStatus !== 'Complete') {
      actionItems.urgent.push({ name, info, deadline: earliestDeadline, hoursNeeded, reason: 'Deadline within 30 days' });
    } else if (earliestDeadline > 30 && earliestDeadline <= 60 && worstStatus !== 'Complete') {
      actionItems.warning.push({ name, info, deadline: earliestDeadline, hoursNeeded, reason: 'Deadline within 60 days' });
    }

    // Priority groups (for Priority View)
    if (worstStatus === 'At Risk') {
      priorityGroups.critical.push({ name, info, deadline: earliestDeadline, hoursNeeded, status: worstStatus });
    } else if (worstStatus === 'Complete') {
      priorityGroups.complete.push({ name, info, deadline: earliestDeadline, hoursNeeded, status: worstStatus });
    } else if (worstStatus === 'Unknown' || noCredentialsProviders.includes(name)) {
      priorityGroups.unknown.push({ name, info, deadline: earliestDeadline, hoursNeeded, status: worstStatus });
    } else if (earliestDeadline >= 0 && earliestDeadline <= 60) {
      priorityGroups.attention.push({ name, info, deadline: earliestDeadline, hoursNeeded, status: worstStatus });
    } else {
      priorityGroups.onTrack.push({ name, info, deadline: earliestDeadline, hoursNeeded, status: worstStatus });
    }
  }

  // Sort priority groups by deadline
  priorityGroups.critical.sort((a, b) => a.deadline - b.deadline);
  priorityGroups.attention.sort((a, b) => a.deadline - b.deadline);
  priorityGroups.onTrack.sort((a, b) => a.deadline - b.deadline);
  priorityGroups.complete.sort((a, b) => a.name.localeCompare(b.name));
  priorityGroups.unknown.sort((a, b) => a.name.localeCompare(b.name));

  // Add missing credentials to info (only those with no credentials at all)
  for (const p of trulyNoCredentialsProviders) {
    if (!actionItems.critical.find(a => a.name === p) && !actionItems.urgent.find(a => a.name === p)) {
      actionItems.info.push({ name: p, reason: 'Missing CE credentials' });
    }
  }

  // ── Lookback Compliance Data (for Compliance tab) ─────────────────────────
  const STATE_ABBREV = {
    'Florida': 'FL', 'Ohio': 'OH', 'Michigan': 'MI', 'Texas': 'TX',
    'New York': 'NY', 'California': 'CA', 'New Mexico': 'NM', 'New Hampshire': 'NH',
    'Georgia': 'GA', 'Pennsylvania': 'PA', 'Illinois': 'IL', 'North Carolina': 'NC',
  };

  const lookbackComplianceData = [];
  for (const [pName, info] of Object.entries(providerMap)) {
    const providerStates = [...new Set(info.licenses.map(l => l.state).filter(Boolean))];
    const allCourses = info.licenses.flatMap(l => l.completedCourses || []);

    for (const state of providerStates) {
      const stateKey = STATE_REQUIREMENTS[state] ? state : STATE_ABBREV[state];
      const stateReqs = STATE_REQUIREMENTS[stateKey];
      if (!stateReqs) continue;

      // Check autonomous APRN requirements (Florida)
      if (stateReqs.autonomousAPRN && info.type === 'NP') {
        const autoReqs = stateReqs.autonomousAPRN;
        for (const subj of autoReqs.subjects || []) {
          if (!subj.lookbackYears) continue; // Only include subjects with lookback
          const result = calculateSubjectHoursWithLookback(allCourses, subj.pattern, subj.lookbackYears);
          const needed = Math.max(0, subj.hoursRequired - result.validHours);
          lookbackComplianceData.push({
            providerName: pName,
            providerType: info.type,
            state: stateReqs.name || state,
            requirement: autoReqs.description || 'Autonomous APRN',
            subject: subj.name,
            hoursRequired: subj.hoursRequired,
            totalHours: result.totalHours,
            validHours: result.validHours,
            lookbackYears: subj.lookbackYears,
            needed,
            status: needed === 0 ? 'Met' : 'Needs ' + needed + 'h'
          });
        }
      }

      // Check standard APRN requirements
      const reqSet = stateReqs[info.type] || stateReqs.APRN;
      if (reqSet && reqSet.subjects) {
        for (const subj of reqSet.subjects) {
          if (!subj.lookbackYears) continue; // Only include subjects with lookback
          const result = calculateSubjectHoursWithLookback(allCourses, subj.pattern, subj.lookbackYears);
          const needed = Math.max(0, subj.hoursRequired - result.validHours);
          lookbackComplianceData.push({
            providerName: pName,
            providerType: info.type,
            state: stateReqs.name || state,
            requirement: reqSet.description || 'Standard',
            subject: subj.name,
            hoursRequired: subj.hoursRequired,
            totalHours: result.totalHours,
            validHours: result.validHours,
            lookbackYears: subj.lookbackYears,
            needed,
            status: needed === 0 ? 'Met' : 'Needs ' + needed + 'h'
          });
        }
      }
    }
  }

  // Summary counts for compliance tab
  const lookbackMet = lookbackComplianceData.filter(d => d.needed === 0).length;
  const lookbackNotMet = lookbackComplianceData.filter(d => d.needed > 0).length;

  // Pre-render each provider's drawer HTML in Node.js (avoids nested template literal issues)
  const drawerHtmlMap = {};
  for (const [pName, info] of Object.entries(providerMap)) {
    const ini      = pName.split(/[\s,]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
    const worstSt  = info.licenses.some(l => getS(l) === 'At Risk')     ? 'At Risk'
                   : info.licenses.some(l => getS(l) === 'In Progress') ? 'In Progress'
                   : info.licenses.every(l => getS(l) === 'Complete')   ? 'Complete'
                   : 'Unknown';
    const ovCls   = { Complete:'status-complete','In Progress':'status-progress','At Risk':'status-risk',Unknown:'status-creds-needed' }[worstSt] || 'status-creds-needed';
    const ovLabel = { Complete:'✓ Complete','In Progress':'◷ In Progress','At Risk':'⚠ At Risk',Unknown:'🔑 Credentials Needed' }[worstSt] || worstSt;

    const licCards = info.licenses.map(lic => {
      const st      = getS(lic);
      const pct     = lic.hoursRequired > 0 ? Math.min(100, Math.round(((lic.hoursCompleted || 0) / lic.hoursRequired) * 100)) : 0;
      const barCls  = pct >= 100 ? '' : pct >= 50 ? 'partial' : 'low';
      const dlCls   = { Complete:'dl-complete','In Progress':'dl-progress','At Risk':'dl-risk',Unknown:'' }[st] || '';
      const stCls   = { Complete:'status-complete','In Progress':'status-progress','At Risk':'status-risk',Unknown:'status-creds-needed' }[st] || 'status-unknown';
      const stLabel = { Complete:'✓ Complete','In Progress':'◷ In Progress','At Risk':'⚠ At Risk',Unknown:'○ Credentials Needed' }[st] || st;
      const licState = lic.state || 'Credentials Needed';
      const days    = daysUntil(parseDate(lic.renewalDeadline));
      const daysStr = days === null ? ''
        : days < 0   ? `<span class="overdue">${Math.abs(days)}d overdue</span>`
        : days <= 60 ? `<span class="urgent">${days}d left</span>`
        : `${days}d left`;
      const cUrl         = courseSearchUrl(licState, lic.licenseType || info.type);
      const cebrokerUrl  = lic.licenseId
        ? `https://licensees.cebroker.com/license/${lic.licenseId}/overview`
        : null;

      const saRows = (lic.subjectAreas || []).map(sa => {
        const rem  = (sa.hoursRequired != null && sa.hoursCompleted != null) ? Math.max(0, sa.hoursRequired - sa.hoursCompleted) : null;
        return `<tr>
          <td>${escHtml(sa.topicName || '—')}</td>
          <td style="text-align:center">${sa.hoursRequired ?? '—'}</td>
          <td style="text-align:center" class="${rem === 0 ? 'sa-done' : ''}">${sa.hoursCompleted ?? '—'}</td>
          <td style="text-align:center" class="${rem > 0 ? 'sa-short' : rem === 0 ? 'sa-done' : ''}">${rem ?? '—'}</td>
        </tr>`;
      }).join('');

      // ── Still Needed section ──────────────────────────────────────────────
      const neededAreas = (lic.subjectAreas || []).filter(sa => {
        if (sa.hoursNeeded != null) return sa.hoursNeeded > 0;
        if (sa.hoursRequired != null && sa.hoursCompleted != null) return sa.hoursCompleted < sa.hoursRequired;
        return false;
      });
      const neededSection = neededAreas.length > 0
        ? `<div class="drawer-section">
            <div class="drawer-section-title">Still Needed</div>
            ${neededAreas.map(sa => {
              const needed = sa.hoursNeeded ?? Math.max(0, (sa.hoursRequired || 0) - (sa.hoursCompleted || 0));
              return `<div class="need-item">
                <span class="need-topic">${escHtml(sa.topicName)}</span>
                <span class="need-hours">${needed} hr${needed !== 1 ? 's' : ''} needed</span>
                ${cUrl ? `<a href="${cUrl}" target="_blank" rel="noopener" class="need-search">Search →</a>` : ''}
              </div>`;
            }).join('')}
          </div>`
        : (lic.hoursRemaining > 0
            ? `<div class="drawer-section">
                <div class="drawer-section-title">Still Needed</div>
                <div class="need-item">
                  <span class="need-topic">General CEUs</span>
                  <span class="need-hours">${lic.hoursRemaining} hrs needed</span>
                  ${cUrl ? `<a href="${cUrl}" target="_blank" rel="noopener" class="need-search">Search →</a>` : ''}
                </div>
              </div>`
            : '');

      // ── Completed Courses section ─────────────────────────────────────────
      const rawCourses = lic.completedCourses || [];

      // Deduplicate courses: merge exact duplicates (same name+date+hours), keep separate completions
      const courseKey = c => `${c.name || ''}|${c.date || ''}|${c.hours || 0}`;
      const deduped = [];
      const seen = new Set();
      for (const c of rawCourses) {
        const key = courseKey(c);
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(c);
        }
      }

      // Check for courses with same name but different dates (legitimate separate completions)
      const nameCounts = {};
      for (const c of deduped) {
        const name = c.name || '';
        nameCounts[name] = (nameCounts[name] || 0) + 1;
      }

      // Sort courses by date (most recent first) then by name
      const sortedCourses = [...deduped].sort((a, b) => {
        const dateA = a.date ? new Date(a.date) : new Date(0);
        const dateB = b.date ? new Date(b.date) : new Date(0);
        if (dateB - dateA !== 0) return dateB - dateA;
        return (a.name || '').localeCompare(b.name || '');
      });

      const completedSection = sortedCourses.length > 0
        ? `<div class="drawer-section">
            <div class="drawer-section-title">Completed Courses (${sortedCourses.length}${sortedCourses.length !== rawCourses.length ? ` unique` : ''})</div>
            <div class="course-list">
              ${sortedCourses.map(c => {
                const isDuplicated = nameCounts[c.name || ''] > 1;
                return `
                <div class="course-item${isDuplicated ? ' has-multiple' : ''}">
                  <span class="course-item-name${c.name ? '' : ' unnamed'}">${escHtml(c.name || 'Course name unavailable')}</span>
                  <div class="course-item-meta">
                    ${c.date ? `<span class="course-item-date${isDuplicated ? ' highlight-date' : ''}">${escHtml(c.date)}</span>` : '<span class="course-item-date no-date">No date</span>'}
                    <span class="course-item-hours">${c.hours} hr${c.hours !== 1 ? 's' : ''}</span>
                    ${c.category ? `<span class="course-item-cat">${escHtml(c.category)}</span>` : ''}
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`
        : '';

      return `<div class="detail-lic-card ${dlCls}">
        <div class="detail-lic-hdr">
          <span class="detail-state-badge">${escHtml(licState)}</span>
          <span class="detail-lic-type">${escHtml(lic.licenseType || info.type || '')}</span>
          ${lic.licenseNumber ? `<span class="detail-lic-num">Lic# ${escHtml(lic.licenseNumber)}</span>` : ''}
          <span class="status-badge ${stCls}" style="margin-left:auto">${stLabel}</span>
        </div>
        <div class="detail-deadline">
          Renewal: <strong>${escHtml(lic.renewalDeadline || '—')}</strong> ${daysStr}
        </div>
        <div class="detail-prog-row">
          <div class="detail-prog-track">
            <div class="detail-prog-fill ${barCls}" style="width:${pct}%"></div>
          </div>
          <span class="detail-prog-label">${lic.hoursCompleted ?? '—'} / ${lic.hoursRequired ?? '—'} hrs (${pct}%)</span>
        </div>
        ${saRows
          ? `<table class="detail-sa-table">
              <thead><tr>
                <th>Subject Area</th>
                <th style="text-align:center">Req</th>
                <th style="text-align:center">Done</th>
                <th style="text-align:center">Left</th>
              </tr></thead>
              <tbody>${saRows}</tbody>
            </table>`
          : '<p class="detail-no-sa">No subject area breakdown available.</p>'
        }
        ${neededSection}
        ${completedSection}
        <div class="detail-btn-row">
          ${cebrokerUrl ? `<a class="cebroker-link" href="${cebrokerUrl}" target="_blank" rel="noopener">View in CE Broker ↗</a>` : ''}
          ${cUrl ? `<a class="detail-course-btn" href="${cUrl}" target="_blank" rel="noopener">Search Available Courses ↗</a>` : ''}
        </div>
      </div>`;
    }).join('');

    const contactEmail = info.licenses[0]?.providerEmail;
    const contactPhone = info.licenses[0]?.providerPhone;
    const contactHtml  = (contactEmail || contactPhone)
      ? `<div class="detail-contact">
          ${contactEmail ? `<a href="mailto:${escHtml(contactEmail)}" class="contact-link">${escHtml(contactEmail)}</a>` : ''}
          ${contactPhone ? `<span class="contact-phone">${escHtml(contactPhone)}</span>` : ''}
        </div>`
      : '';

    const platformSection = buildPlatformSection(platformByProvider[pName] || []);

    // Build lookback compliance section
    const providerStates = [...new Set(info.licenses.map(l => l.state).filter(Boolean))];
    const allCourses = info.licenses.flatMap(l => l.completedCourses || []);
    const lookbackSection = buildLookbackComplianceSection(providerStates, info.type, allCourses);

    // Build spending section
    const providerSpending = spendingStats.byProvider[pName] || null;
    const providerOrders = ordersByProvider[pName] || [];
    const spendingSection = buildSpendingSection(pName, providerSpending, providerOrders);

    drawerHtmlMap[pName] = `<div class="detail-hdr">
      <div class="detail-avatar" style="background:${
        worstSt === 'Complete'    ? '#10b981'
      : worstSt === 'In Progress' ? '#f59e0b'
      : worstSt === 'At Risk'     ? '#ef4444'
      :                              '#64748b'
      }">${escHtml(ini)}</div>
      <div style="flex:1;min-width:0">
        <div class="detail-name">${escHtml(pName)}</div>
        <div class="detail-type-lbl">${escHtml(info.type || 'Healthcare Provider')}</div>
        ${contactHtml}
      </div>
      <div class="detail-overall"><span class="status-badge ${ovCls}">${ovLabel}</span></div>
    </div>
    <div>${licCards}</div>
    ${lookbackSection}
    ${spendingSection}
    ${platformSection}
    <div class="notes-section" data-provider="${escHtml(pName)}">
      <div class="notes-header">
        <div class="notes-title"><span class="notes-title-icon">📝</span> Notes & Tasks</div>
        <button class="add-note-btn" onclick="showNoteForm('${escHtml(pName).replace(/'/g, '&#39;')}')">+ Add Note</button>
      </div>
      <div class="note-form" id="noteForm-${escHtml(pName).replace(/[^a-zA-Z0-9]/g, '_')}">
        <div class="note-form-inner">
          <textarea class="note-input" placeholder="Enter note or task..." id="noteInput-${escHtml(pName).replace(/[^a-zA-Z0-9]/g, '_')}"></textarea>
          <div class="note-form-options">
            <label class="note-type-toggle">
              <input type="checkbox" id="noteIsTask-${escHtml(pName).replace(/[^a-zA-Z0-9]/g, '_')}">
              <span>Mark as task</span>
            </label>
            <div class="note-form-actions">
              <button class="note-cancel-btn" onclick="hideNoteForm('${escHtml(pName).replace(/'/g, '&#39;')}')">Cancel</button>
              <button class="note-save-btn" onclick="saveNote('${escHtml(pName).replace(/'/g, '&#39;')}')">Save</button>
            </div>
          </div>
        </div>
      </div>
      <div class="notes-list" id="notesList-${escHtml(pName).replace(/[^a-zA-Z0-9]/g, '_')}">
        <div class="notes-empty">No notes yet. Click "+ Add Note" to add the first one.</div>
      </div>
    </div>`;
  }

  // ── Renewal deadline calendar (pre-rendered HTML) ────────────────────────
  const today = new Date();
  const calendarData = {};
  for (const rec of flat) {
    const d = parseDate(rec.renewalDeadline);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!calendarData[key]) calendarData[key] = [];
    calendarData[key].push({
      name:     rec.providerName,
      state:    rec.state || '??',
      deadline: rec.renewalDeadline,
      days:     daysUntil(d),
      status:   getS(rec),
    });
  }
  const calendarKeys = Object.keys(calendarData).sort();
  let calendarHtml = '';
  if (calendarKeys.length === 0) {
    calendarHtml = '<p class="cal-empty">No renewal deadlines found.</p>';
  } else {
    calendarHtml = calendarKeys.map(key => {
      const [yr, mo] = key.split('-');
      const monthName = new Date(+yr, +mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      const isPast    = new Date(+yr, +mo, 0) < today;
      const entries   = calendarData[key].slice().sort((a, b) => {
        const da = parseDate(a.deadline), db = parseDate(b.deadline);
        return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
      });
      const entriesHtml = entries.map(e => {
        const stCls = {
          Complete:      'status-complete',
          'In Progress': 'status-progress',
          'At Risk':     'status-risk',
          Unknown:       'status-unknown',
        }[e.status] || 'status-unknown';
        const daysStr = e.days === null ? ''
          : e.days < 0   ? `<span class="overdue">${Math.abs(e.days)}d overdue</span>`
          : e.days <= 60 ? `<span class="urgent">${e.days}d left</span>`
          : `${e.days}d left`;
        return `<div class="cal-entry">
          <div class="cal-entry-left">
            <span class="cal-entry-state">${escHtml(e.state)}</span>
            <span class="cal-entry-name">${escHtml(e.name)}</span>
          </div>
          <div class="cal-entry-right">
            <span class="cal-entry-date">${escHtml(e.deadline)}</span>
            ${daysStr ? `<span class="cal-entry-days">${daysStr}</span>` : ''}
            <span class="status-badge ${stCls}" style="font-size:0.7rem;padding:2px 7px">${escHtml(e.status)}</span>
          </div>
        </div>`;
      }).join('');
      return `<div class="cal-month${isPast ? ' cal-past' : ''}">
        <div class="cal-month-hdr">${escHtml(monthName)}${isPast ? ' <span class="cal-past-lbl">Past</span>' : ''}</div>
        <div class="cal-entries">${entriesHtml}</div>
      </div>`;
    }).join('');
  }

  // ── RN identification ─────────────────────────────────────────────────────
  const isRN = (name, type) => {
    // Clinicians (NP, MD, DO) are providers, not support staff
    if (['NP', 'MD', 'DO'].includes(type)) return false;
    // Explicit RN type is support staff
    if (type === 'RN') return true;
    // Fallback: check name suffix
    return name.includes(', RN');
  };

  // ── Helper to determine why a provider has Unknown status ────────────────
  const getUnknownReason = (providerName) => {
    // Check if login failed
    const failedLogin = loginErrors.find(r => r.name === providerName);
    if (failedLogin) {
      return { reason: 'Login Failed', detail: failedLogin.error || 'Platform login error', icon: '⚠', cls: 'unknown-error', platforms: [] };
    }

    // Get platforms this provider has access to
    const providerPlatforms = (platformByProvider[providerName] || [])
      .filter(p => p.status === 'success')
      .map(p => p.platform);

    // Check if no CE Broker credentials
    if (noCEBrokerList.includes(providerName)) {
      if (providerPlatforms.length > 0) {
        return {
          reason: 'Platform Access',
          detail: providerPlatforms.join(', '),
          icon: '✓',
          cls: 'unknown-partial',
          platforms: providerPlatforms
        };
      }
      // Check if they have platform credentials configured but not yet scraped
      const provider = providers.find(p => p.name === providerName);
      const configuredPlatforms = (provider?.platforms || []).map(p => p.platform);
      if (configuredPlatforms.length > 0) {
        return {
          reason: 'Platform Configured',
          detail: configuredPlatforms.join(', ') + ' (pending sync)',
          icon: '◷',
          cls: 'unknown-pending',
          platforms: configuredPlatforms
        };
      }
      return { reason: 'No Access Configured', detail: 'Submit credentials for tracking', icon: '○', cls: 'unknown-none', platforms: [] };
    }
    return { reason: 'Awaiting Data', detail: 'Will sync on next scrape', icon: '◷', cls: 'unknown-default', platforms: [] };
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ENHANCED FEATURES DATA - Timeline, Cost Comparison, ROI, Trends
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Timeline data (12-month deadline view) ───────────────────────────────
  const timelineMonths = [];
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  for (let i = 0; i < 12; i++) {
    const monthIdx = (currentMonth + i) % 12;
    const year = currentYear + Math.floor((currentMonth + i) / 12);
    timelineMonths.push({
      month: monthIdx,
      year: year,
      label: new Date(year, monthIdx, 1).toLocaleString('en-US', { month: 'short' }),
      isCurrent: i === 0
    });
  }

  const timelineDeadlines = flat
    .map(r => {
      const d = parseDate(r.renewalDeadline);
      if (!d) return null;
      const days = daysUntil(d);
      if (days === null || days < 0 || days > 365) return null;
      const monthIdx = d.getMonth();
      const year = d.getFullYear();
      const dayOfMonth = d.getDate();
      const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
      // Calculate position within the 12-month timeline (0-100%)
      const monthOffset = timelineMonths.findIndex(m => m.month === monthIdx && m.year === year);
      if (monthOffset === -1) return null;
      const pct = ((monthOffset + (dayOfMonth / daysInMonth)) / 12) * 100;
      // Get initials for label
      const initials = r.providerName.split(/[\s,]+/).filter(Boolean).slice(0, 2)
        .map(w => w[0].toUpperCase()).join('');
      // Determine status based on provider overall status
      const providerInfo = providerMap[r.providerName];
      const status = providerInfo ? (
        providerInfo.licenses.some(l => getStatus(l) === 'At Risk') ? 'At Risk' :
        providerInfo.licenses.some(l => getStatus(l) === 'In Progress') ? 'In Progress' :
        providerInfo.licenses.every(l => getStatus(l) === 'Complete') ? 'Complete' : 'Unknown'
      ) : 'Unknown';
      return {
        name: r.providerName,
        initials: initials,
        state: r.state || '',
        date: r.renewalDeadline,
        days: days,
        pct: pct,
        urgency: days <= 30 ? 'urgent' : days <= 90 ? 'warning' : 'safe',
        status: status
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.days - b.days);

  // ── Cost per hour comparison across platforms ────────────────────────────
  const platformCostData = {};
  for (const [providerName, providerHistory] of Object.entries(courseHistory)) {
    const courses = providerHistory.courses || [];
    for (const course of courses) {
      if (course.platform && course.hours > 0) {
        if (!platformCostData[course.platform]) {
          platformCostData[course.platform] = { totalCost: 0, totalHours: 0, courses: 0, providers: new Set() };
        }
        platformCostData[course.platform].totalHours += course.hours;
        platformCostData[course.platform].courses++;
        platformCostData[course.platform].providers.add(providerName);
        if (course.cost) {
          platformCostData[course.platform].totalCost += course.cost;
        }
      }
    }
  }
  // Add subscription/course costs from costData
  for (const [platform, costs] of Object.entries(costData.subscriptions || {})) {
    if (!platformCostData[platform]) {
      platformCostData[platform] = { totalCost: 0, totalHours: 0, courses: 0, providers: new Set() };
    }
    platformCostData[platform].totalCost += costs.annual || costs.monthly * 12 || 0;
  }
  const platformComparison = Object.entries(platformCostData)
    .map(([platform, data]) => ({
      platform,
      costPerHour: data.totalHours > 0 ? data.totalCost / data.totalHours : 0,
      totalSpent: data.totalCost,
      totalHours: data.totalHours,
      courseCount: data.courses,
      providerCount: data.providers.size
    }))
    .filter(p => p.totalHours > 0)
    .sort((a, b) => a.costPerHour - b.costPerHour);
  const bestValuePlatform = platformComparison[0]?.platform || null;

  // ── Platform ROI data ────────────────────────────────────────────────────
  const platformROI = {};
  for (const [providerName, providerHistory] of Object.entries(courseHistory)) {
    const courses = providerHistory.courses || [];
    for (const course of courses) {
      if (course.platform && course.hours > 0) {
        if (!platformROI[course.platform]) {
          platformROI[course.platform] = { totalSpent: 0, totalHours: 0, topUsers: {} };
        }
        platformROI[course.platform].totalHours += course.hours;
        if (course.cost) platformROI[course.platform].totalSpent += course.cost;
        if (!platformROI[course.platform].topUsers[providerName]) {
          platformROI[course.platform].topUsers[providerName] = 0;
        }
        platformROI[course.platform].topUsers[providerName] += course.hours;
      }
    }
  }
  const platformROICards = Object.entries(platformROI)
    .map(([platform, data]) => ({
      platform,
      totalSpent: data.totalSpent,
      totalHours: data.totalHours,
      topUsers: Object.entries(data.topUsers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, hours]) => ({ name, hours }))
    }))
    .filter(p => p.totalHours > 0)
    .sort((a, b) => b.totalSpent - a.totalSpent);

  // ── Compliance trend data (last 6 data points for sparkline) ─────────────
  const historyData = (() => {
    try {
      const histFile = require('path').join(__dirname, 'history.json');
      if (require('fs').existsSync(histFile)) {
        return JSON.parse(require('fs').readFileSync(histFile, 'utf8'));
      }
    } catch (e) {}
    return [];
  })();
  const trendData = historyData
    .slice(-6)
    .map(snapshot => {
      const providers = snapshot.providers || [];
      const total = providers.length;
      const complete = providers.filter(p => {
        const remaining = p.hoursRemaining ?? (p.hoursRequired - p.hoursCompleted);
        return remaining <= 0;
      }).length;
      return total > 0 ? Math.round((complete / total) * 100) : 0;
    });
  const trendDirection = trendData.length >= 2
    ? (trendData[trendData.length - 1] > trendData[0] ? 'up' : trendData[trendData.length - 1] < trendData[0] ? 'down' : 'flat')
    : 'flat';

  // ── Monthly spending for briefing ────────────────────────────────────────
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let thisMonthSpend = 0;
  for (const [providerName, providerHistory] of Object.entries(courseHistory)) {
    const courses = providerHistory.courses || [];
    for (const course of courses) {
      if (course.cost && course.date) {
        const courseDate = parseDate(course.date);
        if (courseDate && courseDate >= thisMonthStart) {
          thisMonthSpend += course.cost;
        }
      }
    }
  }

  // ── Helper to build a single provider card ───────────────────────────────
  const buildProviderCard = ([name, info]) => {
    // Check if this is a platform-only provider (no CE Broker data)
    const isPlatformOnly = info.licenses.every(l => l.hoursRequired === null && l.state === null);
    const platformTotals = platformTotalsByProvider[name];
    const hasPlatformData = platformTotals && platformTotals.totalHours > 0;

    // For platform-only providers with data, show platform summary instead
    let licBadges;
    if (isPlatformOnly && hasPlatformData) {
      const platformBlocks = platformTotals.details.map(p => `
        <div class="lic-block lic-platform">
          <div class="lic-header">
            <span class="lic-dot dot-blue"></span>
            <strong>${escHtml(p.platform)}</strong>
            <span class="lic-type">Platform</span>
            <span class="lic-status-text platform-status">✓ Connected</span>
          </div>
          <div class="lic-bar-row platform-hours">
            <span class="platform-hours-big">${p.hours}</span>
            <span class="platform-hours-label">hours earned</span>
          </div>
          <div class="platform-courses">${p.courses} course${p.courses !== 1 ? 's' : ''} on record</div>
        </div>
      `).join('');

      licBadges = `
        <div class="platform-summary-header">
          <span class="platform-icon">📊</span>
          <span>Platform CEU Data (${platformTotals.totalHours} total hours)</span>
        </div>
        ${platformBlocks}
        <div class="platform-creds-notice">
          <span class="creds-notice-icon">○</span>
          <span>Submit platform credentials for license compliance tracking</span>
        </div>
      `;
    } else {
      licBadges = info.licenses.map(lic => {
      const status    = getS(lic);
      const state     = lic.state || 'Creds Needed';
      const deadline  = lic.renewalDeadline || '—';
      const days      = daysUntil(parseDate(lic.renewalDeadline));

      // Generate countdown badge with color coding
      let countdownBadge = '';
      if (days !== null) {
        let badgeClass = 'safe';
        let badgeText = `${days} days`;
        let badgeIcon = '';
        if (days < 0) {
          badgeClass = 'overdue';
          badgeText = `${Math.abs(days)}d overdue`;
          badgeIcon = '⚠️ ';
        } else if (days <= 14) {
          badgeClass = 'danger critical';
          badgeText = `${days} days`;
          badgeIcon = '🔥 ';
        } else if (days <= 30) {
          badgeClass = 'danger';
          badgeText = `${days} days`;
        } else if (days <= 90) {
          badgeClass = 'warning';
          badgeText = `${days} days`;
        }
        countdownBadge = `<span class="countdown-badge ${badgeClass}" title="Due: ${escHtml(deadline)}">${badgeIcon}${badgeText}</span>`;
      }

      const badgeCls  = {
        Complete:      'lic-complete',
        'In Progress': 'lic-progress',
        'At Risk':     'lic-risk',
        Unknown:       'lic-unknown',
      }[status] || 'lic-unknown';

      const dotCls    = {
        Complete:      'dot-green',
        'In Progress': 'dot-yellow',
        'At Risk':     'dot-red',
        Unknown:       'dot-gray',
      }[status] || 'dot-gray';

      const pct = lic.hoursRequired
        ? Math.min(100, Math.round(((lic.hoursCompleted || 0) / lic.hoursRequired) * 100))
        : 0;
      const barCls = pct >= 100 ? '' : pct >= 50 ? 'partial' : (days !== null && days <= 14 ? 'low critical' : 'low');

      const courseUrl = courseSearchUrl(state, lic.licenseType || info.type);

      const dotTooltip = {
        Complete: 'Complete - All CEUs done',
        'In Progress': 'On Track - In progress, deadline far',
        'At Risk': 'Needs Attention - Deadline approaching!',
        Unknown: 'Missing Credentials'
      }[status] || 'Unknown status';

      return `<div class="lic-block ${badgeCls}">
        <div class="lic-header">
          <span class="lic-dot ${dotCls}" title="${dotTooltip}"></span>
          <strong>${escHtml(state)}</strong>
          <span class="lic-type">${escHtml(lic.licenseType || info.type || '')}</span>
          <span class="lic-status-text">${status === 'Unknown' ? 'Credentials Needed' : escHtml(status)}</span>
        </div>
        <div class="lic-deadline">
          <span class="deadline-label">Renewal:</span>
          ${countdownBadge}
        </div>
        <div class="lic-bar-row">
          <div class="bar-track"><div class="bar-fill ${barCls}" style="width:${pct}%"></div></div>
          <span class="bar-label">${lic.hoursCompleted ?? '—'} / ${lic.hoursRequired ?? '—'} hrs <span class="bar-pct">(${pct}%)</span></span>
        </div>
        ${courseUrl ? `<a class="lic-course-link" href="${courseUrl}" target="_blank" rel="noopener" title="Search courses"></a>` : ''}
      </div>`;
    }).join('');
    }

    // Overall worst status for card border (give platform-only providers a special status)
    let worstStatus;
    if (isPlatformOnly && hasPlatformData) {
      worstStatus = 'Platform';
    } else {
      worstStatus = info.licenses.some(l => getS(l) === 'At Risk')      ? 'At Risk'
                  : info.licenses.some(l => getS(l) === 'In Progress')  ? 'In Progress'
                  : info.licenses.every(l => getS(l) === 'Complete')    ? 'Complete'
                  : 'Unknown';
    }

    // Get specific reason for Unknown status
    const unknownInfo = worstStatus === 'Unknown' ? getUnknownReason(name) : null;

    // Earliest deadline (for sorting) and critical detection
    const earliestDeadline = Math.min(...info.licenses.map(l => daysUntil(parseDate(l.renewalDeadline)) ?? 9999));
    const isCritical = earliestDeadline <= 14 && earliestDeadline >= 0;
    const cardBorderCls = {
      Complete:      'card-ok',
      'In Progress': 'card-prog',
      'At Risk':     'card-risk',
      Platform:      'card-platform',
      Unknown:       unknownInfo?.cls === 'unknown-error' ? 'card-error' : 'card-unk',
    }[worstStatus] || 'card-unk';
    const criticalCls = isCritical ? 'critical-deadline' : '';

    const initials = name.split(/[\s,]+/).filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('');

    const statesList = info.licenses.map(l => l.state).filter(Boolean).join(',');

    // State chips — one per license (or platform summary for platform-only)
    let stateChips;
    if (isPlatformOnly && hasPlatformData) {
      stateChips = `<span class="card-state-chip sc-blue">${platformTotals.totalHours}h from ${platformTotals.platformCount} platform${platformTotals.platformCount !== 1 ? 's' : ''}</span>`;
    } else {
      stateChips = info.licenses.map(lic => {
        const st  = getS(lic);
        const cls = { Complete: 'sc-green', 'In Progress': 'sc-yellow', 'At Risk': 'sc-red', Unknown: 'sc-orange' }[st] || 'sc-gray';
        const stateLabel = lic.state || 'Creds Needed';
        return `<span class="card-state-chip ${cls}">${escHtml(stateLabel)} ${escHtml(lic.licenseType || info.type || '')}</span>`;
      }).join('');
    }

    // Aggregate progress bar data (sum across all licenses)
    const totalCompleted = info.licenses.reduce((sum, l) => sum + (l.hoursCompleted || 0), 0);
    const totalRequired = info.licenses.reduce((sum, l) => sum + (l.hoursRequired || 0), 0);
    const totalRemaining = info.licenses.reduce((sum, l) => sum + (l.hoursRemaining || 0), 0);
    const aggregatePct = totalRequired > 0 ? Math.min(100, Math.round((totalCompleted / totalRequired) * 100)) : 0;
    const aggBarCls = aggregatePct >= 100 ? 'agg-complete' : aggregatePct >= 75 ? 'agg-good' : aggregatePct >= 50 ? 'agg-partial' : 'agg-low';

    // Build aggregate progress bar HTML (only show for non-platform-only providers with requirements)
    const showAggProgress = !isPlatformOnly && totalRequired > 0;
    const aggProgressHtml = showAggProgress ? `
      <div class="card-agg-progress">
        <div class="agg-bar-track">
          <div class="agg-bar-fill ${aggBarCls}" style="width:${aggregatePct}%"></div>
        </div>
        <div class="agg-bar-stats">
          <span class="agg-completed">${totalCompleted}h completed</span>
          <span class="agg-pct">${aggregatePct}%</span>
          ${totalRemaining > 0 ? `<span class="agg-remaining">${totalRemaining}h needed</span>` : '<span class="agg-done">Complete</span>'}
        </div>
      </div>` : '';

    // Platform tags — show platform, hours, and course count
    const platTags = (platformByProvider[name] || [])
      .filter(pr => pr.status === 'success')
      .map(pr => {
        const slug = pr.platform === 'NetCE' ? 'netce'
                   : pr.platform === 'CEUfast' ? 'ceufast'
                   : pr.platform === 'AANP Cert' ? 'aanp'
                   : 'other';
        let detail = pr.hoursRequired !== null
          ? `${pr.hoursEarned ?? '?'}/${pr.hoursRequired} cr`
          : pr.hoursEarned !== null ? `${pr.hoursEarned} h` : '';
        if (pr.certStatus) detail += ` · ${pr.certStatus}`;
        const count = pr.courses && pr.courses.length > 0 ? ` (${pr.courses.length} courses)` : '';
        return `<span class="card-plat-tag plat-tag-${slug}">${escHtml(pr.platform)}${detail ? `: ${escHtml(detail)}` : ''}${count}</span>`;
      }).join('');
    const platTagsRow = platTags ? `<div class="card-plat-tags">${platTags}</div>` : '';

    // Unknown reason banner - show platform access badges if available
    const platformBadges = (unknownInfo?.platforms || []).map(p => {
      const slug = p === 'NetCE' ? 'netce' : p === 'CEUfast' ? 'ceufast' : p === 'AANP Cert' ? 'aanp' : 'other';
      return `<span class="access-badge access-${slug}">${escHtml(p)}</span>`;
    }).join('');

    const unknownBanner = unknownInfo ? `
      <div class="unknown-reason ${unknownInfo.cls}">
        <span class="unknown-icon">${unknownInfo.icon}</span>
        <span class="unknown-text"><strong>${escHtml(unknownInfo.reason)}</strong>${unknownInfo.platforms?.length ? '' : ' — ' + escHtml(unknownInfo.detail)}</span>
        ${platformBadges ? `<div class="access-badges">${platformBadges}</div>` : ''}
      </div>` : '';

    return `<div class="provider-card ${cardBorderCls} ${criticalCls} card-clickable"
        data-provider="${escHtml(name)}"
        data-name="${escHtml(name)}"
        data-status="${worstStatus}"
        data-states="${escHtml(statesList)}"
        data-deadline="${earliestDeadline}"
        data-type="${escHtml(info.type || '')}"
        data-completed="${info.licenses?.[0]?.hoursCompleted || 0}"
        data-required="${info.licenses?.[0]?.hoursRequired || 0}"
        data-remaining="${info.licenses?.[0]?.hoursRemaining || 0}"
        data-no-creds="${noCredentialsProviders.includes(name) || noCEBrokerList.includes(name)}"
        onclick="openProvider(this.dataset.provider)">
      ${unknownBanner}
      <div class="card-top">
        <input type="checkbox" class="bulk-select-cb" onclick="event.stopPropagation(); updateBulkSelection()" title="Select for bulk export">
        <button class="pin-btn" data-provider="${escHtml(name)}" onclick="event.stopPropagation(); togglePinProvider('${escHtml(name).replace(/'/g, '&#39;')}', event)" title="Pin provider">☆</button>
        <div class="avatar" style="background:${
        worstStatus === 'Complete'    ? '#10b981'
      : worstStatus === 'In Progress' ? '#f59e0b'
      : worstStatus === 'At Risk'     ? '#ef4444'
      : worstStatus === 'Platform'    ? '#3b82f6'
      : unknownInfo?.cls === 'unknown-error' ? '#dc2626'
      :                                  '#64748b'
      }">${escHtml(initials)}</div>
        <div class="card-info">
          <div class="card-name">${escHtml(name)}</div>
          <div class="card-states">${stateChips}</div>
        </div>
        <div class="card-lic-count">${isPlatformOnly && hasPlatformData ? `${platformTotals.platformCount} platform${platformTotals.platformCount !== 1 ? 's' : ''}` : `${info.licenses.length} license${info.licenses.length !== 1 ? 's' : ''}`} <span class="card-arrow">›</span></div>
      </div>
      ${aggProgressHtml}
      <div class="lic-blocks">${licBadges}</div>
      ${platTagsRow}
    </div>`;
  };

  // ── Coverage gaps (no CE Broker and/or no platform credentials) ──────────
  // Moved up so these lists are available when building provider cards
  const noCEBrokerList = (runResults || [])
    .filter(r => r.status === 'not_configured')
    .map(r => r.name);
  const withPlatforms = new Set(platformData.map(p => p.providerName));
  const noPlatformList = Object.keys(providerMap).filter(name => !withPlatforms.has(name) && noCEBrokerList.includes(name));
  const noCredentialsList = noCEBrokerList.filter(name => noPlatformList.includes(name));

  // ── Credential Gaps Analysis ───────────────────────────────────────────────
  const missingCEBroker = providers
    .filter(p => !p.username || !p.password)
    .map(p => ({ name: p.name, type: p.type, noCredentials: p.noCredentials === true }));

  const missingNetCE = providers
    .filter(p => !p.platforms?.some(plat => plat.platform === 'NetCE'))
    .map(p => ({ name: p.name, type: p.type, noCredentials: p.noCredentials === true }));

  const haveBoth = providers
    .filter(p => p.username && p.password && p.platforms?.some(plat => plat.platform === 'NetCE'))
    .map(p => ({ name: p.name, type: p.type }));

  // ── Credential Categories for Filtering ───────────────────────────────────
  // CE Broker Only: Have CE Broker credentials but no platform credentials
  const ceBrokerOnly = providers
    .filter(p => p.username && p.password && (!p.platforms || p.platforms.length === 0))
    .map(p => ({ name: p.name, type: p.type }));

  // Platform Only: Have platform credentials but no CE Broker
  const platformOnly = providers
    .filter(p => (!p.username || !p.password) && p.platforms && p.platforms.length > 0 && p.noCredentials !== true)
    .map(p => ({ name: p.name, type: p.type, platforms: p.platforms.map(pl => pl.platform) }));

  // Both: Have CE Broker AND at least one platform
  const haveCEBrokerAndPlatform = providers
    .filter(p => p.username && p.password && p.platforms && p.platforms.length > 0)
    .map(p => ({ name: p.name, type: p.type, platforms: p.platforms.map(pl => pl.platform) }));

  // No Credentials: Marked as noCredentials or truly have nothing
  const noCredsAtAll = providers
    .filter(p => p.noCredentials === true || ((!p.username || !p.password) && (!p.platforms || p.platforms.length === 0)))
    .map(p => ({ name: p.name, type: p.type }));

  // Accounts with no activity: Have credentials but never successfully logged in
  const accountsNoActivity = healthSummary.credentials
    .filter(c => c.lastSuccess === null && c.consecutiveFailures > 0)
    .map(c => ({
      providerName: c.providerName,
      platform: c.platform,
      failures: c.consecutiveFailures,
      lastError: c.lastError
    }));

  // Providers with credentials but no course history (unused credentials)
  const providersWithCreds = providers.filter(p =>
    (p.username && p.password) || (p.platforms && p.platforms.length > 0)
  );
  const hasCredentialsNoCourses = providersWithCreds
    .filter(p => {
      const history = courseHistory[p.name];
      const hasCourses = history && history.courses && history.courses.length > 0;
      return !hasCourses;
    })
    .map(p => ({
      name: p.name,
      type: p.type,
      hasCEBroker: !!(p.username && p.password),
      platforms: p.platforms ? p.platforms.map(pl => pl.platform) : []
    }));

  // Providers with no CEU history at all (regardless of credential status)
  const noCEUHistory = providers
    .filter(p => {
      const history = courseHistory[p.name];
      return !history || !history.courses || history.courses.length === 0;
    })
    .map(p => ({
      name: p.name,
      type: p.type,
      hasCredentials: (p.username && p.password) || (p.platforms && p.platforms.length > 0),
      noCredentials: p.noCredentials === true
    }));

  // ── Split providers into clinicians and RNs ──────────────────────────────
  const providerEntries = Object.entries(providerMap);
  const clinicianEntries = providerEntries.filter(([name, info]) => !isRN(name, info.type));
  const rnEntries = providerEntries.filter(([name, info]) => isRN(name, info.type));

  const clinicianCards = clinicianEntries.map(buildProviderCard).join('');
  const rnCards = rnEntries.map(buildProviderCard).join('');

  // ── Lazy Loading: Store individual cards for progressive rendering ──────
  const LAZY_BATCH_SIZE = 20;
  const allCardHtmlArray = providerEntries.map(buildProviderCard);
  const initialCards = allCardHtmlArray.slice(0, LAZY_BATCH_SIZE).join('');
  const profileCards = allCardHtmlArray.join(''); // Keep for backward compat (used in deadline/state views)

  // ── Timeline Data Generation with Persistent Course History ────────────────
  // 1. Extract courses from current scrape
  const currentScrapeCourses = {};
  for (const [name, info] of providerEntries) {
    const providerData = {
      type: info.type,
      courses: [],
      deadlines: []
    };
    for (const lic of info.licenses) {
      // Add deadline
      if (lic.renewalDeadline) {
        const dlDate = parseDate(lic.renewalDeadline);
        if (dlDate) {
          providerData.deadlines.push({
            date: dlDate.toISOString().split('T')[0],
            state: lic.state,
            licenseType: lic.licenseType || info.type
          });
        }
      }
      // Add courses
      for (const course of (lic.completedCourses || [])) {
        if (course.date) {
          let courseDate = parseDate(course.date);
          if (courseDate) {
            providerData.courses.push({
              date: courseDate.toISOString().split('T')[0],
              name: course.name || 'Course',
              hours: course.hours || 0,
              state: lic.state,
              scrapedAt: new Date().toISOString().split('T')[0]
            });
          }
        }
      }
    }
    if (providerData.courses.length > 0 || providerData.deadlines.length > 0) {
      currentScrapeCourses[name] = providerData;
    }
  }

  // 1b. Add platform courses with cost data
  for (const pr of platformData) {
    if (pr.status !== 'success' || !pr.courses) continue;

    const providerName = pr.providerName;
    if (!currentScrapeCourses[providerName]) {
      currentScrapeCourses[providerName] = {
        type: providers.find(p => p.name === providerName)?.type || 'Unknown',
        courses: [],
        deadlines: []
      };
    }

    // Add platform courses with cost info
    for (const course of pr.courses) {
      if (course.date) {
        const courseDate = parseDate(course.date);
        if (courseDate) {
          currentScrapeCourses[providerName].courses.push({
            date: courseDate.toISOString().split('T')[0],
            name: course.name || course.title || 'Course',
            hours: course.hours || course.credits || 0,
            platform: pr.platform,
            cost: course.cost || null,
            scrapedAt: new Date().toISOString().split('T')[0]
          });
        }
      }
    }

    // Store total spent from platform if available
    if (pr.totalSpent) {
      currentScrapeCourses[providerName].platformSpend = currentScrapeCourses[providerName].platformSpend || {};
      currentScrapeCourses[providerName].platformSpend[pr.platform] = pr.totalSpent;
    }
  }

  // 2. Load existing course history and merge with current scrape
  const existingHistory = loadCourseHistory();
  const mergedHistory = mergeCourseHistory(existingHistory, currentScrapeCourses);

  // 3. Save merged history
  saveCourseHistory(mergedHistory);

  // 4. Build timeline data from merged history
  const timelineData = Object.entries(mergedHistory).map(([name, data]) => ({
    name,
    type: data.type,
    courses: data.courses || [],
    deadlines: data.deadlines || []
  }));

  // Sort providers by number of courses descending
  timelineData.sort((a, b) => b.courses.length - a.courses.length);

  // ── Summary table rows ───────────────────────────────────────────────────
  const rows = flat.map(rec => {
    const status     = getS(rec);
    const state      = rec.state || '';
    const licType    = rec.licenseType || rec.providerType || '';
    const deadline   = parseDate(rec.renewalDeadline);
    const days       = daysUntil(deadline);
    const courseUrl  = courseSearchUrl(state, licType);

    const statusClass = { Complete: 'status-complete', 'At Risk': 'status-risk', 'In Progress': 'status-progress', Unknown: 'status-unknown' }[status] || 'status-unknown';
    const statusBadge = { Complete: '✓ Complete', 'At Risk': '⚠ At Risk', 'In Progress': '◷ In Progress', Unknown: '— Unknown' }[status] || status;

    const daysLabel = days !== null
      ? (days < 0 ? `<span class="overdue">${Math.abs(days)}d overdue</span>`
        : days <= 60 ? `<span class="urgent">${days}d</span>`
        : `${days}d`)
      : '—';

    const hoursBar  = buildHoursBar(rec.hoursCompleted, rec.hoursRequired);

    // Subject-area detail rows
    const subjectRows = (rec.subjectAreas || []).length > 0
      ? rec.subjectAreas.map(sa => {
          const saRem    = (sa.hoursRequired != null && sa.hoursCompleted != null) ? Math.max(0, sa.hoursRequired - sa.hoursCompleted) : null;
          const saStatus = getStatus(saRem, null);
          const saClass  = { Complete: 'sa-ok', 'In Progress': 'sa-prog', 'At Risk': 'sa-risk', Unknown: 'sa-unk' }[saStatus] || 'sa-unk';
          return `<tr class="detail-row">
            <td colspan="2" class="sa-indent">${escHtml(sa.topicName || '')}</td>
            <td class="center">${sa.hoursRequired ?? '—'}</td>
            <td class="center">${sa.hoursCompleted ?? '—'}</td>
            <td colspan="3" class="center"><span class="sa-badge ${saClass}">${saStatus}</span></td>
          </tr>`;
        }).join('')
      : '';

    const toggleId  = `detail-${slugify(rec.providerName)}-${state}`;
    const toggleBtn = subjectRows
      ? `<button class="toggle-btn" onclick="toggleDetail('${toggleId}')">▸ Details</button>`
      : '';

    return `<tr class="summary-row" data-status="${status}" data-provider="${escHtml(rec.providerName)}">
      <td>${escHtml(rec.providerName || '—')}</td>
      <td class="center">${escHtml(licType)}</td>
      <td class="center">${escHtml(state) || '—'}</td>
      <td class="center">${escHtml(rec.renewalDeadline || '—')}<br><small class="days-label">${daysLabel}</small></td>
      <td class="center">${hoursBar}</td>
      <td class="center"><span class="status-badge ${statusClass}">${statusBadge}</span></td>
      <td class="center">
        ${courseUrl ? `<a class="course-link" href="${courseUrl}" target="_blank" rel="noopener">Search ↗</a>` : '—'}
        ${toggleBtn}
      </td>
    </tr>
    <tbody id="${toggleId}" class="detail-group hidden">${subjectRows}</tbody>`;
  }).join('');

  // ── Run result table ─────────────────────────────────────────────────────
  const getStatusBadge = (status) => {
    if (status === 'success') return '<span class="status-badge status-complete">✓ Success</span>';
    if (status === 'not_configured') return '<span class="status-badge status-pending">○ Not Configured</span>';
    return '<span class="status-badge status-risk">✗ Login Error</span>';
  };
  const runRows = runResults.map(r => `<tr>
    <td>${escHtml(r.name)}</td>
    <td class="center">${getStatusBadge(r.status)}</td>
    <td>${r.error ? `<span style="color:#ef4444;font-size:0.8rem">${escHtml(r.error)}</span>` : '<span style="color:#94a3b8">—</span>'}</td>
  </tr>`).join('');

  // ── Pre-compute Export Data (for embedding in JavaScript) ─────────────────
  const exportDataNoLogins = trulyNoCredentialsProviders.map(name => {
    const info = providerMap[name];
    return {
      name: name,
      type: info?.type || '',
      states: [...new Set((info?.licenses || []).map(l => l.state))].join(', ')
    };
  });
  const exportDataAtRisk = flat.filter(p => {
    const days = daysUntil(parseDate(p.renewalDeadline));
    return days !== null && days <= 60 && (p.hoursRemaining || 0) > 0;
  }).map(p => ({
    name: p.providerName,
    type: p.providerType || '',
    state: p.state || '',
    hoursRemaining: p.hoursRemaining || 0,
    renewalDeadline: p.renewalDeadline || '',
    daysUntilDeadline: daysUntil(parseDate(p.renewalDeadline)) ?? ''
  }));

  // ── Urgency List Data (sorted by priority) ─────────────────────────────────
  const urgencyList = flat.map(p => {
    const days = daysUntil(parseDate(p.renewalDeadline));
    const hoursRemaining = p.hoursRemaining || 0;
    const needsCreds = trulyNoCredentialsProviders.includes(p.providerName);
    let urgency = 'ok';
    let urgencyOrder = 99;
    if (needsCreds) {
      urgency = 'no-creds';
      urgencyOrder = 50;
    } else if (days !== null && days < 0 && hoursRemaining > 0) {
      urgency = 'overdue';
      urgencyOrder = 0;
    } else if (days !== null && days <= 14 && hoursRemaining > 0) {
      urgency = 'critical';
      urgencyOrder = 1;
    } else if (days !== null && days <= 30 && hoursRemaining > 0) {
      urgency = 'urgent';
      urgencyOrder = 2;
    } else if (days !== null && days <= 60 && hoursRemaining > 0) {
      urgency = 'warning';
      urgencyOrder = 3;
    } else if (hoursRemaining > 0) {
      urgency = 'needs-hours';
      urgencyOrder = 4;
    } else {
      urgency = 'ok';
      urgencyOrder = 99;
    }
    return {
      name: p.providerName,
      type: p.providerType || '',
      state: p.state || '',
      hoursRemaining,
      hoursRequired: p.hoursRequired || 0,
      hoursCompleted: p.hoursCompleted || 0,
      deadline: p.renewalDeadline || '',
      days: days,
      urgency,
      urgencyOrder
    };
  }).sort((a, b) => {
    if (a.urgencyOrder !== b.urgencyOrder) return a.urgencyOrder - b.urgencyOrder;
    if (a.days !== b.days) return (a.days ?? 9999) - (b.days ?? 9999);
    return a.name.localeCompare(b.name);
  });

  const urgencyNeedsAction = urgencyList.filter(p => p.urgencyOrder < 50);
  const urgencyNoCreds = urgencyList.filter(p => p.urgency === 'no-creds');

  // ── Compliance Scorecard Data ────────────────────────────────────────────
  const complianceByType = {};
  const complianceByState = {};
  for (const p of flat) {
    const type = p.providerType || 'Other';
    const state = p.state || 'Unknown';
    const status = getStatus(p.hoursRemaining, daysUntil(parseDate(p.renewalDeadline)), p.hoursRequired);
    const isCompliant = status === 'Complete';
    // By type
    if (!complianceByType[type]) complianceByType[type] = { total: 0, compliant: 0 };
    complianceByType[type].total++;
    if (isCompliant) complianceByType[type].compliant++;
    // By state
    if (!complianceByState[state]) complianceByState[state] = { total: 0, compliant: 0 };
    complianceByState[state].total++;
    if (isCompliant) complianceByState[state].compliant++;
  }
  const scorecardByType = Object.entries(complianceByType)
    .map(([type, data]) => ({ type, ...data, pct: Math.round((data.compliant / data.total) * 100) }))
    .sort((a, b) => a.pct - b.pct);
  const scorecardByState = Object.entries(complianceByState)
    .map(([state, data]) => ({ state, ...data, pct: Math.round((data.compliant / data.total) * 100) }))
    .sort((a, b) => a.pct - b.pct);
  const overallCompliance = flat.length > 0 ? Math.round((flat.filter(p => getStatus(p.hoursRemaining, daysUntil(parseDate(p.renewalDeadline)), p.hoursRequired) === 'Complete').length / flat.length) * 100) : 0;

  // ── Build 12-Month Timeline Data ───────────────────────────────────────────
  const renewalNow = new Date();
  const renewalMonthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const renewalMonths = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(renewalNow.getFullYear(), renewalNow.getMonth() + i, 1);
    renewalMonths.push({
      month: renewalMonthNames[d.getMonth()],
      year: d.getFullYear(),
      key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
      providers: []
    });
  }
  // Assign providers to their renewal months
  for (const p of flat) {
    const deadline = parseDate(p.renewalDeadline);
    if (!deadline) continue;
    const deadlineKey = deadline.getFullYear() + '-' + String(deadline.getMonth() + 1).padStart(2, '0');
    const monthObj = renewalMonths.find(m => m.key === deadlineKey);
    if (monthObj) {
      const days = daysUntil(deadline);
      const status = getStatus(p.hoursRemaining, days, p.hoursRequired);
      let urgency = 'ok';
      if (status === 'Complete') urgency = 'complete';
      else if (days !== null && days <= 14) urgency = 'critical';
      else if (days !== null && days <= 30) urgency = 'urgent';
      else if (days !== null && days <= 60) urgency = 'warning';
      else if (p.hoursRemaining > 0) urgency = 'needs';
      monthObj.providers.push({
        name: p.providerName,
        type: p.providerType || 'Unknown',
        day: deadline.getDate(),
        hours: p.hoursRemaining || 0,
        urgency,
        status
      });
    }
  }
  // Sort providers within each month by day
  for (const m of renewalMonths) {
    m.providers.sort((a, b) => a.day - b.day);
  }
  // Pre-compute timeline HTML to avoid template literal issues
  const renewalTimelineHtml = renewalMonths.map((m, idx) => {
    const isCurrentMonth = idx === 0;
    const hasProviders = m.providers.length > 0;
    const providerList = m.providers.map(p => {
      const urgCls = 'tl-' + p.urgency;
      return '<div class="tl-provider ' + urgCls + '" onclick="openProvider(\'' + escHtml(p.name).replace(/'/g, "\\'") + '\')">' +
        '<span class="tl-day">' + p.day + '</span>' +
        '<span class="tl-name">' + escHtml(p.name.split(',')[0]) + '</span>' +
        '<span class="tl-hours">' + (p.urgency === 'complete' ? '✓' : p.hours + 'h') + '</span>' +
      '</div>';
    }).join('');
    return '<div class="tl-month' + (isCurrentMonth ? ' tl-current' : '') + (hasProviders ? ' has-renewals' : '') + '">' +
      '<div class="tl-month-header">' +
        '<span class="tl-month-name">' + m.month + '</span>' +
        '<span class="tl-month-year">' + m.year + '</span>' +
        (hasProviders ? '<span class="tl-month-count">' + m.providers.length + '</span>' : '') +
      '</div>' +
      '<div class="tl-month-body">' +
        (hasProviders ? providerList : '<div class="tl-empty">No renewals</div>') +
      '</div>' +
    '</div>';
  }).join('');

  // ── Pre-compute Table View Rows ────────────────────────────────────────────
  const tableViewRows = providerEntries.map(([name, info]) => {
    const lic = info.licenses[0] || {};
    const status = getStatus(lic.hoursRemaining, daysUntil(parseDate(lic.renewalDeadline)), lic.hoursRequired);
    const pct = lic.hoursRequired > 0 ? Math.min(100, Math.round(((lic.hoursCompleted || 0) / lic.hoursRequired) * 100)) : 0;
    const days = daysUntil(parseDate(lic.renewalDeadline));
    const statusCls = status === 'Complete' ? 'tbl-complete' : status === 'At Risk' ? 'tbl-risk' : status === 'In Progress' ? 'tbl-progress' : 'tbl-unknown';
    const barCls = pct >= 100 ? 'bar-complete' : pct >= 50 ? 'bar-progress' : 'bar-low';
    const needsCreds = trulyNoCredentialsProviders.includes(name);
    const daysCls = days !== null && days <= 30 ? 'days-urgent' : days !== null && days <= 60 ? 'days-warning' : '';
    return '<tr class="' + statusCls + '" onclick="openProvider(\'' + escHtml(name).replace(/'/g, "\\'") + '\')">' +
      '<td class="tbl-name">' + escHtml(name) + '</td>' +
      '<td>' + escHtml(info.type || '—') + '</td>' +
      '<td>' + escHtml(lic.state || '—') + '</td>' +
      '<td><span class="tbl-status ' + statusCls + '">' + (needsCreds ? '🔑 Credentials Needed' : status) + '</span></td>' +
      '<td><div class="tbl-progress-wrap"><div class="tbl-bar"><div class="tbl-fill ' + barCls + '" style="width:' + pct + '%"></div></div><span class="tbl-pct">' + pct + '%</span></div></td>' +
      '<td class="tbl-hours">' + (needsCreds ? '—' : (lic.hoursRemaining || 0) + 'h') + '</td>' +
      '<td>' + escHtml(lic.renewalDeadline || '—') + '</td>' +
      '<td class="tbl-days ' + daysCls + '">' + (days !== null ? days + 'd' : '—') + '</td>' +
    '</tr>';
  }).join('');

  // ── HTML ─────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CEU Tracker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    /* ─ CSS Variables (Theme System) - Bold & Vibrant Design ─ */
    :root {
      --bg-body: #f0f4f8;
      --bg-primary: #ffffff;
      --bg-secondary: #f8fafc;
      --bg-tertiary: #e2e8f0;
      --bg-header: linear-gradient(135deg, #1e3a5f 0%, #0f172a 50%, #1e1b4b 100%);
      --bg-header-solid: #1e3a5f;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-on-dark: #ffffff;
      --text-accent: #6366f1;
      --border-color: #e2e8f0;
      --border-dark: #475569;
      --accent-primary: #6366f1;
      --accent-primary-hover: #4f46e5;
      --accent-blue: #3b82f6;
      --accent-blue-hover: #2563eb;
      --accent-purple: #8b5cf6;
      --accent-cyan: #06b6d4;
      --status-green: #10b981;
      --status-green-bg: #d1fae5;
      --status-green-gradient: linear-gradient(135deg, #10b981 0%, #059669 100%);
      --status-amber: #f59e0b;
      --status-amber-bg: #fef3c7;
      --status-amber-gradient: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      --status-red: #ef4444;
      --status-red-bg: #fee2e2;
      --status-red-gradient: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      --shadow-sm: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
      --shadow-md: 0 4px 6px rgba(0,0,0,.07), 0 2px 4px rgba(0,0,0,.06);
      --shadow-lg: 0 10px 25px rgba(0,0,0,.1), 0 6px 10px rgba(0,0,0,.08);
      --shadow-xl: 0 20px 40px rgba(0,0,0,.12), 0 8px 16px rgba(0,0,0,.08);
      --shadow-header: 0 4px 20px rgba(0,0,0,.15);
      --shadow-card-hover: 0 12px 28px rgba(99,102,241,.15), 0 4px 8px rgba(0,0,0,.08);
      --card-border-radius: 16px;
      --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
      --transition-smooth: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    [data-theme="dark"] {
      --bg-body: #0f172a;
      --bg-primary: #1e293b;
      --bg-secondary: #334155;
      --bg-tertiary: #475569;
      --bg-header: linear-gradient(135deg, #1e1b4b 0%, #0f172a 50%, #164e63 100%);
      --bg-header-solid: #1e1b4b;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-on-dark: #ffffff;
      --text-accent: #818cf8;
      --border-color: #334155;
      --border-dark: #475569;
      --accent-primary: #818cf8;
      --accent-primary-hover: #6366f1;
      --status-green-bg: rgba(16,185,129,.2);
      --status-amber-bg: rgba(245,158,11,.2);
      --status-red-bg: rgba(239,68,68,.2);
      --shadow-sm: 0 1px 3px rgba(0,0,0,.3);
      --shadow-md: 0 4px 6px rgba(0,0,0,.4);
      --shadow-lg: 0 10px 25px rgba(0,0,0,.5);
      --shadow-header: 0 4px 20px rgba(0,0,0,.4);
      --shadow-card-hover: 0 12px 28px rgba(129,140,248,.2), 0 4px 8px rgba(0,0,0,.3);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-body); color: var(--text-primary); min-height: 100vh; transition: background-color 0.3s, color 0.3s; font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

    /* ─ Header ─ */
    header {
      background: var(--bg-header);
      color: var(--text-on-dark);
      padding: 14px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      box-shadow: var(--shadow-header);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(90deg, rgba(99,102,241,0.1) 0%, transparent 50%, rgba(6,182,212,0.1) 100%);
      pointer-events: none;
    }
    header.scrolled { box-shadow: 0 4px 30px rgba(0,0,0,.25); }
    .header-brand { display: flex; align-items: center; gap: 14px; position: relative; z-index: 1; }
    .header-logo  { height: 32px; width: auto; display: block; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2)); }
    .header-divider {
      width: 2px; height: 28px; background: linear-gradient(180deg, rgba(99,102,241,0.6), rgba(6,182,212,0.6)); border-radius: 2px; flex-shrink: 0;
    }
    header h1 { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.02em; text-shadow: 0 2px 4px rgba(0,0,0,0.2); }
    header h1 span { background: linear-gradient(135deg, #818cf8, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .header-meta { text-align: right; display: flex; align-items: center; gap: 16px; position: relative; z-index: 1; }
    .last-scraped-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.6); font-weight: 500; }
    .last-scraped-value { font-size: 0.85rem; color: #f1f5f9; font-weight: 700; margin-top: 2px; }
    .last-scraped-ago { font-size: 0.7rem; color: #818cf8; margin-top: 2px; font-weight: 500; }
    .theme-toggle {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      padding: 8px 14px;
      border-radius: 10px;
      color: var(--text-on-dark);
      cursor: pointer;
      font-size: 1rem;
      transition: all var(--transition-fast);
      display: flex;
      align-items: center;
      gap: 8px;
      backdrop-filter: blur(10px);
    }
    .theme-toggle:hover {
      background: rgba(255,255,255,0.2);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .theme-toggle:active { transform: translateY(0); }
    .theme-toggle-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .run-badge { margin-top: 4px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .run-pill { padding: 4px 12px; border-radius: 99px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .run-pill.ok   { background: linear-gradient(135deg, #10b981, #059669); color: #ffffff; box-shadow: 0 2px 8px rgba(16,185,129,0.3); }
    .run-pill.notconfig { background: rgba(255,255,255,0.15); color: #e2e8f0; }
    .run-pill.fail { background: linear-gradient(135deg, #ef4444, #dc2626); color: #ffffff; box-shadow: 0 2px 8px rgba(239,68,68,0.3); }

    /* ─ Global Search ─ */
    .global-search-wrap { position: relative; }
    .global-search {
      width: 200px; padding: 10px 14px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.1);
      color: #fff; font-size: 0.85rem;
      transition: all 0.2s;
    }
    .global-search:focus {
      width: 280px; outline: none;
      border-color: var(--text-accent);
      background: rgba(255,255,255,0.15);
    }
    .global-search::placeholder { color: rgba(255,255,255,0.5); }
    .global-search-results {
      position: absolute; top: 100%; left: 0; right: 0;
      background: var(--bg-primary); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      max-height: 320px; overflow-y: auto;
      display: none; z-index: 1000; margin-top: 8px;
    }
    .global-search-results.active { display: block; }
    .search-result-item {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; cursor: pointer;
      border-bottom: 1px solid var(--border-color);
      transition: background 0.15s;
    }
    .search-result-item:last-child { border-bottom: none; }
    .search-result-item:hover { background: var(--bg-secondary); }
    .search-result-name { font-weight: 600; color: var(--text-primary); }
    .search-result-meta { font-size: 0.75rem; color: var(--text-secondary); }
    .search-result-badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
    .search-result-badge.ok { background: #d1fae5; color: #059669; }
    .search-result-badge.risk { background: #fecaca; color: #dc2626; }
    .search-result-badge.prog { background: #fef3c7; color: #d97706; }
    .search-no-results { padding: 16px; text-align: center; color: var(--text-secondary); font-size: 0.85rem; }

    /* ─ Stat cards ─ */
    .stats { display: flex; gap: 16px; padding: 24px 40px 0; flex-wrap: wrap; }
    .stat-card {
      background: var(--bg-primary);
      border-radius: var(--card-border-radius);
      padding: 20px 24px;
      min-width: 130px;
      border: none;
      box-shadow: var(--shadow-md);
      position: relative;
      overflow: hidden;
      transition: all var(--transition-smooth);
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: var(--accent-primary);
    }
    .stat-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); }
    .stat-card .num { font-size: 2rem; font-weight: 600; line-height: 1; color: var(--text-primary); }
    .stat-card .lbl { font-size: 0.875rem; letter-spacing: 0; color: var(--text-secondary); margin-top: 8px; font-weight: 500; }
    .stat-card.total::before { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
    .stat-card.total .num { background: linear-gradient(135deg, #6366f1, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .stat-card.ok::before { background: var(--status-green-gradient); }
    .stat-card.ok .num { color: var(--status-green); }
    .stat-card.prog::before { background: var(--status-amber-gradient); }
    .stat-card.prog .num { color: var(--status-amber); }
    .stat-card.risk::before { background: var(--status-red-gradient); }
    .stat-card.risk .num { color: var(--status-red); }
    .stat-card.risk { box-shadow: var(--shadow-md), 0 0 0 1px rgba(239,68,68,0.2); }
    /* Sub-label for stat cards */
    .stat-sublbl { font-size: 0.7rem; color: var(--text-secondary); opacity: 0.7; margin-top: 4px; }
    /* Needs Attention card with active risk - pulsing red border */
    .stat-card.risk.has-risk {
      background: linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0.04) 100%);
      box-shadow: var(--shadow-md), 0 0 0 2px rgba(239,68,68,0.4);
      animation: pulse-risk 2s ease-in-out infinite;
    }
    @keyframes pulse-risk {
      0%, 100% { box-shadow: var(--shadow-md), 0 0 0 2px rgba(239,68,68,0.4); }
      50% { box-shadow: var(--shadow-md), 0 0 0 4px rgba(239,68,68,0.2), 0 0 20px rgba(239,68,68,0.15); }
    }
    /* Complete card when all providers complete - celebration glow */
    .stat-card.ok.all-complete {
      background: linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(16,185,129,0.04) 100%);
      box-shadow: var(--shadow-md), 0 0 0 2px rgba(16,185,129,0.3), 0 0 20px rgba(16,185,129,0.1);
    }
    .celebration-indicator {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      background: var(--status-green);
      color: #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(16,185,129,0.4);
    }

    /* ─ Welcome Banner (Slim info bar) ─ */
    .welcome-banner {
      background: linear-gradient(90deg, #1e3a5f 0%, #1e1b4b 100%);
      color: white;
      padding: 10px 20px;
      margin: 0 0 16px 0;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
      height: 48px;
      box-shadow: var(--shadow-sm);
    }
    .welcome-icon { font-size: 1.2rem; }
    .welcome-content { flex: 1; display: flex; align-items: center; gap: 8px; }
    .welcome-title {
      font-size: 0.85rem;
      font-weight: 600;
      margin: 0;
    }
    .welcome-subtitle {
      font-size: 0.78rem;
      opacity: 0.85;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .welcome-dismiss {
      background: rgba(255,255,255,0.15);
      border: none;
      color: white;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .welcome-dismiss:hover { background: rgba(255,255,255,0.25); }

    /* ─ Quick Stats Summary ─ */
    .quick-summary {
      background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
      border: 1px solid #bae6fd;
      border-radius: 12px;
      padding: 14px 20px;
      margin-bottom: 20px;
      font-size: 0.92rem;
      color: #0c4a6e;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    [data-theme="dark"] .quick-summary {
      background: linear-gradient(135deg, #1e3a5f 0%, #1e1b4b 100%);
      border-color: #3b82f6;
      color: #e0f2fe;
    }
    .quick-summary-icon { font-size: 1.3rem; }
    .quick-summary-text { flex: 1; line-height: 1.5; }
    .quick-summary-text strong { font-weight: 700; }
    .quick-summary-highlight {
      color: #059669;
      font-weight: 700;
    }
    .quick-summary-warning {
      color: #dc2626;
      font-weight: 700;
    }

    /* ─ Status Legend ─ */
    .status-legend {
      display: flex;
      gap: 16px;
      padding: 12px 20px;
      background: var(--bg-secondary);
      border-radius: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
    }
    .legend-title {
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .legend-dot.green { background: var(--status-green); }
    .legend-dot.yellow { background: var(--status-amber); }
    .legend-dot.red { background: var(--status-red); }
    .legend-dot.gray { background: #94a3b8; }

    /* ─ Tooltips ─ */
    .has-tooltip {
      position: relative;
      cursor: help;
    }
    .tooltip {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: #1e293b;
      color: white;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 500;
      white-space: nowrap;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s, visibility 0.15s;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .tooltip::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-top-color: #1e293b;
    }
    .has-tooltip:hover .tooltip {
      opacity: 1;
      visibility: visible;
    }

    /* ─ Getting Started Card ─ */
    .getting-started {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      border: 1px solid #fbbf24;
      border-radius: var(--card-border-radius);
      padding: 20px 24px;
      margin-bottom: 20px;
    }
    [data-theme="dark"] .getting-started {
      background: linear-gradient(135deg, #78350f 0%, #92400e 100%);
      border-color: #f59e0b;
    }
    .getting-started-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .getting-started-icon { font-size: 1.3rem; }
    .getting-started-title {
      font-size: 0.95rem;
      font-weight: 700;
      color: #92400e;
    }
    [data-theme="dark"] .getting-started-title { color: #fef3c7; }
    .getting-started-steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }
    .getting-started-step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 0.85rem;
      color: #78350f;
    }
    [data-theme="dark"] .getting-started-step { color: #fef3c7; }
    .step-number {
      background: #92400e;
      color: white;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      font-weight: 700;
      flex-shrink: 0;
    }
    .getting-started-dismiss {
      background: none;
      border: none;
      color: #92400e;
      font-size: 0.75rem;
      cursor: pointer;
      margin-top: 12px;
      text-decoration: underline;
    }
    [data-theme="dark"] .getting-started-dismiss { color: #fef3c7; }

    /* ─ Nav Descriptions ─ */
    .nav-label-wrap { flex: 1; display: flex; flex-direction: column; align-items: flex-start; }
    .nav-desc {
      font-size: 0.65rem;
      color: var(--text-secondary);
      opacity: 0.8;
      margin-top: 2px;
      font-weight: 400;
    }
    .nav-item.active .nav-desc { color: rgba(255,255,255,0.75); }
    .sidebar.collapsed .nav-desc { display: none; }
    .sidebar.collapsed .nav-label-wrap { align-items: center; }

    /* ─ Missing Credentials Section ─ */
    .missing-creds-section {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      border: 2px solid #f59e0b;
      border-radius: var(--card-border-radius);
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    [data-theme="dark"] .missing-creds-section {
      background: linear-gradient(135deg, #78350f 0%, #92400e 100%);
      border-color: #f59e0b;
    }
    .missing-creds-header { margin-bottom: 16px; }
    .missing-creds-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.1rem;
      font-weight: 700;
      color: #92400e;
      margin-bottom: 6px;
    }
    [data-theme="dark"] .missing-creds-title { color: #fef3c7; }
    .missing-creds-icon { font-size: 1.3rem; }
    .missing-creds-count {
      background: #dc2626;
      color: white;
      padding: 2px 10px;
      border-radius: 99px;
      font-size: 0.85rem;
      font-weight: 700;
    }
    .missing-creds-subtitle {
      font-size: 0.88rem;
      color: #78350f;
      opacity: 0.9;
    }
    [data-theme="dark"] .missing-creds-subtitle { color: #fde68a; }
    .missing-creds-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
    }
    .missing-creds-item {
      background: white;
      border: 1px solid #fbbf24;
      border-radius: 10px;
      padding: 12px 16px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 200px;
    }
    [data-theme="dark"] .missing-creds-item {
      background: rgba(0,0,0,0.2);
      border-color: #f59e0b;
    }
    .missing-creds-item:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(245,158,11,0.3);
    }
    .missing-creds-item-main {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .missing-creds-name {
      font-weight: 600;
      color: #1e293b;
    }
    [data-theme="dark"] .missing-creds-name { color: #fef3c7; }
    .missing-creds-type {
      font-size: 0.75rem;
      background: #fbbf24;
      color: #78350f;
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 600;
    }
    .missing-creds-platforms {
      font-size: 0.75rem;
      color: #92400e;
      font-weight: 500;
    }
    [data-theme="dark"] .missing-creds-platforms { color: #fde68a; }
    .missing-creds-actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .missing-creds-copy-btn,
    .missing-creds-export-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 18px;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      border: none;
    }
    .missing-creds-copy-btn {
      background: #1e293b;
      color: white;
    }
    .missing-creds-copy-btn:hover {
      background: #0f172a;
      transform: translateY(-1px);
    }
    .missing-creds-export-btn {
      background: white;
      color: #78350f;
      border: 2px solid #fbbf24;
    }
    .missing-creds-export-btn:hover {
      background: #fef3c7;
    }

    /* ─ Section titles ─ */
    .section-title {
      padding: 24px 40px 12px;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-color);
    }

    /* ─ Provider cards ─ */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 20px;
      padding: 0 40px;
    }
    .provider-card {
      background: var(--bg-primary);
      border-radius: var(--card-border-radius);
      padding: 24px;
      box-shadow: var(--shadow-md);
      border: 1px solid var(--border-color);
      transition: all var(--transition-smooth);
      position: relative;
      overflow: hidden;
    }
    .provider-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--accent-primary);
      opacity: 0;
      transition: opacity var(--transition-fast);
    }
    .provider-card:hover {
      box-shadow: var(--shadow-card-hover);
      transform: translateY(-4px);
      border-color: var(--accent-primary);
    }
    .provider-card:hover::after { opacity: 1; }
    /* Status left-border accent for scannability */
    .provider-card.card-ok { border-left: 4px solid var(--status-green); }
    .provider-card.card-ok::after { background: var(--status-green-gradient); }
    .provider-card.card-ok:hover { border-color: var(--status-green); border-left-color: var(--status-green); }
    .provider-card.card-prog { border-left: 4px solid var(--status-amber); }
    .provider-card.card-prog::after { background: var(--status-amber-gradient); }
    .provider-card.card-prog:hover { border-color: var(--status-amber); border-left-color: var(--status-amber); }
    .provider-card.card-risk {
      border-left: 4px solid var(--status-red);
      border-color: var(--status-red);
      border-width: 2px;
      border-left-width: 4px;
      box-shadow: var(--shadow-md), 0 0 0 2px rgba(239,68,68,0.1);
    }
    .provider-card.card-risk::after { background: var(--status-red-gradient); opacity: 1; }
    .provider-card.card-risk.critical-deadline {
      animation: pulse-card-risk 2s ease-in-out infinite;
    }
    @keyframes pulse-card-risk {
      0%, 100% { box-shadow: var(--shadow-md), 0 0 0 2px rgba(239,68,68,0.1); }
      50% { box-shadow: var(--shadow-md), 0 0 0 4px rgba(239,68,68,0.2); }
    }
    .provider-card.card-unk { border-left: 4px solid #64748b; }
    .provider-card.card-platform::after { background: linear-gradient(135deg, #3b82f6, #06b6d4); }
    .provider-card.card-error {
      border-color: #f87171;
    }
    [data-theme="dark"] .provider-card.card-risk {
      border-color: var(--status-red);
      box-shadow: var(--shadow-md), 0 0 0 2px rgba(239,68,68,0.2);
    }

    /* Unknown reason banner */
    .unknown-reason {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 12px;
      font-size: 0.78rem;
    }
    .unknown-reason.unknown-none {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
    }
    .unknown-reason.unknown-partial {
      background: #eff6ff;
      color: #1e40af;
      border: 1px solid #bfdbfe;
    }
    [data-theme="dark"] .unknown-reason.unknown-partial {
      background: #1e3a5f;
      color: #93c5fd;
      border-color: #3b82f6;
    }
    .unknown-reason.unknown-error {
      background: var(--status-red-bg);
      color: var(--status-red);
      border: 1px solid #fecaca;
    }
    [data-theme="dark"] .unknown-reason.unknown-error {
      border-color: #991b1b;
    }
    .unknown-reason.unknown-default {
      background: var(--bg-secondary);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
    }
    .unknown-icon { font-size: 1rem; }
    .unknown-text { flex: 1; }
    .unknown-text strong { font-weight: 700; }
    .unknown-reason.unknown-pending {
      background: #fefce8;
      color: #854d0e;
      border: 1px solid #fde047;
    }
    [data-theme="dark"] .unknown-reason.unknown-pending {
      background: #422006;
      color: #fde047;
      border-color: #ca8a04;
    }

    /* Platform Access Badges */
    .access-badges { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
    .access-badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .access-badge.access-netce { background: #dbeafe; color: #1e40af; }
    .access-badge.access-ceufast { background: #ede9fe; color: #5b21b6; }
    .access-badge.access-aanp { background: #d1fae5; color: #065f46; }
    .access-badge.access-other { background: #f1f5f9; color: #475569; }
    [data-theme="dark"] .access-badge.access-netce { background: #1e3a5f; color: #93c5fd; }
    [data-theme="dark"] .access-badge.access-ceufast { background: #2e1065; color: #c4b5fd; }
    [data-theme="dark"] .access-badge.access-aanp { background: #064e3b; color: #6ee7b7; }
    [data-theme="dark"] .access-badge.access-other { background: #334155; color: #cbd5e1; }

    .card-top { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .avatar {
      width: 48px; height: 48px; border-radius: 14px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; font-weight: 700; flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(99,102,241,0.3);
    }
    .card-info { flex: 1; min-width: 0; }
    .card-name { font-weight: 800; font-size: 1.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); letter-spacing: -0.01em; }
    .card-type { font-size: 0.8rem; color: var(--text-secondary); margin-top: 3px; font-weight: 500; }
    .card-lic-count { font-size: 0.78rem; color: var(--text-secondary); white-space: nowrap; font-weight: 600; background: var(--bg-secondary); padding: 4px 10px; border-radius: 8px; }

    /* ─ License blocks inside a card ─ */
    .lic-blocks { display: flex; flex-direction: column; gap: 10px; }
    .lic-block {
      border-radius: 12px;
      padding: 14px 16px;
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      transition: all var(--transition-fast);
    }
    .lic-block:hover { background: var(--bg-tertiary); }
    .lic-block.lic-complete { border-left: 3px solid var(--status-green); }
    .lic-block.lic-progress { border-left: 3px solid var(--status-amber); }
    .lic-block.lic-risk { border-left: 3px solid var(--status-red); border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.05); }
    .lic-block.lic-platform { border-left: 3px solid var(--accent-blue); }
    [data-theme="dark"] .lic-block { border-color: #475569; background: var(--bg-secondary); }
    [data-theme="dark"] .lic-block.lic-risk { border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.1); }

    /* ─ Platform summary for platform-only providers ─ */
    .platform-summary-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      color: #3b82f6;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed #93c5fd;
    }
    .platform-icon { font-size: 1rem; }
    .platform-hours {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-top: 4px;
    }
    .platform-hours-big {
      font-size: 1.6rem;
      font-weight: 700;
      color: #1d4ed8;
    }
    .platform-hours-label {
      font-size: 0.75rem;
      color: #64748b;
    }
    .platform-courses {
      font-size: 0.72rem;
      color: #64748b;
      margin-top: 4px;
    }
    .platform-status {
      color: #10b981 !important;
      font-weight: 600;
    }
    [data-theme="dark"] .platform-summary-header { color: #60a5fa; border-bottom-color: #1d4ed8; }
    [data-theme="dark"] .platform-hours-big { color: #60a5fa; }
    .platform-creds-notice {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.75rem;
      color: #9a3412;
      background: #fed7aa;
      padding: 8px 12px;
      border-radius: 6px;
      margin-top: 10px;
    }
    .creds-notice-icon { font-weight: 700; }
    [data-theme="dark"] .platform-creds-notice { background: rgba(249, 115, 22, 0.2); color: #fdba74; }

    .lic-header { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .lic-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; cursor: help; }
    .dot-green  { background: #16a34a; }
    .dot-yellow { background: #f59e0b; }
    .dot-red    { background: #ef4444; }
    .dot-blue   { background: #3b82f6; }
    .dot-gray   { background: #94a3b8; }
    .dot-gray   { background: #94a3b8; }
    .lic-header strong { font-size: 0.9rem; }
    .lic-type   { font-size: 0.72rem; color: #64748b; background: #e2e8f0; padding: 1px 7px; border-radius: 99px; }
    /* License status badges (pill-shaped) */
    .lic-status-text {
      margin-left: auto;
      font-size: 0.68rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }
    .lic-block.lic-complete .lic-status-text { background: rgba(16,185,129,0.15); color: #059669; }
    .lic-block.lic-progress .lic-status-text { background: rgba(245,158,11,0.15); color: #d97706; }
    .lic-block.lic-risk .lic-status-text { background: rgba(239,68,68,0.15); color: #dc2626; }
    [data-theme="dark"] .lic-type { background: #475569; color: #cbd5e1; }
    [data-theme="dark"] .lic-status-text { color: #94a3b8; }
    [data-theme="dark"] .lic-header strong { color: #f1f5f9; }
    [data-theme="dark"] .deadline-label { color: #94a3b8; }

    .lic-deadline { font-size: 0.78rem; color: #475569; margin-bottom: 7px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .deadline-label { color: #64748b; }

    /* Countdown badges - minimal styling */
    .countdown-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.72rem;
      cursor: help;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }
    .countdown-badge.safe { }
    .countdown-badge.warning { color: var(--text-primary); }
    .countdown-badge.danger { background: #fee2e2; color: #991b1b; }
    .countdown-badge.overdue { background: #991b1b; color: white; }
    .countdown-badge.critical { }
    [data-theme="dark"] .countdown-badge { background: var(--bg-tertiary); }
    [data-theme="dark"] .countdown-badge.danger { background: #7f1d1d; color: #fecaca; }
    [data-theme="dark"] .countdown-badge.overdue { background: #ef4444; color: white; }

    .lic-bar-row { display: flex; align-items: center; gap: 12px; }
    .bar-track { flex: 1; height: 8px; background: var(--bg-tertiary); border-radius: 99px; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.1); }
    .bar-fill  { height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--status-green), #34d399); transition: width .4s cubic-bezier(0.4, 0, 0.2, 1); }
    .bar-fill.partial { background: linear-gradient(90deg, var(--status-amber), #fbbf24); }
    .bar-fill.low     { background: linear-gradient(90deg, var(--status-red), #f87171); }
    .bar-label { font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; font-weight: 600; min-width: 70px; }
    .bar-pct { font-size: 0.68rem; color: var(--text-secondary); margin-left: 3px; font-weight: 500; opacity: 0.8; }
    [data-theme="dark"] .bar-track { background: #334155; }
    [data-theme="dark"] .bar-label { color: #e2e8f0; }

    /* Aggregate Progress Bar (Provider Card Summary) */
    .card-agg-progress {
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-radius: 12px;
      margin: 10px 0;
      border: 1px solid var(--border-color);
    }
    .agg-bar-track {
      height: 12px;
      background: var(--bg-tertiary);
      border-radius: 99px;
      overflow: hidden;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
    }
    .agg-bar-fill {
      height: 100%;
      border-radius: 99px;
      transition: width .5s cubic-bezier(0.4, 0, 0.2, 1);
      background: linear-gradient(90deg, #64748b, #94a3b8);
      position: relative;
    }
    .agg-bar-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 50%);
    }
    .agg-bar-fill.agg-complete { background: linear-gradient(90deg, #059669, #10b981, #34d399); }
    .agg-bar-fill.agg-good { background: linear-gradient(90deg, #0d9488, #14b8a6, #2dd4bf); }
    .agg-bar-fill.agg-partial { background: linear-gradient(90deg, #d97706, #f59e0b, #fbbf24); }
    .agg-bar-fill.agg-low { background: linear-gradient(90deg, #dc2626, #ef4444, #f87171); }
    .agg-bar-stats {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
      font-size: 0.72rem;
    }
    .agg-completed { color: var(--text-secondary); font-weight: 500; }
    .agg-pct { font-weight: 700; color: var(--text-primary); font-size: 0.82rem; }
    .agg-remaining { color: var(--status-red); font-weight: 700; font-size: 0.85rem; text-shadow: 0 0 1px rgba(239,68,68,0.3); }
    .agg-done { color: var(--status-green); font-weight: 600; font-size: 0.72rem; }
    [data-theme="dark"] .card-agg-progress { background: rgba(255,255,255,0.05); border-color: var(--border-color); }
    [data-theme="dark"] .agg-bar-track { background: #1e293b; }
    [data-theme="dark"] .agg-completed { color: #94a3b8; }
    [data-theme="dark"] .agg-remaining { color: #f87171; }
    [data-theme="dark"] .agg-done { color: #34d399; }

    /* Course link - compact icon style */
    .lic-course-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      margin-top: 6px;
      font-size: 0.7rem;
      color: #64748b;
      text-decoration: none;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .lic-course-link:hover { color: #1d4ed8; border-color: #1d4ed8; background: #eff6ff; }
    .lic-course-link::before { content: '↗'; }

    /* ─ Controls ─ */
    .controls {
      padding: 20px 40px 12px;
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .search-box {
      padding: 8px 14px;
      border: 1.5px solid var(--border-color);
      border-radius: 8px;
      font-size: 0.88rem;
      width: 220px;
      outline: none;
      background: var(--bg-primary);
      color: var(--text-primary);
    }
    .search-box:focus { border-color: var(--accent-blue); }
    .search-box::placeholder { color: var(--text-secondary); }
    .filter-btn {
      padding: 7px 16px;
      border: 1.5px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-primary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.82rem;
      transition: all .15s;
    }
    .filter-btn:hover, .filter-btn.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
    .filter-select {
      padding: 7px 12px;
      border: 1.5px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 0.82rem;
      cursor: pointer;
      min-width: 140px;
    }
    .filter-select:focus { border-color: var(--accent-blue); outline: none; }
    .control-row {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .license-controls {
      flex-direction: column;
      align-items: flex-start;
    }
    .license-controls .search-box {
      width: 100%;
      max-width: 400px;
      margin-bottom: 12px;
    }
    .filter-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 40px 16px;
      font-size: 0.85rem;
      color: #64748b;
    }
    .reset-btn {
      padding: 6px 14px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: #f8fafc;
      cursor: pointer;
      font-size: 0.78rem;
      color: #475569;
      transition: all .15s;
    }
    .reset-btn:hover { background: #e2e8f0; border-color: #94a3b8; }

    /* ─ Table ─ */
    .table-wrap { padding: 0 40px 16px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.07); font-size: 0.86rem; }
    thead th { background: #1e3a8a; color: #fff; padding: 12px 16px; text-align: left; font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: .6px; white-space: nowrap; cursor: pointer; user-select: none; }
    thead th:hover { background: #2563eb; }
    thead th .sort-icon { opacity: .4; margin-left: 4px; font-size: .68rem; }
    thead th.sorted .sort-icon { opacity: 1; }
    tbody tr.summary-row { border-bottom: 1px solid #f1f5f9; transition: background .1s; }
    tbody tr.summary-row:hover { background: #f8fafc; }
    td { padding: 11px 16px; vertical-align: middle; }
    td.center { text-align: center; }
    td:first-child { font-weight: 600; color: #1e293b; }
    .days-label { color: #94a3b8; font-size: .73rem; }

    .hours-wrap { display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .hours-text { font-size: .78rem; color: #475569; white-space: nowrap; }

    .status-badge { display: inline-block; padding: 6px 14px; border-radius: 99px; font-size: .78rem; font-weight: 700; white-space: nowrap; background: var(--bg-tertiary); color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
    .status-complete { background: linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.15)); color: var(--status-green); }
    .status-progress { background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(251,191,36,0.15)); color: var(--status-amber); }
    .status-risk     { background: linear-gradient(135deg, rgba(239,68,68,0.15), rgba(248,113,113,0.15)); color: var(--status-red); }
    .status-pending  { background: var(--bg-tertiary); color: var(--text-secondary); }
    .status-unknown  { background: var(--bg-tertiary); color: var(--text-secondary); }
    .status-creds-needed { background: linear-gradient(135deg, rgba(249,115,22,0.15), rgba(251,146,60,0.15)); color: #ea580c; font-weight: 600; border: 1px solid rgba(249,115,22,0.3); }

    .data-table { width: 100%; border-collapse: collapse; margin: 0 40px 40px; max-width: calc(100% - 80px); font-size: 0.86rem; background: var(--bg-primary); border-radius: 16px; overflow: hidden; box-shadow: var(--shadow-md); }
    .data-table th, .data-table td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--border-color); }
    .data-table th { background: linear-gradient(135deg, #1e3a5f, #1e1b4b); color: #fff; font-weight: 700; cursor: pointer; white-space: nowrap; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; }
    .data-table th:hover { background: linear-gradient(135deg, #2563eb, #4f46e5); }
    .data-table tbody tr { transition: all var(--transition-fast); }
    .data-table tbody tr:hover { background: var(--bg-secondary); }
    .data-table code { background: var(--bg-tertiary); padding: 4px 8px; border-radius: 6px; font-size: 0.82rem; font-weight: 500; }
    .notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 0.82rem; }

    /* ─ Provider Table View ─ */
    .table-view-container { padding: 0 40px; overflow-x: auto; }
    .provider-table { width: 100%; border-collapse: collapse; background: var(--bg-primary); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-md); font-size: 0.85rem; }
    .provider-table th { padding: 14px 16px; text-align: left; background: linear-gradient(135deg, #1e3a5f, #1e1b4b); color: #fff; font-weight: 600; cursor: pointer; white-space: nowrap; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; }
    .provider-table th:hover { background: linear-gradient(135deg, #2563eb, #4f46e5); }
    .provider-table td { padding: 12px 16px; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
    .provider-table tbody tr { cursor: pointer; transition: background 0.1s; }
    .provider-table tbody tr:hover { background: var(--bg-secondary); }
    .provider-table tbody tr.tbl-risk { background: rgba(239,68,68,0.05); }
    .provider-table tbody tr.tbl-unknown { background: rgba(249,115,22,0.05); }
    .tbl-name { font-weight: 600; color: var(--text-primary); }
    .tbl-status { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; }
    .tbl-status.tbl-complete { background: #dcfce7; color: #16a34a; }
    .tbl-status.tbl-progress { background: #fef3c7; color: #d97706; }
    .tbl-status.tbl-risk { background: #fee2e2; color: #dc2626; }
    .tbl-status.tbl-unknown { background: #ffedd5; color: #ea580c; }
    .tbl-progress-wrap { display: flex; align-items: center; gap: 10px; }
    .tbl-bar { flex: 1; height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; min-width: 80px; }
    .tbl-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .tbl-fill.bar-complete { background: linear-gradient(90deg, #16a34a, #22c55e); }
    .tbl-fill.bar-progress { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .tbl-fill.bar-low { background: linear-gradient(90deg, #ef4444, #f87171); }
    .tbl-pct { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); min-width: 35px; }
    .tbl-hours { font-weight: 600; }
    .tbl-days { font-weight: 600; }
    .tbl-days.days-urgent { color: #dc2626; }
    .tbl-days.days-warning { color: #d97706; }

    .status-pill { display: inline-block; padding: 5px 12px; border-radius: 99px; font-size: .75rem; font-weight: 700; background: var(--bg-tertiary); color: var(--text-secondary); }
    .status-pill.complete { background: var(--status-green-bg); color: var(--status-green); }
    .status-pill.warning { background: var(--status-amber-bg); color: var(--status-amber); }
    .status-pill.at-risk { background: var(--status-red-bg); color: var(--status-red); }
    .status-pill.expired { background: #e5e7eb; color: #374151; }
    .status-pill.in-progress { background: rgba(59,130,246,0.15); color: var(--accent-blue); }

    .section-subtitle { font-size: 1.1rem; font-weight: 600; color: #1e293b; padding: 0 40px 16px; }

    .course-link { display: inline-block; padding: 4px 10px; background: #eff6ff; color: #1d4ed8; border-radius: 6px; font-size: .76rem; text-decoration: none; font-weight: 500; }
    .course-link:hover { background: #dbeafe; }
    .toggle-btn { display: inline-block; margin-left: 6px; padding: 3px 8px; background: #f1f5f9; color: #475569; border: none; border-radius: 6px; font-size: .73rem; cursor: pointer; }
    .toggle-btn:hover { background: #e2e8f0; }

    .detail-group.hidden { display: none; }
    .detail-row td { background: #f8fafc; color: #475569; font-size: .8rem; }
    .sa-indent { padding-left: 40px !important; font-style: italic; }
    .sa-badge  { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: .7rem; font-weight: 600; }
    .sa-ok   { background: #dcfce7; color: #059669; }
    .sa-prog { background: #fef3c7; color: #d97706; }
    .sa-risk { background: #fee2e2; color: #dc2626; }
    .sa-unk  { background: #f1f5f9; color: #64748b; }

    tr.hidden-row { display: none; }

    /* ─ Run log table ─ */
    .run-table-wrap { padding: 0 40px 40px; overflow-x: auto; }
    .run-table-wrap table { font-size: 0.84rem; }

    /* ─ Quick Filters ─ */
    .quick-filters { display: flex; gap: 10px; padding: 16px 40px; flex-wrap: wrap; align-items: center; }
    .quick-filter-label { font-size: 0.78rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-right: 6px; }
    .quick-filter-btn { padding: 8px 18px; border: 2px solid var(--border-color); border-radius: 99px; background: var(--bg-primary); color: var(--text-secondary); font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all var(--transition-fast); display: inline-flex; align-items: center; gap: 8px; box-shadow: var(--shadow-sm); }
    .quick-filter-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); transform: translateY(-2px); box-shadow: var(--shadow-md); }
    .quick-filter-btn.active { background: linear-gradient(135deg, var(--accent-primary), var(--accent-purple)); color: #fff; border-color: transparent; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
    .quick-filter-btn .qf-count { background: rgba(0,0,0,0.1); padding: 3px 8px; border-radius: 99px; font-size: 0.72rem; font-weight: 700; }
    .quick-filter-btn.active .qf-count { background: rgba(255,255,255,0.25); }
    .quick-filter-btn.qf-urgent { border-color: var(--status-red); color: var(--status-red); }
    .quick-filter-btn.qf-urgent:hover, .quick-filter-btn.qf-urgent.active { background: var(--status-red-gradient); color: #fff; border-color: transparent; box-shadow: 0 4px 12px rgba(239,68,68,0.3); }

    /* ─ Keyboard Shortcuts ─ */
    .keyboard-help { position: fixed; bottom: 20px; right: 20px; z-index: 90; }
    .keyboard-help-btn { width: 36px; height: 36px; border-radius: 8px; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-secondary); cursor: pointer; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow-sm); }
    .keyboard-help-btn:hover { background: var(--bg-secondary); }
    .keyboard-modal { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--bg-primary); border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 1001; min-width: 320px; }
    .keyboard-modal.open { display: block; }
    .keyboard-modal h3 { font-size: 1rem; font-weight: 700; margin-bottom: 16px; color: var(--text-primary); }
    .keyboard-shortcut { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-color); }
    .keyboard-shortcut:last-child { border-bottom: none; }
    .shortcut-key { display: inline-flex; gap: 4px; }
    .shortcut-key kbd { background: var(--bg-tertiary); padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 0.8rem; border: 1px solid var(--border-color); }
    .shortcut-desc { color: var(--text-secondary); font-size: 0.85rem; }
    .keyboard-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; }
    .keyboard-overlay.open { display: block; }

    /* ─ Provider Notes ─ */
    .provider-note { margin-top: 12px; padding: 10px 12px; background: #fefce8; border: 1px solid #fef08a; border-radius: 8px; font-size: 0.82rem; color: #854d0e; }
    .provider-note-icon { margin-right: 6px; }
    [data-theme="dark"] .provider-note { background: #422006; border-color: #854d0e; color: #fef08a; }
    .note-editor { margin-top: 12px; }
    .note-editor textarea { width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 8px; font-size: 0.85rem; resize: vertical; min-height: 60px; background: var(--bg-primary); color: var(--text-primary); }
    .note-editor-actions { display: flex; gap: 8px; margin-top: 8px; }
    .note-btn { padding: 6px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; border: none; }
    .note-btn-save { background: var(--accent-primary); color: #fff; }
    .note-btn-cancel { background: var(--bg-tertiary); color: var(--text-secondary); }

    /* ─ Compliance Score ─ */
    .compliance-score-card { background: var(--bg-primary); border-radius: 12px; padding: 20px; border: 1px solid var(--border-color); margin-bottom: 20px; }
    .compliance-score-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .compliance-score-title { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; }
    .compliance-score-value { font-size: 2.5rem; font-weight: 700; }
    .compliance-score-value.score-good { color: var(--status-green); }
    .compliance-score-value.score-warning { color: var(--status-amber); }
    .compliance-score-value.score-bad { color: var(--status-red); }
    .compliance-breakdown { display: flex; gap: 16px; flex-wrap: wrap; }
    .compliance-breakdown-item { flex: 1; min-width: 100px; text-align: center; padding: 12px; background: var(--bg-secondary); border-radius: 8px; }
    .compliance-breakdown-num { font-size: 1.4rem; font-weight: 700; }
    .compliance-breakdown-label { font-size: 0.72rem; color: var(--text-secondary); text-transform: uppercase; }

    /* ─ Trend Chart ─ */
    .trend-chart-container { background: var(--bg-primary); border-radius: 12px; padding: 20px; border: 1px solid var(--border-color); margin-bottom: 20px; }
    .trend-chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .trend-chart-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
    .trend-chart-controls { display: flex; gap: 8px; }
    .trend-chart-controls select { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.8rem; background: var(--bg-primary); color: var(--text-primary); }
    .trend-chart { height: 200px; display: flex; align-items: flex-end; gap: 4px; padding-top: 20px; }
    .trend-bar { flex: 1; background: var(--accent-primary); border-radius: 4px 4px 0 0; min-height: 4px; position: relative; transition: height 0.3s; }
    .trend-bar:hover { opacity: 0.8; }
    .trend-bar-label { position: absolute; bottom: -20px; left: 50%; transform: translateX(-50%); font-size: 0.65rem; color: var(--text-secondary); white-space: nowrap; }
    .trend-bar-value { position: absolute; top: -18px; left: 50%; transform: translateX(-50%); font-size: 0.7rem; font-weight: 600; color: var(--text-primary); }

    /* ─ Calendar Export ─ */
    .calendar-export-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 0.82rem; cursor: pointer; transition: all 0.15s; }
    .calendar-export-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .calendar-export-btn svg { width: 16px; height: 16px; }

    /* ─ Print Compliance Report ─ */
    .print-report-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 0.82rem; cursor: pointer; }
    .print-report-btn:hover { border-color: var(--accent-primary); }
    @media print {
      .quick-filters, .keyboard-help, .sidebar, header, .providers-filter-bar, .bulk-controls, footer { display: none !important; }
      .main-content { margin-left: 0 !important; }
      .provider-card { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ddd !important; box-shadow: none !important; }
      .cards-grid { gap: 12px; }
      body { background: #fff !important; color: #000 !important; font-size: 11pt; }
      .print-header { display: block !important; text-align: center; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #000; }
      .print-header h1 { font-size: 18pt; margin: 0; }
      .print-header p { font-size: 10pt; color: #666; margin: 4px 0 0; }
    }
    .print-header { display: none; }

    /* ─ Course Recommendations ─ */
    .course-recommendations { margin-top: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; }
    .course-rec-title { font-size: 0.8rem; font-weight: 600; color: #1e40af; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .course-rec-list { display: flex; flex-direction: column; gap: 6px; }
    .course-rec-item { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #1e3a8a; }
    .course-rec-item a { color: #1d4ed8; text-decoration: none; }
    .course-rec-item a:hover { text-decoration: underline; }
    [data-theme="dark"] .course-recommendations { background: #1e3a5f; border-color: #1d4ed8; }
    [data-theme="dark"] .course-rec-title { color: #93c5fd; }
    [data-theme="dark"] .course-rec-item { color: #bfdbfe; }

    /* ─ Action Items Banner ─ */
    .action-banner {
      margin: 20px 40px;
      background: linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 100%);
      border-radius: 16px;
      padding: 20px 24px;
      box-shadow: var(--shadow-md);
      border: 1px solid var(--border-color);
    }
    .action-banner-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .action-banner-title {
      font-size: 1.1rem;
      font-weight: 800;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .action-banner-title-icon {
      font-size: 1.3rem;
    }
    .action-banner-dismiss {
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 1.2rem;
      padding: 4px 8px;
      border-radius: 6px;
      transition: all var(--transition-fast);
    }
    .action-banner-dismiss:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }
    .action-banner-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .action-item-card {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 16px;
      background: var(--bg-primary);
      border-radius: 12px;
      border-left: 4px solid var(--accent-primary);
      transition: all var(--transition-fast);
      cursor: pointer;
    }
    .action-item-card:hover {
      transform: translateX(4px);
      box-shadow: var(--shadow-md);
    }
    .action-item-card.action-critical {
      border-left-color: var(--status-red);
      background: linear-gradient(135deg, rgba(239,68,68,0.05) 0%, var(--bg-primary) 100%);
    }
    .action-item-card.action-warning {
      border-left-color: var(--status-amber);
      background: linear-gradient(135deg, rgba(245,158,11,0.05) 0%, var(--bg-primary) 100%);
    }
    .action-item-card.action-info {
      border-left-color: var(--accent-blue);
      background: linear-gradient(135deg, rgba(59,130,246,0.05) 0%, var(--bg-primary) 100%);
    }
    .action-item-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
      flex-shrink: 0;
    }
    .action-critical .action-item-icon {
      background: linear-gradient(135deg, rgba(239,68,68,0.15) 0%, rgba(239,68,68,0.05) 100%);
    }
    .action-warning .action-item-icon {
      background: linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(245,158,11,0.05) 100%);
    }
    .action-info .action-item-icon {
      background: linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.05) 100%);
    }
    .action-item-content {
      flex: 1;
      min-width: 0;
    }
    .action-item-label {
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .action-item-value {
      font-size: 1.4rem;
      font-weight: 800;
      line-height: 1;
    }
    .action-critical .action-item-value { color: var(--status-red); }
    .action-warning .action-item-value { color: var(--status-amber); }
    .action-info .action-item-value { color: var(--accent-blue); }
    .action-item-detail {
      font-size: 0.78rem;
      color: var(--text-secondary);
      margin-top: 6px;
    }
    .action-item-providers {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .action-provider-chip {
      font-size: 0.72rem;
      padding: 3px 8px;
      background: var(--bg-secondary);
      border-radius: 6px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    .action-banner-empty {
      text-align: center;
      padding: 24px;
      color: var(--text-secondary);
    }
    .action-banner-empty-icon {
      font-size: 2.5rem;
      margin-bottom: 8px;
      opacity: 0.5;
    }
    .action-banner-empty-text {
      font-size: 0.95rem;
      font-weight: 600;
    }
    .action-banner.all-clear {
      background: linear-gradient(135deg, rgba(16,185,129,0.1) 0%, var(--bg-primary) 100%);
      border-color: var(--status-green);
    }
    /* Collapsed action badge */
    .action-banner-wrap { position: relative; }
    .action-badge-collapsed {
      display: none;
      margin: 12px 40px;
      padding: 10px 16px;
      background: linear-gradient(135deg, rgba(239,68,68,0.1) 0%, var(--bg-primary) 100%);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
      align-items: center;
      gap: 10px;
    }
    .action-badge-collapsed:hover {
      background: linear-gradient(135deg, rgba(239,68,68,0.15) 0%, var(--bg-primary) 100%);
      border-color: rgba(239,68,68,0.5);
    }
    .action-badge-icon { font-size: 1rem; }
    .action-badge-text { font-size: 0.82rem; font-weight: 600; color: var(--status-red); flex: 1; }
    .action-badge-expand { font-size: 0.75rem; color: var(--text-secondary); padding: 4px 10px; background: var(--bg-secondary); border-radius: 6px; }
    .action-banner-wrap.collapsed .action-banner { display: none; }
    .action-banner-wrap.collapsed .action-badge-collapsed { display: flex; }
    [data-theme="dark"] .action-item-card {
      background: var(--bg-secondary);
    }
    [data-theme="dark"] .action-item-card.action-critical {
      background: linear-gradient(135deg, rgba(239,68,68,0.1) 0%, var(--bg-secondary) 100%);
    }
    [data-theme="dark"] .action-item-card.action-warning {
      background: linear-gradient(135deg, rgba(245,158,11,0.1) 0%, var(--bg-secondary) 100%);
    }
    [data-theme="dark"] .action-item-card.action-info {
      background: linear-gradient(135deg, rgba(59,130,246,0.1) 0%, var(--bg-secondary) 100%);
    }

    /* ─ Footer ─ */
    footer { text-align: center; padding: 16px; font-size: .76rem; color: var(--text-secondary); border-top: 1px solid var(--border-color); margin-top: 8px; background: var(--bg-primary); }
    .footer-updates { margin-bottom: 8px; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 16px; align-items: center; }
    .footer-updates-title { font-weight: 700; color: var(--text-primary); }
    .footer-update-item { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--bg-secondary); border-radius: 6px; border: 1px solid var(--border-color); }
    .footer-update-date { font-weight: 600; color: var(--accent-blue); font-size: 0.7rem; }
    .footer-meta { opacity: 0.8; }

    /* ─ Updates Section ─ */
    .updates-section {
      max-width: 900px;
      margin: 40px auto 20px;
      padding: 0 24px;
    }
    .updates-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--accent-blue);
    }
    .updates-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    .updates-icon {
      font-size: 1.4rem;
    }
    .update-item {
      background: var(--bg-secondary);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 12px;
      border-left: 4px solid var(--accent-blue);
    }
    .update-item.new {
      border-left-color: var(--status-green);
    }
    .update-item.removed {
      border-left-color: var(--status-red);
    }
    .update-item.changed {
      border-left-color: var(--status-amber);
    }
    .update-date {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .update-title {
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .update-desc {
      font-size: 0.88rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .update-badge {
      display: inline-block;
      font-size: 0.68rem;
      padding: 2px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 600;
      margin-right: 8px;
    }
    .update-badge.new { background: var(--status-green-bg); color: var(--status-green); }
    .update-badge.removed { background: var(--status-red-bg); color: var(--status-red); }
    .update-badge.changed { background: var(--status-amber-bg); color: var(--status-amber); }

    /* ─ Sidebar Navigation ─ */
    .app-layout { display: flex; min-height: calc(100vh - 60px); }
    .sidebar {
      position: fixed;
      top: 60px;
      left: 0;
      width: 200px;
      height: calc(100vh - 60px);
      background: var(--bg-primary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      z-index: 90;
      transition: all var(--transition-smooth);
      box-shadow: 2px 0 10px rgba(0,0,0,0.03);
    }
    .sidebar-nav { flex: 1; padding: 16px 10px; overflow-y: auto; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 12px 16px;
      border: none;
      border-radius: 12px;
      background: none;
      cursor: pointer;
      font-size: 0.88rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-align: left;
      transition: all var(--transition-fast);
      margin-bottom: 4px;
      position: relative;
    }
    .nav-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 0;
      background: var(--accent-primary);
      border-radius: 0 3px 3px 0;
      transition: height var(--transition-fast);
    }
    .nav-item:hover { background: var(--bg-secondary); color: var(--text-primary); }
    .nav-item:hover::before { height: 60%; }
    .nav-item.active { background: linear-gradient(135deg, var(--accent-primary), var(--accent-purple)); color: #fff; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
    .nav-item.active::before { display: none; }
    .nav-icon { font-size: 1.1rem; width: 24px; text-align: center; }
    .nav-label { flex: 1; }
    .nav-badge { font-size: 0.7rem; padding: 3px 8px; border-radius: 99px; background: var(--bg-tertiary); font-weight: 700; }
    .nav-item.active .nav-badge { background: rgba(255,255,255,.25); }
    .nav-badge.warn { background: var(--status-red); color: #fff; box-shadow: 0 2px 6px rgba(239,68,68,0.3); }
    .sidebar-footer { padding: 14px; border-top: 1px solid var(--border-color); }
    .sidebar-stats { display: flex; gap: 10px; }
    .sidebar-stat { flex: 1; text-align: center; padding: 12px 10px; background: var(--bg-secondary); border-radius: 12px; transition: all var(--transition-fast); border: 1px solid var(--border-color); }
    .sidebar-stat:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
    .sidebar-stat.warn { background: linear-gradient(135deg, rgba(239,68,68,0.15) 0%, rgba(239,68,68,0.05) 100%); border-color: rgba(239,68,68,0.3); }
    .sidebar-stat.warn.has-risk { animation: pulse-sidebar-risk 2s ease-in-out infinite; }
    @keyframes pulse-sidebar-risk {
      0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
      50% { box-shadow: 0 0 0 4px rgba(239,68,68,0.2); }
    }
    .sidebar-stat-num { display: block; font-size: 1.5rem; font-weight: 800; color: var(--text-primary); line-height: 1; }
    .sidebar-stat.warn .sidebar-stat-num { color: var(--status-red); }
    .sidebar-stat-label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; margin-top: 4px; }
    .main-content { flex: 1; margin-left: 200px; min-width: 0; transition: margin-left var(--transition-smooth); }

    /* ─ Sidebar Collapse Toggle ─ */
    .sidebar-collapse-btn {
      position: absolute;
      top: 8px;
      right: -12px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      color: var(--text-secondary);
      z-index: 100;
      transition: all 0.2s;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .sidebar-collapse-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }

    /* Collapsed Sidebar State */
    .sidebar.collapsed { width: 80px; }
    .sidebar.collapsed .nav-item {
      flex-direction: column;
      justify-content: center;
      padding: 10px 6px;
      gap: 4px;
      text-align: center;
    }
    .sidebar.collapsed .nav-icon { width: auto; font-size: 1.2rem; }
    .sidebar.collapsed .nav-label {
      font-size: 0.65rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .sidebar.collapsed .nav-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      font-size: 0.6rem;
      padding: 1px 4px;
    }
    .sidebar.collapsed .sidebar-footer { display: none; }
    .sidebar.collapsed .sidebar-nav { padding: 10px 4px; }
    .sidebar.collapsed .sidebar-collapse-btn { right: -12px; }
    .sidebar.collapsed + .main-content,
    body.sidebar-collapsed .main-content { margin-left: 80px; }

    /* Expand sidebar on hover when collapsed */
    .sidebar.collapsed:hover {
      width: 200px;
      box-shadow: 4px 0 20px rgba(0,0,0,0.15);
    }
    .sidebar.collapsed:hover .nav-item {
      flex-direction: row;
      justify-content: flex-start;
      padding: 12px 16px;
      gap: 12px;
      text-align: left;
    }
    .sidebar.collapsed:hover .nav-icon {
      width: 20px;
      font-size: 1rem;
    }
    .sidebar.collapsed:hover .nav-label {
      font-size: 0.88rem;
      max-width: none;
      overflow: visible;
    }
    .sidebar.collapsed:hover .nav-desc {
      display: block;
    }
    .sidebar.collapsed:hover .nav-badge {
      position: static;
      font-size: 0.7rem;
      padding: 2px 6px;
    }
    .sidebar.collapsed:hover .sidebar-nav {
      padding: 16px 10px;
    }
    .sidebar.collapsed:hover .sidebar-footer {
      display: block;
    }

    /* ─ Header Collapse Toggle ─ */
    .header-collapse-btn {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--text-on-dark);
      cursor: pointer;
      font-size: 0.65rem;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-collapse-btn:hover { background: rgba(255,255,255,0.2); }

    /* Collapsed Header State */
    header.collapsed { padding: 4px 24px; }
    header.collapsed .header-logo { height: 20px; }
    header.collapsed .header-divider { height: 16px; }
    header.collapsed h1 { font-size: 0.9rem; }
    header.collapsed .last-scraped-label,
    header.collapsed .last-scraped-ago,
    header.collapsed .run-badge { display: none; }
    header.collapsed .last-scraped-value { font-size: 0.7rem; margin: 0; }
    header.collapsed .theme-toggle { padding: 4px 8px; font-size: 0.9rem; }
    header.collapsed .theme-toggle-label { display: none; }
    header.collapsed .global-search { width: 140px; padding: 6px 10px; font-size: 0.75rem; }

    /* Adjust layout when header is collapsed */
    body.header-collapsed .app-layout { min-height: calc(100vh - 32px); }
    body.header-collapsed .sidebar { top: 32px; height: calc(100vh - 32px); }
    body.header-collapsed .providers-filter-bar { top: 32px; }

    .sidebar-toggle {
      display: none;
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 100;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: var(--accent-blue);
      color: #fff;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      box-shadow: var(--shadow-md);
    }
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); }
      .sidebar.open { transform: translateX(0); box-shadow: 4px 0 20px rgba(0,0,0,.2); }
      .main-content { margin-left: 0 !important; }
      .sidebar-toggle { display: flex; align-items: center; justify-content: center; }
      .sidebar-collapse-btn { display: none; }
    }

    /* ─ Tabs (hidden, using sidebar now) ─ */
    .tab-bar { display: none; }
    .tab-btn {
      padding: 9px 20px;
      border: none;
      border-bottom: 3px solid transparent;
      background: none;
      cursor: pointer;
      font-size: 0.88rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: -2px;
      border-radius: 8px 8px 0 0;
      transition: all .15s;
    }
    .tab-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
    .tab-btn.active {
      color: var(--text-primary);
      border-bottom-color: #10b981;
      background: var(--bg-primary);
      box-shadow: 0 -2px 6px rgba(0,0,0,.05);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ─ State chips ─ */
    .state-chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 40px 0; }
    .state-chip {
      padding: 5px 14px; border-radius: 99px; border: 1.5px solid var(--border-color);
      background: var(--bg-primary); cursor: pointer; font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);
      transition: all .15s;
    }
    .state-chip:hover, .state-chip.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }

    /* ─ Clickable card ─ */
    .card-clickable { cursor: pointer; }
    .card-clickable:hover { box-shadow: 0 8px 24px rgba(0,0,0,.14); transform: translateY(-3px); }
    .card-arrow { color: #94a3b8; font-size: 1rem; transition: color .15s; }
    .card-clickable:hover .card-arrow { color: #1d4ed8; }
    /* ─ Favorite Button ─ */
    .fav-btn, .pin-btn { position: absolute; top: 8px; right: 8px; background: none; border: none; font-size: 1.2rem; color: #cbd5e1; cursor: pointer; padding: 4px; z-index: 10; transition: color 0.2s, transform 0.2s; }
    .fav-btn:hover, .pin-btn:hover { color: #f59e0b; transform: scale(1.2); }
    .fav-btn.favorited, .pin-btn.pinned { color: #f59e0b; }
    .pin-btn.pinned { font-size: 1.3rem; text-shadow: 0 0 4px rgba(245, 158, 11, 0.5); }
    .provider-card { position: relative; }
    /* ─ Stats Cards ─ */
    .stats-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 0 40px 24px; }
    .stat-card { background: #fff; border-radius: 14px; padding: 20px 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); position: relative; overflow: hidden; }
    .stat-number { font-size: 2.5rem; font-weight: 800; line-height: 1; }
    .stat-label { font-size: 0.85rem; font-weight: 600; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-icon { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); font-size: 2.5rem; opacity: 0.15; }
    .stat-at-risk { border-left: 4px solid #ef4444; }
    .stat-at-risk .stat-number, .stat-at-risk .stat-label { color: #ef4444; }
    .stat-in-progress { border-left: 4px solid #f59e0b; }
    .stat-in-progress .stat-number, .stat-in-progress .stat-label { color: #f59e0b; }
    .stat-complete { border-left: 4px solid #16a34a; }
    .stat-complete .stat-number, .stat-complete .stat-label { color: #16a34a; }
    .stat-no-creds { border-left: 4px solid #6b7280; }
    .stat-no-creds .stat-number, .stat-no-creds .stat-label { color: #6b7280; }

    /* ─ New Dashboard Tab ─ */
    .dashboard-stats-row { display: flex; gap: 16px; padding: 24px 40px 16px; flex-wrap: wrap; }
    .dash-stat-card { display: flex; align-items: center; gap: 12px; background: var(--bg-primary); border-radius: 8px; padding: 14px 20px; border: 1px solid var(--border-color); flex: 1; min-width: 140px; }
    .dash-stat-icon { font-size: 1.3rem; opacity: 0.6; }
    .dash-stat-content { display: flex; flex-direction: column; }
    .dash-stat-num { font-size: 1.6rem; font-weight: 700; line-height: 1; color: var(--text-primary); }
    .dash-stat-label { font-size: 0.72rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); }
    .dash-stat-risk { border-color: var(--status-red); }
    .dash-stat-risk .dash-stat-num { color: var(--status-red); }
    .dash-stat-warning { }
    .dash-stat-warning .dash-stat-num, .dash-stat-warning .dash-stat-label { }
    .dash-stat-complete { }
    .dash-stat-complete .dash-stat-num, .dash-stat-complete .dash-stat-label { }
    .dash-stat-unknown { }
    .dash-stat-unknown .dash-stat-num, .dash-stat-unknown .dash-stat-label { }
    .dash-stat-cost { border-color: #059669; cursor: pointer; }
    .dash-stat-cost:hover { box-shadow: 0 4px 12px rgba(5, 150, 105, 0.2); }
    .dash-stat-cost .dash-stat-icon { color: #059669; font-family: system-ui, sans-serif; font-weight: 800; }
    .dash-stat-cost .dash-stat-num { color: #059669; }
    [data-theme="dark"] .dash-stat-cost { border-color: #34d399; }
    [data-theme="dark"] .dash-stat-cost .dash-stat-icon, [data-theme="dark"] .dash-stat-cost .dash-stat-num { color: #34d399; }

    /* ─ Urgency Panel ─ */
    .urgency-panel { margin: 0 40px 24px; background: var(--bg-primary); border-radius: 16px; box-shadow: var(--shadow-md); overflow: hidden; border: 2px solid var(--border-color); }
    .urgency-header { padding: 20px 24px; background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 50%, #1e1b4b 100%); display: flex; align-items: center; justify-content: space-between; }
    .urgency-title { margin: 0; font-size: 1.1rem; font-weight: 700; color: #fff; }
    .urgency-subtitle { font-size: 0.8rem; color: rgba(255,255,255,0.7); }
    .urgency-list { max-height: 400px; overflow-y: auto; }
    .urgency-item { display: flex; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--border-color); cursor: pointer; transition: background 0.15s; }
    .urgency-item:hover { background: var(--bg-secondary); }
    .urgency-item:last-child { border-bottom: none; }
    .urgency-icon { font-size: 1.2rem; flex-shrink: 0; }
    .urgency-info { flex: 1; min-width: 0; }
    .urgency-name { font-weight: 600; color: var(--text-primary); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .urgency-meta { font-size: 0.75rem; color: var(--text-secondary); }
    .urgency-progress { display: flex; align-items: center; gap: 8px; flex-shrink: 0; width: 120px; }
    .urgency-bar { flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
    .urgency-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 3px; }
    .urgency-hours { font-size: 0.7rem; color: var(--text-secondary); white-space: nowrap; }
    .urgency-badge { padding: 4px 10px; border-radius: 6px; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
    .urgency-overdue { background: #fef2f2; }
    .urgency-badge.urgency-overdue { background: #dc2626; color: #fff; animation: pulse-urgent 1s ease-in-out infinite; }
    .urgency-critical { background: #fef2f2; }
    .urgency-badge.urgency-critical { background: #ef4444; color: #fff; }
    .urgency-urgent { background: #fff7ed; }
    .urgency-badge.urgency-urgent { background: #f97316; color: #fff; }
    .urgency-warning { background: #fffbeb; }
    .urgency-badge.urgency-warning { background: #eab308; color: #1e1b4b; }
    .urgency-needs { background: #f0f9ff; }
    .urgency-badge.urgency-needs { background: #3b82f6; color: #fff; }
    .urgency-nocreds { background: #faf5ff; }
    .urgency-badge.urgency-nocreds { background: #7c3aed; color: #fff; }
    .urgency-creds-needed { font-size: 0.72rem; color: #7c3aed; font-weight: 500; }
    .urgency-empty { padding: 40px; text-align: center; color: #16a34a; font-size: 1rem; font-weight: 600; }
    .urgency-more { padding: 14px 24px; text-align: center; color: var(--accent-primary); font-size: 0.85rem; font-weight: 600; cursor: pointer; background: var(--bg-secondary); }
    .urgency-more:hover { background: var(--bg-tertiary); }
    @keyframes pulse-urgent { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }

    /* ─ Compliance Scorecard ─ */
    .scorecard-panel { margin: 0 40px 24px; background: var(--bg-primary); border-radius: 16px; box-shadow: var(--shadow-md); overflow: hidden; border: 2px solid var(--border-color); }
    .scorecard-header { padding: 20px 24px; background: linear-gradient(135deg, #0f766e 0%, #134e4a 50%, #064e3b 100%); display: flex; align-items: center; justify-content: space-between; }
    .scorecard-title { margin: 0; font-size: 1.1rem; font-weight: 700; color: #fff; }
    .scorecard-overall { display: flex; flex-direction: column; align-items: flex-end; }
    .overall-pct { font-size: 2rem; font-weight: 800; line-height: 1; }
    .overall-pct.pct-good { color: #86efac; }
    .overall-pct.pct-warn { color: #fcd34d; }
    .overall-pct.pct-bad { color: #fca5a5; }
    .overall-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.7); margin-top: 4px; }
    .scorecard-grid { display: grid; grid-template-columns: 1fr 1fr; }
    @media (max-width: 700px) { .scorecard-grid { grid-template-columns: 1fr; } }
    .scorecard-section { padding: 20px 24px; }
    .scorecard-section:first-child { border-right: 1px solid var(--border-color); }
    @media (max-width: 700px) { .scorecard-section:first-child { border-right: none; border-bottom: 1px solid var(--border-color); } }
    .scorecard-section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 16px; }
    .scorecard-items { display: flex; flex-direction: column; gap: 12px; }
    .scorecard-item { display: flex; flex-direction: column; gap: 6px; }
    .sc-label { display: flex; justify-content: space-between; align-items: baseline; }
    .sc-type { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
    .sc-count { font-size: 0.72rem; color: var(--text-secondary); }
    .sc-bar-wrap { display: flex; align-items: center; gap: 10px; height: 10px; background: var(--bg-tertiary); border-radius: 5px; overflow: hidden; position: relative; }
    .sc-bar { height: 100%; border-radius: 5px; transition: width 0.5s ease; }
    .sc-bar.sc-good { background: linear-gradient(90deg, #16a34a, #22c55e); }
    .sc-bar.sc-warn { background: linear-gradient(90deg, #d97706, #f59e0b); }
    .sc-bar.sc-bad { background: linear-gradient(90deg, #dc2626, #ef4444); }
    .sc-pct { position: absolute; right: 8px; font-size: 0.65rem; font-weight: 700; color: var(--text-primary); text-shadow: 0 0 4px var(--bg-primary), 0 0 8px var(--bg-primary); }

    /* ─ 12-Month Timeline ─ */
    .timeline-panel { margin: 0 40px 24px; background: var(--bg-primary); border-radius: 16px; box-shadow: var(--shadow-md); overflow: hidden; border: 2px solid var(--border-color); }
    .timeline-header { padding: 20px 24px; background: linear-gradient(135deg, #4f46e5 0%, #3730a3 50%, #312e81 100%); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .timeline-title { margin: 0; font-size: 1.1rem; font-weight: 700; color: #fff; }
    .timeline-legend { display: flex; gap: 16px; flex-wrap: wrap; }
    .tl-legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.7rem; color: rgba(255,255,255,0.9); }
    .tl-dot { width: 10px; height: 10px; border-radius: 50%; }
    .tl-dot.tl-complete { background: #22c55e; }
    .tl-dot.tl-critical { background: #ef4444; }
    .tl-dot.tl-urgent { background: #f97316; }
    .tl-dot.tl-warning { background: #eab308; }
    .tl-dot.tl-needs { background: #3b82f6; }
    .timeline-scroll { overflow-x: auto; padding: 16px 24px 20px; }
    .timeline-grid { display: grid; grid-template-columns: repeat(12, minmax(120px, 1fr)); gap: 12px; min-width: max-content; }
    .tl-month { background: var(--bg-secondary); border-radius: 10px; border: 1px solid var(--border-color); overflow: hidden; min-height: 100px; }
    .tl-month.tl-current { border-color: #6366f1; border-width: 2px; }
    .tl-month.has-renewals { background: var(--bg-primary); }
    .tl-month-header { padding: 10px 12px; background: var(--bg-tertiary); display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border-color); }
    .tl-current .tl-month-header { background: rgba(99, 102, 241, 0.15); }
    .tl-month-name { font-size: 0.85rem; font-weight: 700; color: var(--text-primary); }
    .tl-month-year { font-size: 0.7rem; color: var(--text-secondary); }
    .tl-month-count { margin-left: auto; background: #6366f1; color: #fff; font-size: 0.65rem; font-weight: 700; padding: 2px 7px; border-radius: 10px; }
    .tl-month-body { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .tl-empty { text-align: center; padding: 12px 8px; font-size: 0.72rem; color: var(--text-secondary); opacity: 0.6; }
    .tl-provider { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; transition: all 0.15s; border-left: 3px solid transparent; }
    .tl-provider:hover { transform: translateX(2px); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .tl-provider.tl-complete { background: #f0fdf4; border-color: #22c55e; }
    .tl-provider.tl-critical { background: #fef2f2; border-color: #ef4444; animation: pulse-urgent 1.5s infinite; }
    .tl-provider.tl-urgent { background: #fff7ed; border-color: #f97316; }
    .tl-provider.tl-warning { background: #fefce8; border-color: #eab308; }
    .tl-provider.tl-needs { background: #eff6ff; border-color: #3b82f6; }
    .tl-provider.tl-ok { background: var(--bg-secondary); border-color: var(--border-color); }
    .tl-day { font-size: 0.65rem; font-weight: 700; color: var(--text-secondary); min-width: 16px; }
    .tl-name { flex: 1; font-size: 0.72rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tl-hours { font-size: 0.65rem; font-weight: 600; color: var(--text-secondary); }
    .tl-complete .tl-hours { color: #16a34a; }
    .tl-critical .tl-hours { color: #dc2626; font-weight: 700; }
    @media (max-width: 768px) { .timeline-grid { grid-template-columns: repeat(6, minmax(100px, 1fr)); } }

    .dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 0 40px 24px; }
    @media (max-width: 900px) { .dashboard-grid { grid-template-columns: 1fr; } }
    .dashboard-actions, .dashboard-deadlines { background: var(--bg-primary); border-radius: 10px; padding: 20px 24px; border: 1px solid var(--border-color); }
    .dash-section-header { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
    .dash-action-list { display: flex; flex-direction: column; gap: 8px; }
    .dash-action-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 6px; cursor: pointer; transition: background .15s; background: var(--bg-secondary); }
    .dash-action-item:hover { background: var(--bg-tertiary); }
    .dash-action-icon { font-size: 1rem; width: 20px; text-align: center; opacity: 0.7; }
    .dash-action-text { flex: 1; font-size: 0.85rem; color: var(--text-primary); }
    .dash-action-text strong { font-weight: 600; }
    .dash-action-arrow { color: var(--text-secondary); font-size: 0.85rem; }
    .dash-action-critical { background: #fef2f2; border-left: 2px solid var(--status-red); }
    .dash-action-critical:hover { background: #fee2e2; }
    .dash-action-warning { }
    .dash-action-warning:hover { }
    .dash-action-info { }
    .dash-action-info:hover { }
    .dash-action-pending { }
    .dash-action-pending:hover { }
    .dash-action-error { background: #fef2f2; border-left: 2px solid var(--status-red); }
    .dash-action-error:hover { background: #fee2e2; }
    .dash-action-empty { display: flex; align-items: center; gap: 12px; padding: 16px; color: var(--text-secondary); font-size: 0.9rem; }

    .dash-deadline-summary { display: flex; gap: 12px; margin-bottom: 16px; }
    .dash-deadline-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #f8fafc; border-radius: 8px; cursor: pointer; transition: all .15s; flex: 1; }
    .dash-deadline-row:hover { background: #f1f5f9; }
    .dash-deadline-row.has-items { background: #fffbeb; }
    .dash-dl-badge { padding: 3px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; }
    .dash-dl-badge.urgent { background: #ef4444; color: #fff; }
    .dash-dl-badge.soon { background: #f59e0b; color: #fff; }
    .dash-dl-badge.upcoming { background: #3b82f6; color: #fff; }
    .dash-dl-count { font-size: 1.2rem; font-weight: 800; color: #1e293b; }
    .dash-dl-label { font-size: 0.75rem; color: #64748b; }
    .dash-deadline-preview { border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 4px; }
    .dash-preview-title { font-size: 0.75rem; font-weight: 600; color: #64748b; margin-bottom: 8px; text-transform: uppercase; }
    .dash-preview-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 0.85rem; }
    .dash-preview-name { flex: 1; color: #334155; font-weight: 500; }
    .dash-preview-state { color: #64748b; font-size: 0.78rem; }
    .dash-preview-days { font-weight: 700; font-size: 0.8rem; }
    .dash-preview-item.di-risk .dash-preview-days { color: #ef4444; }
    .dash-preview-item.di-progress .dash-preview-days { color: #f59e0b; }
    .dash-preview-item.di-complete .dash-preview-days { color: #16a34a; }
    .dash-preview-more { font-size: 0.78rem; color: #3b82f6; margin-top: 4px; }

    .dashboard-run-summary { background: #fff; margin: 0 40px 24px; padding: 16px 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .run-summary-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .run-summary-title { font-weight: 700; font-size: 0.85rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
    .run-summary-time { font-size: 0.85rem; color: #1e293b; }
    .run-summary-ago { font-size: 0.78rem; color: #64748b; margin-left: auto; }
    .run-summary-stats { display: flex; gap: 24px; flex-wrap: wrap; }
    .run-stat { display: flex; gap: 8px; align-items: center; font-size: 0.85rem; }
    .run-stat-label { color: #64748b; font-weight: 500; }
    .run-stat-value { color: #1e293b; }
    .run-ok { color: #16a34a; }
    .run-fail { color: #ef4444; }

    /* ─ Providers Filter Bar ─ */
    .providers-filter-bar { display: flex; gap: 14px; padding: 18px 40px 14px; flex-wrap: wrap; align-items: center; position: sticky; top: 60px; z-index: 50; background: var(--bg-body); border-bottom: 1px solid var(--border-color); backdrop-filter: blur(10px); }
    .providers-filter-bar .search-box { flex: 1; min-width: 220px; background: var(--bg-primary); color: var(--text-primary); border: 2px solid var(--border-color); border-radius: 12px; padding: 10px 16px; font-size: 0.9rem; transition: all var(--transition-fast); box-shadow: var(--shadow-sm); }
    .providers-filter-bar .search-box:focus { border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }
    .providers-filter-bar .filter-select { min-width: 140px; background: var(--bg-primary); color: var(--text-primary); border: 2px solid var(--border-color); border-radius: 12px; padding: 10px 14px; font-size: 0.88rem; cursor: pointer; transition: all var(--transition-fast); }
    .providers-filter-bar .filter-select:focus { border-color: var(--accent-primary); outline: none; }
    .advanced-filter-toggle { padding: 10px 18px; border: 2px solid var(--border-color); border-radius: 12px; background: var(--bg-primary); cursor: pointer; font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; transition: all var(--transition-fast); box-shadow: var(--shadow-sm); }
    .advanced-filter-toggle:hover { border-color: var(--accent-primary); color: var(--accent-primary); transform: translateY(-2px); }
    .advanced-filter-toggle.active { background: linear-gradient(135deg, var(--accent-primary), var(--accent-purple)); color: #fff; border-color: transparent; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
    .toggle-icon { font-size: 0.75rem; transition: transform 0.2s; }
    .advanced-filter-toggle.active .toggle-icon { transform: rotate(180deg); }
    .advanced-filters { display: flex; gap: 24px; padding: 16px 40px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); flex-wrap: wrap; }
    .adv-filter-group { display: flex; flex-direction: column; gap: 6px; }
    .adv-filter-group label { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; }
    .range-inputs { display: flex; align-items: center; gap: 8px; }
    .range-inputs input { width: 70px; padding: 6px 10px; border: 1.5px solid var(--border-color); border-radius: 6px; font-size: 0.85rem; background: var(--bg-primary); color: var(--text-primary); }
    .range-inputs span { color: var(--text-secondary); font-size: 0.85rem; }
    .filter-checkboxes { display: flex; gap: 16px; }
    .filter-checkboxes label { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; color: var(--text-primary); cursor: pointer; }
    .filter-checkboxes input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
    .providers-count { display: flex; align-items: center; gap: 12px; font-size: 0.85rem; color: var(--text-secondary); }
    .providers-count-row { display: flex; justify-content: space-between; align-items: center; padding: 0 40px 12px; gap: 16px; flex-wrap: wrap; }

    /* ─ Quick Filter Pills (compact, above grid) ─ */
    .quick-filter-pills { display: flex; gap: 6px; align-items: center; }
    .qf-pill { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 99px; background: var(--bg-primary); color: var(--text-secondary); font-size: 0.72rem; font-weight: 600; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 4px; }
    .qf-pill:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .qf-pill.active { background: var(--accent-primary); color: #fff; border-color: var(--accent-primary); }
    .qf-pill-dot { width: 6px; height: 6px; border-radius: 50%; }
    .qf-pill-dot.urgent { background: var(--status-red); }
    .qf-pill-dot.complete { background: var(--status-green); }
    .qf-pill-count { font-size: 0.68rem; opacity: 0.8; }
    .qf-pill-urgent { border-color: rgba(239,68,68,0.3); color: var(--status-red); }
    .qf-pill-urgent:hover, .qf-pill-urgent.active { background: var(--status-red); color: #fff; border-color: var(--status-red); }
    .qf-pill-complete { border-color: rgba(16,185,129,0.3); color: var(--status-green); }
    .qf-pill-complete:hover, .qf-pill-complete.active { background: var(--status-green); color: #fff; border-color: var(--status-green); }

    /* ─ View Toggle Bar (Consolidated) ─ */
    .view-toggle-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 40px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border-color); margin-bottom: 12px; }
    .view-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .view-toggle { padding: 6px 12px; border: 1.5px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); cursor: pointer; font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); transition: all .15s; display: flex; align-items: center; gap: 6px; }
    .view-toggle:hover { border-color: var(--border-dark); color: var(--text-primary); }
    .view-toggle.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
    .view-count { font-size: 0.68rem; padding: 1px 6px; border-radius: 8px; background: rgba(0,0,0,.1); }
    .view-toggle.active .view-count { background: rgba(255,255,255,.2); }
    .view-count.warning { background: var(--status-amber); color: #fff; }
    .toolbar-actions { display: flex; align-items: center; gap: 8px; }

    /* ─ Export Dropdown ─ */
    .export-dropdown { position: relative; }
    .export-dropdown-trigger { padding: 6px 12px; border: 1.5px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); cursor: pointer; font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); transition: all .15s; display: flex; align-items: center; gap: 6px; }
    .export-dropdown-trigger:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .export-dropdown-trigger svg { opacity: 0.7; }
    .dropdown-caret { font-size: 0.65rem; opacity: 0.6; }
    .export-dropdown-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 200px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: var(--shadow-lg); z-index: 1000; display: none; overflow: hidden; }
    .export-dropdown-menu.show { display: block; }
    .export-dropdown-menu button { display: block; width: 100%; padding: 10px 14px; border: none; background: transparent; text-align: left; font-size: 0.82rem; color: var(--text-primary); cursor: pointer; transition: background 0.1s; }
    .export-dropdown-menu button:hover:not(:disabled) { background: var(--bg-secondary); }
    .export-dropdown-menu button:disabled { opacity: 0.4; cursor: not-allowed; }
    .dropdown-divider { height: 1px; background: var(--border-color); margin: 4px 0; }
    .dropdown-label { padding: 6px 14px 4px; font-size: 0.7rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
    .bulk-export-item { padding-left: 24px !important; }

    /* ─ Bulk Controls Compact ─ */
    .bulk-controls-compact { display: flex; align-items: center; gap: 4px; padding-left: 8px; border-left: 1px solid var(--border-color); }
    .bulk-btn-compact { padding: 5px 6px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary); cursor: pointer; color: var(--text-secondary); transition: all 0.15s; display: flex; align-items: center; justify-content: center; }
    .bulk-btn-compact:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .bulk-btn-compact svg { opacity: 0.7; }
    .bulk-count-compact { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); min-width: 16px; text-align: center; }

    .license-view, .report-view { display: none; padding: 0 40px 24px; }
    .license-view.active, .report-view.active { display: block; }

    .empty-state { padding: 60px 40px; text-align: center; color: #64748b; }
    .empty-hint { font-size: 0.85rem; margin-top: 8px; }
    .empty-message { text-align: center; color: #94a3b8; padding: 24px; }

    /* ─ Overview tab ─ */
    .about-box { margin: 0 40px 8px; background: #fff; border-radius: 14px; padding: 24px 28px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .about-steps { display: flex; flex-direction: column; gap: 14px; }
    .about-step { display: flex; gap: 14px; align-items: flex-start; font-size: 0.88rem; color: #334155; line-height: 1.5; }
    .step-num { background: #1d4ed8; color: #fff; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
    .platform-overview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; padding: 0 40px; }
    .poc { background: #fff; border-radius: 12px; padding: 16px 18px; box-shadow: 0 2px 8px rgba(0,0,0,.06); display: flex; flex-direction: column; gap: 6px; border-top: 3px solid #e2e8f0; border-left: 4px solid transparent; }
    .poc-connected  { border-top-color: #16a34a; border-left-color: #16a34a; }
    .poc-ce-broker  { border-top-color: #10b981; border-left-color: #10b981; }
    .poc-pending    { border-top-color: #e2e8f0; border-left-color: #e2e8f0; opacity: 0.75; }
    .poc-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .poc-name { font-weight: 700; font-size: 0.95rem; color: #1e293b; }
    .poc-badge { font-size: 0.68rem; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
    .poc-on  { background: #dcfce7; color: #166534; }
    .poc-off { background: #f1f5f9; color: #64748b; }
    .poc-desc { font-size: 0.78rem; color: #64748b; }
    .poc-stats { display: flex; gap: 12px; margin-top: 2px; }
    .poc-stat { font-size: 0.8rem; color: #475569; }
    .poc-stat strong { color: #1e293b; }
    .poc-providers { font-size: 0.73rem; color: #94a3b8; line-height: 1.4; }
    .poc-unconfigured { font-size: 0.75rem; color: #94a3b8; font-style: italic; margin-top: 2px; }
    .poc-link { font-size: 0.73rem; color: #1d4ed8; text-decoration: none; margin-top: auto; padding-top: 6px; }
    .poc-link:hover { text-decoration: underline; }
    .coverage-wrap { padding: 0 40px 28px; overflow-x: auto; }
    .coverage-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.06); font-size: 0.82rem; }
    .coverage-table th { background: #f8fafc; padding: 10px 14px; text-align: center; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    .coverage-table th:first-child { text-align: left; }
    .coverage-table td { padding: 9px 14px; border-bottom: 1px solid #f1f5f9; }
    .cov-name { font-weight: 500; color: #1e293b; white-space: nowrap; }
    .cov-cell { text-align: center; }
    .cov-yes { color: #16a34a; font-weight: 700; }
    .cov-no  { color: #cbd5e1; }
    .cov-none { color: #ef4444; font-weight: 700; }
    .cov-pending { color: #f59e0b; }
    .cov-row-none { background: #fef2f2; }
    .coverage-matrix { border-collapse: separate; border-spacing: 0; }
    .matrix-legend { display: flex; gap: 20px; margin-bottom: 12px; padding-left: 4px; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #64748b; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
    .legend-dot.dot-green { background: #16a34a; }
    .legend-dot.dot-gray { background: #cbd5e1; }
    .legend-dot.dot-red { background: #ef4444; }

    .coverage-gaps-box { margin: 0 40px 28px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 12px; padding: 20px 24px; }
    /* ─ Action Required section ─ */
    .action-required-box { margin: 0 40px 28px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.04); }
    .action-section { padding: 18px 24px; border-bottom: 1px solid #e2e8f0; }
    .action-section:last-child { border-bottom: none; }
    .action-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .action-icon { font-size: 1.1rem; width: 24px; text-align: center; }
    .action-title { font-weight: 700; font-size: 0.95rem; }
    .action-desc { font-size: 0.82rem; color: #64748b; margin-bottom: 12px; line-height: 1.4; }
    .action-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .action-name { font-size: 0.78rem; font-weight: 500; padding: 4px 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; }
    .action-critical { background: #fef2f2; }
    .action-critical .action-icon, .action-critical .action-title { color: #ef4444; }
    .action-name-critical { background: #fee2e2; border-color: #fca5a5; color: #991b1b; }
    .action-no-creds { background: #fefce8; }
    .action-no-creds .action-icon, .action-no-creds .action-title { color: #a16207; }
    .action-name-none { background: #fef9c3; border-color: #fde047; color: #854d0e; }
    .action-warning { background: #fff7ed; }
    .action-warning .action-icon, .action-warning .action-title { color: #c2410c; }
    .action-name-warning { background: #ffedd5; border-color: #fed7aa; color: #9a3412; }
    .action-info { background: #f0f9ff; }
    .action-info .action-icon, .action-info .action-title { color: #0369a1; }
    .action-name-info { background: #e0f2fe; border-color: #7dd3fc; color: #0c4a6e; }
    /* ─ Tab badge ─ */
    .tab-badge { background: #ef4444; color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 10px; margin-left: 6px; }
    .tab-badge-sm { background: #64748b; color: #fff; font-size: 0.65rem; font-weight: 600; padding: 1px 5px; border-radius: 8px; margin-left: 4px; }
    /* ─ Needs Attention tab ─ */
    .deadlines-container { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 0 40px 24px; }
    .deadline-group { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.06); overflow: hidden; }
    .deadline-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #e2e8f0; }
    .deadline-badge { font-size: 0.8rem; font-weight: 700; padding: 4px 10px; border-radius: 12px; }
    .deadline-badge.urgent { background: #fee2e2; color: #ef4444; }
    .deadline-badge.soon { background: #fef3c7; color: #f59e0b; }
    .deadline-badge.upcoming { background: #dbeafe; color: #2563eb; }
    .deadline-count { font-size: 0.8rem; color: #64748b; }
    .deadline-list { padding: 8px 0; }
    .deadline-item { display: grid; grid-template-columns: 1fr auto auto auto auto; gap: 8px; padding: 10px 18px; align-items: center; border-bottom: 1px solid #f1f5f9; }
    .deadline-item:last-child { border-bottom: none; }
    .di-name { font-weight: 600; font-size: 0.85rem; color: #1e293b; }
    .di-state { font-size: 0.75rem; font-weight: 600; padding: 2px 6px; background: #f1f5f9; border-radius: 4px; color: #475569; }
    .di-days { font-size: 0.8rem; font-weight: 700; min-width: 40px; text-align: right; }
    .di-date { font-size: 0.75rem; color: #64748b; min-width: 80px; }
    .di-status { font-size: 0.9rem; }
    .di-risk { background: #fef2f2; }
    .di-risk .di-days { color: #ef4444; }
    .di-complete { background: #f0fdf4; }
    .di-complete .di-days { color: #16a34a; }
    .di-progress { background: #fffbeb; }
    .di-progress .di-days { color: #f59e0b; }
    .deadline-empty { padding: 24px 18px; text-align: center; color: #94a3b8; font-size: 0.85rem; }
    .login-errors-box { margin: 0 40px 24px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 18px 24px; }
    .error-desc { font-size: 0.85rem; color: #991b1b; margin-bottom: 14px; }
    .error-list { display: flex; flex-direction: column; gap: 8px; }
    .error-item { display: flex; justify-content: space-between; align-items: center; background: #fff; border-radius: 8px; padding: 10px 14px; }
    .error-name { font-weight: 600; color: #1e293b; }
    .error-msg { font-size: 0.8rem; color: #ef4444; max-width: 50%; text-align: right; }
    .missing-creds-box { margin: 0 40px 24px; background: #fefce8; border: 1px solid #fde047; border-radius: 12px; padding: 18px 24px; }
    .missing-desc { font-size: 0.85rem; color: #854d0e; margin-bottom: 14px; }
    .missing-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
    .missing-card { background: #fff; border: 1px solid #fde047; border-radius: 8px; padding: 10px 14px; font-weight: 600; font-size: 0.85rem; color: #854d0e; }
    /* ─ Provider Profiles sub-tabs ─ */
    .profiles-header { padding: 0 40px 16px; }
    .sub-tabs { display: flex; gap: 8px; }
    .sub-tab { background: #f1f5f9; border: none; padding: 10px 18px; border-radius: 10px; font-size: 0.85rem; font-weight: 600; color: #475569; cursor: pointer; transition: all .15s; }
    .sub-tab:hover { background: #e2e8f0; }
    .sub-tab.active { background: #1d4ed8; color: #fff; }
    .sub-panel { display: none; }
    .sub-panel.active { display: block; }
    .control-group { display: flex; align-items: center; gap: 8px; }
    .control-label { font-size: 0.8rem; font-weight: 600; color: #64748b; }
    .creds-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.82rem; color: #475569; white-space: nowrap; }
    .creds-toggle input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #1d4ed8; }
    .sort-select { padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.82rem; background: #fff; color: #1e293b; cursor: pointer; min-width: 140px; }
    .sort-select:focus { outline: none; border-color: #1d4ed8; }
    .gap-section { margin-bottom: 16px; }
    .gap-section:last-child { margin-bottom: 0; }
    .gap-title { font-weight: 600; color: #c2410c; font-size: 0.9rem; margin-bottom: 6px; }
    .gap-desc { font-size: 0.78rem; color: #9a3412; margin-bottom: 10px; line-height: 1.4; }
    .gap-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .gap-name { font-size: 0.78rem; font-weight: 500; padding: 4px 10px; background: #fff; border: 1px solid #fdba74; border-radius: 14px; color: #9a3412; }

    .card-states { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .card-state-chip { font-size: 0.67rem; font-weight: 600; padding: 2px 6px; border-radius: 8px; }
    .sc-green  { background: #dcfce7; color: #166534; }
    .sc-yellow { background: #fef9c3; color: #854d0e; }
    .sc-red    { background: #fee2e2; color: #7f1d1d; }
    .sc-gray   { background: #f1f5f9; color: #475569; }
    .sc-blue   { background: #dbeafe; color: #1e40af; }
    .sc-orange { background: #fed7aa; color: #9a3412; }
    /* Platform tags - hidden by default, shown on hover */
    .card-plat-tags { display: none; flex-wrap: wrap; gap: 5px; padding: 8px 12px 4px; border-top: 1px solid #f1f5f9; }
    .provider-card:hover .card-plat-tags, .provider-card.expanded .card-plat-tags { display: flex; }
    .card-plat-tag { font-size: 0.68rem; font-weight: 600; padding: 2px 7px; border-radius: 10px; }
    .plat-tag-netce   { background: #ccfbf1; color: #0f766e; }
    .plat-tag-ceufast { background: #ede9fe; color: #6d28d9; }
    .plat-tag-aanp    { background: #dbeafe; color: #1e40af; }
    .plat-tag-other   { background: #f1f5f9; color: #475569; }

    /* ─ Provider detail drawer ─ */
    .drawer-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(30,58,138,0.45); z-index: 1000;
      align-items: flex-start; justify-content: center;
      padding: 32px 16px 48px; overflow-y: auto;
    }
    [data-theme="dark"] .drawer-overlay { background: rgba(0,0,0,0.7); }
    .drawer-overlay.open { display: flex; }
    .drawer-panel {
      background: var(--bg-primary); border-radius: 18px; padding: 36px;
      width: 100%; max-width: 740px; position: relative;
      box-shadow: 0 24px 64px rgba(0,0,0,.22); margin: auto;
      animation: slideUp .2s ease;
      color: var(--text-primary);
    }
    @keyframes slideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
    .drawer-close {
      position: absolute; top: 18px; right: 18px;
      background: var(--bg-tertiary); border: none; border-radius: 50%;
      width: 34px; height: 34px; cursor: pointer; font-size: 1rem;
      color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
    }
    .drawer-close:hover { background: var(--border-color); }

    .detail-hdr { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
    .detail-avatar {
      width: 56px; height: 56px; border-radius: 50%;
      background: #64748b; color: #fff; font-size: 1.1rem; font-weight: 700;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .detail-name { font-size: 1.25rem; font-weight: 700; color: #1e293b; }
    .detail-type-lbl { font-size: 0.8rem; color: #64748b; margin-top: 2px; }
    .detail-overall { margin-left: auto; }

    .detail-lic-card {
      border: 1.5px solid #e2e8f0; border-radius: 12px;
      padding: 20px; margin-bottom: 16px; background: #f8fafc;
    }
    .detail-lic-card.dl-complete { border-color: #bbf7d0; background: #f0fdf4; }
    .detail-lic-card.dl-progress { border-color: #fde68a; background: #fffbeb; }
    .detail-lic-card.dl-risk     { border-color: #fecaca; background: #fff5f5; }

    .detail-lic-hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
    .detail-state-badge {
      font-size: 1rem; font-weight: 800; color: #1e293b;
      background: #e2e8f0; padding: 2px 10px; border-radius: 6px;
    }
    .detail-lic-type { font-size: 0.8rem; color: #64748b; background: #fff; border: 1px solid #e2e8f0; padding: 2px 8px; border-radius: 99px; }
    .detail-deadline { font-size: 0.82rem; color: #475569; margin-bottom: 12px; }

    .detail-prog-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .detail-prog-track { flex: 1; height: 10px; background: #e2e8f0; border-radius: 99px; overflow: hidden; }
    .detail-prog-fill  { height: 100%; border-radius: 99px; background: #16a34a; transition: width .4s; }
    .detail-prog-fill.partial { background: #f59e0b; }
    .detail-prog-fill.low     { background: #ef4444; }
    .detail-prog-label { font-size: 0.82rem; color: #475569; white-space: nowrap; font-weight: 600; }

    .detail-sa-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 12px; }
    .detail-sa-table th { background: #f1f5f9; color: #64748b; font-weight: 600; padding: 6px 10px; text-align: left; font-size: 0.72rem; text-transform: uppercase; }
    .detail-sa-table td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; color: #334155; }
    .detail-sa-table tr:last-child td { border-bottom: none; }
    .sa-done  { color: #059669; font-weight: 600; }
    .sa-short { color: #dc2626; font-weight: 600; }

    .detail-lic-num {
      font-size: 0.72rem; color: #64748b; background: #f1f5f9;
      padding: 2px 8px; border-radius: 6px; white-space: nowrap;
    }
    .detail-btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .cebroker-link {
      display: inline-block; padding: 6px 14px;
      background: #1d4ed8; color: #fff; border-radius: 8px;
      font-size: 0.78rem; text-decoration: none; font-weight: 600;
    }
    .cebroker-link:hover { background: #1e40af; }
    .detail-course-btn {
      display: inline-block; padding: 6px 14px;
      background: #eff6ff; color: #1d4ed8; border-radius: 8px;
      font-size: 0.78rem; text-decoration: none; font-weight: 600;
      border: 1px solid #bfdbfe;
    }
    .detail-course-btn:hover { background: #dbeafe; }
    .detail-no-sa { font-size: 0.8rem; color: #94a3b8; font-style: italic; margin-bottom: 8px; }
    .detail-contact { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 5px; }
    .contact-link {
      font-size: 0.78rem; color: #1d4ed8; text-decoration: none; font-weight: 500;
    }
    .contact-link:hover { text-decoration: underline; }
    .contact-phone { font-size: 0.78rem; color: #475569; }

    /* ─ Needs / Completed sections ─ */
    .drawer-section { margin-top: 18px; }
    .drawer-section-title {
      font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.7px; color: #64748b; margin-bottom: 10px;
      padding-bottom: 6px; border-bottom: 1px solid #e2e8f0;
    }
    .need-item {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 7px 10px; background: #fff5f5; border: 1px solid #fecaca;
      border-radius: 8px; margin-bottom: 6px;
    }
    .need-topic  { font-size: 0.82rem; font-weight: 600; color: #991b1b; flex: 1; }
    .need-hours  { font-size: 0.78rem; color: #dc2626; white-space: nowrap; }
    .need-search {
      font-size: 0.75rem; padding: 3px 10px; background: #fee2e2;
      color: #dc2626; border-radius: 6px; text-decoration: none; font-weight: 600;
      white-space: nowrap;
    }
    .need-search:hover { background: #fecaca; }

    .course-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
    .course-item {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0;
      border-radius: 8px; gap: 10px;
    }
    .course-item-name { font-size: 0.82rem; color: #1e293b; flex: 1; line-height: 1.4; }
    .course-item-name.unnamed { color: #94a3b8; font-style: italic; }
    .course-item-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; white-space: nowrap; flex-shrink: 0; }
    .course-item-date  { font-size: 0.72rem; color: #94a3b8; }
    .course-item-hours { font-size: 0.75rem; font-weight: 600; color: #16a34a;
                         background: #dcfce7; padding: 1px 7px; border-radius: 99px; }
    /* Highlight courses that appear multiple times (separate completions) */
    .course-item.has-multiple { border-left: 3px solid #3b82f6; background: #f0f9ff; }
    .course-item-date.highlight-date { font-weight: 600; color: #1d4ed8; background: #dbeafe; padding: 1px 6px; border-radius: 4px; }
    .course-item-date.no-date { color: #cbd5e1; font-style: italic; }
    .course-item-cat { font-size: 0.68rem; color: #64748b; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; }

    /* ─ Chart section ─ */
    .chart-wrap { padding: 28px 40px 40px; }
    .chart-section { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 10px rgba(0,0,0,.07); margin-bottom: 20px; }
    .chart-section-title { font-size: 0.82rem; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 16px; }
    .chart-canvas-wrap { position: relative; height: 380px; }
    .chart-no-data { text-align: center; padding: 40px; color: #94a3b8; font-size: 0.88rem; }

    /* ─ Print button (inside drawer) ─ */
    .print-btn {
      position: absolute; top: 18px; right: 60px;
      background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;
      padding: 6px 13px; cursor: pointer; font-size: 0.78rem; font-weight: 600;
      color: #1d4ed8;
    }
    .print-btn:hover { background: #dbeafe; }

    /* ─ Provider Notes Section ─ */
    .notes-section {
      margin-top: 24px; padding: 20px; background: var(--bg-secondary);
      border-radius: 12px; border: 1px solid var(--border-color);
    }
    .notes-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-color);
    }
    .notes-title {
      font-size: 0.9rem; font-weight: 700; color: var(--text-primary);
      display: flex; align-items: center; gap: 8px;
    }
    .notes-title-icon { font-size: 1rem; }
    .add-note-btn {
      background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-purple) 100%);
      color: white; border: none; padding: 6px 14px; border-radius: 8px;
      font-size: 0.78rem; font-weight: 600; cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .add-note-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99,102,241,.3); }
    .notes-list { display: flex; flex-direction: column; gap: 10px; }
    .notes-empty {
      text-align: center; padding: 24px; color: var(--text-secondary);
      font-size: 0.85rem; font-style: italic;
    }
    .note-item {
      background: var(--bg-body); border: 1px solid var(--border-color);
      border-radius: 10px; padding: 14px 16px; position: relative;
    }
    .note-item.note-task { border-left: 4px solid var(--accent-primary); }
    .note-item.note-task.task-done { border-left-color: var(--status-green); opacity: 0.7; }
    .note-text { font-size: 0.88rem; color: var(--text-primary); line-height: 1.5; margin-bottom: 8px; }
    .note-task .note-text { padding-left: 24px; }
    .task-checkbox {
      position: absolute; left: 16px; top: 16px; width: 16px; height: 16px;
      cursor: pointer; accent-color: var(--accent-primary);
    }
    .note-meta {
      display: flex; align-items: center; gap: 12px; font-size: 0.72rem;
      color: var(--text-secondary);
    }
    .note-date { font-weight: 500; }
    .note-actions { margin-left: auto; display: flex; gap: 8px; }
    .note-action-btn {
      background: none; border: none; cursor: pointer; font-size: 0.72rem;
      color: var(--text-secondary); padding: 2px 6px; border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }
    .note-action-btn:hover { background: var(--bg-secondary); color: var(--text-primary); }
    .note-action-btn.delete:hover { background: #fef2f2; color: #dc2626; }

    /* Note Form */
    .note-form { display: none; margin-bottom: 16px; }
    .note-form.active { display: block; }
    .note-form-inner {
      background: var(--bg-body); border: 1px solid var(--border-color);
      border-radius: 10px; padding: 14px;
    }
    .note-input {
      width: 100%; border: 1px solid var(--border-color); border-radius: 8px;
      padding: 10px 12px; font-size: 0.88rem; resize: vertical; min-height: 60px;
      font-family: inherit; background: var(--bg-body); color: var(--text-primary);
    }
    .note-input:focus { outline: none; border-color: var(--accent-primary); }
    .note-form-options {
      display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap;
    }
    .note-type-toggle {
      display: flex; align-items: center; gap: 6px; font-size: 0.8rem;
      color: var(--text-secondary);
    }
    .note-type-toggle input { accent-color: var(--accent-primary); }
    .note-form-actions { margin-left: auto; display: flex; gap: 8px; }
    .note-cancel-btn {
      background: var(--bg-secondary); border: 1px solid var(--border-color);
      padding: 6px 14px; border-radius: 8px; font-size: 0.78rem;
      font-weight: 600; color: var(--text-secondary); cursor: pointer;
    }
    .note-save-btn {
      background: var(--accent-primary); color: white; border: none;
      padding: 6px 14px; border-radius: 8px; font-size: 0.78rem;
      font-weight: 600; cursor: pointer;
    }
    .note-cancel-btn:hover { background: var(--bg-tertiary); }
    .note-save-btn:hover { background: var(--accent-purple); }

    /* ─ Calendar ─ */
    .cal-wrap { padding: 20px 40px 40px; display: flex; flex-direction: column; gap: 16px; }
    .cal-empty { text-align: center; color: #94a3b8; font-size: 0.88rem; padding: 40px 0; }
    .cal-month {
      background: #fff; border-radius: 12px; padding: 20px 24px;
      box-shadow: 0 2px 8px rgba(0,0,0,.07);
    }
    .cal-month.cal-past { opacity: 0.5; }
    .cal-month-hdr {
      font-size: 0.95rem; font-weight: 700; color: #1e293b;
      margin-bottom: 14px; padding-bottom: 10px;
      border-bottom: 1px solid #e2e8f0;
      display: flex; align-items: center; gap: 10px;
    }
    .cal-past-lbl {
      font-size: 0.68rem; font-weight: 600; background: #f1f5f9; color: #94a3b8;
      padding: 2px 8px; border-radius: 99px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .cal-entries { display: flex; flex-direction: column; gap: 8px; }
    .cal-entry {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #f8fafc; border: 1px solid #e2e8f0;
      border-radius: 8px; gap: 12px; flex-wrap: wrap;
    }
    .cal-entry-left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .cal-entry-state {
      font-size: 0.78rem; font-weight: 700; background: #e2e8f0; color: #334155;
      padding: 2px 8px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
    }
    .cal-entry-name {
      font-size: 0.88rem; font-weight: 600; color: #1e293b;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cal-entry-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
    .cal-entry-date  { font-size: 0.78rem; color: #64748b; white-space: nowrap; }
    .cal-entry-days  { font-size: 0.75rem; white-space: nowrap; }

    /* ─ Status Page ─ */
    .status-page { padding: 24px 40px; }
    .status-section { background: var(--bg-primary); border-radius: 16px; padding: 24px; margin-bottom: 24px; box-shadow: var(--shadow-sm); }
    .status-section-title { display: flex; align-items: center; gap: 10px; font-size: 1.1rem; font-weight: 700; color: var(--text-primary); margin-bottom: 20px; }
    .status-icon { font-size: 1.3rem; }
    .status-cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .status-card { background: var(--bg-secondary); border-radius: 12px; padding: 16px 20px; text-align: center; }
    .status-card-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 8px; }
    .status-card-value { font-size: 1.5rem; font-weight: 800; color: var(--text-primary); }
    .status-card-sub { font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; }
    .status-card-success { border-left: 4px solid #10b981; }
    .status-card-success .status-card-value { color: #10b981; }
    .status-card-error { border-left: 4px solid #ef4444; }
    .status-card-error .status-card-value { color: #ef4444; }
    .status-card-info { border-left: 4px solid #3b82f6; }
    .status-card-info .status-card-value { color: #3b82f6; }

    .health-summary { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
    .health-stat { flex: 1; min-width: 100px; text-align: center; padding: 16px; border-radius: 12px; }
    .health-num { display: block; font-size: 2rem; font-weight: 800; }
    .health-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .health-healthy { background: #d1fae5; }
    .health-healthy .health-num { color: #059669; }
    .health-healthy .health-label { color: #047857; }
    .health-degraded { background: #fef3c7; }
    .health-degraded .health-num { color: #d97706; }
    .health-degraded .health-label { color: #b45309; }
    .health-warning { background: #fed7aa; }
    .health-warning .health-num { color: #ea580c; }
    .health-warning .health-label { color: #c2410c; }
    .health-critical { background: #fecaca; }
    .health-critical .health-num { color: #dc2626; }
    .health-critical .health-label { color: #b91c1c; }

    .health-issues { margin-top: 20px; }
    .health-issues-title { font-size: 0.9rem; font-weight: 700; color: var(--text-primary); margin-bottom: 12px; }
    .health-issues-list { display: flex; flex-direction: column; gap: 10px; }
    .health-issue-item { display: flex; align-items: center; gap: 16px; padding: 14px 18px; border-radius: 10px; background: var(--bg-secondary); }
    .health-issue-critical { border-left: 4px solid #dc2626; }
    .health-issue-warning { border-left: 4px solid #ea580c; }
    .health-issue-degraded { border-left: 4px solid #d97706; }
    .health-issue-status { min-width: 80px; }
    .health-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
    .health-dot-critical { background: #dc2626; }
    .health-dot-warning { background: #ea580c; }
    .health-dot-degraded { background: #d97706; }
    .health-status-text { font-size: 0.7rem; font-weight: 700; }
    .health-issue-info { flex: 1; }
    .health-issue-provider { font-weight: 700; color: var(--text-primary); }
    .health-issue-platform { font-size: 0.8rem; color: var(--text-secondary); }
    .health-issue-details { text-align: right; }
    .health-issue-failures { font-size: 0.8rem; color: #dc2626; font-weight: 600; }
    .health-issue-error { font-size: 0.72rem; color: var(--text-secondary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .health-all-good { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 24px; background: #d1fae5; border-radius: 12px; }
    .health-all-good-icon { font-size: 1.5rem; color: #059669; }
    .health-all-good-text { font-size: 1rem; font-weight: 600; color: #047857; }

    .error-log { display: flex; flex-direction: column; gap: 8px; }
    .error-log-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #fef2f2; border-radius: 8px; border-left: 3px solid #ef4444; }
    .error-log-type { font-size: 0.72rem; font-weight: 700; background: #fee2e2; color: #dc2626; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .error-log-provider { font-weight: 600; color: #1e293b; min-width: 150px; }
    .error-log-msg { font-size: 0.8rem; color: #64748b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .scheduler-info { display: flex; flex-direction: column; gap: 12px; }
    .scheduler-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--bg-secondary); border-radius: 8px; }
    .scheduler-label { font-weight: 600; color: var(--text-secondary); }
    .scheduler-value { font-weight: 700; color: var(--text-primary); }
    .scheduler-enabled { color: #059669; }

    /* ─ Scrape History Log ─ */
    .history-log { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; }
    .history-item {
      display: flex; align-items: center; gap: 16px;
      padding: 12px 16px; background: var(--bg-secondary);
      border-radius: 8px; border-left: 3px solid var(--border-color);
    }
    .history-item.history-latest { border-left-color: #10b981; background: rgba(16, 185, 129, 0.1); }
    .history-time { min-width: 100px; }
    .history-date { font-weight: 700; color: var(--text-primary); display: block; }
    .history-clock { font-size: 0.75rem; color: var(--text-secondary); }
    .history-stats { display: flex; gap: 10px; flex: 1; }
    .history-stat { font-size: 0.8rem; padding: 3px 10px; border-radius: 6px; font-weight: 600; }
    .history-stat-ok { background: #d1fae5; color: #059669; }
    .history-stat-fail { background: #fecaca; color: #dc2626; }
    .history-stat-total { background: var(--bg-tertiary); color: var(--text-secondary); }
    .history-badge-latest { font-size: 0.7rem; padding: 3px 8px; background: #10b981; color: #fff; border-radius: 6px; font-weight: 700; text-transform: uppercase; }
    .history-summary { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); text-align: center; }
    .history-total { font-size: 0.85rem; color: var(--text-secondary); }
    [data-theme="dark"] .history-stat-ok { background: rgba(16, 185, 129, 0.2); }
    [data-theme="dark"] .history-stat-fail { background: rgba(220, 38, 38, 0.2); }
    [data-theme="dark"] .history-item.history-latest { background: rgba(16, 185, 129, 0.15); }

    [data-theme="dark"] .health-healthy { background: rgba(5, 150, 105, 0.2); }
    [data-theme="dark"] .health-degraded { background: rgba(217, 119, 6, 0.2); }
    [data-theme="dark"] .health-warning { background: rgba(234, 88, 12, 0.2); }
    [data-theme="dark"] .health-critical { background: rgba(220, 38, 38, 0.2); }
    [data-theme="dark"] .health-all-good { background: rgba(5, 150, 105, 0.2); }
    [data-theme="dark"] .health-all-good-text { color: #34d399; }

    /* ─ Credential Tracker Section ─ */
    .cred-tracker-summary { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 12px; border: 1px solid var(--border-color); }
    .cred-summary-stat { flex: 1; min-width: 100px; text-align: center; padding: 12px 8px; border-radius: 8px; }
    .cred-summary-num { display: block; font-size: 1.75rem; font-weight: 800; }
    .cred-summary-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .cred-summary-total { background: #f1f5f9; }
    .cred-summary-total .cred-summary-num { color: #334155; }
    .cred-summary-total .cred-summary-label { color: #64748b; }
    .cred-summary-configured { background: #dbeafe; }
    .cred-summary-configured .cred-summary-num { color: #1d4ed8; }
    .cred-summary-configured .cred-summary-label { color: #1e40af; }
    .cred-summary-nocreds { background: #fef2f2; }
    .cred-summary-nocreds .cred-summary-num { color: #dc2626; }
    .cred-summary-nocreds .cred-summary-label { color: #b91c1c; }
    .cred-summary-nocourses { background: #fef3c7; }
    .cred-summary-nocourses .cred-summary-num { color: #d97706; }
    .cred-summary-nocourses .cred-summary-label { color: #b45309; }
    .cred-summary-nohistory { background: #e2e8f0; }
    .cred-summary-nohistory .cred-summary-num { color: #475569; }
    .cred-summary-nohistory .cred-summary-label { color: #64748b; }

    .cred-tracker-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .cred-filter-btn { padding: 8px 16px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary); font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
    .cred-filter-btn:hover { background: var(--bg-tertiary); border-color: var(--text-secondary); }
    .cred-filter-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    .cred-filter-btn.cred-filter-warning { border-color: #f59e0b; }
    .cred-filter-btn.cred-filter-warning.active { background: #f59e0b; border-color: #f59e0b; }
    .cred-filter-btn.cred-filter-danger { border-color: #ef4444; }
    .cred-filter-btn.cred-filter-danger.active { background: #ef4444; border-color: #ef4444; }
    .cred-filter-btn.cred-filter-info { border-color: #06b6d4; }
    .cred-filter-btn.cred-filter-info.active { background: #06b6d4; border-color: #06b6d4; }
    .cred-filter-btn.cred-filter-orange { border-color: #ea580c; }
    .cred-filter-btn.cred-filter-orange.active { background: #ea580c; border-color: #ea580c; }
    .cred-filter-count { background: rgba(0,0,0,0.15); padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; }
    .cred-filter-btn.active .cred-filter-count { background: rgba(255,255,255,0.25); }

    .cred-tracker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; }
    .cred-tracker-card { border-radius: 12px; overflow: hidden; background: var(--bg-secondary); border: 1px solid var(--border-color); }
    .cred-tracker-card.hidden { display: none; }
    .cred-tracker-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; }
    .cred-tracker-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.75rem; color: #fff; }
    .cred-header-cebroker { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
    .cred-header-cebroker .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-header-platform { background: linear-gradient(135deg, #06b6d4, #0891b2); }
    .cred-header-platform .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-header-complete { background: linear-gradient(135deg, #10b981, #059669); }
    .cred-header-complete .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-header-danger { background: linear-gradient(135deg, #ef4444, #dc2626); }
    .cred-header-danger .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-header-warning { background: linear-gradient(135deg, #f59e0b, #d97706); }
    .cred-header-warning .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-header-info { background: linear-gradient(135deg, #06b6d4, #0284c7); }
    .cred-header-info .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-header-dark { background: linear-gradient(135deg, #475569, #334155); }
    .cred-header-dark .cred-tracker-icon { background: rgba(255,255,255,0.2); }
    .cred-tracker-title { flex: 1; font-weight: 700; color: #fff; font-size: 0.95rem; }
    .cred-tracker-count { background: rgba(255,255,255,0.2); color: #fff; padding: 4px 12px; border-radius: 16px; font-weight: 700; font-size: 0.85rem; }

    .cred-tracker-body { padding: 16px 20px; }
    .cred-tracker-desc { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px; }
    .cred-tracker-note { font-size: 0.8rem; color: var(--text-primary); padding: 8px 12px; background: #fef3c7; border-radius: 6px; margin-bottom: 12px; border-left: 3px solid #f59e0b; }
    .cred-tracker-note.cred-note-good { background: #d1fae5; border-left-color: #10b981; }
    .cred-tracker-note.cred-note-danger { background: #fef2f2; border-left-color: #ef4444; }
    .cred-tracker-note.cred-note-warning { background: #fef3c7; border-left-color: #f59e0b; }

    .cred-tracker-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
    .cred-tracker-chip { display: inline-block; padding: 6px 12px; background: var(--bg-tertiary); border-radius: 6px; font-size: 0.85rem; cursor: pointer; transition: background 0.2s; margin: 2px; }
    .cred-tracker-chip:hover { background: var(--border-color); }
    .cred-tracker-chip.cred-chip-danger { background: #fef2f2; color: #dc2626; }
    .cred-tracker-chip.cred-chip-danger:hover { background: #fecaca; }
    .cred-tracker-chip small { opacity: 0.7; }

    .cred-tracker-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 8px; cursor: pointer; transition: all 0.2s; }
    .cred-tracker-item:hover { background: var(--border-color); transform: translateX(4px); }
    .cred-tracker-item.cred-item-good { border-left: 3px solid #10b981; }
    .cred-tracker-item.cred-item-warning { border-left: 3px solid #f59e0b; background: #fffbeb; }
    .cred-tracker-item.cred-item-danger { border-left: 3px solid #ef4444; background: #fef2f2; }
    .cred-tracker-item.cred-item-info { border-left: 3px solid #06b6d4; background: #ecfeff; }
    .cred-tracker-name { font-weight: 600; color: var(--text-primary); font-size: 0.9rem; }
    .cred-tracker-name small { font-weight: 400; opacity: 0.7; }
    .cred-tracker-platforms { font-size: 0.75rem; color: var(--text-secondary); text-align: right; }

    .cred-tracker-status-badge { font-size: 0.7rem; font-weight: 700; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
    .cred-badge-danger { background: #fecaca; color: #dc2626; }
    .cred-badge-warning { background: #fef3c7; color: #d97706; }
    .cred-badge-info { background: #cffafe; color: #0891b2; }
    .cred-badge-cebroker { background: #e0e7ff; color: #6366f1; }

    .cred-tracker-note.cred-note-info { background: #ecfeff; border-left-color: #06b6d4; }
    .cred-tracker-note.cred-note-dark { background: #f1f5f9; border-left-color: #475569; }

    .cred-tracker-none { font-size: 0.85rem; color: var(--text-secondary); font-style: italic; padding: 12px; text-align: center; }
    .cred-tracker-none.cred-none-good { color: #059669; background: #d1fae5; border-radius: 8px; font-style: normal; font-weight: 600; }

    [data-theme="dark"] .cred-tracker-summary { background: var(--bg-tertiary); }
    [data-theme="dark"] .cred-summary-total { background: rgba(100, 116, 139, 0.2); }
    [data-theme="dark"] .cred-summary-configured { background: rgba(59, 130, 246, 0.2); }
    [data-theme="dark"] .cred-summary-nocreds { background: rgba(239, 68, 68, 0.2); }
    [data-theme="dark"] .cred-summary-nocourses { background: rgba(245, 158, 11, 0.2); }
    [data-theme="dark"] .cred-summary-nohistory { background: rgba(100, 116, 139, 0.2); }
    [data-theme="dark"] .cred-tracker-note { background: rgba(245, 158, 11, 0.15); }
    [data-theme="dark"] .cred-tracker-note.cred-note-good { background: rgba(16, 185, 129, 0.15); }
    [data-theme="dark"] .cred-tracker-note.cred-note-danger { background: rgba(239, 68, 68, 0.15); }
    [data-theme="dark"] .cred-tracker-note.cred-note-warning { background: rgba(245, 158, 11, 0.15); }
    [data-theme="dark"] .cred-tracker-note.cred-note-info { background: rgba(6, 182, 212, 0.15); }
    [data-theme="dark"] .cred-tracker-note.cred-note-dark { background: rgba(71, 85, 105, 0.2); }
    [data-theme="dark"] .cred-tracker-chip.cred-chip-danger { background: rgba(239, 68, 68, 0.2); }
    [data-theme="dark"] .cred-tracker-item.cred-item-warning { background: rgba(245, 158, 11, 0.15); }
    [data-theme="dark"] .cred-tracker-item.cred-item-danger { background: rgba(239, 68, 68, 0.15); }
    [data-theme="dark"] .cred-tracker-item.cred-item-info { background: rgba(6, 182, 212, 0.15); }
    [data-theme="dark"] .cred-tracker-none.cred-none-good { background: rgba(16, 185, 129, 0.2); }
    [data-theme="dark"] .cred-badge-danger { background: rgba(239, 68, 68, 0.3); }
    [data-theme="dark"] .cred-badge-warning { background: rgba(245, 158, 11, 0.3); }
    [data-theme="dark"] .cred-badge-info { background: rgba(6, 182, 212, 0.3); }
    [data-theme="dark"] .cred-badge-cebroker { background: rgba(99, 102, 241, 0.3); }

    /* ─ Help Page ─ */
    .help-page { padding: 24px 40px; max-width: 1000px; }
    .help-header { margin-bottom: 32px; }
    .help-header h1 { font-size: 2rem; font-weight: 800; color: var(--text-primary); margin: 0 0 8px; }
    .help-subtitle { font-size: 1rem; color: var(--text-secondary); margin: 0; }
    .help-section { background: var(--bg-primary); border-radius: 16px; padding: 24px; margin-bottom: 24px; box-shadow: var(--shadow-sm); }
    .help-section-title { display: flex; align-items: center; gap: 10px; font-size: 1.2rem; font-weight: 700; color: var(--text-primary); margin: 0 0 20px; padding-bottom: 12px; border-bottom: 2px solid var(--border-color); }
    .help-icon { font-size: 1.3rem; }
    .help-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .help-card { padding: 16px; border-radius: 12px; border: 1px solid var(--border-color); }
    .help-card-complete { background: #f0fdf4; border-color: #bbf7d0; }
    .help-card-progress { background: #fffbeb; border-color: #fde68a; }
    .help-card-risk { background: #fef2f2; border-color: #fecaca; }
    .help-card-unknown { background: #fff7ed; border-color: #fed7aa; }
    .help-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .help-card p { font-size: 0.85rem; color: var(--text-secondary); margin: 0; line-height: 1.5; }
    .help-status-dot { width: 12px; height: 12px; border-radius: 50%; }
    .help-status-dot.complete { background: #10b981; }
    .help-status-dot.progress { background: #f59e0b; }
    .help-status-dot.risk { background: #ef4444; }
    .help-status-dot.unknown { background: #f97316; }
    .help-content { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.7; }
    .help-content h3 { font-size: 1rem; font-weight: 700; color: var(--text-primary); margin: 0 0 8px; }
    .help-content ul { margin: 8px 0 16px; padding-left: 20px; }
    .help-content li { margin: 6px 0; }
    .help-note { font-size: 0.8rem; background: #eff6ff; padding: 10px 14px; border-radius: 8px; border-left: 3px solid #3b82f6; margin-top: 12px; }
    .help-source { margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px dashed var(--border-color); }
    .help-source:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
    .help-type-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .help-type-card { padding: 20px; border-radius: 12px; border: 2px solid var(--border-color); }
    .help-type-card.clinical { border-left: 4px solid #3b82f6; background: #eff6ff; }
    .help-type-card.support { border-left: 4px solid #f59e0b; background: #fffbeb; }
    .help-type-header { margin-bottom: 8px; }
    .help-type-badge { font-size: 0.7rem; font-weight: 700; padding: 3px 10px; border-radius: 99px; text-transform: uppercase; }
    .help-type-badge.clinical { background: #dbeafe; color: #1d4ed8; }
    .help-type-badge.support { background: #fef3c7; color: #d97706; }
    .help-type-card h3 { margin: 8px 0; font-size: 1.1rem; color: var(--text-primary); }
    .help-type-card p { font-size: 0.85rem; color: var(--text-secondary); margin: 0 0 12px; }
    .help-type-card ul { margin: 0; padding-left: 18px; font-size: 0.85rem; }
    .help-email-info { margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 12px; }
    .help-email-info:last-child { margin-bottom: 0; }
    .help-email-info h3 { margin: 0 0 10px; }
    .help-email-info ul { margin: 8px 0; }
    .help-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .help-table th { text-align: left; padding: 12px; background: var(--bg-secondary); font-weight: 600; color: var(--text-secondary); border-bottom: 2px solid var(--border-color); }
    .help-table td { padding: 12px; border-bottom: 1px solid var(--border-color); }
    .help-badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 3px 10px; border-radius: 6px; }
    .help-badge-green { background: #d1fae5; color: #059669; }
    .help-badge-yellow { background: #fef3c7; color: #d97706; }
    .help-badge-orange { background: #fed7aa; color: #ea580c; }
    .help-badge-red { background: #fecaca; color: #dc2626; }
    .help-badge-gray { background: #e2e8f0; color: #64748b; }
    .help-formula { display: flex; flex-direction: column; gap: 16px; }
    .help-formula-step { display: flex; align-items: flex-start; gap: 16px; padding: 16px; background: var(--bg-secondary); border-radius: 12px; }
    .help-step-num { width: 32px; height: 32px; background: #3b82f6; color: #fff; font-weight: 700; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .help-step-content { flex: 1; }
    .help-step-content strong { display: block; margin-bottom: 4px; color: var(--text-primary); }
    .help-step-content p { margin: 0; font-size: 0.85rem; }
    .help-step-content ul { margin: 8px 0 0; padding-left: 18px; font-size: 0.85rem; }
    .help-status { font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .help-status.complete { background: #d1fae5; color: #059669; }
    .help-status.progress { background: #fef3c7; color: #d97706; }
    .help-status.risk { background: #fecaca; color: #dc2626; }
    .help-schedule { display: flex; flex-direction: column; gap: 12px; }
    .help-schedule-item { display: flex; align-items: center; gap: 16px; padding: 14px 18px; background: var(--bg-secondary); border-radius: 10px; }
    .help-schedule-time { font-weight: 700; color: #3b82f6; min-width: 180px; }
    .help-schedule-desc { color: var(--text-secondary); }
    .help-faq { display: flex; flex-direction: column; gap: 16px; }
    .help-faq-item { padding: 16px; background: var(--bg-secondary); border-radius: 12px; }
    .help-faq-item h4 { margin: 0 0 8px; font-size: 0.95rem; color: var(--text-primary); }
    .help-faq-item p { margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.6; }
    [data-theme="dark"] .help-card-complete { background: rgba(16, 185, 129, 0.15); border-color: #166534; }
    [data-theme="dark"] .help-card-progress { background: rgba(245, 158, 11, 0.15); border-color: #92400e; }
    [data-theme="dark"] .help-card-risk { background: rgba(239, 68, 68, 0.15); border-color: #991b1b; }
    [data-theme="dark"] .help-card-unknown { background: rgba(249, 115, 22, 0.15); border-color: #9a3412; }
    [data-theme="dark"] .help-note { background: rgba(59, 130, 246, 0.15); border-color: #3b82f6; }
    [data-theme="dark"] .help-type-card.clinical { background: rgba(59, 130, 246, 0.1); }
    [data-theme="dark"] .help-type-card.support { background: rgba(245, 158, 11, 0.1); }
    @media (max-width: 768px) {
      .help-page { padding: 16px; }
      .help-section { padding: 16px; }
      .help-header h1 { font-size: 1.5rem; }
      .help-cards { grid-template-columns: 1fr; }
      .help-type-grid { grid-template-columns: 1fr; }
      .help-table { font-size: 0.75rem; }
      .help-table th, .help-table td { padding: 8px; }
      .help-schedule-item { flex-direction: column; align-items: flex-start; gap: 4px; }
      .help-schedule-time { min-width: auto; }
    }
    [data-theme="dark"] .error-log-item { background: rgba(254, 242, 242, 0.1); }

    /* ─ Mobile (768px and below) ─ */
    @media (max-width: 768px) {
      header {
        padding: 16px; flex-direction: column; align-items: flex-start; gap: 8px;
      }
      .header-logo  { height: 30px; }
      .header-brand { gap: 10px; }
      header h1 { font-size: 1.1rem; }
      .header-meta { text-align: left; }
      .run-badge { justify-content: flex-start; }

      .stats { padding: 16px 16px 0; gap: 10px; }
      .stats-cards { grid-template-columns: repeat(2, 1fr); padding: 0 16px 16px; gap: 10px; }
      .stat-card { min-width: calc(50% - 5px); flex: 1; padding: 12px 14px; }
      .stat-card .stat-number { font-size: 1.8rem; }
      .stat-card .stat-icon { font-size: 1.8rem; right: 10px; }
      .stat-card .num { font-size: 1.5rem; }

      .cards-grid { padding-left: 16px; padding-right: 16px; grid-template-columns: 1fr; gap: 12px; }
      .section-title { padding-left: 16px; padding-right: 16px; }
      .state-chips    { padding-left: 16px; padding-right: 16px; }
      .controls { padding-left: 16px; padding-right: 16px; flex-wrap: wrap; }
      .search-box { width: 100%; }

      .tab-bar { padding-left: 16px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .tab-btn { flex-shrink: 0; padding: 10px 15px; font-size: 0.82rem; }

      .table-wrap { padding: 0 0 16px; }
      .run-table-wrap { padding: 0 0 24px; }
      table { font-size: 0.78rem; }
      td, th { padding: 7px 10px; }

      .chart-wrap { padding-left: 16px; padding-right: 16px; }
      .cal-wrap   { padding: 12px 16px 32px; }
      .cal-month  { padding: 14px 16px; }
      .cal-entry  { flex-direction: column; align-items: flex-start; gap: 6px; }
      .cal-entry-right { width: 100%; justify-content: flex-start; }

      /* Drawer: bottom-sheet on mobile */
      .drawer-overlay { padding: 0; align-items: flex-end; }
      .drawer-panel {
        border-radius: 20px 20px 0 0; max-height: 90vh;
        overflow-y: auto; padding: 24px 16px 32px;
        margin: 0; width: 100%; max-width: 100%;
        animation: slideUp .22s ease;
      }
      .drawer-close { top: 16px; right: 16px; }
      .print-btn    { top: 16px; right: 58px; padding: 5px 10px; font-size: 0.72rem; }
      .detail-sa-table { font-size: 0.72rem; }
      .detail-sa-table th, .detail-sa-table td { padding: 5px 7px; }
      .course-list { max-height: 220px; }
      .platform-overview-grid { padding: 0 16px; gap: 10px; }
      .coverage-wrap { padding: 0 16px 28px; }
      .coverage-gaps-box { margin: 0 16px 28px; padding: 16px; }
      .action-required-box { margin: 0 16px 28px; }
      .action-section { padding: 14px 16px; }
      .deadlines-container { grid-template-columns: 1fr; padding: 0 16px 16px; }
      .deadline-item { grid-template-columns: 1fr auto auto; }
      .di-date { display: none; }
      .login-errors-box, .missing-creds-box { margin: 0 16px 16px; padding: 14px 16px; }
      .error-item { flex-direction: column; align-items: flex-start; gap: 4px; }
      .error-msg { max-width: 100%; text-align: left; }
      .profiles-header { padding: 0 16px 12px; }
      .sub-tabs { flex-wrap: wrap; }
      .sub-tab { padding: 8px 14px; font-size: 0.8rem; }
      .controls { flex-wrap: wrap; }
      .control-group { width: 100%; margin-top: 8px; }
      .sort-select { flex: 1; }
      .about-box { margin: 0 16px 8px; padding: 16px; }
      .chart-canvas-wrap { height: 260px; }
      .poc { padding: 12px 14px; }

      /* Status page mobile */
      .status-page { padding: 16px; }
      .status-section { padding: 16px; }
      .status-cards-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .status-card { padding: 12px; }
      .status-card-value { font-size: 1.2rem; }
      .health-summary { gap: 10px; }
      .health-stat { min-width: 70px; padding: 12px 8px; }
      .health-num { font-size: 1.5rem; }
      .health-issue-item { flex-direction: column; align-items: flex-start; gap: 8px; }
      .health-issue-details { text-align: left; width: 100%; }
      .health-issue-error { max-width: 100%; white-space: normal; }
      .error-log-item { flex-direction: column; align-items: flex-start; gap: 6px; }
      .error-log-msg { white-space: normal; }
      .scheduler-item { flex-direction: column; align-items: flex-start; gap: 4px; }

      /* History log mobile */
      .history-item { flex-direction: column; align-items: flex-start; gap: 8px; }
      .history-time { display: flex; gap: 8px; align-items: center; }
      .history-date { display: inline; }
      .history-stats { flex-wrap: wrap; }

      /* Global search mobile */
      .global-search { width: 140px; font-size: 0.8rem; padding: 8px 12px; }
      .global-search:focus { width: 200px; }
      .global-search-results { left: auto; right: 0; width: 280px; }

      /* Bulk selection mobile */
      .bulk-controls { width: 100%; margin-left: 0; padding-left: 0; border-left: none; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.2); }
      .bulk-select-cb { width: 22px; height: 22px; }
      .view-toggle-bar { gap: 6px; padding: 16px 16px 0; }
      .view-toggle { padding: 6px 12px; font-size: 0.75rem; }
      .export-btn { padding: 6px 12px; font-size: 0.75rem; }
      .bulk-btn { padding: 5px 10px; font-size: 0.75rem; }
      .bulk-count { font-size: 0.75rem; min-width: auto; }

      /* Improved mobile navigation */
      .sidebar { width: 100%; transform: translateX(-100%); }
      .sidebar.open { transform: translateX(0); }
      .nav-item { padding: 14px 16px; }
      .nav-label { font-size: 0.95rem; }

      /* Better touch targets */
      .provider-card { padding: 16px; }
      .stat-card { min-height: 90px; }
      button, .btn { min-height: 44px; }

      /* Coverage matrix mobile */
      .matrix-wrap { padding: 0 16px; }
      .coverage-matrix { font-size: 0.75rem; }
      .coverage-matrix th, .coverage-matrix td { padding: 8px 6px; }
      .coverage-matrix th { font-size: 0.65rem; }
      .cov-score { font-size: 0.75rem; }
      .cov-score-bar { width: 40px; }
      .cov-summary-num { font-size: 0.85rem; }
      .cov-summary-pct { font-size: 0.6rem; }

      /* Action banner mobile */
      .action-banner { margin: 16px; padding: 16px; }
      .action-banner-title { font-size: 0.95rem; }
      .action-banner-grid { grid-template-columns: 1fr; gap: 12px; }
      .action-item-card { padding: 14px; }
      .action-item-icon { width: 36px; height: 36px; font-size: 1rem; }
      .action-item-value { font-size: 1.2rem; }
      .action-item-label { font-size: 0.8rem; }
      .action-item-detail { font-size: 0.72rem; }
      .action-provider-chip { font-size: 0.68rem; padding: 2px 6px; }

      /* Quick filters mobile */
      .quick-filters { padding: 12px 16px; gap: 8px; flex-wrap: wrap; }
      .quick-filter-btn { padding: 6px 12px; font-size: 0.75rem; }
      .qf-count { padding: 2px 5px; font-size: 0.65rem; }

      /* Providers filter bar mobile */
      .providers-filter-bar { padding: 12px 16px; gap: 8px; top: 50px; }
      .providers-filter-bar .search-box { min-width: 100%; padding: 8px 12px; font-size: 0.85rem; }
      .providers-filter-bar .filter-select { min-width: calc(50% - 4px); padding: 8px 10px; font-size: 0.82rem; }
      .advanced-filter-toggle { padding: 8px 12px; font-size: 0.8rem; }

      /* Platform cards mobile */
      .platform-summary-grid { padding: 0 16px; grid-template-columns: 1fr; }
      .credential-gaps-grid { padding: 0 16px; grid-template-columns: 1fr; }
    }

    /* ─ Print / Export PDF ─ */
    @media print {
      body > *:not(.drawer-overlay) { display: none !important; }
      .drawer-overlay {
        display: block !important; position: static !important;
        background: none !important; padding: 0 !important; overflow: visible !important;
      }
      .drawer-panel {
        box-shadow: none !important; max-width: 100% !important; width: 100% !important;
        animation: none !important; padding: 24px !important;
        margin: 0 !important; border-radius: 0 !important;
        max-height: none !important; overflow: visible !important;
      }
      .drawer-close, .print-btn { display: none !important; }
      .course-list { max-height: none !important; overflow: visible !important; }
      .detail-lic-card { break-inside: avoid; }
    }

    /* ─ Platform CEU Accounts section ─ */
    .platform-section { margin-top: 24px; }
    .platform-section-title {
      font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.7px; color: #64748b; margin-bottom: 12px;
      padding-bottom: 6px; border-bottom: 1px solid #e2e8f0;
    }
    .platform-cards { display: flex; flex-wrap: wrap; gap: 12px; }
    .platform-card {
      flex: 1 1 260px; border: 1px solid #e2e8f0; border-radius: 10px;
      overflow: hidden; background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.06);
    }
    .platform-card-hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; font-size: 0.8rem; font-weight: 700; color: #fff;
    }
    .platform-card.plat-netce   .platform-card-hdr { background: #10b981; }
    .platform-card.plat-ceufast .platform-card-hdr { background: #7c3aed; }
    .platform-card.plat-aanp    .platform-card-hdr { background: #1d4ed8; }
    .platform-card.plat-error   .platform-card-hdr { background: #64748b; }
    .platform-hdr-status {
      font-size: 0.72rem; font-weight: 600; padding: 2px 8px;
      border-radius: 99px; background: rgba(255,255,255,.25);
    }
    .platform-card-body { padding: 12px; }
    .platform-hours-row {
      display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px;
    }
    .platform-hours-big { font-size: 1.5rem; font-weight: 700; color: #1e3a8a; }
    .platform-hours-lbl { font-size: 0.75rem; color: #64748b; }
    .platform-prog-wrap { margin-bottom: 10px; }
    .platform-prog-row {
      display: flex; justify-content: space-between;
      font-size: 0.72rem; color: #64748b; margin-bottom: 4px;
    }
    .platform-prog-track {
      height: 7px; background: #e2e8f0; border-radius: 99px; overflow: hidden;
    }
    .platform-prog-fill {
      height: 100%; border-radius: 99px; background: #1d4ed8;
      transition: width .4s ease;
    }
    .platform-prog-fill.pp-complete { background: #16a34a; }
    .platform-cert-row {
      font-size: 0.78rem; color: #475569; margin-bottom: 6px; display: flex; gap: 8px; flex-wrap: wrap;
    }
    .platform-cert-status {
      font-weight: 600; padding: 1px 8px; border-radius: 99px; font-size: 0.72rem;
    }
    .platform-cert-status.cert-active   { background: #dcfce7; color: #166534; }
    .platform-cert-status.cert-inactive { background: #fee2e2; color: #7f1d1d; }
    .platform-courses-title {
      font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 6px;
    }
    .platform-course-list { display: flex; flex-direction: column; gap: 4px; }
    .platform-course-item {
      font-size: 0.75rem; color: #475569; display: flex;
      justify-content: space-between; gap: 8px; align-items: baseline;
      padding: 3px 0; border-bottom: 1px solid #f1f5f9;
    }
    .platform-course-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .platform-course-meta { color: #94a3b8; white-space: nowrap; font-size: 0.7rem; }
    .platform-error-msg { font-size: 0.75rem; color: #ef4444; font-style: italic; padding: 8px 0; }
    .platform-updated { font-size: 0.68rem; color: #94a3b8; padding: 6px 12px; border-top: 1px solid #f1f5f9; }
    .platform-no-courses { font-size: 0.75rem; color: #94a3b8; font-style: italic; }

    /* ─ Lookback Compliance Section ─ */
    .lookback-section { margin-top: 20px; padding: 16px; background: #fefce8; border-radius: 12px; border: 1px solid #fef08a; }
    .lookback-section-title { font-size: 0.85rem; font-weight: 700; color: #854d0e; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .lookback-section-title::before { content: '⏱'; }
    .lookback-req-group { margin-bottom: 16px; }
    .lookback-req-group:last-child { margin-bottom: 0; }
    .lookback-req-title { font-size: 0.78rem; font-weight: 600; color: #713f12; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #fde68a; }
    .lookback-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .lookback-table th { text-align: left; padding: 6px 8px; background: #fef9c3; color: #854d0e; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.3px; }
    .lookback-table td { padding: 8px; border-bottom: 1px solid #fef08a; }
    .lookback-table tr:last-child td { border-bottom: none; }
    .lb-subject { font-weight: 500; color: #1e293b; }
    .lb-required { color: #64748b; }
    .lb-total { color: #64748b; }
    .lb-valid { color: #1e293b; font-weight: 500; }
    .lb-window { font-size: 0.68rem; color: #94a3b8; font-weight: 400; margin-left: 4px; }
    .lb-status { font-weight: 600; white-space: nowrap; }
    .lb-status.lb-met { color: #16a34a; }
    .lb-status.lb-partial { color: #f59e0b; }
    .lb-status.lb-none { color: #ef4444; }

    /* ─ Spending Section ─ */
    .spending-section { margin-top: 20px; padding: 16px; background: #f0fdf4; border-radius: 12px; border: 1px solid #bbf7d0; }
    .spending-section-title { font-size: 0.85rem; font-weight: 700; color: #166534; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .spending-section-title::before { content: '$'; font-family: monospace; }
    .spending-no-data { font-size: 0.78rem; color: #64748b; font-style: italic; }
    .spending-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .spending-stat { text-align: center; padding: 12px 8px; background: white; border-radius: 8px; border: 1px solid #dcfce7; }
    .spending-stat-value { display: block; font-size: 1.1rem; font-weight: 700; color: #166534; }
    .spending-stat-label { display: block; font-size: 0.68rem; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
    .spending-orders { margin-top: 12px; }
    .spending-orders-title { font-size: 0.75rem; font-weight: 600; color: #166534; margin-bottom: 8px; }
    .spending-order-item { display: flex; justify-content: space-between; padding: 6px 8px; background: white; border-radius: 4px; margin-bottom: 4px; font-size: 0.78rem; }
    .spending-order-date { color: #64748b; }
    .spending-order-total { font-weight: 600; color: #166534; }
    .spending-more { font-size: 0.72rem; color: #94a3b8; font-style: italic; padding: 4px 8px; }
    .spending-stat-total { border-color: #16a34a; background: #f0fdf4; }
    .spending-stat-total .spending-stat-value { font-size: 1.3rem; }

    /* Platform Breakdown Bars */
    .spending-platform-breakdown { margin-top: 16px; padding-top: 12px; border-top: 1px solid #dcfce7; }
    .spending-breakdown-title { font-size: 0.75rem; font-weight: 600; color: #166534; margin-bottom: 10px; }
    .spending-platform-row { display: grid; grid-template-columns: 100px 1fr 70px 80px; gap: 8px; align-items: center; padding: 6px 0; font-size: 0.78rem; }
    .spending-platform-name { font-weight: 500; color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .spending-platform-bar-track { height: 8px; background: #e2e8f0; border-radius: 99px; overflow: hidden; }
    .spending-platform-bar-fill { height: 100%; border-radius: 99px; transition: width 0.3s ease; }
    .spending-platform-amount { font-weight: 600; color: #166534; text-align: right; }
    .spending-platform-count { color: #64748b; font-size: 0.72rem; text-align: right; }

    /* Efficiency Indicators */
    .spending-stat.efficiency-great { border-color: #059669; background: linear-gradient(135deg, #f0fdf4, #dcfce7); }
    .spending-stat.efficiency-great .spending-stat-value { color: #059669; }
    .spending-stat.efficiency-good { border-color: #14b8a6; }
    .spending-stat.efficiency-good .spending-stat-value { color: #14b8a6; }
    .spending-stat.efficiency-fair { border-color: #f59e0b; }
    .spending-stat.efficiency-fair .spending-stat-value { color: #d97706; }
    .spending-stat.efficiency-poor { border-color: #ef4444; background: #fef2f2; }
    .spending-stat.efficiency-poor .spending-stat-value { color: #dc2626; }
    .spending-efficiency-label { display: block; font-size: 0.65rem; color: #64748b; margin-top: 2px; font-style: italic; }

    /* Dark mode for spending section */
    [data-theme="dark"] .spending-section { background: rgba(16, 185, 129, 0.1); border-color: #065f46; }
    [data-theme="dark"] .spending-section-title { color: #34d399; }
    [data-theme="dark"] .spending-stat { background: #1e293b; border-color: #065f46; }
    [data-theme="dark"] .spending-stat-value { color: #34d399; }
    [data-theme="dark"] .spending-platform-bar-track { background: #334155; }
    [data-theme="dark"] .spending-platform-name { color: #e2e8f0; }
    [data-theme="dark"] .spending-order-item { background: #1e293b; }
    [data-theme="dark"] .spending-order-total { color: #34d399; }

    /* ─ Platform Coverage Tab ─ */
    .platform-view { display: none; padding: 20px 0; }
    .platform-view.active { display: block; }

    /* Matrix legend */
    .matrix-legend { display: flex; gap: 20px; padding: 16px 40px; font-size: 0.85rem; color: #64748b; }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .legend-dot.cov-yes { background: #dcfce7; border: 1px solid #16a34a; }
    .legend-dot.cov-fail { background: #fee2e2; border: 1px solid #ef4444; }
    .legend-dot.cov-no { background: #f1f5f9; border: 1px solid #cbd5e1; }

    /* Coverage matrix table */
    .matrix-wrap { padding: 0 40px; overflow-x: auto; }
    .coverage-matrix { width: 100%; border-collapse: collapse; font-size: 0.85rem; border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-md); }
    .coverage-matrix th, .coverage-matrix td { padding: 14px 18px; text-align: center; border: 1px solid var(--border-color); }
    .coverage-matrix th { background: linear-gradient(135deg, #1e3a5f, #1e1b4b); color: #fff; font-weight: 700; white-space: nowrap; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; }
    .coverage-matrix .cov-provider-hdr { text-align: left; }
    .coverage-matrix .cov-provider { text-align: left; font-weight: 600; cursor: pointer; color: var(--accent-primary); }
    .coverage-matrix .cov-provider:hover { text-decoration: underline; }
    .coverage-matrix .cov-yes { background: linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.1)); color: #059669; font-weight: 700; }
    .coverage-matrix .cov-fail { background: linear-gradient(135deg, rgba(239,68,68,0.15), rgba(248,113,113,0.1)); color: #dc2626; font-weight: 700; }
    .coverage-matrix .cov-no { background: var(--bg-secondary); color: #94a3b8; }
    .coverage-matrix tbody tr { transition: all var(--transition-fast); }
    .coverage-matrix tbody tr:hover { transform: scale(1.005); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .coverage-matrix tbody tr:hover .cov-yes { background: linear-gradient(135deg, rgba(16,185,129,0.25), rgba(52,211,153,0.2)); }
    .coverage-matrix tbody tr:hover .cov-fail { background: linear-gradient(135deg, rgba(239,68,68,0.25), rgba(248,113,113,0.2)); }
    .coverage-matrix tbody tr:hover .cov-no { background: var(--bg-tertiary); }
    /* Row coverage level color-coding */
    .coverage-matrix tbody tr.cov-row-full { background: rgba(16,185,129,0.05); }
    .coverage-matrix tbody tr.cov-row-good { background: rgba(6,182,212,0.05); }
    .coverage-matrix tbody tr.cov-row-partial { background: rgba(245,158,11,0.05); }
    .coverage-matrix tbody tr.cov-row-minimal { background: rgba(239,68,68,0.05); }
    .coverage-matrix tbody tr.cov-row-none { background: rgba(239,68,68,0.1); }
    /* Coverage score column */
    .cov-score { font-weight: 800; font-size: 0.9rem; }
    .cov-score-full { color: #059669; }
    .cov-score-good { color: #0891b2; }
    .cov-score-partial { color: #d97706; }
    .cov-score-low { color: #dc2626; }
    .cov-score-bar { width: 60px; height: 6px; background: var(--bg-tertiary); border-radius: 99px; margin: 4px auto 0; overflow: hidden; }
    .cov-score-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }
    .cov-score-fill.fill-full { background: linear-gradient(90deg, #059669, #10b981); }
    .cov-score-fill.fill-good { background: linear-gradient(90deg, #0891b2, #06b6d4); }
    .cov-score-fill.fill-partial { background: linear-gradient(90deg, #d97706, #f59e0b); }
    .cov-score-fill.fill-low { background: linear-gradient(90deg, #dc2626, #ef4444); }
    /* Summary footer row */
    .coverage-matrix tfoot td { background: linear-gradient(135deg, #f8fafc, #f1f5f9); font-weight: 700; font-size: 0.8rem; border-top: 2px solid var(--border-color); }
    .coverage-matrix tfoot .cov-summary-label { text-align: left; color: var(--text-primary); }
    .cov-summary-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .cov-summary-num { font-size: 1rem; font-weight: 800; }
    .cov-summary-num.sum-green { color: #059669; }
    .cov-summary-num.sum-red { color: #dc2626; }
    .cov-summary-num.sum-gray { color: #64748b; }
    .cov-summary-pct { font-size: 0.7rem; color: var(--text-secondary); }

    /* Platform summary cards */
    .platform-summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; padding: 0 40px; }
    .platform-summary-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.08); border-top: 4px solid #cbd5e1; }
    .platform-summary-card.plat-card-netce { border-top-color: #10b981; }
    .platform-summary-card.plat-card-ceufast { border-top-color: #7c3aed; }
    .platform-summary-card.plat-card-aanp { border-top-color: #1d4ed8; }
    .platform-summary-card.plat-card-excl { border-top-color: #f59e0b; }
    .plat-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .plat-name { font-size: 1.1rem; font-weight: 700; color: #1e293b; }
    .plat-link { color: #64748b; text-decoration: none; font-size: 1rem; }
    .plat-link:hover { color: #1d4ed8; }
    .plat-stats { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .plat-stat { display: flex; flex-direction: column; align-items: center; min-width: 60px; }
    .plat-stat-num { font-size: 1.5rem; font-weight: 700; color: #1e293b; }
    .plat-stat-num.plat-stat-success { color: #16a34a; }
    .plat-stat-num.plat-stat-fail { color: #ef4444; }
    .plat-stat-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; }
    .plat-providers-section { border-top: 1px solid #e2e8f0; padding-top: 12px; }
    .plat-providers-title { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 8px; }
    .plat-providers-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .plat-provider-chip { padding: 4px 10px; background: #f1f5f9; border-radius: 99px; font-size: 0.78rem; color: #475569; cursor: pointer; transition: all .15s; }
    .plat-provider-chip:hover { background: #e0f2fe; color: #0369a1; }
    .no-providers { font-size: 0.85rem; color: #94a3b8; font-style: italic; }

    /* ─ Credential Gaps View ─ */
    .credential-gaps-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 20px; padding: 0 40px; }
    .cred-gap-card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .cred-gap-header { display: flex; align-items: center; gap: 10px; padding: 16px 20px; color: #fff; }
    .cred-gap-header.cred-gap-cebroker { background: linear-gradient(135deg, #ef4444 0%, #991b1b 100%); }
    .cred-gap-header.cred-gap-netce { background: linear-gradient(135deg, #f59e0b 0%, #92400e 100%); }
    .cred-gap-header.cred-gap-complete { background: linear-gradient(135deg, #16a34a 0%, #166534 100%); }
    .cred-gap-icon { font-size: 1.3rem; }
    .cred-gap-title { flex: 1; font-weight: 600; font-size: 0.95rem; }
    .cred-gap-count { background: rgba(255,255,255,.25); padding: 4px 12px; border-radius: 99px; font-weight: 700; font-size: 0.9rem; }
    .cred-gap-body { padding: 16px 20px; }
    .cred-gap-subtitle { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 8px; }
    .cred-gap-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .cred-gap-chip { padding: 6px 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; font-size: 0.82rem; color: #991b1b; cursor: pointer; transition: all .15s; }
    .cred-gap-chip:hover { background: #fee2e2; transform: translateY(-1px); }
    .cred-gap-chip small { color: #dc2626; opacity: 0.7; }
    .cred-gap-chip.cred-gap-chip-none { background: #f1f5f9; border-color: #cbd5e1; color: #64748b; }
    .cred-gap-chip.cred-gap-chip-none small { color: #94a3b8; }
    .cred-gap-chip.cred-gap-chip-none:hover { background: #e2e8f0; }
    .cred-gap-chip.cred-gap-chip-complete { background: #dcfce7; border-color: #86efac; color: #166534; }
    .cred-gap-chip.cred-gap-chip-complete small { color: #16a34a; }
    .cred-gap-chip.cred-gap-chip-complete:hover { background: #bbf7d0; }
    .cred-gap-none { font-size: 0.85rem; color: #94a3b8; font-style: italic; }

    /* ─ Provider View Styles ─ */
    .provider-view { display: none; padding: 0 40px 24px; }
    .provider-view.active { display: block; }
    .export-btn { padding: 8px 16px; background: #059669; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 600; margin-left: auto; }
    .export-btn:hover { background: #047857; }
    .export-btn:disabled { background: #94a3b8; cursor: not-allowed; opacity: 0.6; }
    .export-btn.pdf-btn { background: #dc2626; }
    .export-btn.pdf-btn:hover { background: #b91c1c; }
    .export-btn.pdf-btn:disabled { background: #94a3b8; }

    /* ─ Bulk Selection Controls ─ */
    .bulk-controls { display: flex; align-items: center; gap: 8px; margin-left: 16px; padding-left: 16px; border-left: 1px solid rgba(255,255,255,0.2); }
    .bulk-btn { padding: 6px 12px; background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.3); border-radius: 6px; cursor: pointer; font-size: 0.8rem; transition: all 0.2s; }
    .bulk-btn:hover { background: rgba(255,255,255,0.25); }
    .bulk-count { font-size: 0.85rem; color: rgba(255,255,255,0.8); min-width: 80px; }
    .bulk-count.has-selection { color: #10b981; font-weight: 600; }
    .bulk-export-btn { margin-left: 0; }

    /* ─ Bulk Selection Checkbox ─ */
    .bulk-select-cb { width: 18px; height: 18px; cursor: pointer; accent-color: #3b82f6; margin-right: 4px; flex-shrink: 0; }
    .provider-card.selected { box-shadow: 0 0 0 2px #3b82f6, var(--shadow-md); }

    /* ─ Deadline Buckets ─ */
    .deadline-buckets { display: flex; flex-direction: column; gap: 24px; }
    .deadline-bucket { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.07); overflow: hidden; }
    .bucket-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
    .bucket-header.bucket-urgent { background: linear-gradient(90deg, #fef2f2 0%, #fff 100%); border-left: 4px solid #ef4444; }
    .bucket-header.bucket-warning { background: linear-gradient(90deg, #fffbeb 0%, #fff 100%); border-left: 4px solid #f59e0b; }
    .bucket-header.bucket-upcoming { background: linear-gradient(90deg, #f0fdf4 0%, #fff 100%); border-left: 4px solid #16a34a; }
    .bucket-badge { padding: 4px 12px; border-radius: 99px; font-size: 0.75rem; font-weight: 700; }
    .bucket-urgent .bucket-badge { background: #ef4444; color: #fff; }
    .bucket-warning .bucket-badge { background: #f59e0b; color: #fff; }
    .bucket-upcoming .bucket-badge { background: #16a34a; color: #fff; }
    .bucket-title { font-weight: 700; color: #0f172a; flex: 1; }
    .bucket-count { font-size: 0.85rem; color: #64748b; }
    .bucket-cards { padding: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .empty-bucket { padding: 24px; text-align: center; color: #94a3b8; font-size: 0.9rem; }

    /* ─ State Groups ─ */
    .state-groups { display: flex; flex-direction: column; gap: 24px; }
    .state-group { background: var(--bg-primary); border-radius: 12px; box-shadow: var(--shadow-sm); overflow: hidden; }
    .state-group-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }
    .state-name { font-weight: 800; font-size: 1.1rem; color: var(--text-primary); min-width: 120px; }
    .state-mini-stats { display: flex; gap: 8px; flex: 1; flex-wrap: wrap; }
    .mini-stat { padding: 2px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .mini-stat.risk { background: var(--status-red-bg); color: var(--status-red); }
    .mini-stat.progress { background: var(--status-amber-bg); color: var(--status-amber); }
    .mini-stat.complete { background: var(--status-green-bg); color: var(--status-green); }
    .state-provider-count { font-size: 0.85rem; color: var(--text-secondary); white-space: nowrap; }
    .state-cards { padding: 16px; }

    /* ─ Collapsible Groups ─ */
    .collapsible .state-group-header,
    .collapsible .type-group-header { cursor: pointer; user-select: none; }
    .collapsible .state-group-header:hover,
    .collapsible .type-group-header:hover { background: var(--bg-tertiary); }
    .collapse-icon { font-size: 0.75rem; color: var(--text-secondary); transition: transform 0.2s; }
    .collapsible.collapsed .collapse-icon { transform: rotate(-90deg); }
    .collapsible-content { transition: max-height 0.3s ease, padding 0.3s ease, opacity 0.2s ease; overflow: hidden; }
    .collapsible.collapsed .collapsible-content { max-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; opacity: 0; }

    /* ─ Type Groups ─ */
    .type-groups { display: flex; flex-direction: column; gap: 24px; }
    .type-group { background: var(--bg-primary); border-radius: 12px; box-shadow: var(--shadow-sm); overflow: hidden; }
    .type-group-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }
    .type-name { font-weight: 800; font-size: 1.1rem; color: var(--text-primary); }
    .type-icon { font-size: 1.2rem; }
    .type-role-badge { font-size: 0.72rem; font-weight: 600; padding: 3px 10px; border-radius: 99px; text-transform: uppercase; letter-spacing: 0.3px; }
    .type-role-badge.role-clinical { background: #dbeafe; color: #1d4ed8; }
    .type-role-badge.role-support { background: #fef3c7; color: #d97706; }
    .type-provider-count { font-size: 0.85rem; color: var(--text-secondary); white-space: nowrap; margin-left: auto; }
    .type-cards { padding: 16px; }
    .type-group-clinical { border-left: 4px solid #3b82f6; }
    .type-group-support { border-left: 4px solid #f59e0b; }
    .type-view-legend { display: flex; gap: 24px; padding: 16px 20px; background: var(--bg-secondary); border-radius: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .type-legend-item { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; color: var(--text-secondary); }
    .type-legend-dot { width: 12px; height: 12px; border-radius: 4px; }
    .type-legend-dot.clinical { background: #3b82f6; }
    .type-legend-dot.support { background: #f59e0b; }
    [data-theme="dark"] .type-role-badge.role-clinical { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    [data-theme="dark"] .type-role-badge.role-support { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }

    /* ─ Favorites View ─ */
    .favorites-header { padding: 16px 20px; background: var(--status-amber-bg); border-radius: 12px; margin-bottom: 20px; display: flex; align-items: center; gap: 16px; }
    .favorites-title { font-weight: 700; font-size: 1.1rem; color: var(--status-amber); }
    .favorites-hint { font-size: 0.85rem; color: var(--status-amber); opacity: 0.8; }
    .favorites-cards { padding: 0; }
    .empty-favorites { text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 1rem; background: var(--bg-secondary); border-radius: 12px; }

    /* ─ Priority View ─ */
    .priority-view-header { padding: 16px 20px; background: var(--bg-secondary); border-radius: 12px; margin-bottom: 20px; }
    .priority-view-header h3 { margin: 0 0 4px; font-size: 1.2rem; color: var(--text-primary); }
    .priority-view-subtitle { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
    .priority-groups { display: flex; flex-direction: column; gap: 20px; }
    .priority-group { background: var(--bg-primary); border-radius: 12px; box-shadow: var(--shadow-sm); overflow: hidden; }
    .priority-group-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; cursor: pointer; user-select: none; transition: background 0.15s; }
    .priority-group-header:hover { background: var(--bg-tertiary); }
    .priority-icon { font-size: 1.2rem; }
    .priority-label { font-weight: 700; font-size: 1rem; color: var(--text-primary); }
    .priority-count { background: var(--bg-tertiary); color: var(--text-secondary); padding: 3px 10px; border-radius: 99px; font-size: 0.8rem; font-weight: 700; }
    .priority-desc { font-size: 0.82rem; color: var(--text-secondary); margin-left: auto; }
    .priority-cards { padding: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .empty-priority { padding: 24px; text-align: center; color: var(--text-secondary); font-size: 0.9rem; }
    .priority-critical { border-left: 4px solid #ef4444; }
    .priority-critical .priority-group-header { background: linear-gradient(90deg, rgba(239,68,68,0.08) 0%, transparent 100%); }
    .priority-critical .priority-count { background: #fef2f2; color: #ef4444; }
    .priority-attention { border-left: 4px solid #f59e0b; }
    .priority-attention .priority-group-header { background: linear-gradient(90deg, rgba(245,158,11,0.08) 0%, transparent 100%); }
    .priority-attention .priority-count { background: #fffbeb; color: #d97706; }
    .priority-ontrack { border-left: 4px solid #3b82f6; }
    .priority-ontrack .priority-group-header { background: linear-gradient(90deg, rgba(59,130,246,0.08) 0%, transparent 100%); }
    .priority-ontrack .priority-count { background: #eff6ff; color: #2563eb; }
    .priority-complete { border-left: 4px solid #16a34a; }
    .priority-complete .priority-group-header { background: linear-gradient(90deg, rgba(22,163,74,0.08) 0%, transparent 100%); }
    .priority-complete .priority-count { background: #f0fdf4; color: #16a34a; }
    .priority-unknown { border-left: 4px solid #64748b; }
    .priority-unknown .priority-group-header { background: linear-gradient(90deg, rgba(100,116,139,0.08) 0%, transparent 100%); }
    .priority-unknown .priority-count { background: #f1f5f9; color: #64748b; }
    .priority-group.empty-group { opacity: 0.6; }
    .collapsible.priority-group .priority-group-header .collapse-icon { transition: transform 0.2s; }
    .collapsible.priority-group.collapsed .priority-group-header .collapse-icon { transform: rotate(-90deg); }

    /* ─ Kanban Board ─ */
    .kanban-header { padding: 16px 20px; background: var(--bg-secondary); border-radius: 12px; margin-bottom: 20px; }
    .kanban-header h3 { margin: 0 0 4px; font-size: 1.2rem; color: var(--text-primary); }
    .kanban-subtitle { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
    .kanban-board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; min-height: 500px; }
    @media (max-width: 1024px) { .kanban-board { grid-template-columns: 1fr; } }
    .kanban-column { background: var(--bg-secondary); border-radius: 12px; display: flex; flex-direction: column; min-height: 400px; }
    .kanban-column-header { padding: 16px 20px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); }
    .kanban-column-icon { font-size: 1.1rem; }
    .kanban-column-title { font-weight: 700; font-size: 0.95rem; color: var(--text-primary); flex: 1; }
    .kanban-column-count { background: var(--bg-tertiary); color: var(--text-secondary); padding: 3px 10px; border-radius: 99px; font-size: 0.8rem; font-weight: 700; }
    .kanban-cards { flex: 1; padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; max-height: 600px; }
    .kanban-card { background: var(--bg-primary); border-radius: 8px; padding: 14px 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.06); cursor: pointer; transition: all 0.15s; border-left: 3px solid transparent; }
    .kanban-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .kanban-card-name { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); margin-bottom: 6px; }
    .kanban-card-meta { display: flex; gap: 10px; flex-wrap: wrap; }
    .kanban-hours { font-size: 0.78rem; color: var(--text-secondary); background: var(--bg-tertiary); padding: 2px 8px; border-radius: 4px; }
    .kanban-days { font-size: 0.78rem; color: var(--text-secondary); }
    .kanban-done-badge { font-size: 0.78rem; color: #16a34a; font-weight: 600; }
    .kanban-empty { padding: 40px 20px; text-align: center; color: var(--text-secondary); font-size: 0.9rem; }
    .kanban-needs .kanban-column-header { background: linear-gradient(90deg, rgba(239,68,68,0.1) 0%, transparent 100%); }
    .kanban-needs .kanban-column-count { background: #fef2f2; color: #ef4444; }
    .kanban-progress .kanban-column-header { background: linear-gradient(90deg, rgba(245,158,11,0.1) 0%, transparent 100%); }
    .kanban-progress .kanban-column-count { background: #fffbeb; color: #d97706; }
    .kanban-done .kanban-column-header { background: linear-gradient(90deg, rgba(22,163,74,0.1) 0%, transparent 100%); }
    .kanban-done .kanban-column-count { background: #f0fdf4; color: #16a34a; }
    .kanban-card.kanban-critical { border-left-color: #ef4444; }
    .kanban-card.kanban-warning { border-left-color: #f59e0b; }
    .kanban-card.kanban-progress-card { border-left-color: #3b82f6; }
    .kanban-card.kanban-complete-card { border-left-color: #16a34a; }
    .kanban-card.kanban-no-creds { border-left-color: #8b5cf6; background: #faf5ff; }
    .kanban-no-creds-label { font-size: 0.75rem; color: #7c3aed; background: #ede9fe; padding: 2px 8px; border-radius: 4px; font-weight: 600; }

    /* ─ Lazy Loading ─ */
    .load-sentinel { height: 1px; width: 100%; }
    .loading-indicator { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 24px; color: var(--text-secondary); font-size: 0.95rem; }
    .loading-spinner { width: 24px; height: 24px; border: 3px solid var(--border-color); border-top-color: var(--accent-blue); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .load-more-btn { display: block; margin: 20px auto; padding: 12px 32px; background: var(--accent-blue); color: #fff; border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .load-more-btn:hover { background: #1e40af; transform: translateY(-1px); }
    .load-more-btn:disabled { background: var(--border-color); cursor: not-allowed; transform: none; }

    /* ─ Action Queue ─ */
    .action-queue { display: flex; flex-direction: column; gap: 20px; }
    .action-section { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.07); overflow: hidden; }
    .action-section-header { display: flex; align-items: center; gap: 10px; padding: 14px 20px; font-weight: 700; }
    .action-section.action-critical .action-section-header { background: #fef2f2; color: #dc2626; border-left: 4px solid #ef4444; }
    .action-section.action-urgent .action-section-header { background: #fef3c7; color: #d97706; border-left: 4px solid #f59e0b; }
    .action-section.action-warning .action-section-header { background: #fefce8; color: #854d0e; border-left: 4px solid #eab308; }
    .action-section.action-info .action-section-header { background: #f1f5f9; color: #475569; border-left: 4px solid #94a3b8; }
    .action-icon { font-size: 1.1rem; }
    .action-section-title { flex: 1; }
    .action-section-count { padding: 2px 10px; border-radius: 99px; font-size: 0.8rem; background: rgba(0,0,0,.1); }
    .action-items-list { padding: 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .action-item-card { padding: 14px 16px; background: #f8fafc; border-radius: 10px; cursor: pointer; transition: all .15s; border: 1px solid #e2e8f0; }
    .action-item-card:hover { background: #f1f5f9; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .action-item-name { font-weight: 700; color: #0f172a; margin-bottom: 6px; }
    .action-item-details { display: flex; gap: 12px; margin-bottom: 6px; }
    .action-detail { font-size: 0.8rem; color: #64748b; }
    .action-item-reason { font-size: 0.78rem; color: #94a3b8; }
    .empty-actions { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; color: #16a34a; }
    .empty-actions .empty-icon { font-size: 2rem; }
    .empty-actions .empty-text { font-size: 1rem; font-weight: 600; }

    /* ─ AANP Tracker ─ */
    .aanp-tracker { }
    .aanp-header { margin-bottom: 20px; }
    .aanp-header h3 { font-size: 1.2rem; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
    .aanp-subtitle { font-size: 0.85rem; color: #64748b; }
    .aanp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .aanp-card { background: #fff; border-radius: 12px; padding: 18px; box-shadow: 0 2px 8px rgba(0,0,0,.07); cursor: pointer; transition: all .15s; border-left: 4px solid #16a34a; }
    .aanp-card:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,.1); }
    .aanp-card.cert-active { border-left-color: #16a34a; }
    .aanp-card.cert-warning { border-left-color: #f59e0b; }
    .aanp-card.cert-expired { border-left-color: #ef4444; }
    .aanp-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .aanp-provider-name { font-weight: 700; color: #0f172a; }
    .aanp-cert-status { padding: 3px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .aanp-cert-status.cert-active { background: #dcfce7; color: #166534; }
    .aanp-cert-status.cert-warning { background: #fef3c7; color: #d97706; }
    .aanp-cert-status.cert-expired { background: #fee2e2; color: #dc2626; }
    .aanp-cert-expiry { font-size: 0.85rem; color: #475569; margin-bottom: 14px; }
    .aanp-days-left { margin-left: 6px; font-weight: 600; color: #64748b; }
    .aanp-days-left.urgent { color: #f59e0b; }
    .aanp-hours-section { display: flex; flex-direction: column; gap: 8px; }
    .aanp-hours-row { display: flex; align-items: center; gap: 10px; }
    .aanp-hours-label { font-size: 0.78rem; color: #64748b; min-width: 80px; }
    .aanp-progress-bar { flex: 1; height: 8px; background: #e2e8f0; border-radius: 99px; overflow: hidden; }
    .aanp-progress-bar.pharm { background: #ede9fe; }
    .aanp-progress-fill { height: 100%; background: #16a34a; border-radius: 99px; }
    .aanp-progress-bar.pharm .aanp-progress-fill { background: #7c3aed; }
    .aanp-hours-text { font-size: 0.78rem; color: #475569; min-width: 80px; text-align: right; }
    .empty-aanp { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; color: #64748b; }
    .empty-aanp .empty-icon { font-size: 2rem; }
    .empty-aanp .empty-text { font-size: 0.9rem; text-align: center; max-width: 400px; }

    /* ─ State Stats ─ */
    .state-stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .state-stat-card { background: #fff; border-radius: 12px; padding: 18px; box-shadow: 0 2px 8px rgba(0,0,0,.07); }
    .state-stat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .state-stat-name { font-weight: 800; font-size: 1.1rem; color: #0f172a; }
    .state-stat-total { font-size: 0.85rem; color: #64748b; }
    .state-stat-bar { display: flex; height: 10px; border-radius: 99px; overflow: hidden; background: #e2e8f0; margin-bottom: 12px; }
    .state-bar-segment { height: 100%; }
    .state-bar-segment.complete { background: #16a34a; }
    .state-bar-segment.progress { background: #f59e0b; }
    .state-bar-segment.risk { background: #ef4444; }
    .state-bar-segment.unknown { background: #94a3b8; }
    .state-stat-details { display: flex; flex-wrap: wrap; gap: 8px; }
    .stat-detail { font-size: 0.78rem; padding: 2px 8px; border-radius: 99px; }
    .stat-detail.complete { background: #dcfce7; color: #166534; }
    .stat-detail.progress { background: #fef3c7; color: #d97706; }
    .stat-detail.risk { background: #fee2e2; color: #dc2626; }
    .stat-detail.unknown { background: #f1f5f9; color: #64748b; }

    /* ─ Timeline View ─ */
    .timeline-header { padding: 20px 0; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); }
    .timeline-header h3 { font-size: 1.2rem; font-weight: 800; color: var(--text-primary); margin-bottom: 4px; }
    .timeline-subtitle { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 16px; }
    .timeline-controls { display: flex; gap: 16px; flex-wrap: wrap; }
    .timeline-controls label { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: var(--text-secondary); }
    .timeline-controls select { padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-size: 0.85rem; }
    .timeline-legend { display: flex; gap: 24px; padding: 12px 0; margin-bottom: 16px; }
    .legend-item { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-secondary); }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
    .legend-dot.course-dot { background: var(--accent-blue); }
    .legend-line { width: 3px; height: 16px; border-radius: 2px; }
    .legend-line.deadline-line { background: var(--status-red); }
    .timeline-container { position: relative; background: var(--bg-secondary); border-radius: 12px; overflow: hidden; min-height: 200px; }
    .timeline-axis { display: flex; background: var(--bg-tertiary); padding: 10px 200px 10px 200px; border-bottom: 1px solid var(--border-color); position: sticky; top: 0; z-index: 10; }
    .timeline-month { flex: 1; text-align: center; font-size: 0.7rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; }
    .timeline-content { padding: 8px 0; max-height: 600px; overflow-y: auto; }
    .timeline-row { display: flex; align-items: center; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--border-color); transition: background 0.15s; }
    .timeline-row:hover { background: var(--bg-tertiary); }
    .timeline-label { width: 184px; flex-shrink: 0; font-size: 0.85rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 16px; }
    .timeline-track { flex: 1; position: relative; height: 24px; }
    .timeline-dot { position: absolute; width: 10px; height: 10px; border-radius: 50%; background: var(--accent-blue); transform: translate(-50%, -50%); top: 50%; cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; z-index: 5; }
    .timeline-dot:hover { transform: translate(-50%, -50%) scale(1.4); box-shadow: 0 2px 8px rgba(29, 78, 216, 0.4); z-index: 20; }
    .timeline-dot.multi { background: #7c3aed; }
    .timeline-deadline { position: absolute; width: 3px; height: 100%; background: var(--status-red); transform: translateX(-50%); border-radius: 2px; }
    .timeline-deadline::after { content: attr(data-label); position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); font-size: 0.65rem; white-space: nowrap; color: var(--status-red); font-weight: 600; opacity: 0; transition: opacity 0.15s; }
    .timeline-row:hover .timeline-deadline::after { opacity: 1; }
    .timeline-tooltip { position: fixed; z-index: 1000; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 14px; box-shadow: var(--shadow-md); pointer-events: none; max-width: 280px; font-size: 0.8rem; }
    .timeline-tooltip-title { font-weight: 700; color: var(--text-primary); margin-bottom: 4px; }
    .timeline-tooltip-meta { color: var(--text-secondary); }
    .timeline-empty { text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 0.95rem; background: var(--bg-secondary); border-radius: 12px; }

    /* ─ Compliance Tab ─ */
    .compliance-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 20px 40px; gap: 20px; flex-wrap: wrap; }
    .compliance-title h2 { font-size: 1.3rem; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
    .compliance-subtitle { font-size: 0.85rem; color: #64748b; }
    .compliance-summary { display: flex; gap: 16px; }
    .compliance-stat { background: #fff; border-radius: 10px; padding: 14px 20px; box-shadow: 0 2px 8px rgba(0,0,0,.07); text-align: center; min-width: 80px; }
    .compliance-stat-num { font-size: 1.8rem; font-weight: 800; display: block; }
    .compliance-stat-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; }
    .compliance-met .compliance-stat-num { color: #16a34a; }
    .compliance-notmet .compliance-stat-num { color: #ef4444; }

    .compliance-table-wrap { padding: 0 40px 20px; overflow-x: auto; }
    .compliance-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.07); }
    .compliance-table th { background: #f8fafc; padding: 12px 14px; text-align: left; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; border-bottom: 2px solid #e2e8f0; }
    .compliance-table td { padding: 12px 14px; border-bottom: 1px solid #f1f5f9; font-size: 0.88rem; }
    .compliance-table tr { cursor: pointer; transition: background .15s; }
    .compliance-table tr:hover { background: #f8fafc; }
    .compliance-table tr.comp-met { background: #f0fdf4; }
    .compliance-table tr.comp-met:hover { background: #dcfce7; }
    .compliance-table tr.comp-partial { background: #fffbeb; }
    .compliance-table tr.comp-partial:hover { background: #fef3c7; }
    .compliance-table tr.comp-none { background: #fef2f2; }
    .compliance-table tr.comp-none:hover { background: #fee2e2; }

    .comp-provider { font-weight: 600; color: #0f172a; }
    .comp-state { font-weight: 500; }
    .comp-req { font-size: 0.82rem; color: #64748b; max-width: 180px; }
    .comp-subject { font-weight: 500; }
    .comp-num { text-align: center; font-family: monospace; }
    .comp-valid { font-weight: 700; }
    .comp-window { font-size: 0.78rem; text-align: center; color: #64748b; }
    .comp-window small { color: #94a3b8; }
    .comp-status { font-weight: 600; text-align: center; white-space: nowrap; }
    .comp-status.comp-met { color: #16a34a; }
    .comp-status.comp-partial { color: #f59e0b; }
    .comp-status.comp-none { color: #ef4444; }

    .compliance-legend { padding: 0 40px 20px; display: flex; gap: 20px; flex-wrap: wrap; }
    .compliance-legend .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: #64748b; }
    .compliance-legend .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .compliance-legend .legend-dot.comp-met { background: #dcfce7; border: 1px solid #86efac; }
    .compliance-legend .legend-dot.comp-partial { background: #fef3c7; border: 1px solid #fcd34d; }
    .compliance-legend .legend-dot.comp-none { background: #fee2e2; border: 1px solid #fca5a5; }

    .compliance-info { margin: 0 40px 20px; padding: 16px 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0; }
    .compliance-info h4 { font-size: 0.9rem; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
    .compliance-info p { font-size: 0.85rem; color: #475569; margin-bottom: 8px; line-height: 1.5; }
    .compliance-info p:last-child { margin-bottom: 0; }

    .compliance-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 40px; text-align: center; }
    .compliance-empty .empty-icon { font-size: 2rem; color: #94a3b8; }
    .compliance-empty .empty-text { font-size: 1rem; color: #64748b; }
    .compliance-empty .empty-hint { font-size: 0.85rem; color: #94a3b8; margin-top: 8px; }

    /* ═══════════════════════════════════════════════════════════════════════════
       ENHANCED FEATURES - Daily Briefing, Focus Mode, Timeline, etc.
    ═══════════════════════════════════════════════════════════════════════════ */

    /* ─ Daily Briefing Banner ─ */
    .daily-briefing { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: #fff; padding: 16px 24px; margin: 0 24px 20px; border-radius: 16px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
    .briefing-date { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; }
    .briefing-stats { display: flex; gap: 24px; flex: 1; flex-wrap: wrap; }
    .briefing-stat { display: flex; align-items: center; gap: 8px; }
    .briefing-stat-icon { font-size: 1.2rem; }
    .briefing-stat-value { font-size: 1.4rem; font-weight: 700; }
    .briefing-stat-label { font-size: 0.78rem; opacity: 0.8; }
    .briefing-stat.urgent .briefing-stat-value { color: #fca5a5; }
    .briefing-stat.warning .briefing-stat-value { color: #fcd34d; }
    .briefing-stat.good .briefing-stat-value { color: #86efac; }
    .briefing-cta { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .briefing-cta:hover { background: rgba(255,255,255,0.25); transform: translateY(-1px); }
    [data-theme="dark"] .daily-briefing { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); }

    /* ─ Focus Mode Toggle ─ */
    .focus-mode-toggle { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--bg-primary); border: 2px solid var(--border-color); border-radius: 99px; cursor: pointer; transition: all 0.2s; margin-left: auto; }
    .focus-mode-toggle:hover { border-color: var(--accent-primary); }
    .focus-mode-toggle.active { background: linear-gradient(135deg, #ef4444, #f97316); border-color: transparent; color: #fff; }
    .focus-mode-toggle .toggle-icon { font-size: 1rem; }
    .focus-mode-toggle .toggle-label { font-size: 0.82rem; font-weight: 600; }
    .focus-mode-banner { display: none; background: linear-gradient(135deg, #fef2f2, #fff7ed); border: 1px solid #fecaca; padding: 12px 20px; margin: 0 24px 16px; border-radius: 10px; color: #991b1b; font-size: 0.88rem; align-items: center; gap: 10px; }
    .focus-mode-banner.visible { display: flex; }
    .focus-mode-banner .banner-icon { font-size: 1.1rem; }
    .focus-mode-banner .banner-text { flex: 1; }
    .focus-mode-banner .exit-focus { background: #991b1b; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer; }

    /* ─ Deadline Timeline ─ */
    .deadline-timeline { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 16px; padding: 20px 24px; margin: 0 24px 20px; }
    .timeline-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .timeline-title { font-size: 0.9rem; font-weight: 700; color: var(--text-primary); }
    .timeline-subtitle { font-size: 0.75rem; color: var(--text-secondary); }
    .timeline-track { position: relative; height: 90px; background: var(--bg-secondary); border-radius: 8px; overflow: visible; }
    .timeline-months { display: flex; position: absolute; top: 0; left: 0; right: 0; height: 20px; border-bottom: 1px solid var(--border-color); }
    .timeline-month { flex: 1; text-align: center; font-size: 0.65rem; font-weight: 600; color: var(--text-secondary); padding-top: 4px; border-right: 1px solid var(--border-color); }
    .timeline-month:last-child { border-right: none; }
    .timeline-month.current { background: rgba(99,102,241,0.1); color: var(--accent-primary); }
    .timeline-markers { position: absolute; top: 24px; left: 0; right: 0; bottom: 0; }
    /* Timeline marker wrapper with label */
    .timeline-marker-wrap { position: absolute; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 4px; z-index: 1; }
    .timeline-marker-wrap:hover { z-index: 20; }
    .timeline-marker-wrap:hover .timeline-marker { transform: scale(1.4); }
    .timeline-marker-label { font-size: 0.6rem; font-weight: 600; color: var(--text-secondary); white-space: nowrap; margin-top: 2px; }
    .timeline-marker { width: 14px; height: 14px; border-radius: 50%; cursor: pointer; transition: all 0.2s; position: relative; }
    /* Status-based colors (matching provider status) */
    .timeline-marker.urgent { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.3); }
    .timeline-marker.warning { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.3); }
    .timeline-marker.complete { background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,0.3); }
    .timeline-marker.unknown { background: #64748b; box-shadow: 0 0 0 3px rgba(100,116,139,0.3); }
    .timeline-marker.safe { background: #10b981; }
    .timeline-marker.cluster { width: 20px; height: 20px; font-size: 0.65rem; font-weight: 700; color: #fff; display: flex; align-items: center; justify-content: center; }
    /* Timeline marker tooltips */
    .timeline-marker::after {
      content: attr(data-tooltip);
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: #1e293b;
      color: #fff;
      font-size: 0.72rem;
      font-weight: 500;
      padding: 8px 12px;
      border-radius: 6px;
      white-space: nowrap;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s, visibility 0.15s;
      z-index: 100;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    }
    .timeline-marker::before {
      content: '';
      position: absolute;
      bottom: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: #1e293b;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s, visibility 0.15s;
      z-index: 100;
    }
    .timeline-marker:hover::after, .timeline-marker:hover::before { opacity: 1; visibility: visible; }
    .timeline-today { position: absolute; top: 20px; bottom: 0; width: 2px; background: var(--accent-primary); z-index: 5; }
    .timeline-today::before { content: 'Today'; position: absolute; top: -16px; left: 50%; transform: translateX(-50%); font-size: 0.6rem; font-weight: 600; color: var(--accent-primary); white-space: nowrap; }

    /* ─ Cost Comparison ─ */
    .cost-comparison { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 16px; padding: 20px 24px; margin: 0 24px 20px; }
    .cost-comparison-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .cost-comparison-title { font-size: 0.9rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
    .cost-comparison-title .title-icon { font-size: 1.1rem; }
    .cost-platforms { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .cost-platform-card { background: var(--bg-secondary); border-radius: 12px; padding: 16px; border: 2px solid transparent; transition: all 0.2s; }
    .cost-platform-card.best-value { border-color: #10b981; background: linear-gradient(135deg, rgba(16,185,129,0.05), rgba(16,185,129,0.1)); }
    .cost-platform-card.best-value::before { content: '✓ Best Value'; position: absolute; top: -10px; right: 12px; background: #10b981; color: #fff; font-size: 0.65rem; font-weight: 700; padding: 3px 8px; border-radius: 4px; }
    .cost-platform-card { position: relative; }
    .cost-platform-name { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
    .cost-platform-rate { font-size: 1.5rem; font-weight: 700; color: var(--accent-primary); }
    .cost-platform-rate span { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); }
    .cost-platform-details { font-size: 0.75rem; color: var(--text-secondary); margin-top: 6px; }

    /* ─ Compliance Trend Sparkline ─ */
    .trend-sparkline { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--bg-secondary); border-radius: 8px; }
    .sparkline-svg { width: 60px; height: 24px; }
    .sparkline-line { fill: none; stroke: var(--accent-primary); stroke-width: 2; }
    .sparkline-area { fill: url(#sparklineGradient); opacity: 0.3; }
    .trend-direction { font-size: 0.75rem; font-weight: 600; }
    .trend-direction.up { color: #10b981; }
    .trend-direction.down { color: #ef4444; }
    .trend-direction.flat { color: #64748b; }

    /* ─ Platform ROI Section ─ */
    .platform-roi { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 16px; padding: 20px 24px; margin: 0 24px 20px; }
    .roi-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .roi-title { font-size: 0.9rem; font-weight: 700; color: var(--text-primary); }
    .roi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .roi-card { background: var(--bg-secondary); border-radius: 12px; padding: 16px; }
    .roi-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .roi-platform-name { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
    .roi-total-spent { font-size: 1.1rem; font-weight: 700; color: #059669; }
    .roi-stats { display: flex; gap: 16px; margin-bottom: 12px; }
    .roi-stat { text-align: center; }
    .roi-stat-value { font-size: 1rem; font-weight: 700; color: var(--text-primary); }
    .roi-stat-label { font-size: 0.68rem; color: var(--text-secondary); text-transform: uppercase; }
    .roi-top-users { border-top: 1px solid var(--border-color); padding-top: 12px; }
    .roi-top-users-title { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase; }
    .roi-user { display: flex; justify-content: space-between; font-size: 0.8rem; padding: 4px 0; }
    .roi-user-name { color: var(--text-primary); }
    .roi-user-hours { color: var(--text-secondary); font-weight: 500; }

    /* ─ Keyboard Shortcuts Overlay ─ */
    .shortcuts-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 9999; display: none; align-items: center; justify-content: center; }
    .shortcuts-overlay.visible { display: flex; }
    .shortcuts-modal { background: var(--bg-primary); border-radius: 16px; padding: 24px 32px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .shortcuts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .shortcuts-title { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
    .shortcuts-close { background: none; border: none; font-size: 1.5rem; color: var(--text-secondary); cursor: pointer; padding: 4px; }
    .shortcuts-close:hover { color: var(--text-primary); }
    .shortcuts-section { margin-bottom: 20px; }
    .shortcuts-section-title { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
    .shortcut-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color); }
    .shortcut-row:last-child { border-bottom: none; }
    .shortcut-keys { display: flex; gap: 4px; }
    .shortcut-key { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 10px; font-size: 0.8rem; font-weight: 600; font-family: monospace; color: var(--text-primary); }
    .shortcut-desc { font-size: 0.85rem; color: var(--text-secondary); }
    .shortcuts-hint { text-align: center; font-size: 0.75rem; color: var(--text-secondary); margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-color); }

  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>

<!-- ── Header ─────────────────────────────────────────────────────────── -->
<header>
  <div class="header-brand">
    <img src="fountain-logo.png" alt="Fountain" class="header-logo" />
    <div class="header-divider"></div>
    <h1>CEU <span>Tracker</span></h1>
  </div>
  <div class="header-meta">
    <div>
      <div class="last-scraped-label">Last Scraped</div>
      <div class="last-scraped-value" id="lastScrapedValue" data-iso="${escHtml(runIso)}">${escHtml(runDate)}</div>
      <div class="last-scraped-ago" id="lastScrapedAgo"></div>
      <div class="run-badge">
        <span class="run-pill ok">✓ ${runResults.filter(r => r.status === 'success').length} successful logins</span>
        ${runResults.filter(r => r.status === 'not_configured').length > 0
          ? `<span class="run-pill notconfig">○ ${runResults.filter(r => r.status === 'not_configured').length} no credentials</span>`
          : ''}
        ${runResults.filter(r => r.status === 'login_error' || r.status === 'failed').length > 0
          ? `<span class="run-pill fail">✗ ${runResults.filter(r => r.status === 'login_error' || r.status === 'failed').length} login errors</span>`
          : ''}
      </div>
    </div>
    <div class="global-search-wrap">
      <input type="text" class="global-search" id="globalSearch" placeholder="Quick search..." onkeyup="globalSearchHandler(event)" />
      <div class="global-search-results" id="globalSearchResults"></div>
    </div>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark/light mode" id="themeToggle">
      <span class="theme-icon">🌙</span>
      <span class="theme-toggle-label">Dark</span>
    </button>
    <button class="header-collapse-btn" onclick="toggleHeaderCollapse()" title="Collapse header" id="headerCollapseBtn">
      <span id="headerCollapseIcon">▲</span>
    </button>
  </div>
</header>

<!-- ── App Layout with Sidebar ─────────────────────────────────────────── -->
<div class="app-layout">
  <!-- Sidebar Navigation -->
  <aside class="sidebar collapsed" id="sidebar">
    <button class="sidebar-collapse-btn" onclick="toggleSidebarCollapse()" title="Expand sidebar" id="sidebarCollapseBtn">
      <span id="sidebarCollapseIcon">▶</span>
    </button>
    <nav class="sidebar-nav">
      <button class="nav-item active" onclick="showTab('providers')" data-tab="providers">
        <span class="nav-icon">👥</span>
        <div class="nav-label-wrap">
          <span class="nav-label">Team View</span>
          <span class="nav-desc">All providers & status</span>
        </div>
      </button>
      <button class="nav-item" onclick="showTab('compliance')" data-tab="compliance">
        <span class="nav-icon">✓</span>
        <div class="nav-label-wrap">
          <span class="nav-label">Compliance</span>
          <span class="nav-desc">CE requirements tracking</span>
        </div>
        ${lookbackNotMet > 0 ? `<span class="nav-badge">${lookbackNotMet}</span>` : ''}
      </button>
      <button class="nav-item" onclick="showTab('platforms')" data-tab="platforms">
        <span class="nav-icon">📚</span>
        <div class="nav-label-wrap">
          <span class="nav-label">Platforms</span>
          <span class="nav-desc">NetCE, CEUfast, etc.</span>
        </div>
      </button>
      <button class="nav-item" onclick="showTab('reports')" data-tab="reports">
        <span class="nav-icon">📊</span>
        <div class="nav-label-wrap">
          <span class="nav-label">Reports</span>
          <span class="nav-desc">Export & history</span>
        </div>
      </button>
      <button class="nav-item" onclick="showTab('help')" data-tab="help">
        <span class="nav-icon">❓</span>
        <div class="nav-label-wrap">
          <span class="nav-label">Help & FAQ</span>
          <span class="nav-desc">How it works</span>
        </div>
      </button>
      <button class="nav-item" onclick="showTab('summary')" data-tab="summary">
        <span class="nav-icon">📋</span>
        <div class="nav-label-wrap">
          <span class="nav-label">Overview</span>
          <span class="nav-desc">Summary & info</span>
        </div>
      </button>
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-stats">
        <div class="sidebar-stat"><span class="sidebar-stat-num">${complete}</span><span class="sidebar-stat-label">Complete</span></div>
        <div class="sidebar-stat warn${atRisk > 0 ? ' has-risk' : ''}"><span class="sidebar-stat-num">${atRisk}</span><span class="sidebar-stat-label">At Risk</span></div>
      </div>
    </div>
  </aside>

  <!-- Mobile Sidebar Toggle -->
  <button class="sidebar-toggle" onclick="toggleSidebar()" id="sidebarToggle">☰</button>

  <!-- Main Content Area -->
  <main class="main-content">
    <!-- ── Welcome Banner (Slim) ────────────────────────────────────────────── -->
    <div class="welcome-banner" id="welcomeBanner">
      <div class="welcome-icon">📊</div>
      <div class="welcome-content">
        <div class="welcome-title">CEU Compliance Tracker</div>
        <div class="welcome-subtitle">— Track CE requirements and deadlines. Updates nightly from connected CE platforms.</div>
      </div>
      <button class="welcome-dismiss" onclick="dismissWelcome()">Dismiss</button>
    </div>

    <!-- ── Daily Briefing Banner ──────────────────────────────────────────── -->
    <div class="daily-briefing" id="dailyBriefing">
      <div class="briefing-date">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div class="briefing-stats">
        ${atRisk > 0 ? `
        <div class="briefing-stat urgent">
          <span class="briefing-stat-icon">⚠</span>
          <span class="briefing-stat-value">${atRisk}</span>
          <span class="briefing-stat-label">need attention</span>
        </div>` : ''}
        ${deadlines30.length > 0 ? `
        <div class="briefing-stat warning">
          <span class="briefing-stat-icon">◷</span>
          <span class="briefing-stat-value">${deadlines30.length}</span>
          <span class="briefing-stat-label">due in 30 days</span>
        </div>` : ''}
        <div class="briefing-stat good">
          <span class="briefing-stat-icon">✓</span>
          <span class="briefing-stat-value">${complete}</span>
          <span class="briefing-stat-label">on track</span>
        </div>
        ${thisMonthSpend > 0 ? `
        <div class="briefing-stat">
          <span class="briefing-stat-icon">$</span>
          <span class="briefing-stat-value">$${thisMonthSpend.toFixed(0)}</span>
          <span class="briefing-stat-label">spent this month</span>
        </div>` : ''}
      </div>
      ${atRisk > 0 ? `<button class="briefing-cta" onclick="toggleFocusMode()">Focus on At-Risk</button>` : ''}
    </div>

    <!-- ── Focus Mode Banner (hidden by default) ──────────────────────────── -->
    <div class="focus-mode-banner" id="focusModeBanner">
      <span class="banner-icon">🎯</span>
      <span class="banner-text"><strong>Focus Mode:</strong> Showing only providers that need attention</span>
      <button class="exit-focus" onclick="toggleFocusMode()">Exit Focus Mode</button>
    </div>

    <!-- ── Deadline Timeline (12-month view) ──────────────────────────────── -->
    <div class="deadline-timeline" id="deadlineTimeline">
      <div class="timeline-header">
        <div class="timeline-title">Deadline Timeline</div>
        <div class="timeline-subtitle">${timelineDeadlines.length} renewals in the next 12 months</div>
      </div>
      <div class="timeline-track">
        <div class="timeline-months">
          ${timelineMonths.map(m => `<div class="timeline-month${m.isCurrent ? ' current' : ''}">${m.label}</div>`).join('')}
        </div>
        <div class="timeline-markers">
          ${timelineDeadlines.map(d => {
            const statusLabel = d.status === 'Complete' ? 'Complete' : d.status === 'At Risk' ? 'Needs Attention' : d.status === 'In Progress' ? 'On Track' : 'Missing Info';
            const statusClass = d.status === 'Complete' ? 'complete' : d.status === 'At Risk' ? 'urgent' : d.status === 'In Progress' ? 'warning' : 'unknown';
            return `<div class="timeline-marker-wrap" style="left: ${d.pct}%">
              <div class="timeline-marker ${statusClass}" data-tooltip="${escHtml(d.name)}${d.state ? ' (' + escHtml(d.state) + ')' : ''} | ${escHtml(d.date)} | ${statusLabel}"></div>
              <div class="timeline-marker-label">${escHtml(d.initials)}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="timeline-today" style="left: ${(1/365) * 100}%"></div>
      </div>
    </div>

    <!-- ── Quick Stats Summary ────────────────────────────────────────────── -->
    <div class="quick-summary">
      <div class="quick-summary-icon">📈</div>
      <div class="quick-summary-text">
        ${atRisk === 0 && trulyNoCredentialsProviders.length === 0
          ? `<span class="quick-summary-highlight">All ${total} providers are on track!</span> No immediate action needed.`
          : atRisk > 0
            ? `<strong>${complete} of ${total}</strong> providers are on track. <span class="quick-summary-warning">${atRisk} need${atRisk === 1 ? 's' : ''} attention</span> before their renewal deadline${atRisk === 1 ? '' : 's'}.`
            : `<strong>${complete} of ${total}</strong> providers are on track. ${trulyNoCredentialsProviders.length} still need platform credentials.`
        }
      </div>
    </div>

    <!-- ── Getting Started (First-time users) ─────────────────────────────── -->
    <div class="getting-started" id="gettingStarted">
      <div class="getting-started-header">
        <span class="getting-started-icon">💡</span>
        <span class="getting-started-title">Quick Start Guide</span>
      </div>
      <div class="getting-started-steps">
        <div class="getting-started-step">
          <span class="step-number">1</span>
          <span>Review providers marked <strong>"At Risk"</strong> (red) - they need CEUs before their deadline</span>
        </div>
        <div class="getting-started-step">
          <span class="step-number">2</span>
          <span>Check <strong>"Missing Creds"</strong> providers and collect their platform login credentials</span>
        </div>
        <div class="getting-started-step">
          <span class="step-number">3</span>
          <span>Click any provider card to see their detailed CE hours and renewal dates</span>
        </div>
      </div>
      <button class="getting-started-dismiss" onclick="dismissGettingStarted()">Don't show this again</button>
    </div>

    <!-- ── Stats with Tooltips ────────────────────────────────────────────── -->
    <div class="stats">
      <div class="stat-card total has-tooltip">
        <div class="tooltip">Total clinical staff being tracked</div>
        <div class="num">${total}</div>
        <div class="lbl">Team Members</div>
        <div class="stat-sublbl">Total providers tracked</div>
      </div>
      <div class="stat-card ok has-tooltip${complete === total ? ' all-complete' : ''}">
        <div class="tooltip">All CE requirements met - no action needed</div>
        ${complete === total ? '<div class="celebration-indicator">✓</div>' : ''}
        <div class="num">${complete}</div>
        <div class="lbl">Complete</div>
        <div class="stat-sublbl">All CE hours fulfilled</div>
      </div>
      <div class="stat-card prog has-tooltip">
        <div class="tooltip">CEUs remaining but deadline is 60+ days away</div>
        <div class="num">${inProg}</div>
        <div class="lbl">On Track</div>
        <div class="stat-sublbl">In progress, deadline is far</div>
      </div>
      <div class="stat-card risk has-tooltip${atRisk > 0 ? ' has-risk' : ''}">
        <div class="tooltip">CEUs remaining AND deadline within 60 days - urgent!</div>
        <div class="num">${atRisk}</div>
        <div class="lbl">Needs Attention</div>
        <div class="stat-sublbl">Deadline approaching or overdue</div>
      </div>
    </div>

<!-- ── Tab: Overview ──────────────────────────────────────────────────── -->
<!-- ── Tab: Dashboard (Consolidated Overview) ────────────────────────────── -->
<div class="tab-panel" id="tab-dashboard">
  <!-- Compact Status Cards Row -->
  <div class="dashboard-stats-row">
    <div class="dash-stat-card dash-stat-risk">
      <div class="dash-stat-icon">⚠</div>
      <div class="dash-stat-content">
        <div class="dash-stat-num">${atRisk}</div>
        <div class="dash-stat-label">At Risk</div>
      </div>
    </div>
    <div class="dash-stat-card dash-stat-warning">
      <div class="dash-stat-icon">◷</div>
      <div class="dash-stat-content">
        <div class="dash-stat-num">${inProg}</div>
        <div class="dash-stat-label">In Progress</div>
      </div>
    </div>
    <div class="dash-stat-card dash-stat-complete">
      <div class="dash-stat-icon">✓</div>
      <div class="dash-stat-content">
        <div class="dash-stat-num">${complete}</div>
        <div class="dash-stat-label">Complete</div>
      </div>
    </div>
    <div class="dash-stat-card dash-stat-unknown">
      <div class="dash-stat-icon">○</div>
      <div class="dash-stat-content">
        <div class="dash-stat-num">${trulyNoCredentialsProviders.length}</div>
        <div class="dash-stat-label">Missing Creds</div>
      </div>
    </div>
    <div class="dash-stat-card dash-stat-cost" onclick="showTab('reports'); showReportView('cost-summary');">
      <div class="dash-stat-icon">$</div>
      <div class="dash-stat-content">
        <div class="dash-stat-num">$${spendingStats.totalOrgSpend.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
        <div class="dash-stat-label">12-Month Spend</div>
      </div>
    </div>
  </div>

  <!-- Urgency Panel - Sorted by Priority -->
  <div class="urgency-panel">
    <div class="urgency-header">
      <h3 class="urgency-title">🚨 Provider Urgency List</h3>
      <span class="urgency-subtitle">${urgencyNeedsAction.length} provider${urgencyNeedsAction.length !== 1 ? 's' : ''} need attention • ${urgencyNoCreds.length} missing credentials</span>
    </div>
    <div class="urgency-list">
      ${urgencyNeedsAction.length === 0 && urgencyNoCreds.length === 0
        ? '<div class="urgency-empty">✓ All providers are on track!</div>'
        : urgencyList.filter(p => p.urgencyOrder < 99).slice(0, 15).map(p => {
            const urgencyLabels = {
              'overdue': { label: 'OVERDUE', cls: 'urgency-overdue', icon: '🔴' },
              'critical': { label: p.days + 'd LEFT', cls: 'urgency-critical', icon: '🔴' },
              'urgent': { label: p.days + 'd LEFT', cls: 'urgency-urgent', icon: '🟠' },
              'warning': { label: p.days + 'd LEFT', cls: 'urgency-warning', icon: '🟡' },
              'needs-hours': { label: p.hoursRemaining + 'h NEEDED', cls: 'urgency-needs', icon: '📚' },
              'no-creds': { label: 'NO LOGIN', cls: 'urgency-nocreds', icon: '🔑' }
            };
            const u = urgencyLabels[p.urgency] || { label: '', cls: '', icon: '' };
            const pct = p.hoursRequired > 0 ? Math.round((p.hoursCompleted / p.hoursRequired) * 100) : 0;
            return `
            <div class="urgency-item ${u.cls}" onclick="openProvider('${escHtml(p.name).replace(/'/g, "\\'")}')">
              <span class="urgency-icon">${u.icon}</span>
              <div class="urgency-info">
                <span class="urgency-name">${escHtml(p.name)}</span>
                <span class="urgency-meta">${escHtml(p.type)} • ${escHtml(p.state || 'N/A')}${p.deadline ? ' • Due: ' + escHtml(p.deadline) : ''}</span>
              </div>
              ${p.urgency !== 'no-creds' ? `
              <div class="urgency-progress">
                <div class="urgency-bar"><div class="urgency-fill" style="width:${pct}%"></div></div>
                <span class="urgency-hours">${p.hoursCompleted}/${p.hoursRequired}h</span>
              </div>` : '<div class="urgency-creds-needed">Submit credentials</div>'}
              <span class="urgency-badge ${u.cls}">${u.label}</span>
            </div>`;
          }).join('')
      }
      ${urgencyList.filter(p => p.urgencyOrder < 99).length > 15 ? `
      <div class="urgency-more" onclick="showTab('providers'); setCardFilter('At Risk');">
        View all ${urgencyList.filter(p => p.urgencyOrder < 99).length} providers →
      </div>` : ''}
    </div>
  </div>

  <!-- Compliance Scorecard -->
  <div class="scorecard-panel">
    <div class="scorecard-header">
      <h3 class="scorecard-title">📊 Team Compliance Scorecard</h3>
      <div class="scorecard-overall">
        <span class="overall-pct ${overallCompliance >= 80 ? 'pct-good' : overallCompliance >= 50 ? 'pct-warn' : 'pct-bad'}">${overallCompliance}%</span>
        <span class="overall-label">Overall Compliance</span>
      </div>
    </div>
    <div class="scorecard-grid">
      <!-- By Credential Type -->
      <div class="scorecard-section">
        <div class="scorecard-section-title">By Credential Type</div>
        <div class="scorecard-items">
          ${scorecardByType.map(d => {
            const barCls = d.pct >= 80 ? 'sc-good' : d.pct >= 50 ? 'sc-warn' : 'sc-bad';
            return '<div class="scorecard-item">' +
              '<div class="sc-label"><span class="sc-type">' + escHtml(d.type) + '</span><span class="sc-count">' + d.compliant + '/' + d.total + '</span></div>' +
              '<div class="sc-bar-wrap"><div class="sc-bar ' + barCls + '" style="width:' + d.pct + '%"></div><span class="sc-pct">' + d.pct + '%</span></div>' +
            '</div>';
          }).join('')}
        </div>
      </div>
      <!-- By State -->
      <div class="scorecard-section">
        <div class="scorecard-section-title">By State</div>
        <div class="scorecard-items">
          ${scorecardByState.map(d => {
            const barCls = d.pct >= 80 ? 'sc-good' : d.pct >= 50 ? 'sc-warn' : 'sc-bad';
            return '<div class="scorecard-item">' +
              '<div class="sc-label"><span class="sc-type">' + escHtml(d.state) + '</span><span class="sc-count">' + d.compliant + '/' + d.total + '</span></div>' +
              '<div class="sc-bar-wrap"><div class="sc-bar ' + barCls + '" style="width:' + d.pct + '%"></div><span class="sc-pct">' + d.pct + '%</span></div>' +
            '</div>';
          }).join('')}
        </div>
      </div>
    </div>
  </div>

  <!-- 12-Month Renewal Timeline -->
  <div class="timeline-panel">
    <div class="timeline-header">
      <h3 class="timeline-title">📅 12-Month Renewal Timeline</h3>
      <div class="timeline-legend">
        <span class="tl-legend-item"><span class="tl-dot tl-complete"></span>Complete</span>
        <span class="tl-legend-item"><span class="tl-dot tl-critical"></span>Critical</span>
        <span class="tl-legend-item"><span class="tl-dot tl-urgent"></span>Urgent</span>
        <span class="tl-legend-item"><span class="tl-dot tl-warning"></span>Warning</span>
        <span class="tl-legend-item"><span class="tl-dot tl-needs"></span>Needs CEUs</span>
      </div>
    </div>
    <div class="timeline-scroll">
      <div class="timeline-grid">
        ${renewalTimelineHtml}
      </div>
    </div>
  </div>

  <!-- Two-Column Layout: Actions + Deadlines -->
  <div class="dashboard-grid">
    <!-- Action Required Column -->
    <div class="dashboard-actions">
      <div class="dash-section-header">Action Required</div>
      <div class="dash-action-list">
        ${atRisk > 0 ? `
        <div class="dash-action-item dash-action-critical" onclick="showTab('providers'); setCardFilter('At Risk');">
          <span class="dash-action-icon">⚠</span>
          <span class="dash-action-text"><strong>${atRisk}</strong> provider${atRisk !== 1 ? 's' : ''} at risk</span>
          <span class="dash-action-arrow">→</span>
        </div>` : ''}
        ${trulyNoCredentialsProviders.length > 0 ? `
        <div class="dash-action-item dash-action-info" onclick="showTab('providers'); document.getElementById('noCredsFilter').checked = true; filterCards();">
          <span class="dash-action-icon">○</span>
          <span class="dash-action-text"><strong>${trulyNoCredentialsProviders.length}</strong> providers need platform credentials</span>
          <span class="dash-action-arrow">→</span>
        </div>` : ''}
        ${loginErrors.length > 0 ? `
        <div class="dash-action-item dash-action-error" onclick="showTab('reports'); showReportView('runlog');">
          <span class="dash-action-icon">✗</span>
          <span class="dash-action-text"><strong>${loginErrors.length}</strong> login error${loginErrors.length !== 1 ? 's' : ''}</span>
          <span class="dash-action-arrow">→</span>
        </div>` : ''}
        ${atRisk === 0 && trulyNoCredentialsProviders.length === 0 && loginErrors.length === 0 ? `
        <div class="dash-action-empty">
          <span class="dash-action-icon">✓</span>
          <span class="dash-action-text">No immediate action needed</span>
        </div>` : ''}
      </div>
    </div>

    <!-- Upcoming Deadlines Column -->
    <div class="dashboard-deadlines">
      <div class="dash-section-header">Upcoming Deadlines</div>
      <div class="dash-deadline-summary">
        <div class="dash-deadline-row ${deadlines30.length > 0 ? 'has-items' : ''}" onclick="showTab('reports'); showReportView('calendar');">
          <span class="dash-dl-badge urgent">30d</span>
          <span class="dash-dl-count">${deadlines30.length}</span>
          <span class="dash-dl-label">license${deadlines30.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="dash-deadline-row ${deadlines60.length > 0 ? 'has-items' : ''}" onclick="showTab('reports'); showReportView('calendar');">
          <span class="dash-dl-badge soon">60d</span>
          <span class="dash-dl-count">${deadlines60.length}</span>
          <span class="dash-dl-label">license${deadlines60.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="dash-deadline-row ${deadlines90.length > 0 ? 'has-items' : ''}" onclick="showTab('reports'); showReportView('calendar');">
          <span class="dash-dl-badge upcoming">90d</span>
          <span class="dash-dl-count">${deadlines90.length}</span>
          <span class="dash-dl-label">license${deadlines90.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      ${deadlines30.length > 0 ? `
      <div class="dash-deadline-preview">
        <div class="dash-preview-title">Next 30 Days</div>
        ${deadlines30.slice(0, 5).map(r => `
        <div class="dash-preview-item ${r.status === 'At Risk' ? 'di-risk' : r.status === 'Complete' ? 'di-complete' : 'di-progress'}">
          <span class="dash-preview-name">${escHtml(r.providerName?.split(',')[0] || 'N/A')}</span>
          <span class="dash-preview-state">${escHtml(r.state || 'N/A')}</span>
          <span class="dash-preview-days">${r.days}d</span>
        </div>`).join('')}
        ${deadlines30.length > 5 ? `<div class="dash-preview-more">+${deadlines30.length - 5} more</div>` : ''}
      </div>` : ''}
    </div>
  </div>

  <!-- Compliance Score & Trend Row -->
  <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 24px; padding: 0 40px 24px;">
    <!-- Compliance Score -->
    <div class="compliance-score-card">
      <div class="compliance-score-header">
        <span class="compliance-score-title">Team Compliance</span>
      </div>
      <div class="compliance-score-value ${complianceScore >= 80 ? 'score-good' : complianceScore >= 60 ? 'score-warning' : 'score-bad'}">${complianceScore}%</div>
      <div class="compliance-breakdown">
        <div class="compliance-breakdown-item">
          <div class="compliance-breakdown-num" style="color: var(--status-green);">${complete}</div>
          <div class="compliance-breakdown-label">Complete</div>
        </div>
        <div class="compliance-breakdown-item">
          <div class="compliance-breakdown-num" style="color: var(--status-amber);">${inProg}</div>
          <div class="compliance-breakdown-label">In Progress</div>
        </div>
        <div class="compliance-breakdown-item">
          <div class="compliance-breakdown-num" style="color: var(--status-red);">${atRisk}</div>
          <div class="compliance-breakdown-label">At Risk</div>
        </div>
      </div>
    </div>

    <!-- Monthly Trend Chart -->
    <div class="trend-chart-container">
      <div class="trend-chart-header">
        <span class="trend-chart-title">CEU Completion Trend (Last 6 Months)</span>
      </div>
      <div class="trend-chart" id="trendChart">
        ${generateTrendChart(courseHistory)}
      </div>
    </div>
  </div>

  <!-- Last Run Summary Bar -->
  <div class="dashboard-run-summary">
    <div class="run-summary-header">
      <span class="run-summary-title">Last Scrape</span>
      <span class="run-summary-time" id="lastScrapedValue" data-iso="${runIso}">${escHtml(runDate)}</span>
      <span class="run-summary-ago" id="lastScrapedAgo"></span>
    </div>
    <div class="run-summary-stats">
      <div class="run-stat">
        <span class="run-stat-label">Platform Logins</span>
        <span class="run-stat-value">${(runResults || []).filter(r => r.status === 'success').length} <span class="run-ok">✓</span></span>
        ${loginErrors.length > 0 ? `<span class="run-stat-value">${loginErrors.length} <span class="run-fail">✗</span></span>` : ''}
        <span class="run-stat-value">${(runResults || []).filter(r => r.status === 'not_configured').length} skipped</span>
      </div>
      <div class="run-stat">
        <span class="run-stat-label">Platforms</span>
        <span class="run-stat-value">${platformData.filter(p => p.status === 'success').length} <span class="run-ok">✓</span></span>
      </div>
    </div>
  </div>
</div>

<!-- ── Tab: Providers ─────────────────────────────────────────────────── -->
<div class="tab-panel active" id="tab-providers">
  <!-- Action Items Banner -->
  ${(() => {
    const criticalProviders = flat.filter(r => {
      const days = daysUntil(r.renewalDeadline);
      return days !== null && days >= 0 && days <= 30 && r.hoursRemaining > 0;
    });
    const warningProviders = flat.filter(r => {
      const days = daysUntil(r.renewalDeadline);
      return days !== null && days > 30 && days <= 60 && r.hoursRemaining > 0;
    });
    const missingCredsCount = trulyNoCredentialsProviders.length;
    const failedLoginsCount = loginErrors.length;

    const hasIssues = criticalProviders.length > 0 || warningProviders.length > 0 || missingCredsCount > 0 || failedLoginsCount > 0;

    if (!hasIssues) {
      return '<div class="action-banner all-clear"><div class="action-banner-empty"><div class="action-banner-empty-icon">✓</div><div class="action-banner-empty-text">All Clear! No urgent action items</div></div></div>';
    }

    let cards = '';

    if (criticalProviders.length > 0) {
      const allNames = [...new Set(criticalProviders.map(p => p.providerName))];
      const names = allNames.slice(0, 3);
      const moreCount = allNames.length - 3;
      cards += '<div class="action-item-card action-critical" onclick="applyQuickFilter(&quot;urgent&quot;)">' +
        '<div class="action-item-icon">🚨</div>' +
        '<div class="action-item-content">' +
          '<div class="action-item-label">URGENT: Deadline in 30 Days</div>' +
          '<div class="action-item-value">' + allNames.length + ' provider' + (allNames.length !== 1 ? 's' : '') + '</div>' +
          '<div class="action-item-detail"><strong>Action:</strong> Contact these providers to ensure they complete required CEUs immediately</div>' +
          '<div class="action-item-providers">' + names.map(n => '<span class="action-provider-chip">' + escHtml(n) + '</span>').join('') + (moreCount > 0 ? '<span class="action-provider-chip">+' + moreCount + ' more</span>' : '') + '</div>' +
        '</div>' +
      '</div>';
    }

    if (warningProviders.length > 0) {
      const allNames = [...new Set(warningProviders.map(p => p.providerName))];
      const names = allNames.slice(0, 3);
      const moreCount = allNames.length - 3;
      cards += '<div class="action-item-card action-warning" onclick="applyQuickFilter(&quot;due90&quot;)">' +
        '<div class="action-item-icon">⚠️</div>' +
        '<div class="action-item-content">' +
          '<div class="action-item-label">Upcoming: Deadline in 31-60 Days</div>' +
          '<div class="action-item-value">' + allNames.length + ' provider' + (allNames.length !== 1 ? 's' : '') + '</div>' +
          '<div class="action-item-detail"><strong>Action:</strong> Remind these providers to start working on CE courses</div>' +
          '<div class="action-item-providers">' + names.map(n => '<span class="action-provider-chip">' + escHtml(n) + '</span>').join('') + (moreCount > 0 ? '<span class="action-provider-chip">+' + moreCount + ' more</span>' : '') + '</div>' +
        '</div>' +
      '</div>';
    }

    if (missingCredsCount > 0) {
      const names = trulyNoCredentialsProviders.slice(0, 3);
      const moreCount = missingCredsCount - 3;
      cards += '<div class="action-item-card action-info" onclick="showTab(&quot;platforms&quot;); setTimeout(function(){ showPlatformView(&quot;gaps&quot;); }, 100)">' +
        '<div class="action-item-icon">🔑</div>' +
        '<div class="action-item-content">' +
          '<div class="action-item-label">Missing Platform Credentials</div>' +
          '<div class="action-item-value">' + missingCredsCount + ' provider' + (missingCredsCount !== 1 ? 's' : '') + '</div>' +
          '<div class="action-item-detail"><strong>Action:</strong> Request CE platform login credentials from these providers</div>' +
          '<div class="action-item-providers">' + names.map(n => '<span class="action-provider-chip">' + escHtml(n) + '</span>').join('') + (moreCount > 0 ? '<span class="action-provider-chip">+' + moreCount + ' more</span>' : '') + '</div>' +
        '</div>' +
      '</div>';
    }

    if (failedLoginsCount > 0) {
      const names = loginErrors.slice(0, 3).map(e => e.name);
      const moreCount = failedLoginsCount - 3;
      cards += '<div class="action-item-card action-critical">' +
        '<div class="action-item-icon">❌</div>' +
        '<div class="action-item-content">' +
          '<div class="action-item-label">Login Failed</div>' +
          '<div class="action-item-value">' + failedLoginsCount + ' provider' + (failedLoginsCount !== 1 ? 's' : '') + '</div>' +
          '<div class="action-item-detail"><strong>Action:</strong> Ask providers for updated platform credentials</div>' +
          '<div class="action-item-providers">' + names.map(n => '<span class="action-provider-chip">' + escHtml(n) + '</span>').join('') + (moreCount > 0 ? '<span class="action-provider-chip">+' + moreCount + ' more</span>' : '') + '</div>' +
        '</div>' +
      '</div>';
    }

    // Count total issues for collapsed badge
    const totalIssues = (criticalProviders.length > 0 ? [...new Set(criticalProviders.map(p => p.providerName))].length : 0) +
                        (warningProviders.length > 0 ? [...new Set(warningProviders.map(p => p.providerName))].length : 0) +
                        missingCredsCount + failedLoginsCount;
    const issueTypes = [];
    if (criticalProviders.length > 0) issueTypes.push('urgent');
    if (missingCredsCount > 0) issueTypes.push(missingCredsCount + ' missing creds');
    if (failedLoginsCount > 0) issueTypes.push(failedLoginsCount + ' login errors');
    const collapsedText = issueTypes.length > 0 ? issueTypes.join(', ') : totalIssues + ' issues';

    return '<div class="action-banner-wrap">' +
      '<div class="action-banner" id="actionBanner">' +
        '<div class="action-banner-header">' +
          '<div class="action-banner-title"><span class="action-banner-title-icon">📋</span> Action Required</div>' +
          '<button class="action-banner-dismiss" onclick="collapseActionBanner()" title="Minimize">−</button>' +
        '</div>' +
        '<div class="action-banner-grid">' + cards + '</div>' +
      '</div>' +
      '<div class="action-badge-collapsed" id="actionBadgeCollapsed" onclick="expandActionBanner()">' +
        '<span class="action-badge-icon">⚠</span>' +
        '<span class="action-badge-text">' + collapsedText + '</span>' +
        '<span class="action-badge-expand">Show</span>' +
      '</div>' +
    '</div>';
  })()}

  <!-- View Toggle Bar (Consolidated - 8 tabs max) -->
  <div class="view-toggle-bar">
    <div class="view-tabs">
      <button class="view-toggle active" onclick="showProviderView('all')">All Providers <span class="view-count">${providerEntries.length}</span></button>
      <button class="view-toggle" onclick="showProviderView('table')">Table View</button>
      <button class="view-toggle" onclick="showProviderView('priority')">By Priority <span class="view-count ${atRiskCount > 0 ? 'warning' : ''}">${atRiskCount}</span></button>
      <button class="view-toggle" onclick="showProviderView('kanban')">Kanban</button>
      <button class="view-toggle" onclick="showProviderView('deadline')">By Deadline <span class="view-count ${deadlineProviders30.length > 0 ? 'warning' : ''}">${deadlineProviders30.length + deadlineProviders60.length + deadlineProviders90.length}</span></button>
      <button class="view-toggle" onclick="showProviderView('state')">By State</button>
      <button class="view-toggle" onclick="showProviderView('type')">By Type</button>
      <button class="view-toggle" onclick="showProviderView('favorites')">Pinned <span class="view-count" id="pinnedCount">0</span></button>
      <button class="view-toggle" onclick="showProviderView('aanp')">AANP</button>
    </div>
    <div class="toolbar-actions">
      <div class="export-dropdown">
        <button class="export-dropdown-trigger" onclick="toggleExportDropdown(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export <span class="dropdown-caret">▾</span>
        </button>
        <div class="export-dropdown-menu" id="exportDropdownMenu">
          <div class="dropdown-label">Quick Exports</div>
          <button onclick="exportAllProviders(); closeExportDropdown()">📋 All Providers</button>
          <button onclick="exportNeedsCEUs(); closeExportDropdown()">📚 Needs CEUs (${flat.filter(p => (p.hoursRemaining || 0) > 0).length})</button>
          <button onclick="exportNoLogins(); closeExportDropdown()">🔑 No CEU Logins (${trulyNoCredentialsProviders.length})</button>
          <button onclick="exportComplete(); closeExportDropdown()">✅ CEUs Complete (${flat.filter(p => (p.hoursRemaining || 0) <= 0 && p.hoursRequired > 0).length})</button>
          <button onclick="exportAtRisk(); closeExportDropdown()">⚠️ At Risk (${flat.filter(p => { const days = daysUntil(parseDate(p.renewalDeadline)); return days !== null && days <= 60 && (p.hoursRemaining || 0) > 0; }).length})</button>
          <div class="dropdown-divider"></div>
          <div class="dropdown-label">Other Exports</div>
          <button onclick="exportFilteredResults(); closeExportDropdown()">Filtered Results (CSV)</button>
          <button onclick="exportToCalendar(); closeExportDropdown()">Calendar (.ics)</button>
          <button onclick="printComplianceReport(); closeExportDropdown()">Print Report</button>
          <div class="dropdown-divider"></div>
          <div class="dropdown-label">Bulk Export (select providers first)</div>
          <button onclick="exportSelectedCSV(); closeExportDropdown()" id="exportSelectedCSVMenu" class="bulk-export-item" disabled>Selected as CSV</button>
          <button onclick="exportSelectedPDF(); closeExportDropdown()" id="exportSelectedPDFMenu" class="bulk-export-item" disabled>Selected as PDF</button>
        </div>
      </div>
      <div class="bulk-controls-compact">
        <button class="bulk-btn-compact" onclick="selectAllVisible()" title="Select all visible">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </button>
        <button class="bulk-btn-compact" onclick="clearSelection()" title="Clear selection">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
        </button>
        <span class="bulk-count-compact" id="bulkCount">0</span>
      </div>
    </div>
  </div>

  <!-- Print Header (shown only when printing) -->
  <div class="print-header">
    <h1>CEU Compliance Report</h1>
    <p>Generated on ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>

  <!-- All Providers View -->
  <div class="provider-view active" id="provider-all">
    <!-- Filter Bar -->
    <div class="providers-filter-bar">
      <input class="search-box" type="text" id="cardSearch" placeholder="Search providers..." oninput="filterCards()" />
      <select class="filter-select" id="statusFilter" onchange="setCardFilter(this.value)">
        <option value="all">All Statuses</option>
        <option value="At Risk">At Risk</option>
        <option value="In Progress">In Progress</option>
        <option value="Complete">Complete</option>
        <option value="Unknown">Credentials Needed</option>
      </select>
      <select class="filter-select" id="typeFilter" onchange="setProviderTypeFilter(this.value)">
        <option value="all">All Types</option>
        <option value="NP">NP</option>
        <option value="MD">MD</option>
        <option value="DO">DO</option>
        <option value="RN">RN</option>
      </select>
      <select class="filter-select" id="stateFilter" onchange="setStateFilter(this.value)">
        <option value="all">All States</option>
        ${allStates.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')}
      </select>
      <select class="filter-select" id="platformFilter" onchange="filterCards()">
        <option value="all">All Platforms</option>
        <option value="CE Broker">CE Broker</option>
        <option value="NetCE">NetCE</option>
        <option value="CEUfast">CEUfast</option>
        <option value="AANP Cert">AANP Cert</option>
      </select>
      <select class="filter-select" id="cardSort" onchange="sortCards()">
        <option value="name">Sort: Name (A-Z)</option>
        <option value="name-desc">Sort: Name (Z-A)</option>
        <option value="status">Sort: Risk First</option>
        <option value="status-asc">Sort: Complete First</option>
        <option value="deadline">Sort: Deadline (Soonest)</option>
      </select>
      <label class="creds-toggle">
        <input type="checkbox" id="noCredsFilter" onchange="filterCards()">
        <span>Missing Credentials</span>
      </label>
      <button class="advanced-filter-toggle" onclick="toggleAdvancedFilters()">
        <span>Advanced</span>
        <span class="toggle-icon" id="advFilterIcon">▼</span>
      </button>
    </div>

    <!-- Advanced Filters Panel -->
    <div class="advanced-filters" id="advancedFilters" style="display:none">
      <div class="adv-filter-group">
        <label>Deadline (days)</label>
        <div class="range-inputs">
          <input type="number" id="deadlineMin" placeholder="Min" min="0" onchange="filterCards()">
          <span>to</span>
          <input type="number" id="deadlineMax" placeholder="Max" min="0" onchange="filterCards()">
        </div>
      </div>
      <div class="adv-filter-group">
        <label>Hours Completed</label>
        <div class="range-inputs">
          <input type="number" id="hoursMin" placeholder="Min" min="0" onchange="filterCards()">
          <span>to</span>
          <input type="number" id="hoursMax" placeholder="Max" min="0" onchange="filterCards()">
        </div>
      </div>
      <div class="adv-filter-group">
        <label>Show Only</label>
        <div class="filter-checkboxes">
          <label><input type="checkbox" id="filterOverdue" onchange="filterCards()"> Overdue</label>
          <label><input type="checkbox" id="filterUrgent" onchange="filterCards()"> Due in 30 days</label>
        </div>
      </div>
    </div>

    <!-- Provider Count + Quick Filter Pills -->
    <div class="providers-count-row">
      <div class="providers-count">
        <span id="providerFilterCount">${providerEntries.length} of ${providerEntries.length} providers</span>
        <button class="reset-btn" onclick="resetProviderFilters()">Reset</button>
      </div>
      <div class="quick-filter-pills">
        <button class="qf-pill qf-pill-urgent" onclick="applyQuickFilter('urgent')" id="qf-urgent" title="Show providers needing attention">
          <span class="qf-pill-dot urgent"></span>Attention <span class="qf-pill-count">${atRiskCount + urgentCount}</span>
        </button>
        <button class="qf-pill" onclick="applyQuickFilter('due30')" id="qf-due30" title="Due within 30 days">
          30d <span class="qf-pill-count">${urgentCount}</span>
        </button>
        <button class="qf-pill" onclick="applyQuickFilter('due90')" id="qf-due90" title="Due within 90 days">
          90d
        </button>
        <button class="qf-pill qf-pill-complete" onclick="applyQuickFilter('complete')" id="qf-complete" title="Show complete providers">
          <span class="qf-pill-dot complete"></span>Done <span class="qf-pill-count">${completeCount}</span>
        </button>
        <button class="qf-pill qf-pill-all" onclick="applyQuickFilter('all')" id="qf-all" title="Show all providers">
          All
        </button>
      </div>
    </div>

    <!-- All Providers Cards Grid -->
    <div class="cards-grid" id="allCardsGrid">
      ${initialCards}
    </div>
    <div id="loadSentinel" class="load-sentinel"></div>
    <div id="loadingIndicator" class="loading-indicator" style="display:none">
      <div class="loading-spinner"></div>
      <span>Loading more providers...</span>
    </div>
  </div>

  <!-- Table View -->
  <div class="provider-view" id="provider-table">
    <div class="table-view-container">
      <table class="provider-table" id="providerTable">
        <thead>
          <tr>
            <th onclick="sortProviderTable('name')">Provider ↕</th>
            <th onclick="sortProviderTable('type')">Type ↕</th>
            <th onclick="sortProviderTable('state')">State ↕</th>
            <th onclick="sortProviderTable('status')">Status ↕</th>
            <th onclick="sortProviderTable('progress')" style="width: 180px;">Progress ↕</th>
            <th onclick="sortProviderTable('remaining')">Remaining ↕</th>
            <th onclick="sortProviderTable('deadline')">Deadline ↕</th>
            <th onclick="sortProviderTable('days')">Days Left ↕</th>
          </tr>
        </thead>
        <tbody>
          ${tableViewRows}
        </tbody>
      </table>
    </div>
  </div>

  <!-- By Deadline View -->
  <div class="provider-view" id="provider-deadline">
    <div class="deadline-buckets">
      <!-- 30 Days Bucket -->
      <div class="deadline-bucket bucket-30">
        <div class="bucket-header bucket-urgent">
          <span class="bucket-badge">30 Days</span>
          <span class="bucket-title">Due Within 30 Days</span>
          <span class="bucket-count">${deadlineProviders30.length} provider${deadlineProviders30.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="bucket-cards">
          ${deadlineProviders30.length > 0
            ? deadlineProviders30.map(([name, info, days]) => buildProviderCard([name, info])).join('')
            : '<div class="empty-bucket">No providers with deadlines in next 30 days</div>'}
        </div>
      </div>

      <!-- 60 Days Bucket -->
      <div class="deadline-bucket bucket-60">
        <div class="bucket-header bucket-warning">
          <span class="bucket-badge">60 Days</span>
          <span class="bucket-title">Due Within 31-60 Days</span>
          <span class="bucket-count">${deadlineProviders60.length} provider${deadlineProviders60.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="bucket-cards">
          ${deadlineProviders60.length > 0
            ? deadlineProviders60.map(([name, info, days]) => buildProviderCard([name, info])).join('')
            : '<div class="empty-bucket">No providers with deadlines in 31-60 days</div>'}
        </div>
      </div>

      <!-- 90 Days Bucket -->
      <div class="deadline-bucket bucket-90">
        <div class="bucket-header bucket-upcoming">
          <span class="bucket-badge">90 Days</span>
          <span class="bucket-title">Due Within 61-90 Days</span>
          <span class="bucket-count">${deadlineProviders90.length} provider${deadlineProviders90.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="bucket-cards">
          ${deadlineProviders90.length > 0
            ? deadlineProviders90.map(([name, info, days]) => buildProviderCard([name, info])).join('')
            : '<div class="empty-bucket">No providers with deadlines in 61-90 days</div>'}
        </div>
      </div>
    </div>
  </div>

  <!-- By State View -->
  <div class="provider-view" id="provider-state">
    <div class="state-groups">
      ${Object.entries(providersByState).sort((a, b) => a[0].localeCompare(b[0])).map(([state, stateProviders]) => {
        const stats = stateStats[state] || { total: 0, complete: 0, atRisk: 0, inProgress: 0 };
        return `<div class="state-group collapsible">
          <div class="state-group-header" onclick="toggleStateGroup(this)">
            <span class="collapse-icon">▼</span>
            <span class="state-name">${escHtml(state)}</span>
            <div class="state-mini-stats">
              ${stats.atRisk > 0 ? `<span class="mini-stat risk">${stats.atRisk} at risk</span>` : ''}
              ${stats.inProgress > 0 ? `<span class="mini-stat progress">${stats.inProgress} in progress</span>` : ''}
              ${stats.complete > 0 ? `<span class="mini-stat complete">${stats.complete} complete</span>` : ''}
            </div>
            <span class="state-provider-count">${stateProviders.length} provider${stateProviders.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="cards-grid state-cards collapsible-content">
            ${stateProviders.map(([name, info]) => buildProviderCard([name, info])).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- By Type View -->
  <div class="provider-view" id="provider-type">
    <div class="type-view-legend">
      <div class="type-legend-item type-clinical">
        <span class="type-legend-dot clinical"></span>
        <span><strong>Clinical Providers</strong> — NP, MD, DO (prescriptive authority, APRN requirements)</span>
      </div>
      <div class="type-legend-item type-support">
        <span class="type-legend-dot support"></span>
        <span><strong>Support Staff</strong> — RN (standard nursing CE requirements)</span>
      </div>
    </div>
    <div class="type-groups">
      ${Object.entries(providersByType).filter(([type, providers]) => providers.length > 0).map(([type, typeProviders]) => {
        const typeLabel = { NP: 'Nurse Practitioners', MD: 'Physicians (MD)', DO: 'Physicians (DO)', RN: 'Registered Nurses', Other: 'Other' }[type] || type;
        const typeRole = ['NP', 'MD', 'DO'].includes(type) ? 'Clinical Provider' : (type === 'RN' ? 'Support Staff' : 'Other');
        const typeIcon = ['NP', 'MD', 'DO'].includes(type) ? '👨‍⚕️' : (type === 'RN' ? '💉' : '👤');
        const groupClass = ['NP', 'MD', 'DO'].includes(type) ? 'type-group-clinical' : (type === 'RN' ? 'type-group-support' : '');
        return `<div class="type-group collapsible ${groupClass}">
          <div class="type-group-header" onclick="toggleStateGroup(this)">
            <span class="collapse-icon">▼</span>
            <span class="type-icon">${typeIcon}</span>
            <span class="type-name">${typeLabel}</span>
            <span class="type-role-badge ${typeRole === 'Clinical Provider' ? 'role-clinical' : 'role-support'}">${typeRole}</span>
            <span class="type-provider-count">${typeProviders.length} provider${typeProviders.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="cards-grid type-cards collapsible-content">
            ${typeProviders.map(([name, info]) => buildProviderCard([name, info])).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Favorites View -->
  <div class="provider-view" id="provider-favorites">
    <div class="favorites-header">
      <span class="favorites-title">Pinned Providers</span>
      <span class="favorites-hint">Click the ⭐ star on any provider card to pin them here for quick access</span>
    </div>
    <div class="cards-grid favorites-cards" id="favoritesGrid">
      <div class="empty-favorites">No pinned providers yet. Click the ⭐ star on any provider card to pin them here.</div>
    </div>
  </div>

  <!-- Priority View (Grouped by Status) -->
  <div class="provider-view" id="provider-priority">
    <div class="priority-view-header">
      <h3>Providers by Priority</h3>
      <p class="priority-view-subtitle">Organized by compliance status - expand/collapse each section</p>
    </div>
    <div class="priority-groups">
      <!-- Critical: At Risk -->
      <div class="priority-group collapsible priority-critical ${priorityGroups.critical.length === 0 ? 'empty-group' : ''}">
        <div class="priority-group-header" onclick="togglePriorityGroup(this)">
          <span class="collapse-icon">▼</span>
          <span class="priority-icon">🚨</span>
          <span class="priority-label">Critical - At Risk</span>
          <span class="priority-count">${priorityGroups.critical.length}</span>
          <span class="priority-desc">Providers behind on CE requirements</span>
        </div>
        <div class="priority-cards collapsible-content">
          ${priorityGroups.critical.length > 0
            ? priorityGroups.critical.map(p => buildProviderCard([p.name, p.info])).join('')
            : '<div class="empty-priority">No providers at risk</div>'}
        </div>
      </div>

      <!-- Needs Attention: Deadline within 60 days -->
      <div class="priority-group collapsible priority-attention ${priorityGroups.attention.length === 0 ? 'empty-group' : ''}">
        <div class="priority-group-header" onclick="togglePriorityGroup(this)">
          <span class="collapse-icon">▼</span>
          <span class="priority-icon">⚠️</span>
          <span class="priority-label">Needs Attention</span>
          <span class="priority-count">${priorityGroups.attention.length}</span>
          <span class="priority-desc">Deadline within 60 days</span>
        </div>
        <div class="priority-cards collapsible-content">
          ${priorityGroups.attention.length > 0
            ? priorityGroups.attention.map(p => buildProviderCard([p.name, p.info])).join('')
            : '<div class="empty-priority">No providers need immediate attention</div>'}
        </div>
      </div>

      <!-- On Track: In Progress, plenty of time -->
      <div class="priority-group collapsible priority-ontrack">
        <div class="priority-group-header" onclick="togglePriorityGroup(this)">
          <span class="collapse-icon">▼</span>
          <span class="priority-icon">📈</span>
          <span class="priority-label">On Track</span>
          <span class="priority-count">${priorityGroups.onTrack.length}</span>
          <span class="priority-desc">In progress with plenty of time</span>
        </div>
        <div class="priority-cards collapsible-content">
          ${priorityGroups.onTrack.length > 0
            ? priorityGroups.onTrack.map(p => buildProviderCard([p.name, p.info])).join('')
            : '<div class="empty-priority">No providers in this category</div>'}
        </div>
      </div>

      <!-- Complete -->
      <div class="priority-group collapsible priority-complete collapsed">
        <div class="priority-group-header" onclick="togglePriorityGroup(this)">
          <span class="collapse-icon">▼</span>
          <span class="priority-icon">✅</span>
          <span class="priority-label">Complete</span>
          <span class="priority-count">${priorityGroups.complete.length}</span>
          <span class="priority-desc">All requirements met</span>
        </div>
        <div class="priority-cards collapsible-content">
          ${priorityGroups.complete.length > 0
            ? priorityGroups.complete.map(p => buildProviderCard([p.name, p.info])).join('')
            : '<div class="empty-priority">No providers have completed all requirements</div>'}
        </div>
      </div>

      <!-- Unknown/Needs Credentials -->
      <div class="priority-group collapsible priority-unknown collapsed">
        <div class="priority-group-header" onclick="togglePriorityGroup(this)">
          <span class="collapse-icon">▼</span>
          <span class="priority-icon">❓</span>
          <span class="priority-label">Needs Setup</span>
          <span class="priority-count">${priorityGroups.unknown.length}</span>
          <span class="priority-desc">Missing platform credentials</span>
        </div>
        <div class="priority-cards collapsible-content">
          ${priorityGroups.unknown.length > 0
            ? priorityGroups.unknown.map(p => buildProviderCard([p.name, p.info])).join('')
            : '<div class="empty-priority">All providers have credentials configured</div>'}
        </div>
      </div>
    </div>
  </div>

  <!-- Kanban Board View -->
  <div class="provider-view" id="provider-kanban">
    <div class="kanban-header">
      <h3>Kanban Board</h3>
      <p class="kanban-subtitle">Visual workflow view of provider compliance status</p>
    </div>
    <div class="kanban-board">
      <!-- Needs CEUs Column -->
      <div class="kanban-column kanban-needs">
        <div class="kanban-column-header">
          <span class="kanban-column-icon">📚</span>
          <span class="kanban-column-title">Needs CEUs</span>
          <span class="kanban-column-count">${priorityGroups.critical.length + priorityGroups.attention.length + trulyNoCredentialsProviders.length}</span>
        </div>
        <div class="kanban-cards">
          ${[...priorityGroups.critical, ...priorityGroups.attention].map(p => {
            const hoursText = p.hoursNeeded > 0 ? p.hoursNeeded + 'h needed' : '';
            const daysText = p.deadline < 9999 ? p.deadline + 'd left' : '';
            return '<div class="kanban-card kanban-' + (p.status === 'At Risk' ? 'critical' : 'warning') + '" onclick="openProvider(\'' + escHtml(p.name).replace(/'/g, '&#39;') + '\')">' +
              '<div class="kanban-card-name">' + escHtml(p.name) + '</div>' +
              '<div class="kanban-card-meta">' +
                (hoursText ? '<span class="kanban-hours">' + hoursText + '</span>' : '') +
                (daysText ? '<span class="kanban-days">' + daysText + '</span>' : '') +
              '</div>' +
            '</div>';
          }).join('')}
          ${trulyNoCredentialsProviders.map(name => {
            return '<div class="kanban-card kanban-no-creds" onclick="openProvider(\'' + escHtml(name).replace(/'/g, '&#39;') + '\')">' +
              '<div class="kanban-card-name">' + escHtml(name) + '</div>' +
              '<div class="kanban-card-meta">' +
                '<span class="kanban-no-creds-label">No CEU logins</span>' +
              '</div>' +
            '</div>';
          }).join('')}
          ${priorityGroups.critical.length + priorityGroups.attention.length + trulyNoCredentialsProviders.length === 0 ? '<div class="kanban-empty">No providers need CEUs</div>' : ''}
        </div>
      </div>

      <!-- In Progress Column -->
      <div class="kanban-column kanban-progress">
        <div class="kanban-column-header">
          <span class="kanban-column-icon">⏳</span>
          <span class="kanban-column-title">In Progress</span>
          <span class="kanban-column-count">${priorityGroups.onTrack.length}</span>
        </div>
        <div class="kanban-cards">
          ${priorityGroups.onTrack.map(p => {
            const hoursText = p.hoursNeeded > 0 ? p.hoursNeeded + 'h needed' : '';
            const daysText = p.deadline < 9999 ? p.deadline + 'd left' : '';
            return '<div class="kanban-card kanban-progress-card" onclick="openProvider(\'' + escHtml(p.name).replace(/'/g, '&#39;') + '\')">' +
              '<div class="kanban-card-name">' + escHtml(p.name) + '</div>' +
              '<div class="kanban-card-meta">' +
                (hoursText ? '<span class="kanban-hours">' + hoursText + '</span>' : '') +
                (daysText ? '<span class="kanban-days">' + daysText + '</span>' : '') +
              '</div>' +
            '</div>';
          }).join('') || '<div class="kanban-empty">No providers in progress</div>'}
        </div>
      </div>

      <!-- Complete Column -->
      <div class="kanban-column kanban-done">
        <div class="kanban-column-header">
          <span class="kanban-column-icon">✅</span>
          <span class="kanban-column-title">Complete</span>
          <span class="kanban-column-count">${priorityGroups.complete.length}</span>
        </div>
        <div class="kanban-cards">
          ${priorityGroups.complete.map(p => {
            return '<div class="kanban-card kanban-complete-card" onclick="openProvider(\'' + escHtml(p.name).replace(/'/g, '&#39;') + '\')">' +
              '<div class="kanban-card-name">' + escHtml(p.name) + '</div>' +
              '<div class="kanban-card-meta"><span class="kanban-done-badge">✓ All done</span></div>' +
            '</div>';
          }).join('') || '<div class="kanban-empty">No providers complete</div>'}
        </div>
      </div>
    </div>
  </div>

  <!-- AANP Certification View -->
  <div class="provider-view" id="provider-aanp">
    <div class="aanp-tracker">
      <div class="aanp-header">
        <h3>AANP Certification Status</h3>
        <p class="aanp-subtitle">National certification tracking for nurse practitioners</p>
      </div>
      ${aanpCertData.length > 0 ? `
      <div class="aanp-grid">
        ${aanpCertData.map(cert => {
          const certInfo = aanpCertByProvider[cert.providerName] || {};
          const daysToExpire = daysUntil(parseDate(cert.certExpires));
          const statusCls = cert.certStatus === 'Active'
            ? (daysToExpire !== null && daysToExpire <= 90 ? 'cert-warning' : 'cert-active')
            : 'cert-expired';
          const pharmPct = cert.pharmacyHoursRequired > 0
            ? Math.min(100, Math.round((cert.pharmacyHoursEarned || 0) / cert.pharmacyHoursRequired * 100))
            : 0;
          const totalPct = cert.hoursRequired > 0
            ? Math.min(100, Math.round((cert.hoursEarned || 0) / cert.hoursRequired * 100))
            : 0;
          const safeName = escHtml(cert.providerName).replace(/'/g, '&#39;');
          return `<div class="aanp-card ${statusCls}" onclick="openProvider('${safeName}')">
            <div class="aanp-card-header">
              <span class="aanp-provider-name">${escHtml(cert.providerName)}</span>
              <span class="aanp-cert-status ${statusCls}">${escHtml(cert.certStatus || 'Unknown')}</span>
            </div>
            <div class="aanp-cert-expiry">
              Expires: <strong>${escHtml(cert.certExpires || 'N/A')}</strong>
              ${daysToExpire !== null ? `<span class="aanp-days-left ${daysToExpire <= 90 ? 'urgent' : ''}">(${daysToExpire}d)</span>` : ''}
            </div>
            <div class="aanp-hours-section">
              <div class="aanp-hours-row">
                <span class="aanp-hours-label">Total CE</span>
                <div class="aanp-progress-bar">
                  <div class="aanp-progress-fill" style="width:${totalPct}%"></div>
                </div>
                <span class="aanp-hours-text">${cert.hoursEarned ?? 0}/${cert.hoursRequired ?? 100} hrs</span>
              </div>
              <div class="aanp-hours-row">
                <span class="aanp-hours-label">Pharmacology</span>
                <div class="aanp-progress-bar pharm">
                  <div class="aanp-progress-fill" style="width:${pharmPct}%"></div>
                </div>
                <span class="aanp-hours-text">${cert.pharmacyHoursEarned ?? 0}/${cert.pharmacyHoursRequired ?? 25} hrs</span>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>` : `
      <div class="empty-aanp">
        <span class="empty-icon">○</span>
        <span class="empty-text">No AANP certification data available. Configure AANP Cert credentials for providers.</span>
      </div>`}
    </div>
  </div>

  <!-- State Stats View -->
  <div class="provider-view" id="provider-stats">
    <div class="state-stats-grid">
      ${Object.entries(stateStats).sort((a, b) => b[1].total - a[1].total).map(([state, stats]) => {
        const completePct = stats.total > 0 ? Math.round(stats.complete / stats.total * 100) : 0;
        return `<div class="state-stat-card">
          <div class="state-stat-header">
            <span class="state-stat-name">${escHtml(state)}</span>
            <span class="state-stat-total">${stats.total} license${stats.total !== 1 ? 's' : ''}</span>
          </div>
          <div class="state-stat-bar">
            <div class="state-bar-segment complete" style="width:${stats.total > 0 ? (stats.complete / stats.total * 100) : 0}%"></div>
            <div class="state-bar-segment progress" style="width:${stats.total > 0 ? (stats.inProgress / stats.total * 100) : 0}%"></div>
            <div class="state-bar-segment risk" style="width:${stats.total > 0 ? (stats.atRisk / stats.total * 100) : 0}%"></div>
            <div class="state-bar-segment unknown" style="width:${stats.total > 0 ? (stats.unknown / stats.total * 100) : 0}%"></div>
          </div>
          <div class="state-stat-details">
            <span class="stat-detail complete">${stats.complete} complete</span>
            <span class="stat-detail progress">${stats.inProgress} in progress</span>
            <span class="stat-detail risk">${stats.atRisk} at risk</span>
            ${stats.unknown > 0 ? `<span class="stat-detail unknown">${stats.unknown} unknown</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Timeline View -->
  <div class="provider-view" id="provider-timeline">
    <div class="timeline-header">
      <h3>CE Activity Timeline</h3>
      <p class="timeline-subtitle">Visualizing course completions and license deadlines over time</p>
      <div class="timeline-controls">
        <label>
          <span>View Range:</span>
          <select id="timelineRange" onchange="updateTimeline()">
            <option value="6">Last 6 Months</option>
            <option value="12" selected>Last 12 Months</option>
            <option value="24">Last 2 Years</option>
            <option value="60">Last 5 Years</option>
          </select>
        </label>
        <label>
          <span>Show:</span>
          <select id="timelineFilter" onchange="updateTimeline()">
            <option value="all">All Providers</option>
            <option value="active">Active (Has Courses)</option>
          </select>
        </label>
      </div>
    </div>
    <div class="timeline-legend">
      <span class="legend-item"><span class="legend-dot course-dot"></span> Course Completed</span>
      <span class="legend-item"><span class="legend-line deadline-line"></span> License Deadline</span>
    </div>
    <div class="timeline-container" id="timelineContainer">
      <div class="timeline-axis" id="timelineAxis"></div>
      <div class="timeline-content" id="timelineContent">
        <!-- Timeline rows will be rendered by JS -->
      </div>
    </div>
    <div class="timeline-empty" id="timelineEmpty" style="display:none">
      <span>No timeline data available. Course completion dates are needed to display the timeline.</span>
    </div>
  </div>
</div>

<!-- ── Tab: Compliance (Lookback Requirements) ─────────────────────────────── -->
<div class="tab-panel" id="tab-compliance">
  <div class="compliance-header">
    <div class="compliance-title">
      <h2>State Lookback Requirements</h2>
      <p class="compliance-subtitle">Certain CE hours must be completed within specific time windows (e.g., last 5 years)</p>
    </div>
    <div class="compliance-summary">
      <div class="compliance-stat compliance-met">
        <span class="compliance-stat-num">${lookbackMet}</span>
        <span class="compliance-stat-label">Met</span>
      </div>
      <div class="compliance-stat compliance-notmet">
        <span class="compliance-stat-num">${lookbackNotMet}</span>
        <span class="compliance-stat-label">Not Met</span>
      </div>
    </div>
  </div>

  ${lookbackComplianceData.length > 0 ? `
  <div class="compliance-table-wrap">
    <table class="compliance-table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>State</th>
          <th>Requirement</th>
          <th>Subject</th>
          <th>Required</th>
          <th>Total Hrs</th>
          <th>Valid Hrs</th>
          <th>Window</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${lookbackComplianceData.map(d => {
          const statusCls = d.needed === 0 ? 'comp-met' : d.validHours > 0 ? 'comp-partial' : 'comp-none';
          const cutoffDate = formatLookbackCutoff(d.lookbackYears);
          const safeName = escHtml(d.providerName).replace(/'/g, '&#39;');
          return `<tr class="${statusCls}" onclick="openProvider('${safeName}')">
            <td class="comp-provider">${escHtml(d.providerName)}</td>
            <td class="comp-state">${escHtml(d.state)}</td>
            <td class="comp-req">${escHtml(d.requirement)}</td>
            <td class="comp-subject">${escHtml(d.subject)}</td>
            <td class="comp-num">${d.hoursRequired}h</td>
            <td class="comp-num">${d.totalHours}h</td>
            <td class="comp-num comp-valid">${d.validHours}h</td>
            <td class="comp-window">${d.lookbackYears}yr<br><small>since ${cutoffDate}</small></td>
            <td class="comp-status ${statusCls}">${d.needed === 0 ? '✓ Met' : '⚠ ' + d.status}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div class="compliance-legend">
    <span class="legend-item"><span class="legend-dot comp-met"></span> Requirement met</span>
    <span class="legend-item"><span class="legend-dot comp-partial"></span> Partial (some valid hours)</span>
    <span class="legend-item"><span class="legend-dot comp-none"></span> No valid hours in window</span>
  </div>

  <div class="compliance-info">
    <h4>About Lookback Periods</h4>
    <p>Some states require specific CE hours to be completed within a recent time window. For example, Florida's Autonomous APRN registration requires 45 hours of pharmacology completed within the <strong>past 5 years</strong>.</p>
    <p>Hours completed outside the lookback window still appear in "Total Hrs" but don't count toward "Valid Hrs" for compliance.</p>
  </div>
  ` : `
  <div class="compliance-empty">
    <span class="empty-icon">○</span>
    <span class="empty-text">No lookback requirements configured for current team members.</span>
    <p class="empty-hint">Lookback requirements are configured in state-requirements.json</p>
  </div>
  `}
</div>

<!-- ── Tab: Platforms ───────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-platforms">
  <!-- View Toggle Buttons -->
  <div class="view-toggle-bar">
    <button class="view-toggle active" onclick="showPlatformView('matrix')">Coverage Matrix</button>
    <button class="view-toggle" onclick="showPlatformView('gaps')">Credential Gaps</button>
  </div>

  <!-- Coverage Matrix View -->
  <div class="platform-view active" id="platform-matrix">
    <div class="matrix-intro" style="background: var(--bg-secondary); padding: 16px 20px; border-radius: 12px; margin-bottom: 16px;">
      <div style="font-weight: 700; margin-bottom: 8px; color: var(--text-primary);">📊 Provider Credentials Status</div>
      <div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
        This matrix shows which providers have credentials configured for CEU tracking.
      </div>
    </div>
    <div class="matrix-legend">
      <span class="legend-item"><span class="legend-dot cov-yes"></span> <strong>Has Credentials</strong> - Provider credentials configured</span>
      <span class="legend-item"><span class="legend-dot cov-no"></span> <strong>No Credentials</strong> - Credentials needed</span>
    </div>
    <div class="matrix-wrap">
      <table class="coverage-matrix">
        <thead>
          <tr>
            <th class="cov-provider-hdr">Provider Name</th>
            <th>Credentials Status</th>
          </tr>
        </thead>
        <tbody>
          ${(() => {
            const totalProviders = providerEntries.length;
            let hasCredsCount = 0;
            let noCredsCount = 0;

            const rows = providerEntries.map(([name, info]) => {
              const providerPlatforms = platformByProvider[name] || [];

              // Check CE Broker status from runResults
              const cebrokerResult = (runResults || []).find(r => r.name === name);
              const hasCEBroker = cebrokerResult && (cebrokerResult.status === 'success' || cebrokerResult.status === 'login_error' || cebrokerResult.status === 'failed');

              // Check if provider has any platform credentials
              const hasAnyPlatform = providerPlatforms.length > 0;

              // Provider has credentials if they have CE Broker OR any platform configured
              const hasCredentials = hasCEBroker || hasAnyPlatform;

              if (hasCredentials) {
                hasCredsCount++;
              } else {
                noCredsCount++;
              }

              const rowClass = hasCredentials ? 'cov-row-full' : 'cov-row-none';
              const statusCell = hasCredentials
                ? '<td class="cov-yes" style="text-align:center;font-weight:700;color:#059669;">Yes</td>'
                : '<td class="cov-no" style="text-align:center;font-weight:700;color:#dc2626;">No</td>';

              const safeName = escHtml(name).replace(/'/g, '&#39;');
              return '<tr class="' + rowClass + '"><td class="cov-provider" onclick="openProvider(\'' + safeName + '\')">' + escHtml(name) + '</td>' + statusCell + '</tr>';
            }).join('');

            // Summary footer
            const hasCredsPct = totalProviders > 0 ? Math.round((hasCredsCount / totalProviders) * 100) : 0;
            const footerCell = '<td><div class="cov-summary-stat"><span class="cov-summary-num sum-green">' + hasCredsCount + '</span><span class="cov-summary-pct">' + hasCredsPct + '% have credentials</span></div></td>';

            return rows + '</tbody><tfoot><tr><td class="cov-summary-label">Total (' + totalProviders + ' providers)</td>' + footerCell + '</tr></tfoot>';
          })()}
      </table>
    </div>
  </div>

  <!-- Credential Gaps View -->
  <div class="platform-view" id="platform-gaps">
    <div class="credential-gaps-grid">
      <!-- Missing CE Broker -->
      <div class="cred-gap-card">
        <div class="cred-gap-header cred-gap-cebroker">
          <span class="cred-gap-icon">🔑</span>
          <span class="cred-gap-title">Missing Platform Credentials</span>
          <span class="cred-gap-count">${missingCEBroker.length}</span>
        </div>
        <div class="cred-gap-body">
          <div class="cred-gap-subtitle">With some platform access (${missingCEBroker.filter(p => !p.noCredentials).length})</div>
          <div class="cred-gap-list">
            ${missingCEBroker.filter(p => !p.noCredentials).map(p => {
              const safeName = escHtml(p.name).replace(/'/g, '&#39;');
              return '<span class="cred-gap-chip" onclick="openProvider(\'' + safeName + '\')">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>';
            }).join('') || '<span class="cred-gap-none">None</span>'}
          </div>
          <div class="cred-gap-subtitle" style="margin-top: 12px;">No credentials at all (${missingCEBroker.filter(p => p.noCredentials).length})</div>
          <div class="cred-gap-list">
            ${missingCEBroker.filter(p => p.noCredentials).map(p => {
              const safeName = escHtml(p.name).replace(/'/g, '&#39;');
              return '<span class="cred-gap-chip cred-gap-chip-none" onclick="openProvider(\'' + safeName + '\')">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>';
            }).join('') || '<span class="cred-gap-none">None</span>'}
          </div>
        </div>
      </div>

      <!-- Missing NetCE -->
      <div class="cred-gap-card">
        <div class="cred-gap-header cred-gap-netce">
          <span class="cred-gap-icon">📚</span>
          <span class="cred-gap-title">Missing NetCE Credentials</span>
          <span class="cred-gap-count">${missingNetCE.length}</span>
        </div>
        <div class="cred-gap-body">
          <div class="cred-gap-subtitle">Have other platform access (${missingNetCE.filter(p => !p.noCredentials).length})</div>
          <div class="cred-gap-list">
            ${missingNetCE.filter(p => !p.noCredentials).map(p => {
              const safeName = escHtml(p.name).replace(/'/g, '&#39;');
              return '<span class="cred-gap-chip" onclick="openProvider(\'' + safeName + '\')">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>';
            }).join('') || '<span class="cred-gap-none">None</span>'}
          </div>
          <div class="cred-gap-subtitle" style="margin-top: 12px;">No credentials at all (${missingNetCE.filter(p => p.noCredentials).length})</div>
          <div class="cred-gap-list">
            ${missingNetCE.filter(p => p.noCredentials).map(p => {
              const safeName = escHtml(p.name).replace(/'/g, '&#39;');
              return '<span class="cred-gap-chip cred-gap-chip-none" onclick="openProvider(\'' + safeName + '\')">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>';
            }).join('') || '<span class="cred-gap-none">None</span>'}
          </div>
        </div>
      </div>

      <!-- Have Both -->
      <div class="cred-gap-card">
        <div class="cred-gap-header cred-gap-complete">
          <span class="cred-gap-icon">✓</span>
          <span class="cred-gap-title">Have Both CE Broker & NetCE</span>
          <span class="cred-gap-count">${haveBoth.length}</span>
        </div>
        <div class="cred-gap-body">
          <div class="cred-gap-list">
            ${haveBoth.map(p => {
              const safeName = escHtml(p.name).replace(/'/g, '&#39;');
              return '<span class="cred-gap-chip cred-gap-chip-complete" onclick="openProvider(\'' + safeName + '\')">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>';
            }).join('') || '<span class="cred-gap-none">None</span>'}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ── Tab: Reports ─────────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-reports">
  <!-- View Toggle Buttons -->
  <div class="view-toggle-bar">
    <button class="view-toggle active" onclick="showReportView('charts')">Progress Charts</button>
    <button class="view-toggle" onclick="showReportView('calendar')">Deadline Calendar</button>
    <button class="view-toggle" onclick="showReportView('costs')">Cost Analysis</button>
    <button class="view-toggle" onclick="showReportView('runlog')">Run History</button>
  </div>

  <!-- Charts View -->
  <div class="report-view active" id="report-charts">
    <div class="chart-wrap">
      <div class="chart-section">
        <div class="chart-section-title">Hours Completed vs. Required</div>
        <div class="chart-canvas-wrap"><canvas id="hoursChart"></canvas></div>
      </div>
      <div class="chart-section">
        <div class="chart-section-title">Progress Over Time</div>
        <div id="historyChartWrap" class="chart-canvas-wrap"><canvas id="historyChart"></canvas></div>
      </div>
    </div>
  </div>

  <!-- Calendar View -->
  <div class="report-view" id="report-calendar">
    <div class="cal-wrap">
      ${calendarHtml}
    </div>
  </div>

  <!-- Cost Analysis View -->
  <div class="report-view" id="report-costs">
    <!-- Cost Per Hour Comparison -->
    <div class="cost-comparison">
      <div class="cost-comparison-header">
        <div class="cost-comparison-title"><span class="title-icon">💰</span> Cost Per CEU Hour</div>
      </div>
      <div class="cost-platforms">
        ${platformComparison.length > 0 ? platformComparison.map(p => `
          <div class="cost-platform-card${p.platform === bestValuePlatform ? ' best-value' : ''}">
            <div class="cost-platform-name">${escHtml(p.platform)}</div>
            <div class="cost-platform-rate">$${p.costPerHour.toFixed(2)} <span>/ hour</span></div>
            <div class="cost-platform-details">
              ${p.totalHours} hours from ${p.courseCount} courses | $${p.totalSpent.toFixed(0)} total
            </div>
          </div>
        `).join('') : '<div class="cost-platform-card"><div class="cost-platform-name">No cost data available</div><div class="cost-platform-details">Add course costs to see comparison</div></div>'}
      </div>
    </div>

    <!-- Platform ROI -->
    <div class="platform-roi">
      <div class="roi-header">
        <div class="roi-title">Platform Investment Breakdown</div>
      </div>
      <div class="roi-grid">
        ${platformROICards.length > 0 ? platformROICards.map(p => `
          <div class="roi-card">
            <div class="roi-card-header">
              <span class="roi-platform-name">${escHtml(p.platform)}</span>
              <span class="roi-total-spent">$${p.totalSpent.toFixed(0)}</span>
            </div>
            <div class="roi-stats">
              <div class="roi-stat">
                <div class="roi-stat-value">${p.totalHours}</div>
                <div class="roi-stat-label">Hours</div>
              </div>
              <div class="roi-stat">
                <div class="roi-stat-value">${p.topUsers.length}</div>
                <div class="roi-stat-label">Providers</div>
              </div>
              <div class="roi-stat">
                <div class="roi-stat-value">$${p.totalHours > 0 ? (p.totalSpent / p.totalHours).toFixed(2) : '0'}</div>
                <div class="roi-stat-label">Per Hour</div>
              </div>
            </div>
            ${p.topUsers.length > 0 ? `
            <div class="roi-top-users">
              <div class="roi-top-users-title">Top Users</div>
              ${p.topUsers.map(u => `
                <div class="roi-user">
                  <span class="roi-user-name">${escHtml(u.name)}</span>
                  <span class="roi-user-hours">${u.hours} hrs</span>
                </div>
              `).join('')}
            </div>` : ''}
          </div>
        `).join('') : '<div class="roi-card"><div class="roi-platform-name">No platform data</div></div>'}
      </div>
    </div>
  </div>

  <!-- Run Log View -->
  <div class="report-view" id="report-runlog">
    <div class="run-table-wrap">
      <table>
        <thead><tr>
          <th>Provider</th>
          <th style="text-align:center;width:140px">Result</th>
          <th>Error Message</th>
        </tr></thead>
        <tbody>${runRows || '<tr><td colspan="3" class="empty-message">No run data available</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>

<!-- ── Provider detail drawer ──────────────────────────────────────────── -->
<div class="drawer-overlay" id="drawerOverlay" onclick="if(event.target===this)closeProvider()">
  <div class="drawer-panel" id="drawerPanel">
    <button class="drawer-close" onclick="closeProvider()">✕</button>
    <button class="print-btn"   onclick="printProvider()">Print / Export PDF</button>
    <div id="drawerContent"></div>
  </div>
</div>

  </main><!-- end main-content -->
</div><!-- end app-layout -->

<!-- ── Tab: Status ─────────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-status">
  <div class="status-page">
    <!-- Scrape Status Section -->
    <div class="status-section">
      <h2 class="status-section-title">
        <span class="status-icon">📡</span>
        Last Scrape Status
      </h2>
      <div class="status-cards-grid">
        <div class="status-card">
          <div class="status-card-label">Last Run</div>
          <div class="status-card-value">${escHtml(runDate)}</div>
        </div>
        <div class="status-card status-card-success">
          <div class="status-card-label">Platform Logins</div>
          <div class="status-card-value">${runResults.filter(r => r.status === 'success').length} / ${runResults.filter(r => r.status !== 'not_configured').length}</div>
          <div class="status-card-sub">successful</div>
        </div>
        <div class="status-card status-card-info">
          <div class="status-card-label">Platform Scrapers</div>
          <div class="status-card-value">${platformData.filter(p => p.status === 'success').length} / ${platformData.length}</div>
          <div class="status-card-sub">successful</div>
        </div>
        <div class="status-card ${runResults.filter(r => r.status === 'login_error').length > 0 ? 'status-card-error' : 'status-card-success'}">
          <div class="status-card-label">Errors</div>
          <div class="status-card-value">${runResults.filter(r => r.status === 'login_error').length + platformData.filter(p => p.status === 'failed').length}</div>
          <div class="status-card-sub">this run</div>
        </div>
      </div>
    </div>

    <!-- Credential Health Section -->
    <div class="status-section">
      <h2 class="status-section-title">
        <span class="status-icon">🔐</span>
        Credential Health
      </h2>
      <div class="health-summary">
        <div class="health-stat health-healthy">
          <span class="health-num">${healthSummary.healthy}</span>
          <span class="health-label">Healthy</span>
        </div>
        <div class="health-stat health-degraded">
          <span class="health-num">${healthSummary.degraded}</span>
          <span class="health-label">Degraded</span>
        </div>
        <div class="health-stat health-warning">
          <span class="health-num">${healthSummary.warning}</span>
          <span class="health-label">Warning</span>
        </div>
        <div class="health-stat health-critical">
          <span class="health-num">${healthSummary.critical}</span>
          <span class="health-label">Critical</span>
        </div>
      </div>

      ${healthSummary.credentials.filter(c => c.status !== 'healthy').length > 0 ? `
      <div class="health-issues">
        <h3 class="health-issues-title">Credentials Requiring Attention</h3>
        <div class="health-issues-list">
          ${healthSummary.credentials.filter(c => c.status !== 'healthy').map(cred => `
            <div class="health-issue-item health-issue-${cred.status}">
              <div class="health-issue-status">
                <span class="health-dot health-dot-${cred.status}"></span>
                <span class="health-status-text">${cred.status.toUpperCase()}</span>
              </div>
              <div class="health-issue-info">
                <div class="health-issue-provider">${escHtml(cred.providerName)}</div>
                <div class="health-issue-platform">${escHtml(cred.platform)}</div>
              </div>
              <div class="health-issue-details">
                <div class="health-issue-failures">${cred.consecutiveFailures} consecutive failure${cred.consecutiveFailures !== 1 ? 's' : ''}</div>
                ${cred.lastError ? `<div class="health-issue-error">${escHtml(cred.lastError.substring(0, 80))}${cred.lastError.length > 80 ? '...' : ''}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : `
      <div class="health-all-good">
        <span class="health-all-good-icon">✓</span>
        <span class="health-all-good-text">All credentials are healthy</span>
      </div>
      `}
    </div>

    <!-- Credential Tracker Section -->
    <div class="status-section">
      <h2 class="status-section-title">
        <span class="status-icon">📋</span>
        Credential Tracker
      </h2>

      <!-- Summary Stats -->
      <div class="cred-tracker-summary">
        <div class="cred-summary-stat cred-summary-total">
          <span class="cred-summary-num">${providers.length}</span>
          <span class="cred-summary-label">Total Providers</span>
        </div>
        <div class="cred-summary-stat cred-summary-configured">
          <span class="cred-summary-num">${haveCEBrokerAndPlatform.length + ceBrokerOnly.length + platformOnly.length}</span>
          <span class="cred-summary-label">Have Some Credentials</span>
        </div>
        <div class="cred-summary-stat cred-summary-nocreds">
          <span class="cred-summary-num">${noCredsAtAll.length}</span>
          <span class="cred-summary-label">Need Credentials</span>
        </div>
        <div class="cred-summary-stat cred-summary-nocourses">
          <span class="cred-summary-num">${hasCredentialsNoCourses.length}</span>
          <span class="cred-summary-label">Unused Credentials</span>
        </div>
        <div class="cred-summary-stat cred-summary-nohistory">
          <span class="cred-summary-num">${noCEUHistory.length}</span>
          <span class="cred-summary-label">No CEU History</span>
        </div>
      </div>

      <!-- Filter Buttons -->
      <div class="cred-tracker-filters">
        <button class="cred-filter-btn active" onclick="filterCredTracker('all')">All <span class="cred-filter-count">${providers.length}</span></button>
        <button class="cred-filter-btn" onclick="filterCredTracker('cebroker-only')">CE Broker Only <span class="cred-filter-count">${ceBrokerOnly.length}</span></button>
        <button class="cred-filter-btn" onclick="filterCredTracker('platform-only')">Platform Only <span class="cred-filter-count">${platformOnly.length}</span></button>
        <button class="cred-filter-btn" onclick="filterCredTracker('both')">Fully Configured <span class="cred-filter-count">${haveCEBrokerAndPlatform.length}</span></button>
        <button class="cred-filter-btn cred-filter-warning" onclick="filterCredTracker('no-creds')">No Credentials <span class="cred-filter-count">${noCredsAtAll.length}</span></button>
        <button class="cred-filter-btn cred-filter-info" onclick="filterCredTracker('unused')">Unused Credentials <span class="cred-filter-count">${hasCredentialsNoCourses.length}</span></button>
        <button class="cred-filter-btn cred-filter-danger" onclick="filterCredTracker('no-history')">No CEU History <span class="cred-filter-count">${noCEUHistory.length}</span></button>
        <button class="cred-filter-btn cred-filter-orange" onclick="filterCredTracker('no-activity')">Login Failures <span class="cred-filter-count">${accountsNoActivity.length}</span></button>
      </div>

      <!-- Credential Tracker Grid -->
      <div class="cred-tracker-grid" id="credTrackerGrid">

        <!-- No Credentials At All - PRIORITY -->
        <div class="cred-tracker-card cred-cat-no-creds" data-category="no-creds">
          <div class="cred-tracker-header cred-header-danger">
            <span class="cred-tracker-icon">!</span>
            <span class="cred-tracker-title">No Credentials At All</span>
            <span class="cred-tracker-count">${noCredsAtAll.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Providers with no login credentials in the system - cannot track compliance</div>
            <div class="cred-tracker-note cred-note-danger"><strong>Action Required:</strong> Submit platform login credentials to begin tracking</div>
            <div class="cred-tracker-list">
              ${noCredsAtAll.length > 0 ? noCredsAtAll.map(p => {
                const safeName = escHtml(p.name).replace(/'/g, '&#39;');
                return '<div class="cred-tracker-item cred-item-danger" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(p.name) + '</span>' +
                  '<span class="cred-tracker-status-badge cred-badge-danger">Needs All Credentials</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none cred-none-good">All providers have credentials configured</span>'}
            </div>
          </div>
        </div>

        <!-- No CEU History -->
        <div class="cred-tracker-card cred-cat-no-history" data-category="no-history">
          <div class="cred-tracker-header cred-header-dark">
            <span class="cred-tracker-icon">0</span>
            <span class="cred-tracker-title">No CEU History</span>
            <span class="cred-tracker-count">${noCEUHistory.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Providers with no recorded CEU courses in the system</div>
            <div class="cred-tracker-note cred-note-dark"><strong>Status:</strong> No courses scraped yet - may need credential setup or first scrape</div>
            <div class="cred-tracker-list">
              ${noCEUHistory.length > 0 ? noCEUHistory.map(p => {
                const safeName = escHtml(p.name).replace(/'/g, '&#39;');
                const statusBadge = p.noCredentials ? 'No Credentials' : (p.hasCredentials ? 'Has Credentials' : 'Partial Credentials');
                const badgeClass = p.noCredentials ? 'cred-badge-danger' : (p.hasCredentials ? 'cred-badge-info' : 'cred-badge-warning');
                return '<div class="cred-tracker-item" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>' +
                  '<span class="cred-tracker-status-badge ' + badgeClass + '">' + statusBadge + '</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none cred-none-good">All providers have CEU history</span>'}
            </div>
          </div>
        </div>

        <!-- Unused Credentials (Have Creds, No Courses) -->
        <div class="cred-tracker-card cred-cat-unused" data-category="unused">
          <div class="cred-tracker-header cred-header-info">
            <span class="cred-tracker-icon">?</span>
            <span class="cred-tracker-title">Unused Credentials</span>
            <span class="cred-tracker-count">${hasCredentialsNoCourses.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Providers with credentials configured but no courses taken/scraped</div>
            <div class="cred-tracker-note cred-note-info"><strong>Check:</strong> Verify credentials work and courses are being tracked</div>
            <div class="cred-tracker-list">
              ${hasCredentialsNoCourses.length > 0 ? hasCredentialsNoCourses.map(p => {
                const safeName = escHtml(p.name).replace(/'/g, '&#39;');
                const credList = [];
                if (p.hasCEBroker) credList.push('CE Broker');
                credList.push(...p.platforms);
                return '<div class="cred-tracker-item cred-item-info" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>' +
                  '<span class="cred-tracker-platforms">Has: ' + escHtml(credList.join(', ')) + '</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none cred-none-good">All credentialed providers have course history</span>'}
            </div>
          </div>
        </div>

        <!-- Login Failures (No Activity) -->
        <div class="cred-tracker-card cred-cat-no-activity" data-category="no-activity">
          <div class="cred-tracker-header cred-header-warning">
            <span class="cred-tracker-icon">X</span>
            <span class="cred-tracker-title">Login Failures</span>
            <span class="cred-tracker-count">${accountsNoActivity.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Credentials configured but never successfully logged in</div>
            <div class="cred-tracker-note cred-note-warning"><strong>Action:</strong> Verify credentials are correct or account is active</div>
            <div class="cred-tracker-list">
              ${accountsNoActivity.length > 0 ? accountsNoActivity.map(a => {
                const safeName = escHtml(a.providerName).replace(/'/g, '&#39;');
                return '<div class="cred-tracker-item cred-item-warning" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(a.providerName) + '</span>' +
                  '<span class="cred-tracker-platforms">' + escHtml(a.platform) + ' - ' + a.failures + ' failed attempts</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none cred-none-good">All logins successful</span>'}
            </div>
          </div>
        </div>

        <!-- Platform Only (No CE Broker) -->
        <div class="cred-tracker-card cred-cat-platform-only" data-category="platform-only">
          <div class="cred-tracker-header cred-header-platform">
            <span class="cred-tracker-icon">PL</span>
            <span class="cred-tracker-title">Platform Only (No CE Broker)</span>
            <span class="cred-tracker-count">${platformOnly.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Have some platform credentials but not connected to primary compliance system</div>
            <div class="cred-tracker-note"><strong>Needs:</strong> Additional credentials for full compliance tracking</div>
            <div class="cred-tracker-list">
              ${platformOnly.length > 0 ? platformOnly.map(p => {
                const safeName = escHtml(p.name).replace(/'/g, '&#39;');
                const platList = p.platforms.join(', ');
                return '<div class="cred-tracker-item" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>' +
                  '<span class="cred-tracker-platforms">' + escHtml(platList) + '</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none">None</span>'}
            </div>
          </div>
        </div>

        <!-- CE Broker Only -->
        <div class="cred-tracker-card cred-cat-cebroker-only" data-category="cebroker-only">
          <div class="cred-tracker-header cred-header-cebroker">
            <span class="cred-tracker-icon">CE</span>
            <span class="cred-tracker-title">CE Broker Only</span>
            <span class="cred-tracker-count">${ceBrokerOnly.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Have CE Broker login but no platform credentials configured</div>
            <div class="cred-tracker-note"><strong>Needs:</strong> Platform credentials (NetCE, CEUfast, AANP, etc.)</div>
            <div class="cred-tracker-list">
              ${ceBrokerOnly.length > 0 ? ceBrokerOnly.map(p => {
                const safeName = escHtml(p.name).replace(/'/g, '&#39;');
                return '<div class="cred-tracker-item" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>' +
                  '<span class="cred-tracker-status-badge cred-badge-cebroker">CE Broker Only</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none">None</span>'}
            </div>
          </div>
        </div>

        <!-- Fully Configured -->
        <div class="cred-tracker-card cred-cat-both" data-category="both">
          <div class="cred-tracker-header cred-header-complete">
            <span class="cred-tracker-icon">OK</span>
            <span class="cred-tracker-title">Fully Configured</span>
            <span class="cred-tracker-count">${haveCEBrokerAndPlatform.length}</span>
          </div>
          <div class="cred-tracker-body">
            <div class="cred-tracker-desc">Have both CE Broker and platform credentials</div>
            <div class="cred-tracker-note cred-note-good"><strong>Status:</strong> No additional credentials needed</div>
            <div class="cred-tracker-list">
              ${haveCEBrokerAndPlatform.length > 0 ? haveCEBrokerAndPlatform.map(p => {
                const safeName = escHtml(p.name).replace(/'/g, '&#39;');
                const platList = p.platforms.join(', ');
                return '<div class="cred-tracker-item cred-item-good" onclick="openProvider(\'' + safeName + '\')">' +
                  '<span class="cred-tracker-name">' + escHtml(p.name) + ' <small>(' + p.type + ')</small></span>' +
                  '<span class="cred-tracker-platforms">' + escHtml(platList) + '</span>' +
                '</div>';
              }).join('') : '<span class="cred-tracker-none">None</span>'}
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- Recent Errors Section -->
    ${(runResults.filter(r => r.error).length + platformData.filter(p => p.error).length) > 0 ? `
    <div class="status-section">
      <h2 class="status-section-title">
        <span class="status-icon">⚠️</span>
        Recent Errors
      </h2>
      <div class="error-log">
        ${runResults.filter(r => r.error).map(r => `
          <div class="error-log-item">
            <span class="error-log-type">CE Broker</span>
            <span class="error-log-provider">${escHtml(r.name)}</span>
            <span class="error-log-msg">${escHtml(r.error)}</span>
          </div>
        `).join('')}
        ${platformData.filter(p => p.error).map(p => `
          <div class="error-log-item">
            <span class="error-log-type">${escHtml(p.platform)}</span>
            <span class="error-log-provider">${escHtml(p.providerName)}</span>
            <span class="error-log-msg">${escHtml(p.error)}</span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <!-- Scheduler Status -->
    <div class="status-section">
      <h2 class="status-section-title">
        <span class="status-icon">⏰</span>
        Scheduler
      </h2>
      <div class="scheduler-info">
        <div class="scheduler-item">
          <span class="scheduler-label">Schedule</span>
          <span class="scheduler-value">Daily at 8:00 AM</span>
        </div>
        <div class="scheduler-item">
          <span class="scheduler-label">Next Run</span>
          <span class="scheduler-value" id="nextRunTime">Calculating...</span>
        </div>
        <div class="scheduler-item">
          <span class="scheduler-label">Auto-publish</span>
          <span class="scheduler-value scheduler-enabled">Enabled (Vercel)</span>
        </div>
      </div>
    </div>

    <!-- Scrape History Log -->
    <div class="status-section">
      <h2 class="status-section-title">
        <span class="status-icon">📜</span>
        Scrape History
      </h2>
      <div class="history-log">
        ${buildHistoryLog(history)}
      </div>
      <div class="history-summary">
        <span class="history-total">${history.length} total runs on record</span>
      </div>
    </div>
  </div>
</div>

<!-- ── Tab: How It Works ─────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-help">
  <div class="help-page">
    <div class="help-header">
      <h1>How CEU Tracker Works</h1>
      <p class="help-subtitle">Understanding the compliance tracking system</p>
    </div>

    <!-- Status Definitions -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">🚦</span>
        Compliance Status Definitions
      </h2>
      <div class="help-cards">
        <div class="help-card help-card-complete">
          <div class="help-card-header">
            <span class="help-status-dot complete"></span>
            <strong>Complete</strong>
          </div>
          <p>Provider has completed all required CE hours for the renewal period. No action needed.</p>
        </div>
        <div class="help-card help-card-progress">
          <div class="help-card-header">
            <span class="help-status-dot progress"></span>
            <strong>In Progress</strong>
          </div>
          <p>Provider has remaining CE hours to complete but has more than 60 days until their renewal deadline. Monitor progress.</p>
        </div>
        <div class="help-card help-card-risk">
          <div class="help-card-header">
            <span class="help-status-dot risk"></span>
            <strong>At Risk</strong>
          </div>
          <p>Provider has remaining CE hours AND their renewal deadline is within 60 days. Immediate attention required.</p>
        </div>
        <div class="help-card help-card-unknown">
          <div class="help-card-header">
            <span class="help-status-dot unknown"></span>
            <strong>Credentials Needed</strong>
          </div>
          <p>Provider's CE Broker login credentials are not in the system. Cannot track compliance until credentials are submitted.</p>
        </div>
      </div>
    </div>

    <!-- Data Sources -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">📊</span>
        Data Sources
      </h2>
      <div class="help-content">
        <div class="help-source">
          <h3>CE Broker (Primary)</h3>
          <p>The official compliance tracking system used by most state nursing boards. CE Broker provides:</p>
          <ul>
            <li>License renewal deadlines</li>
            <li>Required CE hours by subject area</li>
            <li>Completed CE hours and transcript</li>
            <li>Overall compliance status</li>
          </ul>
          <p class="help-note"><strong>Note:</strong> Providers without CE Broker credentials show as "Credentials Needed" and cannot be fully tracked.</p>
        </div>
        <div class="help-source">
          <h3>Platform Scrapers (Secondary)</h3>
          <p>Additional CE platforms are scraped to capture courses that may not yet appear in CE Broker:</p>
          <ul>
            <li><strong>NetCE</strong> — Course completion history</li>
            <li><strong>CEUfast</strong> — Course completion history</li>
            <li><strong>AANP Certification</strong> — National certification CE credits</li>
          </ul>
          <p class="help-note">Platform data supplements CE Broker data and helps identify courses in progress.</p>
        </div>
      </div>
    </div>

    <!-- Provider Types -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">👥</span>
        Provider Types & Requirements
      </h2>
      <div class="help-content">
        <div class="help-type-grid">
          <div class="help-type-card clinical">
            <div class="help-type-header">
              <span class="help-type-badge clinical">Clinical Provider</span>
            </div>
            <h3>NP, MD, DO</h3>
            <p>Nurse Practitioners, Medical Doctors, and Doctors of Osteopathy have prescriptive authority and must meet APRN/Physician CE requirements including:</p>
            <ul>
              <li>Pharmacology hours</li>
              <li>Controlled substance prescribing</li>
              <li>State-specific mandated topics</li>
              <li>Florida Autonomous APRN requirements (HB 607) where applicable</li>
            </ul>
          </div>
          <div class="help-type-card support">
            <div class="help-type-header">
              <span class="help-type-badge support">Support Staff</span>
            </div>
            <h3>RN</h3>
            <p>Registered Nurses have different CE requirements focused on nursing practice:</p>
            <ul>
              <li>Prevention of medical errors</li>
              <li>Domestic violence awareness</li>
              <li>Human trafficking recognition</li>
              <li>State-specific mandated topics</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Email Reminders -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">📧</span>
        Email Reminders
      </h2>
      <div class="help-content">
        <div class="help-email-info">
          <h3>Daily Renewal Reminders</h3>
          <p>Sent daily at <strong>8:00 AM EST</strong> to:</p>
          <ul>
            <li>brittany.toliver@fountain.net</li>
            <li>faith@fountain.net</li>
          </ul>
          <p>Reminders are sent when providers have:</p>
          <ul>
            <li>Renewal deadline within 30 days</li>
            <li>Status is NOT Complete (still have CE hours remaining)</li>
          </ul>
          <p class="help-note">Reminders continue daily until the provider completes their requirements or the deadline passes.</p>
        </div>
        <div class="help-email-info">
          <h3>Weekly Digest</h3>
          <p>Sent every <strong>Monday at 9:00 AM EST</strong> with a full compliance summary and PDF attachment.</p>
        </div>
      </div>
    </div>

    <!-- Credential Status -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">🔐</span>
        Credential Status Indicators
      </h2>
      <div class="help-content">
        <table class="help-table">
          <thead>
            <tr>
              <th>Indicator</th>
              <th>Meaning</th>
              <th>Action Needed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="help-badge help-badge-green">✓ Healthy</span></td>
              <td>Login working, data retrieved successfully</td>
              <td>None</td>
            </tr>
            <tr>
              <td><span class="help-badge help-badge-yellow">◷ Degraded</span></td>
              <td>Occasional login failures (1-2 consecutive)</td>
              <td>Monitor - may be temporary</td>
            </tr>
            <tr>
              <td><span class="help-badge help-badge-orange">⚠ Warning</span></td>
              <td>Multiple consecutive failures (3-4)</td>
              <td>Verify credentials are correct</td>
            </tr>
            <tr>
              <td><span class="help-badge help-badge-red">✗ Critical</span></td>
              <td>5+ consecutive failures</td>
              <td>Password likely changed - update credentials</td>
            </tr>
            <tr>
              <td><span class="help-badge help-badge-gray">○ Not Configured</span></td>
              <td>No credentials in system</td>
              <td>Obtain and add CE Broker login</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- How Status is Calculated -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">🧮</span>
        How Status is Calculated
      </h2>
      <div class="help-content">
        <div class="help-formula">
          <div class="help-formula-step">
            <span class="help-step-num">1</span>
            <div class="help-step-content">
              <strong>Get Hours Data</strong>
              <p>Pull required and completed hours from CE Broker for each license</p>
            </div>
          </div>
          <div class="help-formula-step">
            <span class="help-step-num">2</span>
            <div class="help-step-content">
              <strong>Calculate Remaining</strong>
              <p>Remaining Hours = Required Hours - Completed Hours</p>
            </div>
          </div>
          <div class="help-formula-step">
            <span class="help-step-num">3</span>
            <div class="help-step-content">
              <strong>Check Deadline</strong>
              <p>Calculate days until renewal deadline</p>
            </div>
          </div>
          <div class="help-formula-step">
            <span class="help-step-num">4</span>
            <div class="help-step-content">
              <strong>Determine Status</strong>
              <ul>
                <li>Remaining = 0 → <span class="help-status complete">Complete</span></li>
                <li>Remaining > 0 AND Days > 60 → <span class="help-status progress">In Progress</span></li>
                <li>Remaining > 0 AND Days ≤ 60 → <span class="help-status risk">At Risk</span></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Data Refresh Schedule -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">🔄</span>
        Data Refresh Schedule
      </h2>
      <div class="help-content">
        <div class="help-schedule">
          <div class="help-schedule-item">
            <span class="help-schedule-time">10:30 PM EST</span>
            <span class="help-schedule-desc">Daily scrape of all providers (CE Broker + platforms)</span>
          </div>
          <div class="help-schedule-item">
            <span class="help-schedule-time">8:00 AM EST</span>
            <span class="help-schedule-desc">Daily renewal reminder emails (if applicable)</span>
          </div>
          <div class="help-schedule-item">
            <span class="help-schedule-time">9:00 AM EST (Mondays)</span>
            <span class="help-schedule-desc">Weekly compliance digest email</span>
          </div>
          <div class="help-schedule-item">
            <span class="help-schedule-time">After each scrape</span>
            <span class="help-schedule-desc">Dashboard auto-published to Vercel</span>
          </div>
        </div>
      </div>
    </div>

    <!-- FAQ -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">❓</span>
        Frequently Asked Questions
      </h2>
      <div class="help-content">
        <div class="help-faq">
          <div class="help-faq-item">
            <h4>Why does a provider show "Credentials Needed"?</h4>
            <p>The provider's CE Broker username and password are not in the system. Contact the provider to obtain their credentials and submit them to be added.</p>
          </div>
          <div class="help-faq-item">
            <h4>Why is platform data different from CE Broker data?</h4>
            <p>CE platforms (NetCE, CEUfast) track course completions, but there can be a delay before those credits appear in CE Broker. Platform data shows the most recent activity.</p>
          </div>
          <div class="help-faq-item">
            <h4>How often is data updated?</h4>
            <p>Data is scraped daily at 10:30 PM EST and the dashboard is automatically updated. The "Last scraped" timestamp in the footer shows when data was last refreshed.</p>
          </div>
          <div class="help-faq-item">
            <h4>What does "Login Failed" mean?</h4>
            <p>The stored credentials are no longer working. The provider may have changed their password. Contact them to get updated credentials.</p>
          </div>
          <div class="help-faq-item">
            <h4>Why are some subject areas highlighted in red?</h4>
            <p>Red highlighting indicates the provider hasn't completed the required hours for that specific subject area (e.g., Pharmacology, Human Trafficking). These are mandatory topics that must be completed.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent Updates (Auto-generated) -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">📋</span>
        Recent Updates
      </h2>
      <div class="help-content">
        ${generateUpdatesHtml()}
      </div>
    </div>
  </div>
</div>

<!-- ── Tab: Overview ────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-summary">
  <div class="help-page">
    <div class="help-header">
      <h1>Overview</h1>
      <p class="help-subtitle">CEU Compliance Dashboard — Generated ${escHtml(runDate)}</p>
    </div>

    <!-- Service Overview -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">📋</span>
        What This Service Does
      </h2>
      <div class="help-content">
        <p style="font-size: 0.95rem; line-height: 1.7; margin-bottom: 16px;">
          The <strong>CEU Tracker</strong> is an automated compliance monitoring system that tracks Continuing Education (CE) requirements
          for Fountain's clinical team. It scrapes data nightly from CE Broker (the official state compliance system) and supplementary
          CE platforms to provide real-time visibility into each provider's license renewal status.
        </p>
        <div style="background: var(--bg-secondary); border-radius: 10px; padding: 16px; margin-top: 12px;">
          <h4 style="margin-bottom: 10px; color: var(--text-primary);">Key Features:</h4>
          <ul style="margin-left: 20px; line-height: 1.8;">
            <li><strong>Automated Scraping:</strong> Data collected daily at 10:30 PM EST from CE Broker + platforms</li>
            <li><strong>Multi-Platform Tracking:</strong> NetCE, CEUfast, AANP Cert, and more</li>
            <li><strong>Email Alerts:</strong> Daily reminders for providers with deadlines within 30 days</li>
            <li><strong>Weekly Digest:</strong> Full compliance report emailed every Monday at 9:00 AM EST</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Upcoming Deadlines -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">⏰</span>
        Upcoming Renewal Deadlines
      </h2>
      <div class="help-content">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
          <div style="background: var(--status-red-bg); border-left: 4px solid var(--status-red); padding: 16px; border-radius: 8px;">
            <div style="font-size: 1.8rem; font-weight: 800; color: var(--status-red);">${deadlines30.length}</div>
            <div style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Within 30 Days</div>
            ${deadlines30.length > 0 ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 8px;">${deadlines30.slice(0, 3).map(d => d.providerName.split(',')[0]).join(', ')}${deadlines30.length > 3 ? '...' : ''}</div>` : ''}
          </div>
          <div style="background: var(--status-amber-bg); border-left: 4px solid var(--status-amber); padding: 16px; border-radius: 8px;">
            <div style="font-size: 1.8rem; font-weight: 800; color: var(--status-amber);">${deadlines60.length}</div>
            <div style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">31-60 Days</div>
            ${deadlines60.length > 0 ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 8px;">${deadlines60.slice(0, 3).map(d => d.providerName.split(',')[0]).join(', ')}${deadlines60.length > 3 ? '...' : ''}</div>` : ''}
          </div>
          <div style="background: var(--bg-secondary); border-left: 4px solid var(--status-green); padding: 16px; border-radius: 8px;">
            <div style="font-size: 1.8rem; font-weight: 800; color: var(--status-green);">${deadlines90.length}</div>
            <div style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">61-90 Days</div>
            ${deadlines90.length > 0 ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 8px;">${deadlines90.slice(0, 3).map(d => d.providerName.split(',')[0]).join(', ')}${deadlines90.length > 3 ? '...' : ''}</div>` : ''}
          </div>
        </div>
      </div>
    </div>

    <!-- Provider Breakdown -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">👥</span>
        Team Breakdown by Role
      </h2>
      <div class="help-content">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead>
            <tr style="background: var(--bg-secondary);">
              <th style="text-align: left; padding: 12px; border-bottom: 2px solid var(--border-color);">Role</th>
              <th style="text-align: center; padding: 12px; border-bottom: 2px solid var(--border-color);">Count</th>
              <th style="text-align: left; padding: 12px; border-bottom: 2px solid var(--border-color);">Description</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 12px; font-weight: 600;">NP</td>
              <td style="padding: 12px; text-align: center;">${providersByType.NP.length}</td>
              <td style="padding: 12px; color: var(--text-secondary);">Nurse Practitioners — Primary prescribers</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 12px; font-weight: 600;">MD</td>
              <td style="padding: 12px; text-align: center;">${providersByType.MD.length}</td>
              <td style="padding: 12px; color: var(--text-secondary);">Medical Doctors</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 12px; font-weight: 600;">DO</td>
              <td style="padding: 12px; text-align: center;">${providersByType.DO.length}</td>
              <td style="padding: 12px; color: var(--text-secondary);">Doctors of Osteopathy</td>
            </tr>
            <tr>
              <td style="padding: 12px; font-weight: 600;">RN</td>
              <td style="padding: 12px; text-align: center;">${providersByType.RN.length}</td>
              <td style="padding: 12px; color: var(--text-secondary);">Registered Nurses — Support staff</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Platform Overview -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">📚</span>
        CE Platform Data Sources
      </h2>
      <div class="help-content">
        <p style="margin-bottom: 16px; color: var(--text-secondary);">
          In addition to CE Broker, the system tracks courses from these platforms:
        </p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
          ${Object.entries(platformStats).map(([name, stats]) => `
            <div style="background: var(--bg-secondary); padding: 14px; border-radius: 10px; border: 1px solid var(--border-color);">
              <div style="font-weight: 700; margin-bottom: 6px;">${escHtml(name)}</div>
              <div style="font-size: 0.8rem; color: var(--text-secondary);">${stats.providers.length} providers tracked</div>
              <div style="font-size: 0.8rem; color: var(--text-secondary);">${Math.round(stats.totalHours)} total hours</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- How to Use -->
    <div class="help-section">
      <h2 class="help-section-title">
        <span class="help-icon">💡</span>
        How to Use This Dashboard
      </h2>
      <div class="help-content">
        <ol style="margin-left: 20px; line-height: 2;">
          <li><strong>Team View:</strong> See all providers with their current compliance status</li>
          <li><strong>Compliance:</strong> View providers grouped by status (At Risk, In Progress, Complete)</li>
          <li><strong>Platforms:</strong> See CE course data from external platforms (NetCE, CEUfast, etc.)</li>
          <li><strong>Reports:</strong> Export data, view history, and access run logs</li>
        </ol>
        <p style="margin-top: 16px; padding: 12px; background: linear-gradient(135deg, #dbeafe 0%, #e0e7ff 100%); border-radius: 8px; font-size: 0.85rem;">
          <strong>Tip:</strong> Click on any provider card to see detailed license information, subject area breakdowns, and completed courses.
        </p>
      </div>
    </div>

  </div>
</div>

<footer>
  <div class="footer-updates">
    <span class="footer-updates-title">Recent Updates:</span>
    ${getAllUpdates(3).map(u => `<span class="footer-update-item"><span class="footer-update-date">${escHtml(u.date)}</span> ${escHtml(u.title)}</span>`).join('')}
  </div>
  <div class="footer-meta">CEU Tracker &nbsp;·&nbsp; Last scraped: ${escHtml(runDate)}</div>
</footer>

<script>
  // ── Global Error Handler ──
  window.onerror = function(msg, url, line, col, error) {
    console.error('Dashboard Error:', msg, 'at line', line);
    return false;
  };

  // ── Theme Toggle ──
  function toggleTheme() {
    const html = document.documentElement;
    const current = html.dataset.theme;
    const newTheme = current === 'dark' ? 'light' : 'dark';
    html.dataset.theme = newTheme;
    localStorage.setItem('ceu-theme', newTheme);
    updateThemeButton(newTheme);
  }
  function updateThemeButton(theme) {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const icon = btn.querySelector('.theme-icon');
    const label = btn.querySelector('.theme-toggle-label');
    if (theme === 'dark') {
      if (icon) icon.textContent = '☀️';
      if (label) label.textContent = 'Light';
    } else {
      if (icon) icon.textContent = '🌙';
      if (label) label.textContent = 'Dark';
    }
  }
  // Restore theme on load
  (function() {
    const saved = localStorage.getItem('ceu-theme');
    if (saved === 'dark') {
      document.documentElement.dataset.theme = 'dark';
      updateThemeButton('dark');
    }
  })();

  // ── Dismiss Welcome Banner ──
  function dismissWelcome() {
    const el = document.getElementById('welcomeBanner');
    if (el) el.style.display = 'none';
    localStorage.setItem('ceu-welcome-dismissed', '1');
  }

  // ── Dismiss Getting Started ──
  function dismissGettingStarted() {
    const el = document.getElementById('gettingStarted');
    if (el) el.style.display = 'none';
    localStorage.setItem('ceu-getting-started-dismissed', '1');
  }

  // ── Action Banner Collapse/Expand ──
  function collapseActionBanner() {
    const wrap = document.querySelector('.action-banner-wrap');
    if (wrap) wrap.classList.add('collapsed');
    localStorage.setItem('ceu-action-banner-collapsed', '1');
  }
  function expandActionBanner() {
    const wrap = document.querySelector('.action-banner-wrap');
    if (wrap) wrap.classList.remove('collapsed');
    localStorage.removeItem('ceu-action-banner-collapsed');
  }

  // Restore dismissed states on load
  (function() {
    if (localStorage.getItem('ceu-welcome-dismissed')) {
      const el = document.getElementById('welcomeBanner');
      if (el) el.style.display = 'none';
    }
    if (localStorage.getItem('ceu-getting-started-dismissed')) {
      const el = document.getElementById('gettingStarted');
      if (el) el.style.display = 'none';
    }
    if (localStorage.getItem('ceu-action-banner-collapsed')) {
      const wrap = document.querySelector('.action-banner-wrap');
      if (wrap) wrap.classList.add('collapsed');
    }
  })();

  // ── Sidebar Collapse Toggle ──
  function toggleSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const icon = document.getElementById('sidebarCollapseIcon');
    if (!sidebar) return;
    const isCollapsed = sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', isCollapsed);
    if (icon) icon.textContent = isCollapsed ? '▶' : '◀';
    localStorage.setItem('ceu-sidebar-collapsed', isCollapsed ? '1' : '0');
  }

  // ── Header Collapse Toggle ──
  function toggleHeaderCollapse() {
    const header = document.querySelector('header');
    const icon = document.getElementById('headerCollapseIcon');
    if (!header) return;
    const isCollapsed = header.classList.toggle('collapsed');
    document.body.classList.toggle('header-collapsed', isCollapsed);
    if (icon) icon.textContent = isCollapsed ? '▼' : '▲';
    localStorage.setItem('ceu-header-collapsed', isCollapsed ? '1' : '0');
  }

  // Restore collapse states on load
  (function() {
    // Sidebar is collapsed by default; only expand if user explicitly saved '0'
    if (localStorage.getItem('ceu-sidebar-collapsed') === '0') {
      document.getElementById('sidebar')?.classList.remove('collapsed');
      document.body.classList.remove('sidebar-collapsed');
      const icon = document.getElementById('sidebarCollapseIcon');
      if (icon) icon.textContent = '◀';
    } else {
      // Ensure body class matches default collapsed state
      document.body.classList.add('sidebar-collapsed');
    }
    if (localStorage.getItem('ceu-header-collapsed') === '1') {
      document.querySelector('header')?.classList.add('collapsed');
      document.body.classList.add('header-collapsed');
      const icon = document.getElementById('headerCollapseIcon');
      if (icon) icon.textContent = '▼';
    }
  })();

  // ── Calculate Next Scheduled Run ──
  (function() {
    const el = document.getElementById('nextRunTime');
    if (!el) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(8, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    const options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    el.textContent = next.toLocaleString('en-US', options);
  })();

  // ── Sticky Header Shadow ──
  window.addEventListener('scroll', () => {
    const header = document.querySelector('header');
    if (header) header.classList.toggle('scrolled', window.scrollY > 10);
  });

  // ── Global Quick Search ──
  const SEARCH_DATA = ${JSON.stringify(flat.map(p => ({
    name: p.providerName,
    type: p.providerType,
    state: p.state,
    status: p.status,
    hours: p.hoursCompleted,
    required: p.hoursRequired
  })))};

  // ── Comprehensive Export Data ──
  const EXPORT_DATA = {
    allProviders: ${JSON.stringify(flat.map(p => ({
      name: p.providerName,
      type: p.providerType || '',
      state: p.state || '',
      status: getStatus(p.hoursRemaining, daysUntil(parseDate(p.renewalDeadline)), p.hoursRequired),
      hoursRequired: p.hoursRequired || 0,
      hoursCompleted: p.hoursCompleted || 0,
      hoursRemaining: p.hoursRemaining || 0,
      renewalDeadline: p.renewalDeadline || '',
      daysUntilDeadline: daysUntil(parseDate(p.renewalDeadline)) ?? ''
    })))},
    needsCEUs: ${JSON.stringify(flat.filter(p => (p.hoursRemaining || 0) > 0).map(p => ({
      name: p.providerName,
      type: p.providerType || '',
      state: p.state || '',
      hoursRequired: p.hoursRequired || 0,
      hoursCompleted: p.hoursCompleted || 0,
      hoursRemaining: p.hoursRemaining || 0,
      renewalDeadline: p.renewalDeadline || '',
      daysUntilDeadline: daysUntil(parseDate(p.renewalDeadline)) ?? ''
    })))},
    complete: ${JSON.stringify(flat.filter(p => (p.hoursRemaining || 0) <= 0 && p.hoursRequired > 0).map(p => ({
      name: p.providerName,
      type: p.providerType || '',
      state: p.state || '',
      hoursCompleted: p.hoursCompleted || 0,
      renewalDeadline: p.renewalDeadline || ''
    })))},
    noLogins: ${JSON.stringify(exportDataNoLogins)},
    atRisk: ${JSON.stringify(exportDataAtRisk)}
  };

  function globalSearchHandler(e) {
    const q = e.target.value.toLowerCase().trim();
    const results = document.getElementById('globalSearchResults');

    if (q.length < 2) {
      results.classList.remove('active');
      return;
    }

    const matches = SEARCH_DATA.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.state && p.state.toLowerCase().includes(q)) ||
      (p.type && p.type.toLowerCase().includes(q))
    ).slice(0, 8);

    if (matches.length === 0) {
      results.innerHTML = '<div class="search-no-results">No providers found</div>';
    } else {
      results.innerHTML = matches.map(p => {
        const badgeClass = p.status === 'Complete' ? 'ok' : p.status === 'At Risk' ? 'risk' : 'prog';
        return \`
          <div class="search-result-item" onclick="jumpToProvider('\${p.name.replace(/'/g, "\\\\'")}')">
            <div>
              <div class="search-result-name">\${p.name}</div>
              <div class="search-result-meta">\${p.state || 'N/A'} · \${p.type || ''}</div>
            </div>
            <span class="search-result-badge \${badgeClass}">\${p.status || 'Unknown'}</span>
          </div>
        \`;
      }).join('');
    }
    results.classList.add('active');

    // Close on escape
    if (e.key === 'Escape') {
      results.classList.remove('active');
      e.target.value = '';
    }
  }

  function jumpToProvider(name) {
    // Close search
    document.getElementById('globalSearchResults').classList.remove('active');
    document.getElementById('globalSearch').value = '';

    // Switch to providers tab
    showTab('providers');

    // Search for the provider
    setTimeout(() => {
      const searchBox = document.getElementById('cardSearch');
      if (searchBox) {
        searchBox.value = name;
        filterCards();

        // Scroll to first match
        const card = document.querySelector('.provider-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }

  // Close search results when clicking outside
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.global-search-wrap');
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById('globalSearchResults')?.classList.remove('active');
    }
  });

  // ── Tabs ──
  function showTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const tabEl = document.getElementById('tab-' + name);
    if (tabEl) {
      tabEl.classList.add('active');
    } else {
      console.warn('Tab not found: tab-' + name);
    }
    // Update sidebar nav
    const navItem = document.querySelector('.nav-item[data-tab="' + name + '"]');
    if (navItem) {
      navItem.classList.add('active');
    }
    if (name === 'reports') initCharts();
    // Close sidebar on mobile after selection
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar')?.classList.remove('open');
    }
  }

  // ── Sidebar Toggle (Mobile) ──
  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
  }

  // ── Report View Toggles ──
  function showReportView(name) {
    const reportsTab = document.getElementById('tab-reports');
    reportsTab.querySelectorAll('.report-view').forEach(p => p.classList.remove('active'));
    reportsTab.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
    document.getElementById('report-' + name)?.classList.add('active');
    const btns = reportsTab.querySelectorAll('.view-toggle');
    const labels = ['charts','calendar','runlog'];
    btns[labels.indexOf(name)]?.classList.add('active');
    if (name === 'charts') initCharts();
  }

  // ── Platform View Toggles ──
  function showPlatformView(name) {
    const platformsTab = document.getElementById('tab-platforms');
    platformsTab.querySelectorAll('.platform-view').forEach(v => v.classList.remove('active'));
    platformsTab.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
    document.getElementById('platform-' + name)?.classList.add('active');
    const btns = platformsTab.querySelectorAll('.view-toggle');
    const labels = ['matrix','gaps'];
    btns[labels.indexOf(name)]?.classList.add('active');
  }

  // ── Provider View Toggles ──
  function showProviderView(name) {
    const providersTab = document.getElementById('tab-providers');
    providersTab.querySelectorAll('.provider-view').forEach(v => v.classList.remove('active'));
    providersTab.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
    document.getElementById('provider-' + name)?.classList.add('active');
    const btns = providersTab.querySelectorAll('.view-toggle');
    const labels = ['all','table','priority','kanban','deadline','state','type','favorites','aanp','stats','timeline'];
    btns[labels.indexOf(name)]?.classList.add('active');
    // Initialize timeline when selected
    if (name === 'timeline' && typeof updateTimeline === 'function') {
      updateTimeline();
    }
    // Update favorites view when selected
    if (name === 'favorites') {
      updateFavoritesView();
    }
  }

  // ── Table Sorting ──
  let tableSortCol = 'name';
  let tableSortDir = 1;
  function sortProviderTable(col) {
    const table = document.getElementById('providerTable');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    if (tableSortCol === col) tableSortDir *= -1;
    else { tableSortCol = col; tableSortDir = 1; }
    const colIdx = { name: 0, type: 1, state: 2, status: 3, progress: 4, remaining: 5, deadline: 6, days: 7 };
    rows.sort((a, b) => {
      const aCell = a.cells[colIdx[col]];
      const bCell = b.cells[colIdx[col]];
      let aVal = aCell?.textContent?.trim() || '';
      let bVal = bCell?.textContent?.trim() || '';
      // Numeric sort for progress, remaining, days
      if (col === 'progress' || col === 'remaining' || col === 'days') {
        aVal = parseFloat(aVal) || 9999;
        bVal = parseFloat(bVal) || 9999;
        return (aVal - bVal) * tableSortDir;
      }
      return aVal.localeCompare(bVal) * tableSortDir;
    });
    rows.forEach(r => tbody.appendChild(r));
  }

  // ── Toggle Collapsible Groups ──
  function toggleStateGroup(header) {
    const group = header.closest('.collapsible');
    if (group) group.classList.toggle('collapsed');
  }

  function togglePriorityGroup(header) {
    const group = header.closest('.collapsible');
    if (group) group.classList.toggle('collapsed');
  }

  // ── Favorites/Pinned Providers ──
  let pinnedProviders = JSON.parse(localStorage.getItem('pinnedProviders') || '[]');

  function togglePinProvider(name, event) {
    if (event) event.stopPropagation();
    const idx = pinnedProviders.indexOf(name);
    if (idx > -1) {
      pinnedProviders.splice(idx, 1);
    } else {
      pinnedProviders.push(name);
    }
    localStorage.setItem('pinnedProviders', JSON.stringify(pinnedProviders));
    updatePinButtons();
    updatePinnedCount();
  }

  function updatePinButtons() {
    document.querySelectorAll('.pin-btn').forEach(btn => {
      const name = btn.dataset.provider;
      const isPinned = pinnedProviders.includes(name);
      btn.classList.toggle('pinned', isPinned);
      btn.innerHTML = isPinned ? '★' : '☆';
      btn.title = isPinned ? 'Unpin provider' : 'Pin provider';
    });
  }

  function updatePinnedCount() {
    const countEl = document.getElementById('pinnedCount');
    if (countEl) countEl.textContent = pinnedProviders.length;
  }

  function updateFavoritesView() {
    const grid = document.getElementById('favoritesGrid');
    if (!grid) return;

    if (pinnedProviders.length === 0) {
      grid.innerHTML = '<div class="empty-favorites">No pinned providers yet. Click the ⭐ star on any provider card to pin them here.</div>';
      return;
    }

    // Clone pinned provider cards from the all providers grid
    const allGrid = document.getElementById('allCardsGrid');
    if (!allGrid) return;

    const pinnedCards = [];
    allGrid.querySelectorAll('.provider-card').forEach(card => {
      const name = card.dataset.name;
      if (pinnedProviders.includes(name)) {
        pinnedCards.push(card.cloneNode(true));
      }
    });

    if (pinnedCards.length === 0) {
      grid.innerHTML = '<div class="empty-favorites">No pinned providers yet. Click the ⭐ star on any provider card to pin them here.</div>';
      return;
    }

    grid.innerHTML = '';
    pinnedCards.forEach(card => grid.appendChild(card));

    // Re-attach click handlers
    grid.querySelectorAll('.provider-card').forEach(card => {
      card.onclick = () => openProvider(card.dataset.name);
    });
    grid.querySelectorAll('.pin-btn').forEach(btn => {
      btn.onclick = (e) => togglePinProvider(btn.dataset.provider, e);
    });
    updatePinButtons();
  }

  // Initialize pin buttons on page load
  document.addEventListener('DOMContentLoaded', function() {
    updatePinButtons();
    updatePinnedCount();
  });

  // ── Credential Tracker Filter ──
  function filterCredTracker(category) {
    const grid = document.getElementById('credTrackerGrid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.cred-tracker-card');
    const btns = document.querySelectorAll('.cred-filter-btn');

    // Update active button
    btns.forEach(b => b.classList.remove('active'));
    event.target.closest('.cred-filter-btn').classList.add('active');

    // Show/hide cards based on filter
    cards.forEach(card => {
      if (category === 'all') {
        card.classList.remove('hidden');
      } else {
        const cardCategory = card.getAttribute('data-category');
        if (cardCategory === category) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      }
    });
  }

  // ── Toggle Advanced Filters ──
  function toggleAdvancedFilters() {
    const panel = document.getElementById('advancedFilters');
    const btn = document.querySelector('.advanced-filter-toggle');
    const icon = document.getElementById('advFilterIcon');
    if (panel.style.display === 'none') {
      panel.style.display = 'flex';
      btn.classList.add('active');
    } else {
      panel.style.display = 'none';
      btn.classList.remove('active');
    }
  }

  // ── Export Filtered Results ──
  function exportFilteredResults() {
    const activeView = document.querySelector('.provider-view.active');
    if (!activeView) return;
    const visibleCards = Array.from(activeView.querySelectorAll('.provider-card')).filter(c => c.style.display !== 'none');
    if (visibleCards.length === 0) { alert('No providers to export'); return; }
    const data = visibleCards.map(card => ({
      name: card.dataset.provider || '',
      status: card.dataset.status || '',
      deadline: card.dataset.deadline || '',
      type: card.dataset.type || ''
    }));
    const csv = 'Name,Type,Status,Days Until Deadline\\n' + data.map(p =>
      '"' + p.name.replace(/"/g, '""') + '","' + p.type + '","' + p.status + '","' + p.deadline + '"'
    ).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'filtered-providers-' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Copy Missing Credentials List ──
  function copyMissingCredsList() {
    const missingCreds = ${JSON.stringify(trulyNoCredentialsProviders)};
    const text = missingCreds.join('\\n');
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.querySelector('.missing-creds-copy-btn');
      if (btn) {
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span>✓</span> Copied!';
        btn.style.background = '#059669';
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.style.background = '';
        }, 2000);
      }
    }).catch(err => {
      alert('Failed to copy: ' + err);
    });
  }

  // ── Export Missing Credentials ──
  function exportMissingCredentials() {
    const missingCreds = ${JSON.stringify(missingCEBroker.map(p => ({ name: p.name, type: p.type, hasPlatform: !p.noCredentials })))};
    const csv = 'Name,Type,Has Platform Access\\n' + missingCreds.map(p =>
      '"' + p.name.replace(/"/g, '""') + '","' + p.type + '","' + (p.hasPlatform ? 'Yes' : 'No') + '"'
    ).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'missing-credentials-' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Quick Export Functions ──
  function downloadCSV(data, headers, filename) {
    const csv = headers.join(',') + '\\n' + data.map(row =>
      headers.map(h => {
        const key = h.toLowerCase().replace(/ /g, '');
        const keyMap = {
          'name': 'name', 'type': 'type', 'state': 'state', 'status': 'status',
          'hoursrequired': 'hoursRequired', 'hourscompleted': 'hoursCompleted',
          'hoursremaining': 'hoursRemaining', 'renewaldeadline': 'renewalDeadline',
          'daysuntildeadline': 'daysUntilDeadline', 'states': 'states'
        };
        const val = row[keyMap[key]] ?? '';
        return '"' + String(val).replace(/"/g, '""') + '"';
      }).join(',')
    ).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '-' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportAllProviders() {
    downloadCSV(EXPORT_DATA.allProviders,
      ['Name', 'Type', 'State', 'Status', 'Hours Required', 'Hours Completed', 'Hours Remaining', 'Renewal Deadline', 'Days Until Deadline'],
      'all-providers');
  }

  function exportNeedsCEUs() {
    if (EXPORT_DATA.needsCEUs.length === 0) { alert('No providers currently need CEUs'); return; }
    downloadCSV(EXPORT_DATA.needsCEUs,
      ['Name', 'Type', 'State', 'Hours Required', 'Hours Completed', 'Hours Remaining', 'Renewal Deadline', 'Days Until Deadline'],
      'needs-ceus');
  }

  function exportNoLogins() {
    if (EXPORT_DATA.noLogins.length === 0) { alert('All providers have CEU logins configured'); return; }
    downloadCSV(EXPORT_DATA.noLogins,
      ['Name', 'Type', 'States'],
      'no-ceu-logins');
  }

  function exportComplete() {
    if (EXPORT_DATA.complete.length === 0) { alert('No providers have completed their CEUs'); return; }
    downloadCSV(EXPORT_DATA.complete,
      ['Name', 'Type', 'State', 'Hours Completed', 'Renewal Deadline'],
      'ceus-complete');
  }

  function exportAtRisk() {
    if (EXPORT_DATA.atRisk.length === 0) { alert('No providers are currently at risk'); return; }
    downloadCSV(EXPORT_DATA.atRisk,
      ['Name', 'Type', 'State', 'Hours Remaining', 'Renewal Deadline', 'Days Until Deadline'],
      'at-risk-providers');
  }

  // ── Export Dropdown Functions ──
  function toggleExportDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('exportDropdownMenu');
    menu.classList.toggle('show');
  }
  function closeExportDropdown() {
    const menu = document.getElementById('exportDropdownMenu');
    if (menu) menu.classList.remove('show');
  }
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.export-dropdown')) {
      closeExportDropdown();
    }
  });

  // ── Bulk Selection Functions ──
  function updateBulkSelection() {
    const checkboxes = document.querySelectorAll('.bulk-select-cb:checked');
    const count = checkboxes.length;
    const countEl = document.getElementById('bulkCount');
    // Update compact count (just the number)
    countEl.textContent = count;
    countEl.classList.toggle('has-selection', count > 0);
    // Update dropdown menu items
    const csvMenuBtn = document.getElementById('exportSelectedCSVMenu');
    const pdfMenuBtn = document.getElementById('exportSelectedPDFMenu');
    if (csvMenuBtn) csvMenuBtn.disabled = count === 0;
    if (pdfMenuBtn) pdfMenuBtn.disabled = count === 0;

    // Toggle selected class on cards
    document.querySelectorAll('.provider-card').forEach(card => {
      const cb = card.querySelector('.bulk-select-cb');
      card.classList.toggle('selected', cb && cb.checked);
    });
  }

  function selectAllVisible() {
    const activeView = document.querySelector('.provider-view.active');
    if (!activeView) return;
    activeView.querySelectorAll('.provider-card').forEach(card => {
      if (card.style.display !== 'none') {
        const cb = card.querySelector('.bulk-select-cb');
        if (cb) cb.checked = true;
      }
    });
    updateBulkSelection();
  }

  function clearSelection() {
    document.querySelectorAll('.bulk-select-cb').forEach(cb => cb.checked = false);
    updateBulkSelection();
  }

  function getSelectedProviders() {
    const selected = [];
    document.querySelectorAll('.provider-card').forEach(card => {
      const cb = card.querySelector('.bulk-select-cb');
      if (cb && cb.checked) {
        selected.push({
          name: card.dataset.provider || '',
          status: card.dataset.status || '',
          state: card.dataset.states || '',
          deadline: card.dataset.deadline || '',
          type: card.dataset.type || '',
          completed: card.dataset.completed || '0',
          required: card.dataset.required || '0',
          remaining: card.dataset.remaining || '0'
        });
      }
    });
    return selected;
  }

  function exportSelectedCSV() {
    const data = getSelectedProviders();
    if (data.length === 0) { alert('No providers selected'); return; }

    const csv = 'Name,Type,State,Status,Completed Hours,Required Hours,Remaining Hours,Days Until Deadline\\n' + data.map(p =>
      '"' + p.name.replace(/"/g, '""') + '","' + p.type + '","' + p.state + '","' + p.status + '","' + p.completed + '","' + p.required + '","' + p.remaining + '","' + p.deadline + '"'
    ).join('\\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selected-providers-' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSelectedPDF() {
    const data = getSelectedProviders();
    if (data.length === 0) { alert('No providers selected'); return; }

    // For PDF, we need to call a server endpoint or generate client-side
    // Creating a print-friendly view and using browser print
    const printContent = generatePrintHTML(data);
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.onload = function() {
      printWindow.print();
    };
  }

  function generatePrintHTML(providers) {
    const complete = providers.filter(p => p.status === 'Complete').length;
    const inProgress = providers.filter(p => p.status === 'In Progress').length;
    const atRisk = providers.filter(p => p.status === 'At Risk').length;

    // Sort by risk first
    const sorted = [...providers].sort((a, b) => {
      const order = { 'At Risk': 0, 'In Progress': 1, 'Complete': 2 };
      return (order[a.status] || 3) - (order[b.status] || 3);
    });

    return '<!DOCTYPE html><html><head><title>CEU Compliance Report</title><style>' +
      'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }' +
      'h1 { color: #1e293b; text-align: center; margin-bottom: 10px; }' +
      '.subtitle { text-align: center; color: #64748b; margin-bottom: 30px; }' +
      '.summary { display: flex; justify-content: center; gap: 20px; margin-bottom: 30px; }' +
      '.summary-box { padding: 15px 30px; border-radius: 8px; text-align: center; }' +
      '.summary-box.complete { background: #d1fae5; color: #059669; }' +
      '.summary-box.progress { background: #fef3c7; color: #d97706; }' +
      '.summary-box.risk { background: #fecaca; color: #dc2626; }' +
      '.summary-num { font-size: 28px; font-weight: 700; }' +
      '.summary-label { font-size: 12px; margin-top: 5px; }' +
      'table { width: 100%; border-collapse: collapse; margin-top: 20px; }' +
      'th { background: #f1f5f9; padding: 12px; text-align: left; font-size: 12px; color: #64748b; border-bottom: 2px solid #e2e8f0; }' +
      'td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }' +
      'tr:nth-child(even) { background: #fafafa; }' +
      '.status { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }' +
      '.status-complete { background: #d1fae5; color: #059669; }' +
      '.status-progress { background: #fef3c7; color: #d97706; }' +
      '.status-risk { background: #fecaca; color: #dc2626; }' +
      '.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 11px; }' +
      '@media print { body { padding: 20px; } }' +
      '</style></head><body>' +
      '<h1>CEU Compliance Report</h1>' +
      '<div class="subtitle">Generated: ' + new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '</div>' +
      '<div class="summary">' +
        '<div class="summary-box complete"><div class="summary-num">' + complete + '</div><div class="summary-label">Complete</div></div>' +
        '<div class="summary-box progress"><div class="summary-num">' + inProgress + '</div><div class="summary-label">In Progress</div></div>' +
        '<div class="summary-box risk"><div class="summary-num">' + atRisk + '</div><div class="summary-label">At Risk</div></div>' +
      '</div>' +
      '<table><thead><tr><th>Provider</th><th>State</th><th>Status</th><th>Completed</th><th>Required</th><th>Remaining</th></tr></thead><tbody>' +
      sorted.map(p => {
        const statusCls = p.status === 'Complete' ? 'status-complete' : p.status === 'At Risk' ? 'status-risk' : 'status-progress';
        return '<tr><td>' + p.name + '</td><td>' + (p.state || 'N/A') + '</td><td><span class="status ' + statusCls + '">' + p.status + '</span></td><td>' + p.completed + 'h</td><td>' + p.required + 'h</td><td>' + p.remaining + 'h</td></tr>';
      }).join('') +
      '</tbody></table>' +
      '<div class="footer">CEU Tracker - ' + providers.length + ' providers</div>' +
      '</body></html>';
  }

  // ── Favorites Management ──
  const FAVORITES_KEY = 'ceu-tracker-favorites';
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || []; }
    catch { return []; }
  }
  function saveFavorites(favs) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
  }
  function toggleFavorite(name) {
    const favs = getFavorites();
    const idx = favs.indexOf(name);
    if (idx === -1) { favs.push(name); }
    else { favs.splice(idx, 1); }
    saveFavorites(favs);
    updateFavoriteButtons();
    updateFavoritesView();
  }
  function updateFavoriteButtons() {
    const favs = getFavorites();
    document.querySelectorAll('.fav-btn').forEach(btn => {
      const card = btn.closest('.provider-card');
      if (card) {
        const name = card.dataset.provider;
        btn.classList.toggle('favorited', favs.includes(name));
      }
    });
  }
  function updateFavoritesView() {
    const favsView = document.getElementById('provider-favorites');
    if (!favsView) return;
    const favs = getFavorites();
    const favCards = Array.from(document.querySelectorAll('#provider-all .provider-card'))
      .filter(c => favs.includes(c.dataset.provider));
    const grid = favsView.querySelector('.favorites-cards');
    if (grid) {
      if (favCards.length === 0) {
        grid.innerHTML = '<div class="empty-favorites">No pinned providers. Click the star on any provider card to pin them here.</div>';
      } else {
        grid.innerHTML = favCards.map(c => c.outerHTML).join('');
        updateFavoriteButtons();
      }
    }
    const countEl = document.querySelector('.view-toggle[onclick*="favorites"] .view-count');
    if (countEl) countEl.textContent = favs.length;
  }
  // Initialize favorites on page load
  document.addEventListener('DOMContentLoaded', () => {
    updateFavoriteButtons();
    updateFavoritesView();
    initLazyLoading();
  });

  // ── Lazy Loading ──
  const ALL_CARDS_HTML = ${JSON.stringify(allCardHtmlArray)};
  const LAZY_BATCH_SIZE = ${LAZY_BATCH_SIZE};
  let lazyLoadedCount = ${LAZY_BATCH_SIZE};
  let lazyObserver = null;
  let isLazyLoading = false;

  function initLazyLoading() {
    const sentinel = document.getElementById('loadSentinel');
    if (!sentinel || ALL_CARDS_HTML.length <= LAZY_BATCH_SIZE) {
      // Hide loading elements if no lazy loading needed
      const loadingIndicator = document.getElementById('loadingIndicator');
      if (loadingIndicator) loadingIndicator.style.display = 'none';
      return;
    }

    lazyObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !isLazyLoading) {
        loadMoreCards();
      }
    }, { rootMargin: '200px' });

    lazyObserver.observe(sentinel);
  }

  function loadMoreCards() {
    if (lazyLoadedCount >= ALL_CARDS_HTML.length || isLazyLoading) return;

    isLazyLoading = true;
    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) loadingIndicator.style.display = 'flex';

    // Use requestAnimationFrame to avoid blocking
    requestAnimationFrame(() => {
      const grid = document.getElementById('allCardsGrid');
      if (!grid) return;

      const nextBatch = ALL_CARDS_HTML.slice(lazyLoadedCount, lazyLoadedCount + LAZY_BATCH_SIZE);
      nextBatch.forEach(cardHtml => {
        grid.insertAdjacentHTML('beforeend', cardHtml);
      });

      lazyLoadedCount += nextBatch.length;

      // Update favorite buttons for new cards
      updateFavoriteButtons();

      // Apply current filters to new cards
      filterCards();

      // Hide loading indicator
      if (loadingIndicator) loadingIndicator.style.display = 'none';
      isLazyLoading = false;

      // Disconnect observer if all cards loaded
      if (lazyLoadedCount >= ALL_CARDS_HTML.length && lazyObserver) {
        lazyObserver.disconnect();
        const sentinel = document.getElementById('loadSentinel');
        if (sentinel) sentinel.style.display = 'none';
      }
    });
  }

  function loadAllCards() {
    // Force load all remaining cards (useful for search/filter)
    while (lazyLoadedCount < ALL_CARDS_HTML.length) {
      const grid = document.getElementById('allCardsGrid');
      if (!grid) return;
      const nextBatch = ALL_CARDS_HTML.slice(lazyLoadedCount, lazyLoadedCount + LAZY_BATCH_SIZE);
      nextBatch.forEach(cardHtml => {
        grid.insertAdjacentHTML('beforeend', cardHtml);
      });
      lazyLoadedCount += nextBatch.length;
    }
    updateFavoriteButtons();
    if (lazyObserver) lazyObserver.disconnect();
    const sentinel = document.getElementById('loadSentinel');
    if (sentinel) sentinel.style.display = 'none';
    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) loadingIndicator.style.display = 'none';
  }

  // ── Sort cards ──
  function sortCards() {
    const sortBy = document.getElementById('cardSort').value;
    const grids = ['cardsGrid', 'rnCardsGrid', 'allCardsGrid'];
    grids.forEach(gridId => {
      const grid = document.getElementById(gridId);
      if (!grid) return;
      const cards = Array.from(grid.querySelectorAll('.provider-card'));
      cards.sort((a, b) => {
        const nameA = (a.dataset.provider || '').toLowerCase();
        const nameB = (b.dataset.provider || '').toLowerCase();
        const statusA = a.dataset.status || '';
        const statusB = b.dataset.status || '';
        const deadlineA = parseInt(a.dataset.deadline) || 9999;
        const deadlineB = parseInt(b.dataset.deadline) || 9999;
        const statusOrder = { 'At Risk': 0, 'In Progress': 1, 'Complete': 2, 'Unknown': 3 };
        switch (sortBy) {
          case 'name': return nameA.localeCompare(nameB);
          case 'name-desc': return nameB.localeCompare(nameA);
          case 'status': return (statusOrder[statusA] ?? 3) - (statusOrder[statusB] ?? 3);
          case 'status-asc': return (statusOrder[statusB] ?? 3) - (statusOrder[statusA] ?? 3);
          case 'deadline': return deadlineA - deadlineB;
          case 'deadline-desc': return deadlineB - deadlineA;
          default: return 0;
        }
      });
      cards.forEach(card => grid.appendChild(card));
    });
  }

  // ── Provider drawer HTML (pre-rendered at build time, embedded as JSON) ──
  const DRAWER_HTML = ${safeJson(drawerHtmlMap)};

  // ── Provider Filters ──
  let stateFilter = 'all';
  let cardFilter = 'all';
  let typeFilter = 'all';
  let platformFilter = 'all';

  function setStateFilter(s) {
    stateFilter = s;
    const select = document.getElementById('stateFilter');
    if (select) select.value = s;
    filterCards();
  }

  function setCardFilter(f) {
    cardFilter = f;
    const select = document.getElementById('statusFilter');
    if (select) select.value = f;
    filterCards();
  }

  function setProviderTypeFilter(t) {
    typeFilter = t;
    filterCards();
  }

  function filterCards() {
    const q = (document.getElementById('cardSearch')?.value || '').toLowerCase();
    const noCredsOnly = document.getElementById('noCredsFilter')?.checked || false;
    const grid = document.getElementById('allCardsGrid');
    if (!grid) return;

    // Get platform filter value
    const platformFilterVal = document.getElementById('platformFilter')?.value || 'all';

    // Load all cards if searching or filtering (so all results are available)
    if (q || noCredsOnly || stateFilter !== 'all' || cardFilter !== 'all' || typeFilter !== 'all' || platformFilterVal !== 'all') {
      if (typeof loadAllCards === 'function' && lazyLoadedCount < ALL_CARDS_HTML.length) {
        loadAllCards();
      }
    }

    // Advanced filters
    const deadlineMin = parseInt(document.getElementById('deadlineMin')?.value) || null;
    const deadlineMax = parseInt(document.getElementById('deadlineMax')?.value) || null;
    const hoursMin = parseInt(document.getElementById('hoursMin')?.value) || null;
    const hoursMax = parseInt(document.getElementById('hoursMax')?.value) || null;
    const filterOverdue = document.getElementById('filterOverdue')?.checked || false;
    const filterUrgent = document.getElementById('filterUrgent')?.checked || false;

    let visibleCount = 0;
    const totalCount = grid.querySelectorAll('.provider-card').length;

    grid.querySelectorAll('.provider-card').forEach(card => {
      const name   = (card.dataset.provider || '').toLowerCase();
      const status = card.dataset.status || '';
      const states = (card.dataset.states || '').split(',');
      const type   = card.dataset.type || '';
      const noCreds = card.dataset.noCreds === 'true';
      const deadline = parseInt(card.dataset.deadline) || 9999;

      const matchQ = !q || name.includes(q);
      const matchF = cardFilter === 'all' || status === cardFilter;
      const matchS = stateFilter === 'all' || states.includes(stateFilter);
      const matchT = typeFilter === 'all' || type === typeFilter;
      const matchC = !noCredsOnly || noCreds;

      // Platform filter - check for platform tags in the card
      let matchP = platformFilterVal === 'all';
      if (!matchP) {
        const platformMap = {
          'CE Broker': 'cebroker',
          'NetCE': 'netce',
          'CEUfast': 'ceufast',
          'AANP Cert': 'aanp'
        };
        const platClass = platformMap[platformFilterVal];
        if (platClass) {
          matchP = card.querySelector('.plat-tag-' + platClass) !== null ||
                   card.querySelector('.access-' + platClass) !== null;
        }
      }

      // Advanced filter matches
      const matchDeadlineMin = deadlineMin === null || deadline >= deadlineMin;
      const matchDeadlineMax = deadlineMax === null || deadline <= deadlineMax;
      const matchOverdue = !filterOverdue || deadline < 0;
      const matchUrgent = !filterUrgent || (deadline >= 0 && deadline <= 30);

      const visible = matchQ && matchF && matchS && matchT && matchC && matchP && matchDeadlineMin && matchDeadlineMax && ((!filterOverdue && !filterUrgent) || matchOverdue || matchUrgent);
      card.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    });

    // Update count display (use ALL_CARDS_HTML length for total count)
    const countEl = document.getElementById('providerFilterCount');
    const totalProviders = typeof ALL_CARDS_HTML !== 'undefined' ? ALL_CARDS_HTML.length : totalCount;
    if (countEl) countEl.textContent = visibleCount + ' of ' + totalProviders + ' providers';
  }

  function resetProviderFilters() {
    document.getElementById('cardSearch').value = '';
    document.getElementById('statusFilter').value = 'all';
    document.getElementById('typeFilter').value = 'all';
    document.getElementById('stateFilter').value = 'all';
    document.getElementById('platformFilter').value = 'all';
    document.getElementById('cardSort').value = 'name';
    document.getElementById('noCredsFilter').checked = false;
    // Reset advanced filters
    const deadlineMin = document.getElementById('deadlineMin');
    const deadlineMax = document.getElementById('deadlineMax');
    const hoursMin = document.getElementById('hoursMin');
    const hoursMax = document.getElementById('hoursMax');
    const filterOverdue = document.getElementById('filterOverdue');
    const filterUrgent = document.getElementById('filterUrgent');
    if (deadlineMin) deadlineMin.value = '';
    if (deadlineMax) deadlineMax.value = '';
    if (hoursMin) hoursMin.value = '';
    if (hoursMax) hoursMax.value = '';
    if (filterOverdue) filterOverdue.checked = false;
    if (filterUrgent) filterUrgent.checked = false;
    stateFilter = 'all';
    cardFilter = 'all';
    typeFilter = 'all';
    platformFilter = 'all';
    filterCards();
    sortCards();
  }

  // Legacy support
  function toggleTypeFilter(t) { setProviderTypeFilter(t); }

  // ── Provider detail drawer ──
  function openProvider(name) {
    const html = DRAWER_HTML[name];
    if (!html) return;
    document.getElementById('drawerContent').innerHTML = html;
    document.getElementById('drawerOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    // Load notes for this provider
    loadProviderNotes(name);
  }
  function closeProvider() {
    document.getElementById('drawerOverlay').classList.remove('open');
    document.body.style.overflow = '';
  }
  function printProvider() {
    window.print();
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProvider(); });

  // ── Provider Notes System ──
  function getNotesKey(provider) {
    return 'ceu-notes-' + provider.replace(/[^a-zA-Z0-9]/g, '_');
  }
  function getFormId(provider) {
    return provider.replace(/[^a-zA-Z0-9]/g, '_');
  }
  function loadAllNotes() {
    const allNotes = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('ceu-notes-')) {
        try {
          allNotes[key] = JSON.parse(localStorage.getItem(key));
        } catch (e) {}
      }
    }
    return allNotes;
  }
  function loadProviderNotes(provider) {
    const key = getNotesKey(provider);
    const formId = getFormId(provider);
    const listEl = document.getElementById('notesList-' + formId);
    if (!listEl) return;
    let notes = [];
    try {
      notes = JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {}
    renderNotes(provider, notes, listEl);
  }
  function renderNotes(provider, notes, listEl) {
    if (notes.length === 0) {
      listEl.innerHTML = '<div class="notes-empty">No notes yet. Click "+ Add Note" to add the first one.</div>';
      return;
    }
    // Sort: incomplete tasks first, then by date (newest first)
    notes.sort((a, b) => {
      if (a.isTask && !a.done && (!b.isTask || b.done)) return -1;
      if (b.isTask && !b.done && (!a.isTask || a.done)) return 1;
      return new Date(b.date) - new Date(a.date);
    });
    listEl.innerHTML = notes.map((note, idx) => {
      const taskClass = note.isTask ? 'note-task' + (note.done ? ' task-done' : '') : '';
      const checkbox = note.isTask ? '<input type="checkbox" class="task-checkbox" ' + (note.done ? 'checked' : '') + ' onchange="toggleNoteTask(\\'' + provider.replace(/'/g, '&#39;') + '\\', ' + idx + ')">' : '';
      const dateStr = new Date(note.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const textStyle = note.isTask && note.done ? 'text-decoration: line-through;' : '';
      return '<div class="note-item ' + taskClass + '">' +
        checkbox +
        '<div class="note-text" style="' + textStyle + '">' + escapeHtml(note.text) + '</div>' +
        '<div class="note-meta">' +
          '<span class="note-date">' + dateStr + '</span>' +
          (note.isTask ? '<span class="note-type-badge">' + (note.done ? 'Completed' : 'Task') + '</span>' : '') +
          '<div class="note-actions">' +
            '<button class="note-action-btn delete" onclick="deleteNote(\\'' + provider.replace(/'/g, '&#39;') + '\\', ' + idx + ')">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  function showNoteForm(provider) {
    const formId = getFormId(provider);
    const form = document.getElementById('noteForm-' + formId);
    if (form) {
      form.classList.add('active');
      const input = document.getElementById('noteInput-' + formId);
      if (input) input.focus();
    }
  }
  function hideNoteForm(provider) {
    const formId = getFormId(provider);
    const form = document.getElementById('noteForm-' + formId);
    const input = document.getElementById('noteInput-' + formId);
    const checkbox = document.getElementById('noteIsTask-' + formId);
    if (form) form.classList.remove('active');
    if (input) input.value = '';
    if (checkbox) checkbox.checked = false;
  }
  function saveNote(provider) {
    const formId = getFormId(provider);
    const input = document.getElementById('noteInput-' + formId);
    const checkbox = document.getElementById('noteIsTask-' + formId);
    const text = input ? input.value.trim() : '';
    if (!text) return;
    const key = getNotesKey(provider);
    let notes = [];
    try {
      notes = JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {}
    notes.push({
      text: text,
      isTask: checkbox ? checkbox.checked : false,
      done: false,
      date: new Date().toISOString()
    });
    localStorage.setItem(key, JSON.stringify(notes));
    hideNoteForm(provider);
    loadProviderNotes(provider);
  }
  function deleteNote(provider, idx) {
    if (!confirm('Delete this note?')) return;
    const key = getNotesKey(provider);
    let notes = [];
    try {
      notes = JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {}
    notes.splice(idx, 1);
    localStorage.setItem(key, JSON.stringify(notes));
    loadProviderNotes(provider);
  }
  function toggleNoteTask(provider, idx) {
    const key = getNotesKey(provider);
    let notes = [];
    try {
      notes = JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {}
    if (notes[idx]) {
      notes[idx].done = !notes[idx].done;
      localStorage.setItem(key, JSON.stringify(notes));
      loadProviderNotes(provider);
    }
  }

  // ── Table filter ──
  let tableFilter = 'all';
  function filterTable() {
    const q = document.getElementById('tableSearch').value.toLowerCase();
    document.querySelectorAll('#tableBody tr.summary-row').forEach(row => {
      const name   = (row.dataset.provider || '').toLowerCase();
      const status = row.dataset.status || '';
      const matchQ = !q || name.includes(q);
      const matchF = tableFilter === 'all' || status === tableFilter;
      row.classList.toggle('hidden-row', !(matchQ && matchF));
    });
  }
  function setTableFilter(f) {
    tableFilter = f;
    document.querySelectorAll('[id^="tbtn-"]').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('tbtn-' + f);
    if (btn) btn.classList.add('active');
    filterTable();
  }

  // ── Detail toggle ──
  function toggleDetail(id) {
    const el  = document.getElementById(id);
    if (!el) return;
    const hidden = el.classList.toggle('hidden');
    const btn = el.previousElementSibling?.querySelector('.toggle-btn');
    if (btn) btn.textContent = hidden ? '▸ Details' : '▾ Details';
  }

  // ── Sort ──
  let sortCol = -1, sortDir = 1;
  function sortTable(col) {
    const tbody = document.getElementById('tableBody');
    const rows  = Array.from(tbody.querySelectorAll('tr.summary-row'));
    if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
    document.querySelectorAll('thead th').forEach((th, i) => {
      th.classList.toggle('sorted', i === col);
      const ic = th.querySelector('.sort-icon');
      if (ic) ic.textContent = i === col ? (sortDir === 1 ? '↑' : '↓') : '↕';
    });
    rows.sort((a, b) => {
      const av = a.cells[col]?.textContent?.trim() || '';
      const bv = b.cells[col]?.textContent?.trim() || '';
      const an = parseFloat(av), bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn)) return (an - bn) * sortDir;
      return av.localeCompare(bv) * sortDir;
    });
    rows.forEach(r => tbody.appendChild(r));
  }

  // ── Chart.js ──
  const CHART_DATA   = ${safeJson(chartData)};
  const HISTORY_DATA = ${safeJson(history)};

  let chartsInit = false;
  function initCharts() {
    if (chartsInit) return;
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js not loaded - charts will not render');
      return;
    }
    chartsInit = true;

    // Bar chart: Completed vs Required per license
    const hoursChartEl = document.getElementById('hoursChart');
    if (!hoursChartEl) return;
    const ctx1 = hoursChartEl.getContext('2d');
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: CHART_DATA.labels,
        datasets: [
          {
            label: 'Hours Completed',
            data: CHART_DATA.completed,
            backgroundColor: CHART_DATA.colors,
            borderRadius: 4,
          },
          {
            label: 'Hours Required',
            data: CHART_DATA.required,
            backgroundColor: 'rgba(148,163,184,0.25)',
            borderColor: 'rgba(148,163,184,0.6)',
            borderWidth: 1,
            borderRadius: 4,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + ' hrs' } }
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Hours' } },
          x: { ticks: { maxRotation: 45, minRotation: 30 } }
        }
      }
    });

    // History trend chart
    const histWrap = document.getElementById('historyChartWrap');
    if (!HISTORY_DATA || HISTORY_DATA.length < 2) {
      histWrap.innerHTML = '<p class="chart-no-data">Run the scraper multiple times to see progress trends over time.</p>';
      return;
    }
    const histLabels = HISTORY_DATA.map(h => {
      const d = new Date(h.timestamp);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    });
    const histAvgPct = HISTORY_DATA.map(h => {
      const pcts = (h.providers || [])
        .filter(p => p.hoursRequired > 0)
        .map(p => Math.min(100, Math.round(((p.hoursCompleted || 0) / p.hoursRequired) * 100)));
      return pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    });
    const histComplete = HISTORY_DATA.map(h =>
      (h.providers || []).filter(p =>
        p.hoursRemaining != null ? p.hoursRemaining <= 0 : (p.hoursCompleted || 0) >= (p.hoursRequired || 1)
      ).length
    );
    const historyChartEl = document.getElementById('historyChart');
    if (!historyChartEl) return;
    const ctx2 = historyChartEl.getContext('2d');
    new Chart(ctx2, {
      type: 'line',
      data: {
        labels: histLabels,
        datasets: [
          {
            label: 'Avg Completion %',
            data: histAvgPct,
            borderColor: '#1d4ed8',
            backgroundColor: 'rgba(29,78,216,0.1)',
            fill: true,
            tension: 0.3,
            yAxisID: 'pct',
          },
          {
            label: 'Licenses Complete',
            data: histComplete,
            borderColor: '#16a34a',
            backgroundColor: 'transparent',
            borderDash: [5, 3],
            tension: 0.3,
            yAxisID: 'count',
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: {
          pct:   { type: 'linear', position: 'left',  beginAtZero: true, max: 100,
                   title: { display: true, text: '% Complete' } },
          count: { type: 'linear', position: 'right', beginAtZero: true,
                   title: { display: true, text: 'Licenses Complete' },
                   grid: { drawOnChartArea: false } }
        }
      }
    });
  }

  // ── Timeline View ────────────────────────────────────────────────────────
  const TIMELINE_DATA = ${JSON.stringify(timelineData)};
  let timelineTooltip = null;

  function updateTimeline() {
    const container = document.getElementById('timelineContainer');
    const axis = document.getElementById('timelineAxis');
    const content = document.getElementById('timelineContent');
    const empty = document.getElementById('timelineEmpty');

    if (!container || !axis || !content) return;

    const rangeMonths = parseInt(document.getElementById('timelineRange')?.value) || 12;
    const filter = document.getElementById('timelineFilter')?.value || 'all';

    // Calculate date range
    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - rangeMonths);
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + 3); // Show 3 months into the future for deadlines

    const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));

    // Generate month labels for axis
    const months = [];
    let current = new Date(startDate);
    current.setDate(1);
    while (current <= endDate) {
      months.push({
        label: current.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        date: new Date(current)
      });
      current.setMonth(current.getMonth() + 1);
    }

    // Render axis
    axis.innerHTML = '<div style="width:184px;flex-shrink:0;padding-right:16px"></div>' +
      months.map(m => '<div class="timeline-month">' + m.label + '</div>').join('');

    // Filter and render timeline rows
    let filteredData = TIMELINE_DATA;
    if (filter === 'active') {
      filteredData = TIMELINE_DATA.filter(p => p.courses.length > 0);
    }

    if (filteredData.length === 0) {
      container.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    container.style.display = 'block';
    empty.style.display = 'none';

    const rows = filteredData.map(provider => {
      // Filter courses in range
      const coursesInRange = provider.courses.filter(c => {
        const d = new Date(c.date);
        return d >= startDate && d <= endDate;
      });

      // Group courses by date for dot positioning
      const coursesByDate = {};
      coursesInRange.forEach(c => {
        const key = c.date;
        if (!coursesByDate[key]) coursesByDate[key] = [];
        coursesByDate[key].push(c);
      });

      // Render course dots
      const dots = Object.entries(coursesByDate).map(([date, courses]) => {
        const d = new Date(date);
        const daysSinceStart = Math.ceil((d - startDate) / (1000 * 60 * 60 * 24));
        const pct = Math.max(0, Math.min(100, (daysSinceStart / totalDays) * 100));
        const isMulti = courses.length > 1;
        const totalHours = courses.reduce((sum, c) => sum + (c.hours || 0), 0);
        const tooltip = courses.length === 1
          ? courses[0].name + ' (' + courses[0].hours + 'h)'
          : courses.length + ' courses (' + totalHours + 'h total)';
        return '<div class="timeline-dot' + (isMulti ? ' multi' : '') + '" ' +
          'style="left:' + pct + '%" ' +
          'data-courses="' + escapeAttr(JSON.stringify(courses)) + '" ' +
          'data-date="' + date + '" ' +
          'onmouseenter="showTimelineTooltip(event, this)" ' +
          'onmouseleave="hideTimelineTooltip()"></div>';
      }).join('');

      // Render deadline markers (show in future)
      const deadlines = provider.deadlines.map(dl => {
        const d = new Date(dl.date);
        if (d < startDate || d > endDate) return '';
        const daysSinceStart = Math.ceil((d - startDate) / (1000 * 60 * 60 * 24));
        const pct = Math.max(0, Math.min(100, (daysSinceStart / totalDays) * 100));
        return '<div class="timeline-deadline" style="left:' + pct + '%" data-label="' + dl.state + ' ' + dl.licenseType + '"></div>';
      }).join('');

      return '<div class="timeline-row">' +
        '<div class="timeline-label" title="' + escapeAttr(provider.name) + '">' + escapeAttr(provider.name) + '</div>' +
        '<div class="timeline-track">' + dots + deadlines + '</div>' +
        '</div>';
    }).join('');

    content.innerHTML = rows;
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showTimelineTooltip(event, el) {
    hideTimelineTooltip();
    const courses = JSON.parse(el.dataset.courses);
    const date = el.dataset.date;

    const tooltip = document.createElement('div');
    tooltip.className = 'timeline-tooltip';
    tooltip.innerHTML = '<div class="timeline-tooltip-title">' +
      new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      '</div>' +
      courses.map(c => '<div class="timeline-tooltip-meta">' +
        escapeAttr(c.name || 'Course') + ' &mdash; ' + c.hours + 'h' +
        (c.state ? ' (' + c.state + ')' : '') + '</div>').join('');

    document.body.appendChild(tooltip);
    timelineTooltip = tooltip;

    const rect = el.getBoundingClientRect();
    tooltip.style.left = Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 20) + 'px';
    tooltip.style.top = (rect.bottom + 8) + 'px';
  }

  function hideTimelineTooltip() {
    if (timelineTooltip) {
      timelineTooltip.remove();
      timelineTooltip = null;
    }
  }

  // Initialize timeline when view becomes active
  document.addEventListener('DOMContentLoaded', () => {
    // Pre-render timeline if there's data
    if (TIMELINE_DATA.length > 0) {
      setTimeout(updateTimeline, 100);
    }
  });

  // ── "Updated X ago" live ticker ──────────────────────────────────────────
  (function() {
    const el  = document.getElementById('lastScrapedAgo');
    const src = document.getElementById('lastScrapedValue');
    if (!el || !src) return;
    const runTime = new Date(src.dataset.iso).getTime();
    if (isNaN(runTime)) return;
    function tick() {
      const diff = Math.floor((Date.now() - runTime) / 60000);
      if (diff < 1)       el.textContent = 'just now';
      else if (diff < 60) el.textContent = diff + 'm ago';
      else {
        const h = Math.floor(diff / 60), m = diff % 60;
        el.textContent = h + 'h' + (m ? ' ' + m + 'm' : '') + ' ago';
      }
    }
    tick();
    setInterval(tick, 60000);
  })();

  // ── Quick Filters ──────────────────────────────────────────────────────────
  let activeQuickFilter = 'all';
  function applyQuickFilter(filter) {
    activeQuickFilter = filter;
    // Support both old .quick-filter-btn and new .qf-pill classes
    document.querySelectorAll('.quick-filter-btn, .qf-pill').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById('qf-' + filter);
    if (activeBtn) activeBtn.classList.add('active');

    const deadlineMin = document.getElementById('deadlineMin');
    const deadlineMax = document.getElementById('deadlineMax');
    const statusFilter = document.getElementById('statusFilter');
    if (deadlineMin) deadlineMin.value = '';
    if (deadlineMax) deadlineMax.value = '';
    if (statusFilter) statusFilter.value = 'all';
    cardFilter = 'all';

    switch(filter) {
      case 'urgent':
        if (statusFilter) statusFilter.value = 'At Risk';
        cardFilter = 'At Risk';
        break;
      case 'due30':
        if (deadlineMax) deadlineMax.value = '30';
        break;
      case 'due90':
        if (deadlineMax) deadlineMax.value = '90';
        break;
      case 'complete':
        if (statusFilter) statusFilter.value = 'Complete';
        cardFilter = 'Complete';
        break;
    }
    filterCards();
  }

  // ── Calendar Export (ICS) ──────────────────────────────────────────────────
  function exportToCalendar() {
    const events = [];
    document.querySelectorAll('.provider-card').forEach(card => {
      const name = card.dataset.provider || 'Unknown';
      const deadline = parseInt(card.dataset.deadline) || 0;
      if (deadline > 0 && deadline < 365) {
        const deadlineDate = new Date();
        deadlineDate.setDate(deadlineDate.getDate() + deadline);
        const y = deadlineDate.getFullYear();
        const m = String(deadlineDate.getMonth() + 1).padStart(2, '0');
        const d = String(deadlineDate.getDate()).padStart(2, '0');
        const dateStr = y + m + d;
        const uid = 'ceu-' + name.replace(/\\s+/g, '-').toLowerCase() + '-' + Date.now() + Math.random().toString(36).substr(2,9);
        events.push('BEGIN:VEVENT\\r\\nUID:' + uid + '\\r\\nDTSTART;VALUE=DATE:' + dateStr + '\\r\\nSUMMARY:CEU Deadline: ' + name + '\\r\\nDESCRIPTION:' + deadline + ' days until renewal\\r\\nEND:VEVENT');
      }
    });
    if (events.length === 0) { alert('No upcoming deadlines to export.'); return; }
    const ics = 'BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nPRODID:-//CEU Tracker//EN\\r\\n' + events.join('\\r\\n') + '\\r\\nEND:VCALENDAR';
    const blob = new Blob([ics.replace(/\\\\r\\\\n/g, '\\r\\n')], { type: 'text/calendar' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'ceu-deadlines.ics';
    link.click();
  }

  // ── Print Compliance Report ────────────────────────────────────────────────
  function printComplianceReport() { window.print(); }

  // ── Provider Notes (localStorage) ──────────────────────────────────────────
  const providerNotes = JSON.parse(localStorage.getItem('ceuTrackerNotes') || '{}');
  function saveProviderNote(name, note) {
    if (note.trim()) providerNotes[name] = note.trim();
    else delete providerNotes[name];
    localStorage.setItem('ceuTrackerNotes', JSON.stringify(providerNotes));
  }
  function getProviderNote(name) { return providerNotes[name] || ''; }

  // ── Focus Mode ────────────────────────────────────────────────────────────
  let focusModeActive = false;
  function toggleFocusMode() {
    focusModeActive = !focusModeActive;
    const banner = document.getElementById('focusModeBanner');
    const cards = document.querySelectorAll('.provider-card');

    if (focusModeActive) {
      banner?.classList.add('visible');
      // Show only at-risk and due-soon providers
      cards.forEach(card => {
        const status = card.dataset.status;
        const deadline = parseInt(card.dataset.deadline) || 999;
        const needsAttention = status === 'At Risk' || deadline <= 30;
        card.style.display = needsAttention ? '' : 'none';
      });
      // Update count
      const visibleCount = Array.from(cards).filter(c => c.style.display !== 'none').length;
      document.getElementById('providerFilterCount').textContent = visibleCount + ' providers need attention';
    } else {
      banner?.classList.remove('visible');
      // Show all providers
      cards.forEach(card => card.style.display = '');
      resetProviderFilters();
    }
  }

  // ── Shortcuts Overlay ────────────────────────────────────────────────────
  function toggleShortcutsOverlay() {
    const overlay = document.getElementById('shortcutsOverlay');
    overlay?.classList.toggle('visible');
  }

  // ── Keyboard Shortcuts ─────────────────────────────────────────────────────
  let keyboardModalOpen = false;
  let currentCardIndex = -1;
  function toggleKeyboardModal() {
    keyboardModalOpen = !keyboardModalOpen;
    document.getElementById('keyboardModal')?.classList.toggle('open', keyboardModalOpen);
    document.getElementById('keyboardOverlay')?.classList.toggle('open', keyboardModalOpen);
  }
  document.addEventListener('keydown', (e) => {
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const shortcutsOpen = document.getElementById('shortcutsOverlay')?.classList.contains('visible');
    const cards = Array.from(document.querySelectorAll('.provider-card')).filter(c => c.style.display !== 'none');
    switch(e.key) {
      case '/': e.preventDefault(); document.getElementById('cardSearch')?.focus(); break;
      case '?': e.preventDefault(); toggleShortcutsOverlay(); break;
      case 'f': e.preventDefault(); toggleFocusMode(); break;
      case 'd': e.preventDefault(); toggleTheme(); break;
      case 'j': e.preventDefault(); currentCardIndex = Math.min(currentCardIndex + 1, cards.length - 1); cards[currentCardIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
      case 'k': e.preventDefault(); currentCardIndex = Math.max(currentCardIndex - 1, 0); cards[currentCardIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
      case 'Enter': if (currentCardIndex >= 0 && cards[currentCardIndex]) openProvider(cards[currentCardIndex].dataset.provider); break;
      case 'Escape': shortcutsOpen ? toggleShortcutsOverlay() : keyboardModalOpen ? toggleKeyboardModal() : closeProvider(); break;
      case 'r': if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); resetProviderFilters(); } break;
      case '1': e.preventDefault(); applyQuickFilter('urgent'); break;
      case '2': e.preventDefault(); applyQuickFilter('due30'); break;
      case '3': e.preventDefault(); applyQuickFilter('complete'); break;
      case '0': e.preventDefault(); applyQuickFilter('all'); break;
    }
  });
</script>
<div class="keyboard-overlay" id="keyboardOverlay" onclick="toggleKeyboardModal()"></div>
<div class="keyboard-modal" id="keyboardModal">
  <h3>Keyboard Shortcuts</h3>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>/</kbd></span><span class="shortcut-desc">Focus search</span></div>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>j</kbd> <kbd>k</kbd></span><span class="shortcut-desc">Navigate cards</span></div>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>Enter</kbd></span><span class="shortcut-desc">Open provider</span></div>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>Esc</kbd></span><span class="shortcut-desc">Close modal</span></div>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>r</kbd></span><span class="shortcut-desc">Reset filters</span></div>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>0</kbd></span><span class="shortcut-desc">Quick filters</span></div>
  <div class="keyboard-shortcut"><span class="shortcut-key"><kbd>?</kbd></span><span class="shortcut-desc">This help</span></div>
</div>
<div class="keyboard-help"><button class="keyboard-help-btn" onclick="toggleShortcutsOverlay()" title="Keyboard shortcuts (?)">?</button></div>

<!-- ── Keyboard Shortcuts Overlay ─────────────────────────────────────────── -->
<div class="shortcuts-overlay" id="shortcutsOverlay" onclick="if(event.target===this)toggleShortcutsOverlay()">
  <div class="shortcuts-modal">
    <div class="shortcuts-header">
      <div class="shortcuts-title">Keyboard Shortcuts</div>
      <button class="shortcuts-close" onclick="toggleShortcutsOverlay()">&times;</button>
    </div>
    <div class="shortcuts-section">
      <div class="shortcuts-section-title">Navigation</div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Focus search</span>
        <div class="shortcut-keys"><span class="shortcut-key">/</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Navigate cards</span>
        <div class="shortcut-keys"><span class="shortcut-key">j</span><span class="shortcut-key">k</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Open selected provider</span>
        <div class="shortcut-keys"><span class="shortcut-key">Enter</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Close modal/drawer</span>
        <div class="shortcut-keys"><span class="shortcut-key">Esc</span></div>
      </div>
    </div>
    <div class="shortcuts-section">
      <div class="shortcuts-section-title">Filters</div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Show At Risk only</span>
        <div class="shortcut-keys"><span class="shortcut-key">1</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Show Due in 30 days</span>
        <div class="shortcut-keys"><span class="shortcut-key">2</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Show Complete</span>
        <div class="shortcut-keys"><span class="shortcut-key">3</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Show all (reset)</span>
        <div class="shortcut-keys"><span class="shortcut-key">0</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Reset all filters</span>
        <div class="shortcut-keys"><span class="shortcut-key">r</span></div>
      </div>
    </div>
    <div class="shortcuts-section">
      <div class="shortcuts-section-title">Views</div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Toggle Focus Mode</span>
        <div class="shortcut-keys"><span class="shortcut-key">f</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Toggle dark mode</span>
        <div class="shortcut-keys"><span class="shortcut-key">d</span></div>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-desc">Show shortcuts</span>
        <div class="shortcut-keys"><span class="shortcut-key">?</span></div>
      </div>
    </div>
    <div class="shortcuts-hint">Press <span class="shortcut-key">Esc</span> to close</div>
  </div>
</div>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');

  // Mirror to public/index.html so Vercel serves it at the root URL
  ensurePublicDir();
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');

  return OUTPUT_HTML;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate HTML for the updates section from updates.json and manual-updates.json
 */
function generateUpdatesHtml() {
  try {
    const updates = getAllUpdates(15); // Get last 15 updates

    if (updates.length === 0) {
      return '<p style="color: var(--text-secondary); font-style: italic;">No updates yet.</p>';
    }

    return updates.map(update => {
      const badgeType = update.type === 'new' ? 'New' :
                        update.type === 'removed' ? 'Removed' :
                        update.type === 'changed' ? 'Update' : 'Info';
      return `
        <div class="update-item ${escHtml(update.type)}">
          <div class="update-date">${escHtml(update.date)}</div>
          <div class="update-title"><span class="update-badge ${escHtml(update.type)}">${badgeType}</span>${escHtml(update.title)}</div>
          <div class="update-desc">${escHtml(update.desc)}</div>
        </div>`;
    }).join('\n');
  } catch (err) {
    console.error('Error generating updates HTML:', err.message);
    return '<p style="color: var(--text-secondary); font-style: italic;">Unable to load updates.</p>';
  }
}

/**
 * Generate a simple bar chart showing course completions by month
 */
function generateTrendChart(courseHistory) {
  const months = [];
  const now = new Date();

  // Generate last 6 months
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'short' }),
      count: 0,
      hours: 0
    });
  }

  // Count courses per month from history
  if (courseHistory && typeof courseHistory === 'object') {
    for (const provider of Object.values(courseHistory)) {
      const courses = provider.courses || [];
      for (const course of courses) {
        if (!course.date) continue;
        const courseDate = new Date(course.date);
        const courseKey = `${courseDate.getFullYear()}-${String(courseDate.getMonth() + 1).padStart(2, '0')}`;
        const month = months.find(m => m.key === courseKey);
        if (month) {
          month.count++;
          month.hours += parseFloat(course.hours) || 0;
        }
      }
    }
  }

  // Find max for scaling
  const maxHours = Math.max(...months.map(m => m.hours), 1);

  // Generate HTML bars
  return months.map(m => {
    const height = Math.max(4, (m.hours / maxHours) * 160);
    return `<div class="trend-bar" style="height: ${height}px;" title="${m.label}: ${m.hours.toFixed(1)} hours (${m.count} courses)">
      <span class="trend-bar-value">${m.hours > 0 ? m.hours.toFixed(0) : ''}</span>
      <span class="trend-bar-label">${m.label}</span>
    </div>`;
  }).join('');
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


function safeJson(obj) {
  // Serialize as JSON safe for embedding in an HTML <script> block
  return JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>');
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function buildHoursBar(completed, required) {
  if (completed == null && required == null) return '<span style="color:#94a3b8">—</span>';
  const c   = completed ?? 0;
  const r   = required  ?? 0;
  const pct = r > 0 ? Math.min(100, Math.round((c / r) * 100)) : (c > 0 ? 100 : 0);
  const cls = pct >= 100 ? '' : pct >= 50 ? 'partial' : 'low';
  return `<div class="hours-wrap">
    <div class="hours-text">${c} / ${r} hrs</div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
  </div>`;
}

/**
 * Build the "Platform CEU Accounts" section HTML for a provider drawer.
 * @param {Array} platformResults  Array of platform result objects for one provider
 */
function buildPlatformSection(platformResults) {
  if (!platformResults || platformResults.length === 0) return '';

  const cards = platformResults.map(pr => {
    const platformKey =
      pr.platform === 'NetCE'     ? 'plat-netce'
    : pr.platform === 'CEUfast'   ? 'plat-ceufast'
    : pr.platform === 'AANP Cert' ? 'plat-aanp'
    :                               'plat-error';

    const statusLabel = pr.status === 'success' ? '✓ Connected' : '✗ Failed';

    // ── Error card ──────────────────────────────────────────────────────────
    if (pr.status === 'failed') {
      return `<div class="platform-card ${platformKey}">
        <div class="platform-card-hdr">
          <span>${escHtml(pr.platform)}</span>
          <span class="platform-hdr-status">${statusLabel}</span>
        </div>
        <div class="platform-card-body">
          <div class="platform-error-msg">${escHtml(pr.error || 'Scrape failed')}</div>
        </div>
        ${pr.lastUpdated ? `<div class="platform-updated">Last run: ${escHtml(pr.lastUpdated)}</div>` : ''}
      </div>`;
    }

    // ── AANP Cert — show cycle progress bar ─────────────────────────────────
    let progressHtml = '';
    if (pr.platform === 'AANP Cert' && pr.hoursRequired != null) {
      const earned = pr.hoursEarned ?? 0;
      const req    = pr.hoursRequired;
      const pct    = req > 0 ? Math.min(100, Math.round((earned / req) * 100)) : 0;
      const fillCls = pct >= 100 ? 'pp-complete' : '';
      const certStatusCls = (pr.certStatus || '').toLowerCase() === 'active' ? 'cert-active' : 'cert-inactive';

      progressHtml = `
        <div class="platform-prog-wrap">
          <div class="platform-prog-row">
            <span>${earned} / ${req} CE credits</span>
            <span>${pct}%</span>
          </div>
          <div class="platform-prog-track">
            <div class="platform-prog-fill ${fillCls}" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="platform-cert-row">
          ${pr.certStatus ? `<span class="platform-cert-status ${certStatusCls}">${escHtml(pr.certStatus)}</span>` : ''}
          ${pr.certExpires ? `<span>Cert expires: <strong>${escHtml(pr.certExpires)}</strong></span>` : ''}
        </div>`;
    } else if (pr.hoursEarned != null) {
      progressHtml = `
        <div class="platform-hours-row">
          <span class="platform-hours-big">${pr.hoursEarned}</span>
          <span class="platform-hours-lbl">hrs earned on this platform</span>
        </div>`;
    }

    // ── Course list (up to 5 shown) ─────────────────────────────────────────
    const courses = pr.courses || [];
    const courseListHtml = courses.length > 0
      ? `<div class="platform-courses-title">Recent Courses (${courses.length})</div>
         <div class="platform-course-list">
           ${courses.slice(0, 15).map(c => `
             <div class="platform-course-item">
               <span class="platform-course-name">${escHtml(c.name || 'Course')}</span>
               <span class="platform-course-meta">${c.hours}h${c.date ? ' · ' + escHtml(c.date) : ''}</span>
             </div>`).join('')}
           ${courses.length > 15 ? `<div class="platform-no-courses">+${courses.length - 15} more courses</div>` : ''}
         </div>`
      : `<div class="platform-no-courses">No course data found</div>`;

    return `<div class="platform-card ${platformKey}">
      <div class="platform-card-hdr">
        <span>${escHtml(pr.platform)}</span>
        <span class="platform-hdr-status">${statusLabel}</span>
      </div>
      <div class="platform-card-body">
        ${progressHtml}
        ${courseListHtml}
      </div>
      ${pr.lastUpdated ? `<div class="platform-updated">Last updated: ${escHtml(pr.lastUpdated)}</div>` : ''}
    </div>`;
  }).join('');

  return `<div class="platform-section">
    <div class="platform-section-title">Platform CEU Accounts</div>
    <div class="platform-cards">${cards}</div>
  </div>`;
}

/**
 * Build the "Lookback Compliance" section HTML for a provider drawer.
 * Shows state-specific requirements with lookback periods (e.g., FL 5-year pharmacology).
 * @param {Array} states - Array of state abbreviations the provider is licensed in
 * @param {string} providerType - Provider type (NP, RN, MD, etc.)
 * @param {Array} courses - Array of completed courses with dates
 */
function buildLookbackComplianceSection(states, providerType, courses) {
  if (!courses || courses.length === 0) return '';
  if (!STATE_REQUIREMENTS || Object.keys(STATE_REQUIREMENTS).length === 0) return '';

  // Map full state names to abbreviations
  const STATE_ABBREV = {
    'Florida': 'FL', 'Ohio': 'OH', 'Michigan': 'MI', 'Texas': 'TX',
    'New York': 'NY', 'California': 'CA', 'New Mexico': 'NM', 'New Hampshire': 'NH',
    'Georgia': 'GA', 'Pennsylvania': 'PA', 'Illinois': 'IL', 'North Carolina': 'NC',
  };

  const sections = [];

  // Check each state the provider is licensed in
  for (const state of states) {
    // Try direct match first, then abbreviation lookup
    const stateKey = STATE_REQUIREMENTS[state] ? state : STATE_ABBREV[state];
    const stateReqs = STATE_REQUIREMENTS[stateKey];
    if (!stateReqs) continue;

    // Find applicable requirement set for provider type
    let reqSet = null;
    let reqSetName = '';

    // Check for specific type requirements (NP, RN, MD, etc.)
    if (stateReqs[providerType]) {
      reqSet = stateReqs[providerType];
      reqSetName = reqSet.description || (stateReqs.name + ' ' + providerType);
    }
    // Check for APRN requirements if provider is NP
    if (!reqSet && (providerType === 'NP' || providerType === 'DO' || providerType === 'MD') && stateReqs.APRN) {
      reqSet = stateReqs.APRN;
      reqSetName = reqSet.description || (stateReqs.name + ' APRN');
    }
    // Check for autonomous APRN requirements (Florida specific)
    if (stateReqs.autonomousAPRN && (providerType === 'NP')) {
      const autoReqs = stateReqs.autonomousAPRN;
      reqSetName = autoReqs.description || (stateReqs.name + ' Autonomous APRN');

      // Build rows for autonomous requirements (these have lookback periods)
      const rows = (autoReqs.subjects || []).map(subj => {
        const result = calculateSubjectHoursWithLookback(courses, subj.pattern, subj.lookbackYears);
        const needed = Math.max(0, subj.hoursRequired - result.validHours);
        const statusClass = needed === 0 ? 'lb-met' : result.validHours > 0 ? 'lb-partial' : 'lb-none';
        const statusText = needed === 0 ? '✓ Met' : '⚠ Need ' + needed + 'h';
        const lookbackText = subj.lookbackYears ? subj.lookbackYears + 'yr' : 'All time';
        const cutoffText = subj.lookbackYears ? ' (since ' + formatLookbackCutoff(subj.lookbackYears) + ')' : '';

        return '<tr>' +
          '<td class="lb-subject">' + escHtml(subj.name) + '</td>' +
          '<td class="lb-required">' + subj.hoursRequired + 'h</td>' +
          '<td class="lb-total">' + result.totalHours + 'h</td>' +
          '<td class="lb-valid">' + result.validHours + 'h <span class="lb-window">' + lookbackText + cutoffText + '</span></td>' +
          '<td class="lb-status ' + statusClass + '">' + statusText + '</td>' +
          '</tr>';
      }).join('');

      if (rows) {
        sections.push(`
          <div class="lookback-req-group">
            <div class="lookback-req-title">${escHtml(reqSetName)}</div>
            <table class="lookback-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Required</th>
                  <th>Total</th>
                  <th>Valid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`);
      }
    }

    // Standard requirements (may or may not have lookback)
    if (reqSet && reqSet.subjects) {
      const rows = reqSet.subjects.map(subj => {
        const result = calculateSubjectHoursWithLookback(courses, subj.pattern, subj.lookbackYears);
        const needed = Math.max(0, subj.hoursRequired - result.validHours);
        const statusClass = needed === 0 ? 'lb-met' : result.validHours > 0 ? 'lb-partial' : 'lb-none';
        const statusText = needed === 0 ? '✓ Met' : '⚠ Need ' + needed + 'h';
        const lookbackText = subj.lookbackYears ? subj.lookbackYears + 'yr' : '—';

        return '<tr>' +
          '<td class="lb-subject">' + escHtml(subj.name) + '</td>' +
          '<td class="lb-required">' + subj.hoursRequired + 'h</td>' +
          '<td class="lb-total">' + result.totalHours + 'h</td>' +
          '<td class="lb-valid">' + result.validHours + 'h' + (subj.lookbackYears ? ' <span class="lb-window">' + lookbackText + '</span>' : '') + '</td>' +
          '<td class="lb-status ' + statusClass + '">' + statusText + '</td>' +
          '</tr>';
      }).join('');

      if (rows && !sections.some(s => s.includes(reqSetName))) {
        sections.push(`
          <div class="lookback-req-group">
            <div class="lookback-req-title">${escHtml(reqSetName)}</div>
            <table class="lookback-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Required</th>
                  <th>Total</th>
                  <th>Valid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`);
      }
    }
  }

  if (sections.length === 0) return '';

  return `<div class="lookback-section">
    <div class="lookback-section-title">State CE Requirements</div>
    ${sections.join('')}
  </div>`;
}

/**
 * Build the "Spending Overview" section HTML for a provider drawer.
 * Shows rolling 12-month spending, cost per hour, and platform breakdown.
 * @param {string} providerName - Provider name
 * @param {Object} spendingData - Spending data for this provider
 * @param {Array} orders - Order data from platform scrapers
 */
function buildSpendingSection(providerName, spendingData, orders = []) {
  if (!spendingData) return '';

  const { courseCosts, subscriptionCosts, totalSpend, costPerHour, hoursCompleted, courseDetails } = spendingData;

  // If no spending data, show a placeholder
  if (!totalSpend && orders.length === 0) {
    return `<div class="spending-section">
      <div class="spending-section-title">Cost Tracking (Rolling 12 Months)</div>
      <div class="spending-no-data">No cost data available. Add costs via costs.json or wait for order scraping.</div>
    </div>`;
  }

  // Calculate platform breakdown from courseDetails
  const platformBreakdown = {};
  if (courseDetails && courseDetails.length > 0) {
    for (const course of courseDetails) {
      const platform = course.platform || 'Unknown';
      if (!platformBreakdown[platform]) platformBreakdown[platform] = { cost: 0, count: 0 };
      platformBreakdown[platform].cost += course.cost || 0;
      platformBreakdown[platform].count++;
    }
  }

  // Build platform breakdown bars
  const maxPlatformCost = Math.max(...Object.values(platformBreakdown).map(p => p.cost), 1);
  const platformColors = {
    'NetCE': '#3b82f6',
    'CEUfast': '#8b5cf6',
    'AANP Cert': '#10b981',
    'ExclamationCE': '#f59e0b',
    'Nursece4less': '#06b6d4',
    'Nursing CE Central': '#ec4899',
    'Unknown': '#64748b',
    'Manual Entry': '#94a3b8',
  };
  const platformBarsHtml = Object.keys(platformBreakdown).length > 0
    ? `<div class="spending-platform-breakdown">
        <div class="spending-breakdown-title">Spend by Platform</div>
        ${Object.entries(platformBreakdown)
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([platform, data]) => {
            const pct = Math.round((data.cost / maxPlatformCost) * 100);
            const color = platformColors[platform] || '#64748b';
            return `<div class="spending-platform-row">
              <span class="spending-platform-name">${escHtml(platform)}</span>
              <div class="spending-platform-bar-track">
                <div class="spending-platform-bar-fill" style="width:${pct}%; background:${color}"></div>
              </div>
              <span class="spending-platform-amount">$${data.cost.toFixed(2)}</span>
              <span class="spending-platform-count">${data.count} course${data.count !== 1 ? 's' : ''}</span>
            </div>`;
          }).join('')}
      </div>`
    : '';

  // Build order list if available
  const orderListHtml = orders.length > 0
    ? `<div class="spending-orders">
        <div class="spending-orders-title">Recent Orders (${orders.length})</div>
        ${orders.slice(0, 10).map(o => `
          <div class="spending-order-item">
            <span class="spending-order-date">${escHtml(o.date || '—')}</span>
            <span class="spending-order-total">$${(o.total || 0).toFixed(2)}</span>
          </div>`).join('')}
        ${orders.length > 10 ? `<div class="spending-more">+${orders.length - 10} more orders</div>` : ''}
      </div>`
    : '';

  // Cost efficiency indicator
  const efficiencyClass = costPerHour === null ? ''
    : costPerHour < 5 ? 'efficiency-great'
    : costPerHour < 10 ? 'efficiency-good'
    : costPerHour < 20 ? 'efficiency-fair'
    : 'efficiency-poor';
  const efficiencyLabel = costPerHour === null ? ''
    : costPerHour < 5 ? 'Excellent value'
    : costPerHour < 10 ? 'Good value'
    : costPerHour < 20 ? 'Average'
    : 'High cost';

  return `<div class="spending-section">
    <div class="spending-section-title">Cost Tracking (Rolling 12 Months)</div>
    <div class="spending-summary">
      <div class="spending-stat spending-stat-total">
        <span class="spending-stat-value">$${totalSpend.toFixed(2)}</span>
        <span class="spending-stat-label">Total Spend</span>
      </div>
      <div class="spending-stat">
        <span class="spending-stat-value">$${courseCosts.toFixed(2)}</span>
        <span class="spending-stat-label">Course Costs</span>
      </div>
      <div class="spending-stat">
        <span class="spending-stat-value">$${subscriptionCosts.toFixed(2)}</span>
        <span class="spending-stat-label">Subscriptions</span>
      </div>
      <div class="spending-stat ${efficiencyClass}">
        <span class="spending-stat-value">${costPerHour !== null ? '$' + costPerHour.toFixed(2) : '—'}</span>
        <span class="spending-stat-label">Cost/CEU Hour</span>
        ${efficiencyLabel ? `<span class="spending-efficiency-label">${efficiencyLabel}</span>` : ''}
      </div>
    </div>
    ${platformBarsHtml}
    ${orderListHtml}
  </div>`;
}

module.exports = { buildDashboard };

// Run when executed directly
if (require.main === module) {
  console.log('Building dashboard...');
  // Load the most recent snapshot from history.json to build dashboard
  let historyData = [];
  try {
    historyData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.log('No history.json found, using empty data');
  }

  // Get the most recent snapshot
  const latestSnapshot = historyData.length > 0 ? historyData[historyData.length - 1] : null;

  // Convert snapshot providers to allProviderRecords format (array of arrays)
  let allProviderRecords = [];
  let runResults = [];

  if (latestSnapshot && latestSnapshot.providers) {
    // Each provider becomes a single-item array containing its record
    allProviderRecords = latestSnapshot.providers.map(p => [{
      providerName: p.name,
      providerType: p.name?.match(/,\s*(NP|MD|DO|RN)/)?.[1] || 'Unknown',
      state: p.state,
      hoursRequired: p.hoursRequired,
      hoursCompleted: p.hoursCompleted,
      hoursRemaining: p.hoursRemaining,
      renewalDeadline: p.renewalDeadline,
      courses: p.courses || []
    }]);
    runResults = latestSnapshot.providers.map(p => ({ name: p.name, status: 'success' }));
  }

  const outputPath = buildDashboard(allProviderRecords, runResults, [], null);
  console.log('Dashboard built:', outputPath);
}
