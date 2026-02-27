// dashboard-builder.js — Generates dashboard.html from scraped records

const fs   = require('fs');
const path = require('path');
const { daysUntil, parseDate, getStatus, courseSearchUrl, calculateSubjectHoursWithLookback, formatLookbackCutoff } = require('./utils');

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
const PUBLIC_DIR     = path.join(__dirname, 'public');

function ensurePublicDir() {
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
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
 * Build and write dashboard.html.
 * @param {LicenseRecord[][]} allProviderRecords
 * @param {{ name:string, status:string, error?:string }[]} [runResults]
 */
function buildDashboard(allProviderRecords, runResults = [], platformData = []) {
  const history = saveHistory(allProviderRecords, runResults);
  const flat    = flattenRecords(allProviderRecords, runResults);
  const runDate = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const runIso  = new Date().toISOString();

  // Load providers.json early for credential checks
  const providers = require('./providers.json');
  const noCredentialsProviders = providers.filter(p => p.noCredentials === true).map(p => p.name);

  // ── Group platform results by provider name ──────────────────────────────
  const platformByProvider = {};
  for (const pr of platformData) {
    if (!platformByProvider[pr.providerName]) platformByProvider[pr.providerName] = [];
    platformByProvider[pr.providerName].push(pr);
  }

  // ── Platform overview data ────────────────────────────────────────────────
  const ALL_PLATFORMS = [
    { name: 'NetCE',              url: 'https://www.netce.com',         slug: 'netce',   desc: 'Online continuing education courses' },
    { name: 'CEUfast',            url: 'https://www.ceufast.com',       slug: 'ceufast', desc: 'Online CEU courses' },
    { name: 'AANP Cert',          url: 'https://www.aanpcert.org',      slug: 'aanp',    desc: 'NP certification & CE tracking' },
    { name: 'AANP',               url: 'https://account.aanp.org',      slug: 'aanp2',   desc: 'AANP member account' },
    { name: 'ExclamationCE',      url: 'https://exclamationce.com',     slug: 'excl',    desc: 'CE courses platform' },
    { name: 'Nursing CE Central', url: 'https://nursingcecentral.com',  slug: 'ncc',     desc: 'Nursing CE courses' },
  ];
  const platformStats = {};
  for (const pr of platformData) {
    if (!platformStats[pr.platform]) platformStats[pr.platform] = { providers: [], totalHours: 0 };
    platformStats[pr.platform].providers.push(pr.providerName);
    if (pr.status === 'success' && pr.hoursEarned) platformStats[pr.platform].totalHours += pr.hoursEarned;
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

  // ── Login errors from run results ─────────────────────────────────────
  const loginErrors = (runResults || []).filter(r => r.status === 'login_error' || r.status === 'failed');

  // ── Chart data (for embedded bar chart) ─────────────────────────────────
  const chartData = { labels: [], completed: [], required: [], colors: [] };
  for (const rec of flat) {
    const sameProvider = flat.filter(r => r.providerName === rec.providerName);
    const label = sameProvider.length > 1
      ? `${rec.providerName} (${rec.state || '?'})` : (rec.providerName || 'Unknown');
    chartData.labels.push(label);
    chartData.completed.push(rec.hoursCompleted ?? 0);
    chartData.required.push(rec.hoursRequired ?? 0);
    const st = getS(rec);
    chartData.colors.push(
      st === 'Complete'     ? 'rgba(22,163,74,0.8)'
    : st === 'At Risk'     ? 'rgba(220,38,38,0.8)'
    : st === 'In Progress' ? 'rgba(217,119,6,0.8)'
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
  for (const [name, info] of Object.entries(providerMap)) {
    const worstStatus = info.licenses.some(l => getS(l) === 'At Risk') ? 'At Risk'
                      : info.licenses.some(l => getS(l) === 'In Progress') ? 'In Progress'
                      : info.licenses.every(l => getS(l) === 'Complete') ? 'Complete'
                      : 'Unknown';
    const earliestDeadline = Math.min(...info.licenses.map(l => daysUntil(parseDate(l.renewalDeadline)) ?? 9999));
    const hoursNeeded = info.licenses.reduce((sum, l) => sum + (l.hoursRemaining || 0), 0);

    if (worstStatus === 'At Risk') {
      actionItems.critical.push({ name, info, deadline: earliestDeadline, hoursNeeded, reason: 'At Risk - CE requirements behind schedule' });
    } else if (earliestDeadline >= 0 && earliestDeadline <= 30 && worstStatus !== 'Complete') {
      actionItems.urgent.push({ name, info, deadline: earliestDeadline, hoursNeeded, reason: 'Deadline within 30 days' });
    } else if (earliestDeadline > 30 && earliestDeadline <= 60 && worstStatus !== 'Complete') {
      actionItems.warning.push({ name, info, deadline: earliestDeadline, hoursNeeded, reason: 'Deadline within 60 days' });
    }
  }
  // Add missing credentials to info
  for (const p of noCredentialsProviders) {
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
    const ovCls   = { Complete:'status-complete','In Progress':'status-progress','At Risk':'status-risk',Unknown:'status-unknown' }[worstSt] || 'status-unknown';
    const ovLabel = { Complete:'✓ Complete','In Progress':'◷ In Progress','At Risk':'⚠ At Risk',Unknown:'— Unknown' }[worstSt] || worstSt;

    const licCards = info.licenses.map(lic => {
      const st      = getS(lic);
      const pct     = lic.hoursRequired > 0 ? Math.min(100, Math.round(((lic.hoursCompleted || 0) / lic.hoursRequired) * 100)) : 0;
      const barCls  = pct >= 100 ? '' : pct >= 50 ? 'partial' : 'low';
      const dlCls   = { Complete:'dl-complete','In Progress':'dl-progress','At Risk':'dl-risk',Unknown:'' }[st] || '';
      const stCls   = { Complete:'status-complete','In Progress':'status-progress','At Risk':'status-risk',Unknown:'status-unknown' }[st] || 'status-unknown';
      const stLabel = { Complete:'✓ Complete','In Progress':'◷ In Progress','At Risk':'⚠ At Risk',Unknown:'— Unknown' }[st] || st;
      const licState = lic.state || '??';
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
      const courses = lic.completedCourses || [];
      const completedSection = courses.length > 0
        ? `<div class="drawer-section">
            <div class="drawer-section-title">Completed Courses (${courses.length})</div>
            <div class="course-list">
              ${courses.map(c => `
                <div class="course-item">
                  <span class="course-item-name${c.name ? '' : ' unnamed'}">${escHtml(c.name || 'Course name unavailable')}</span>
                  <div class="course-item-meta">
                    ${c.date ? `<span class="course-item-date">${escHtml(c.date)}</span>` : ''}
                    <span class="course-item-hours">${c.hours} hr${c.hours !== 1 ? 's' : ''}</span>
                  </div>
                </div>`).join('')}
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
          <span class="detail-prog-label">${lic.hoursCompleted ?? '?'} / ${lic.hoursRequired ?? '?'} hrs (${pct}%)</span>
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

    drawerHtmlMap[pName] = `<div class="detail-hdr">
      <div class="detail-avatar" style="background:${
        worstSt === 'Complete'    ? '#0d9488'
      : worstSt === 'In Progress' ? '#d97706'
      : worstSt === 'At Risk'     ? '#dc2626'
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
    ${platformSection}`;
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
      return { reason: 'Login Failed', detail: failedLogin.error || 'CE Broker login error', icon: '⚠', cls: 'unknown-error' };
    }
    // Check if no CE Broker credentials
    if (noCEBrokerList.includes(providerName)) {
      const hasPlatform = withPlatforms.has(providerName);
      if (hasPlatform) {
        return { reason: 'No CE Broker', detail: 'Platform data only', icon: '○', cls: 'unknown-partial' };
      }
      return { reason: 'No Credentials', detail: 'No CE Broker or platform logins', icon: '○', cls: 'unknown-none' };
    }
    return { reason: 'Unknown', detail: 'Data unavailable', icon: '—', cls: 'unknown-default' };
  };

  // ── Helper to build a single provider card ───────────────────────────────
  const buildProviderCard = ([name, info]) => {
    const licBadges = info.licenses.map(lic => {
      const status    = getS(lic);
      const state     = lic.state || '??';
      const deadline  = lic.renewalDeadline || '—';
      const days      = daysUntil(parseDate(lic.renewalDeadline));
      const daysStr   = days !== null
        ? (days < 0 ? `<span class="overdue">${Math.abs(days)}d overdue</span>`
          : days <= 60 ? `<span class="urgent">${days}d left</span>`
          : `${days}d left`)
        : '';

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
      const barCls = pct >= 100 ? '' : pct >= 50 ? 'partial' : 'low';

      const courseUrl = courseSearchUrl(state, lic.licenseType || info.type);

      return `<div class="lic-block ${badgeCls}">
        <div class="lic-header">
          <span class="lic-dot ${dotCls}"></span>
          <strong>${escHtml(state)}</strong>
          <span class="lic-type">${escHtml(lic.licenseType || info.type || '')}</span>
          <span class="lic-status-text">${escHtml(status)}</span>
        </div>
        <div class="lic-deadline">Renewal: ${escHtml(deadline)} ${daysStr}</div>
        <div class="lic-bar-row">
          <div class="bar-track"><div class="bar-fill ${barCls}" style="width:${pct}%"></div></div>
          <span class="bar-label">${lic.hoursCompleted ?? '?'} / ${lic.hoursRequired ?? '?'} hrs</span>
        </div>
        ${courseUrl ? `<a class="lic-course-link" href="${courseUrl}" target="_blank" rel="noopener">Search Courses ↗</a>` : ''}
      </div>`;
    }).join('');

    // Overall worst status for card border
    const worstStatus = info.licenses.some(l => getS(l) === 'At Risk')      ? 'At Risk'
                      : info.licenses.some(l => getS(l) === 'In Progress')  ? 'In Progress'
                      : info.licenses.every(l => getS(l) === 'Complete')    ? 'Complete'
                      : 'Unknown';

    // Get specific reason for Unknown status
    const unknownInfo = worstStatus === 'Unknown' ? getUnknownReason(name) : null;

    // Earliest deadline (for sorting)
    const earliestDeadline = Math.min(...info.licenses.map(l => daysUntil(parseDate(l.renewalDeadline)) ?? 9999));
    const cardBorderCls = {
      Complete:      'card-ok',
      'In Progress': 'card-prog',
      'At Risk':     'card-risk',
      Unknown:       unknownInfo?.cls === 'unknown-error' ? 'card-error' : 'card-unk',
    }[worstStatus] || 'card-unk';

    const initials = name.split(/[\s,]+/).filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('');

    const statesList = info.licenses.map(l => l.state).filter(Boolean).join(',');

    // State chips — one per license
    const stateChips = info.licenses.map(lic => {
      const st  = getS(lic);
      const cls = { Complete: 'sc-green', 'In Progress': 'sc-yellow', 'At Risk': 'sc-red', Unknown: 'sc-gray' }[st] || 'sc-gray';
      return `<span class="card-state-chip ${cls}">${escHtml(lic.state || '?')} ${escHtml(lic.licenseType || info.type || '')}</span>`;
    }).join('');

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

    // Unknown reason banner
    const unknownBanner = unknownInfo ? `
      <div class="unknown-reason ${unknownInfo.cls}">
        <span class="unknown-icon">${unknownInfo.icon}</span>
        <span class="unknown-text"><strong>${escHtml(unknownInfo.reason)}</strong> — ${escHtml(unknownInfo.detail)}</span>
      </div>` : '';

    return `<div class="provider-card ${cardBorderCls} card-clickable"
        data-provider="${escHtml(name)}"
        data-status="${worstStatus}"
        data-states="${escHtml(statesList)}"
        data-deadline="${earliestDeadline}"
        data-type="${escHtml(info.type || '')}"
        data-no-creds="${noCredentialsProviders.includes(name) || noCEBrokerList.includes(name)}"
        onclick="openProvider(this.dataset.provider)">
      ${unknownBanner}
      <div class="card-top">
        <button class="fav-btn" onclick="event.stopPropagation(); toggleFavorite('${escHtml(name).replace(/'/g, '&#39;')}')" title="Pin to favorites">☆</button>
        <div class="avatar" style="background:${
        worstStatus === 'Complete'    ? '#0d9488'
      : worstStatus === 'In Progress' ? '#d97706'
      : worstStatus === 'At Risk'     ? '#dc2626'
      : unknownInfo?.cls === 'unknown-error' ? '#b91c1c'
      :                                  '#64748b'
      }">${escHtml(initials)}</div>
        <div class="card-info">
          <div class="card-name">${escHtml(name)}</div>
          <div class="card-states">${stateChips}</div>
        </div>
        <div class="card-lic-count">${info.licenses.length} license${info.licenses.length !== 1 ? 's' : ''} <span class="card-arrow">›</span></div>
      </div>
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

  // ── Timeline Data Generation ──────────────────────────────────────────────
  const timelineData = [];
  for (const [name, info] of providerEntries) {
    const providerTimeline = {
      name,
      type: info.type,
      courses: [],
      deadlines: []
    };
    for (const lic of info.licenses) {
      // Add deadline
      if (lic.renewalDeadline) {
        const dlDate = parseDate(lic.renewalDeadline);
        if (dlDate) {
          providerTimeline.deadlines.push({
            date: dlDate.toISOString().split('T')[0],
            state: lic.state,
            licenseType: lic.licenseType || info.type
          });
        }
      }
      // Add courses
      for (const course of (lic.completedCourses || [])) {
        if (course.date) {
          // Parse course date (format varies: "MM/DD/YYYY" or "YYYY-MM-DD")
          let courseDate = parseDate(course.date);
          if (courseDate) {
            providerTimeline.courses.push({
              date: courseDate.toISOString().split('T')[0],
              name: course.name || 'Course',
              hours: course.hours || 0,
              state: lic.state
            });
          }
        }
      }
    }
    // Only add providers with activity
    if (providerTimeline.courses.length > 0 || providerTimeline.deadlines.length > 0) {
      timelineData.push(providerTimeline);
    }
  }
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
    <td>${r.error ? `<span style="color:#dc2626;font-size:0.8rem">${escHtml(r.error)}</span>` : '<span style="color:#94a3b8">—</span>'}</td>
  </tr>`).join('');

  // ── HTML ─────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CEU Tracker</title>
  <style>
    /* ─ CSS Variables (Theme System) ─ */
    :root {
      --bg-body: #f0f4f2;
      --bg-primary: #ffffff;
      --bg-secondary: #f8fafc;
      --bg-tertiary: #f1f5f9;
      --bg-header: #0f172a;
      --text-primary: #0f172a;
      --text-secondary: #64748b;
      --text-on-dark: #ffffff;
      --text-accent: #5eead4;
      --border-color: #e2e8f0;
      --border-dark: #475569;
      --accent-blue: #1d4ed8;
      --accent-blue-hover: #1e40af;
      --status-green: #16a34a;
      --status-green-bg: #dcfce7;
      --status-orange: #d97706;
      --status-orange-bg: #fef3c7;
      --status-red: #dc2626;
      --status-red-bg: #fee2e2;
      --shadow-sm: 0 2px 8px rgba(0,0,0,.06);
      --shadow-md: 0 4px 12px rgba(0,0,0,.1);
      --shadow-header: 0 4px 20px rgba(0,0,0,.5);
    }

    [data-theme="dark"] {
      --bg-body: #0f172a;
      --bg-primary: #1e293b;
      --bg-secondary: #334155;
      --bg-tertiary: #475569;
      --bg-header: #020617;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-on-dark: #ffffff;
      --border-color: #475569;
      --border-dark: #64748b;
      --status-green-bg: #14532d;
      --status-orange-bg: #78350f;
      --status-red-bg: #7f1d1d;
      --shadow-sm: 0 2px 8px rgba(0,0,0,.3);
      --shadow-md: 0 4px 12px rgba(0,0,0,.4);
      --shadow-header: 0 4px 20px rgba(0,0,0,.7);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-body); color: var(--text-primary); min-height: 100vh; transition: background-color 0.3s, color 0.3s; }

    /* ─ Header ─ */
    header {
      background-color: var(--bg-header);
      background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 18px,
        rgba(255,255,255,0.03) 18px,
        rgba(255,255,255,0.03) 36px
      );
      color: var(--text-on-dark);
      padding: 20px 40px;
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
    header.scrolled { box-shadow: 0 4px 24px rgba(0,0,0,.6); }
    .header-brand { display: flex; align-items: center; gap: 16px; }
    .header-logo  { height: 38px; width: auto; display: block; }
    .header-divider {
      width: 1px; height: 32px; background: rgba(255,255,255,0.3); flex-shrink: 0;
    }
    header h1 { font-size: 1.4rem; font-weight: 700; }
    header h1 span { color: var(--text-accent); }
    .header-meta { text-align: right; display: flex; align-items: center; gap: 16px; }
    .last-scraped-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1px; color: var(--text-secondary); }
    .last-scraped-value { font-size: 0.95rem; color: #e2e8f0; font-weight: 500; margin-top: 2px; }
    .last-scraped-ago { font-size: 0.72rem; color: var(--text-accent); margin-top: 1px; }
    .theme-toggle { background: rgba(255,255,255,0.1); border: none; padding: 8px 12px; border-radius: 8px; color: var(--text-on-dark); cursor: pointer; font-size: 1.1rem; transition: background 0.2s; }
    .theme-toggle:hover { background: rgba(255,255,255,0.2); }
    .run-badge { margin-top: 6px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .run-pill { padding: 3px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .run-pill.ok   { background: #166534; color: #dcfce7; }
    .run-pill.notconfig { background: #475569; color: #e2e8f0; }
    .run-pill.fail { background: #7f1d1d; color: #fee2e2; }

    /* ─ Stat cards ─ */
    .stats { display: flex; gap: 14px; padding: 28px 40px 0; flex-wrap: wrap; }
    .stat-card { background: var(--bg-primary); border-radius: 12px; padding: 18px 22px; min-width: 130px; box-shadow: var(--shadow-sm); border-top: 4px solid var(--border-color); }
    .stat-card .num { font-size: 2.4rem; font-weight: 800; line-height: 1; }
    .stat-card .lbl { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .8px; color: var(--text-secondary); margin-top: 6px; }
    .stat-card.total { border-top-color: #6366f1; }
    .stat-card.total .num { color: #4f46e5; }
    .stat-card.ok    { border-top-color: var(--status-green); }
    .stat-card.ok    .num { color: #15803d; }
    .stat-card.prog  { border-top-color: #d97706; }
    .stat-card.prog  .num { color: #b45309; }
    .stat-card.risk  { border-top-color: #dc2626; }
    .stat-card.risk  .num { color: #b91c1c; }

    /* ─ Section titles ─ */
    .section-title {
      padding: 28px 40px 12px;
      font-size: 1.1rem;
      font-weight: 800;
      color: #0f172a;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-title::before {
      content: '';
      width: 4px;
      height: 1.1em;
      background: #0d9488;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e2e8f0;
    }

    /* ─ Provider cards ─ */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 18px;
      padding: 0 40px;
    }
    .provider-card {
      background: var(--bg-primary);
      border-radius: 14px;
      padding: 20px;
      box-shadow: var(--shadow-sm);
      border-left: 5px solid var(--border-color);
      transition: box-shadow .15s, transform .15s, background-color .3s;
    }
    .provider-card:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
    .provider-card.card-ok   { border-left-color: var(--status-green); }
    .provider-card.card-prog { border-left-color: var(--status-orange); }
    .provider-card.card-risk { border-left-color: var(--status-red); }
    .provider-card.card-unk  { border-left-color: #93c5fd; }
    .provider-card.card-error { border-left-color: #f87171; }

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

    .card-top { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .avatar {
      width: 42px; height: 42px; border-radius: 50%;
      background: #64748b; color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.9rem; font-weight: 700; flex-shrink: 0;
    }
    .card-info { flex: 1; min-width: 0; }
    .card-name { font-weight: 800; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #0f172a; }
    .card-type { font-size: 0.78rem; color: #64748b; margin-top: 2px; }
    .card-lic-count { font-size: 0.75rem; color: #94a3b8; white-space: nowrap; }

    /* ─ License blocks inside a card ─ */
    .lic-blocks { display: flex; flex-direction: column; gap: 10px; }
    .lic-block {
      border-radius: 10px;
      padding: 12px 14px;
      border: 1.5px solid #e2e8f0;
      background: #f8fafc;
    }
    .lic-block.lic-complete  { border-color: #bbf7d0; background: #f0fdf4; }
    .lic-block.lic-progress  { border-color: #fde68a; background: #fffbeb; }
    .lic-block.lic-risk      { border-color: #fecaca; background: #fff5f5; }

    .lic-header { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .lic-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .dot-green  { background: #16a34a; }
    .dot-yellow { background: #d97706; }
    .dot-red    { background: #dc2626; }
    .dot-gray   { background: #94a3b8; }
    .lic-header strong { font-size: 0.9rem; }
    .lic-type   { font-size: 0.72rem; color: #64748b; background: #e2e8f0; padding: 1px 7px; border-radius: 99px; }
    .lic-status-text { margin-left: auto; font-size: 0.75rem; color: #475569; font-weight: 500; }

    .lic-deadline { font-size: 0.78rem; color: #475569; margin-bottom: 7px; }
    .overdue  { color: #dc2626; font-weight: 700; }
    .urgent   { color: #d97706; font-weight: 600; }

    .lic-bar-row { display: flex; align-items: center; gap: 8px; }
    .bar-track { flex: 1; height: 7px; background: #e2e8f0; border-radius: 99px; overflow: hidden; }
    .bar-fill  { height: 100%; border-radius: 99px; background: #16a34a; transition: width .4s; }
    .bar-fill.partial { background: #d97706; }
    .bar-fill.low     { background: #dc2626; }
    .bar-label { font-size: 0.75rem; color: #64748b; white-space: nowrap; }

    .lic-course-link {
      display: inline-block;
      margin-top: 8px;
      font-size: 0.75rem;
      color: #1d4ed8;
      text-decoration: none;
      font-weight: 500;
    }
    .lic-course-link:hover { text-decoration: underline; }

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

    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 99px; font-size: .75rem; font-weight: 700; white-space: nowrap; }
    .status-complete { background: #bbf7d0; color: #14532d; }
    .status-progress { background: #fde68a; color: #92400e; }
    .status-risk     { background: #fca5a5; color: #7f1d1d; }
    .status-pending  { background: #cbd5e1; color: #334155; }
    .status-unknown  { background: #e2e8f0; color: #475569; }

    .data-table { width: 100%; border-collapse: collapse; margin: 0 40px 40px; max-width: calc(100% - 80px); font-size: 0.84rem; }
    .data-table th, .data-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    .data-table th { background: #f8fafc; color: #475569; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .data-table th:hover { background: #f1f5f9; }
    .data-table tbody tr:hover { background: #f8fafc; }
    .data-table code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.82rem; }
    .notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #64748b; font-size: 0.8rem; }

    .status-pill { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: .72rem; font-weight: 600; }
    .status-pill.complete { background: #dcfce7; color: #15803d; }
    .status-pill.warning { background: #fef3c7; color: #b45309; }
    .status-pill.at-risk { background: #fee2e2; color: #b91c1c; }
    .status-pill.expired { background: #e5e7eb; color: #374151; }
    .status-pill.in-progress { background: #dbeafe; color: #1d4ed8; }

    .section-subtitle { font-size: 1.1rem; font-weight: 600; color: #1e293b; padding: 0 40px 16px; }

    .course-link { display: inline-block; padding: 4px 10px; background: #eff6ff; color: #1d4ed8; border-radius: 6px; font-size: .76rem; text-decoration: none; font-weight: 500; }
    .course-link:hover { background: #dbeafe; }
    .toggle-btn { display: inline-block; margin-left: 6px; padding: 3px 8px; background: #f1f5f9; color: #475569; border: none; border-radius: 6px; font-size: .73rem; cursor: pointer; }
    .toggle-btn:hover { background: #e2e8f0; }

    .detail-group.hidden { display: none; }
    .detail-row td { background: #f8fafc; color: #475569; font-size: .8rem; }
    .sa-indent { padding-left: 40px !important; font-style: italic; }
    .sa-badge  { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: .7rem; font-weight: 600; }
    .sa-ok   { background: #dcfce7; color: #15803d; }
    .sa-prog { background: #fef3c7; color: #b45309; }
    .sa-risk { background: #fee2e2; color: #b91c1c; }
    .sa-unk  { background: #f1f5f9; color: #64748b; }

    tr.hidden-row { display: none; }

    /* ─ Run log table ─ */
    .run-table-wrap { padding: 0 40px 40px; overflow-x: auto; }
    .run-table-wrap table { font-size: 0.84rem; }

    /* ─ Footer ─ */
    footer { text-align: center; padding: 16px; font-size: .76rem; color: var(--text-secondary); border-top: 1px solid var(--border-color); margin-top: 8px; background: var(--bg-primary); }

    /* ─ Sidebar Navigation ─ */
    .app-layout { display: flex; min-height: calc(100vh - 82px); }
    .sidebar {
      position: fixed;
      top: 82px;
      left: 0;
      width: 220px;
      height: calc(100vh - 82px);
      background: var(--bg-primary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      z-index: 90;
      transition: transform 0.3s ease;
    }
    .sidebar-nav { flex: 1; padding: 16px 8px; overflow-y: auto; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 12px 16px;
      border: none;
      border-radius: 8px;
      background: none;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--text-secondary);
      text-align: left;
      transition: all 0.15s;
      margin-bottom: 4px;
    }
    .nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
    .nav-item.active { background: var(--accent-blue); color: #fff; }
    .nav-icon { font-size: 1.1rem; width: 24px; text-align: center; }
    .nav-label { flex: 1; }
    .nav-badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,.1); }
    .nav-item.active .nav-badge { background: rgba(255,255,255,.2); }
    .nav-badge.warn { background: var(--status-red); color: #fff; }
    .sidebar-footer { padding: 16px; border-top: 1px solid var(--border-color); }
    .sidebar-stats { display: flex; gap: 12px; }
    .sidebar-stat { flex: 1; text-align: center; padding: 8px; background: var(--bg-secondary); border-radius: 8px; }
    .sidebar-stat.warn { background: var(--status-red-bg); }
    .sidebar-stat-num { display: block; font-size: 1.2rem; font-weight: 700; color: var(--text-primary); }
    .sidebar-stat.warn .sidebar-stat-num { color: var(--status-red); }
    .sidebar-stat-label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; }
    .main-content { flex: 1; margin-left: 220px; min-width: 0; }
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
      .main-content { margin-left: 0; }
      .sidebar-toggle { display: flex; align-items: center; justify-content: center; }
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
      border-bottom-color: #0d9488;
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
    .fav-btn { position: absolute; top: 8px; right: 8px; background: none; border: none; font-size: 1.2rem; color: #cbd5e1; cursor: pointer; padding: 4px; z-index: 10; transition: color 0.2s, transform 0.2s; }
    .fav-btn:hover { color: #f59e0b; transform: scale(1.2); }
    .fav-btn.favorited { color: #f59e0b; }
    .fav-btn.favorited::after { content: '★'; position: absolute; top: 4px; left: 4px; }
    .fav-btn.favorited { color: transparent; }
    .provider-card { position: relative; }
    /* ─ Stats Cards ─ */
    .stats-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 0 40px 24px; }
    .stat-card { background: #fff; border-radius: 14px; padding: 20px 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); position: relative; overflow: hidden; }
    .stat-number { font-size: 2.5rem; font-weight: 800; line-height: 1; }
    .stat-label { font-size: 0.85rem; font-weight: 600; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-icon { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); font-size: 2.5rem; opacity: 0.15; }
    .stat-at-risk { border-left: 4px solid #dc2626; }
    .stat-at-risk .stat-number, .stat-at-risk .stat-label { color: #dc2626; }
    .stat-in-progress { border-left: 4px solid #d97706; }
    .stat-in-progress .stat-number, .stat-in-progress .stat-label { color: #d97706; }
    .stat-complete { border-left: 4px solid #16a34a; }
    .stat-complete .stat-number, .stat-complete .stat-label { color: #16a34a; }
    .stat-no-creds { border-left: 4px solid #6b7280; }
    .stat-no-creds .stat-number, .stat-no-creds .stat-label { color: #6b7280; }

    /* ─ New Dashboard Tab ─ */
    .dashboard-stats-row { display: flex; gap: 16px; padding: 24px 40px 16px; flex-wrap: wrap; }
    .dash-stat-card { display: flex; align-items: center; gap: 12px; background: #fff; border-radius: 12px; padding: 14px 20px; box-shadow: 0 2px 8px rgba(0,0,0,.06); flex: 1; min-width: 140px; }
    .dash-stat-icon { font-size: 1.5rem; opacity: 0.9; }
    .dash-stat-content { display: flex; flex-direction: column; }
    .dash-stat-num { font-size: 1.8rem; font-weight: 800; line-height: 1; }
    .dash-stat-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8; }
    .dash-stat-risk { background: linear-gradient(135deg, #fef2f2, #fff); border-left: 4px solid #dc2626; }
    .dash-stat-risk .dash-stat-num, .dash-stat-risk .dash-stat-label { color: #dc2626; }
    .dash-stat-warning { background: linear-gradient(135deg, #fffbeb, #fff); border-left: 4px solid #d97706; }
    .dash-stat-warning .dash-stat-num, .dash-stat-warning .dash-stat-label { color: #d97706; }
    .dash-stat-complete { background: linear-gradient(135deg, #f0fdf4, #fff); border-left: 4px solid #16a34a; }
    .dash-stat-complete .dash-stat-num, .dash-stat-complete .dash-stat-label { color: #16a34a; }
    .dash-stat-unknown { background: linear-gradient(135deg, #f8fafc, #fff); border-left: 4px solid #64748b; }
    .dash-stat-unknown .dash-stat-num, .dash-stat-unknown .dash-stat-label { color: #64748b; }

    .dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 0 40px 24px; }
    @media (max-width: 900px) { .dashboard-grid { grid-template-columns: 1fr; } }
    .dashboard-actions, .dashboard-deadlines { background: #fff; border-radius: 14px; padding: 20px 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .dash-section-header { font-size: 0.9rem; font-weight: 700; color: #1e293b; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
    .dash-action-list { display: flex; flex-direction: column; gap: 10px; }
    .dash-action-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 10px; cursor: pointer; transition: all .15s; }
    .dash-action-item:hover { transform: translateX(4px); }
    .dash-action-icon { font-size: 1.1rem; width: 24px; text-align: center; }
    .dash-action-text { flex: 1; font-size: 0.88rem; color: #334155; }
    .dash-action-text strong { font-weight: 700; }
    .dash-action-arrow { color: #94a3b8; font-size: 0.9rem; }
    .dash-action-critical { background: #fef2f2; border-left: 3px solid #dc2626; }
    .dash-action-critical:hover { background: #fee2e2; }
    .dash-action-warning { background: #fffbeb; border-left: 3px solid #d97706; }
    .dash-action-warning:hover { background: #fef3c7; }
    .dash-action-info { background: #f8fafc; border-left: 3px solid #64748b; }
    .dash-action-info:hover { background: #f1f5f9; }
    .dash-action-pending { background: #eff6ff; border-left: 3px solid #3b82f6; }
    .dash-action-pending:hover { background: #dbeafe; }
    .dash-action-error { background: #fef2f2; border-left: 3px solid #dc2626; }
    .dash-action-error:hover { background: #fee2e2; }
    .dash-action-empty { display: flex; align-items: center; gap: 12px; padding: 16px; color: #16a34a; font-size: 0.9rem; }

    .dash-deadline-summary { display: flex; gap: 12px; margin-bottom: 16px; }
    .dash-deadline-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #f8fafc; border-radius: 8px; cursor: pointer; transition: all .15s; flex: 1; }
    .dash-deadline-row:hover { background: #f1f5f9; }
    .dash-deadline-row.has-items { background: #fffbeb; }
    .dash-dl-badge { padding: 3px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; }
    .dash-dl-badge.urgent { background: #dc2626; color: #fff; }
    .dash-dl-badge.soon { background: #d97706; color: #fff; }
    .dash-dl-badge.upcoming { background: #3b82f6; color: #fff; }
    .dash-dl-count { font-size: 1.2rem; font-weight: 800; color: #1e293b; }
    .dash-dl-label { font-size: 0.75rem; color: #64748b; }
    .dash-deadline-preview { border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 4px; }
    .dash-preview-title { font-size: 0.75rem; font-weight: 600; color: #64748b; margin-bottom: 8px; text-transform: uppercase; }
    .dash-preview-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 0.85rem; }
    .dash-preview-name { flex: 1; color: #334155; font-weight: 500; }
    .dash-preview-state { color: #64748b; font-size: 0.78rem; }
    .dash-preview-days { font-weight: 700; font-size: 0.8rem; }
    .dash-preview-item.di-risk .dash-preview-days { color: #dc2626; }
    .dash-preview-item.di-progress .dash-preview-days { color: #d97706; }
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
    .run-fail { color: #dc2626; }

    /* ─ Providers Filter Bar ─ */
    .providers-filter-bar { display: flex; gap: 12px; padding: 20px 40px 12px; flex-wrap: wrap; align-items: center; position: sticky; top: 82px; z-index: 50; background: var(--bg-body); border-bottom: 1px solid var(--border-color); }
    .providers-filter-bar .search-box { flex: 1; min-width: 200px; background: var(--bg-primary); color: var(--text-primary); border-color: var(--border-color); }
    .providers-filter-bar .filter-select { min-width: 120px; background: var(--bg-primary); color: var(--text-primary); border-color: var(--border-color); }
    .advanced-filter-toggle { padding: 8px 14px; border: 2px solid var(--border-color); border-radius: 8px; background: var(--bg-primary); cursor: pointer; font-size: 0.82rem; font-weight: 600; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; transition: all .15s; }
    .advanced-filter-toggle:hover { border-color: var(--accent-blue); color: var(--accent-blue); }
    .advanced-filter-toggle.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
    .toggle-icon { font-size: 0.7rem; transition: transform 0.2s; }
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
    .providers-count { display: flex; justify-content: space-between; align-items: center; padding: 0 40px 16px; font-size: 0.85rem; color: var(--text-secondary); }

    /* ─ View Toggle Buttons ─ */
    .view-toggle-bar { display: flex; gap: 8px; padding: 20px 40px 0; flex-wrap: wrap; }
    .view-toggle { padding: 8px 16px; border: 2px solid var(--border-color); border-radius: 8px; background: var(--bg-primary); cursor: pointer; font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); transition: all .15s; display: flex; align-items: center; gap: 8px; }
    .view-toggle:hover { border-color: var(--border-dark); color: var(--text-primary); }
    .view-toggle.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
    .view-count { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,.1); }
    .view-toggle.active .view-count { background: rgba(255,255,255,.2); }
    .view-count.warning { background: var(--status-orange); color: #fff; }

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
    .poc-ce-broker  { border-top-color: #0d9488; border-left-color: #0d9488; }
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
    .cov-none { color: #dc2626; font-weight: 700; }
    .cov-pending { color: #d97706; }
    .cov-row-none { background: #fef2f2; }
    .coverage-matrix { border-collapse: separate; border-spacing: 0; }
    .matrix-legend { display: flex; gap: 20px; margin-bottom: 12px; padding-left: 4px; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #64748b; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
    .legend-dot.dot-green { background: #16a34a; }
    .legend-dot.dot-gray { background: #cbd5e1; }
    .legend-dot.dot-red { background: #dc2626; }

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
    .action-critical .action-icon, .action-critical .action-title { color: #dc2626; }
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
    .tab-badge { background: #dc2626; color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 10px; margin-left: 6px; }
    .tab-badge-sm { background: #64748b; color: #fff; font-size: 0.65rem; font-weight: 600; padding: 1px 5px; border-radius: 8px; margin-left: 4px; }
    /* ─ Needs Attention tab ─ */
    .deadlines-container { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 0 40px 24px; }
    .deadline-group { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.06); overflow: hidden; }
    .deadline-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #e2e8f0; }
    .deadline-badge { font-size: 0.8rem; font-weight: 700; padding: 4px 10px; border-radius: 12px; }
    .deadline-badge.urgent { background: #fee2e2; color: #dc2626; }
    .deadline-badge.soon { background: #fef3c7; color: #d97706; }
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
    .di-risk .di-days { color: #dc2626; }
    .di-complete { background: #f0fdf4; }
    .di-complete .di-days { color: #16a34a; }
    .di-progress { background: #fffbeb; }
    .di-progress .di-days { color: #d97706; }
    .deadline-empty { padding: 24px 18px; text-align: center; color: #94a3b8; font-size: 0.85rem; }
    .login-errors-box { margin: 0 40px 24px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 18px 24px; }
    .error-desc { font-size: 0.85rem; color: #991b1b; margin-bottom: 14px; }
    .error-list { display: flex; flex-direction: column; gap: 8px; }
    .error-item { display: flex; justify-content: space-between; align-items: center; background: #fff; border-radius: 8px; padding: 10px 14px; }
    .error-name { font-weight: 600; color: #1e293b; }
    .error-msg { font-size: 0.8rem; color: #dc2626; max-width: 50%; text-align: right; }
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
    .card-plat-tags { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 12px 4px; border-top: 1px solid #f1f5f9; }
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
    .detail-prog-fill.partial { background: #d97706; }
    .detail-prog-fill.low     { background: #dc2626; }
    .detail-prog-label { font-size: 0.82rem; color: #475569; white-space: nowrap; font-weight: 600; }

    .detail-sa-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 12px; }
    .detail-sa-table th { background: #f1f5f9; color: #64748b; font-weight: 600; padding: 6px 10px; text-align: left; font-size: 0.72rem; text-transform: uppercase; }
    .detail-sa-table td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; color: #334155; }
    .detail-sa-table tr:last-child td { border-bottom: none; }
    .sa-done  { color: #15803d; font-weight: 600; }
    .sa-short { color: #b91c1c; font-weight: 600; }

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
    .need-hours  { font-size: 0.78rem; color: #b91c1c; white-space: nowrap; }
    .need-search {
      font-size: 0.75rem; padding: 3px 10px; background: #fee2e2;
      color: #b91c1c; border-radius: 6px; text-decoration: none; font-weight: 600;
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
    .platform-card.plat-netce   .platform-card-hdr { background: #0d9488; }
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
    .lb-status.lb-partial { color: #d97706; }
    .lb-status.lb-none { color: #dc2626; }

    /* ─ Platform Coverage Tab ─ */
    .platform-view { display: none; padding: 20px 0; }
    .platform-view.active { display: block; }

    /* Matrix legend */
    .matrix-legend { display: flex; gap: 20px; padding: 16px 40px; font-size: 0.85rem; color: #64748b; }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .legend-dot.cov-yes { background: #dcfce7; border: 1px solid #16a34a; }
    .legend-dot.cov-fail { background: #fee2e2; border: 1px solid #dc2626; }
    .legend-dot.cov-no { background: #f1f5f9; border: 1px solid #cbd5e1; }

    /* Coverage matrix table */
    .matrix-wrap { padding: 0 40px; overflow-x: auto; }
    .coverage-matrix { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .coverage-matrix th, .coverage-matrix td { padding: 12px 16px; text-align: center; border: 1px solid #e2e8f0; }
    .coverage-matrix th { background: #f8fafc; color: #475569; font-weight: 600; white-space: nowrap; }
    .coverage-matrix .cov-provider-hdr { text-align: left; }
    .coverage-matrix .cov-provider { text-align: left; font-weight: 500; cursor: pointer; color: #1d4ed8; }
    .coverage-matrix .cov-provider:hover { text-decoration: underline; }
    .coverage-matrix .cov-yes { background: #dcfce7; color: #15803d; font-weight: 600; }
    .coverage-matrix .cov-fail { background: #fee2e2; color: #b91c1c; }
    .coverage-matrix .cov-no { background: #f8fafc; color: #94a3b8; }
    .coverage-matrix tbody tr:hover { background: #f1f5f9; }
    .coverage-matrix tbody tr:hover .cov-yes { background: #bbf7d0; }
    .coverage-matrix tbody tr:hover .cov-fail { background: #fecaca; }
    .coverage-matrix tbody tr:hover .cov-no { background: #e2e8f0; }

    /* Platform summary cards */
    .platform-summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; padding: 0 40px; }
    .platform-summary-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.08); border-top: 4px solid #cbd5e1; }
    .platform-summary-card.plat-card-netce { border-top-color: #0d9488; }
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
    .plat-stat-num.plat-stat-fail { color: #dc2626; }
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
    .cred-gap-header.cred-gap-cebroker { background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); }
    .cred-gap-header.cred-gap-netce { background: linear-gradient(135deg, #d97706 0%, #92400e 100%); }
    .cred-gap-header.cred-gap-complete { background: linear-gradient(135deg, #16a34a 0%, #166534 100%); }
    .cred-gap-icon { font-size: 1.3rem; }
    .cred-gap-title { flex: 1; font-weight: 600; font-size: 0.95rem; }
    .cred-gap-count { background: rgba(255,255,255,.25); padding: 4px 12px; border-radius: 99px; font-weight: 700; font-size: 0.9rem; }
    .cred-gap-body { padding: 16px 20px; }
    .cred-gap-subtitle { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 8px; }
    .cred-gap-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .cred-gap-chip { padding: 6px 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; font-size: 0.82rem; color: #991b1b; cursor: pointer; transition: all .15s; }
    .cred-gap-chip:hover { background: #fee2e2; transform: translateY(-1px); }
    .cred-gap-chip small { color: #b91c1c; opacity: 0.7; }
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

    /* ─ Deadline Buckets ─ */
    .deadline-buckets { display: flex; flex-direction: column; gap: 24px; }
    .deadline-bucket { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.07); overflow: hidden; }
    .bucket-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
    .bucket-header.bucket-urgent { background: linear-gradient(90deg, #fef2f2 0%, #fff 100%); border-left: 4px solid #dc2626; }
    .bucket-header.bucket-warning { background: linear-gradient(90deg, #fffbeb 0%, #fff 100%); border-left: 4px solid #d97706; }
    .bucket-header.bucket-upcoming { background: linear-gradient(90deg, #f0fdf4 0%, #fff 100%); border-left: 4px solid #16a34a; }
    .bucket-badge { padding: 4px 12px; border-radius: 99px; font-size: 0.75rem; font-weight: 700; }
    .bucket-urgent .bucket-badge { background: #dc2626; color: #fff; }
    .bucket-warning .bucket-badge { background: #d97706; color: #fff; }
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
    .mini-stat.progress { background: var(--status-orange-bg); color: var(--status-orange); }
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
    .type-name { font-weight: 800; font-size: 1.1rem; color: var(--text-primary); flex: 1; }
    .type-provider-count { font-size: 0.85rem; color: var(--text-secondary); white-space: nowrap; }
    .type-cards { padding: 16px; }

    /* ─ Favorites View ─ */
    .favorites-header { padding: 16px 20px; background: var(--status-orange-bg); border-radius: 12px; margin-bottom: 20px; display: flex; align-items: center; gap: 16px; }
    .favorites-title { font-weight: 700; font-size: 1.1rem; color: var(--status-orange); }
    .favorites-hint { font-size: 0.85rem; color: var(--status-orange); opacity: 0.8; }
    .favorites-cards { padding: 0; }
    .empty-favorites { text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 1rem; background: var(--bg-secondary); border-radius: 12px; }

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
    .action-section.action-critical .action-section-header { background: #fef2f2; color: #b91c1c; border-left: 4px solid #dc2626; }
    .action-section.action-urgent .action-section-header { background: #fef3c7; color: #b45309; border-left: 4px solid #d97706; }
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
    .aanp-card.cert-warning { border-left-color: #d97706; }
    .aanp-card.cert-expired { border-left-color: #dc2626; }
    .aanp-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .aanp-provider-name { font-weight: 700; color: #0f172a; }
    .aanp-cert-status { padding: 3px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .aanp-cert-status.cert-active { background: #dcfce7; color: #166534; }
    .aanp-cert-status.cert-warning { background: #fef3c7; color: #b45309; }
    .aanp-cert-status.cert-expired { background: #fee2e2; color: #b91c1c; }
    .aanp-cert-expiry { font-size: 0.85rem; color: #475569; margin-bottom: 14px; }
    .aanp-days-left { margin-left: 6px; font-weight: 600; color: #64748b; }
    .aanp-days-left.urgent { color: #d97706; }
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
    .state-bar-segment.progress { background: #d97706; }
    .state-bar-segment.risk { background: #dc2626; }
    .state-bar-segment.unknown { background: #94a3b8; }
    .state-stat-details { display: flex; flex-wrap: wrap; gap: 8px; }
    .stat-detail { font-size: 0.78rem; padding: 2px 8px; border-radius: 99px; }
    .stat-detail.complete { background: #dcfce7; color: #166534; }
    .stat-detail.progress { background: #fef3c7; color: #b45309; }
    .stat-detail.risk { background: #fee2e2; color: #b91c1c; }
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
    .compliance-notmet .compliance-stat-num { color: #dc2626; }

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
    .comp-status.comp-partial { color: #d97706; }
    .comp-status.comp-none { color: #dc2626; }

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
        <span class="run-pill ok">✓ ${runResults.filter(r => r.status === 'success').length} succeeded</span>
        ${runResults.filter(r => r.status === 'not_configured').length > 0
          ? `<span class="run-pill notconfig">○ ${runResults.filter(r => r.status === 'not_configured').length} not configured</span>`
          : ''}
        ${runResults.filter(r => r.status === 'login_error' || r.status === 'failed').length > 0
          ? `<span class="run-pill fail">✗ ${runResults.filter(r => r.status === 'login_error' || r.status === 'failed').length} login errors</span>`
          : ''}
      </div>
    </div>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode" id="themeToggle">🌙</button>
  </div>
</header>

<!-- ── App Layout with Sidebar ─────────────────────────────────────────── -->
<div class="app-layout">
  <!-- Sidebar Navigation -->
  <aside class="sidebar" id="sidebar">
    <nav class="sidebar-nav">
      <button class="nav-item active" onclick="showTab('providers')" data-tab="providers">
        <span class="nav-icon">👥</span>
        <span class="nav-label">Team View</span>
      </button>
      <button class="nav-item" onclick="showTab('compliance')" data-tab="compliance">
        <span class="nav-icon">✓</span>
        <span class="nav-label">Compliance</span>
        ${lookbackNotMet > 0 ? `<span class="nav-badge">${lookbackNotMet}</span>` : ''}
      </button>
      <button class="nav-item" onclick="showTab('platforms')" data-tab="platforms">
        <span class="nav-icon">📚</span>
        <span class="nav-label">Platforms</span>
      </button>
      <button class="nav-item" onclick="showTab('reports')" data-tab="reports">
        <span class="nav-icon">📊</span>
        <span class="nav-label">Reports</span>
      </button>
      <button class="nav-item" onclick="showTab('dashboard')" data-tab="dashboard">
        <span class="nav-icon">📋</span>
        <span class="nav-label">Dashboard</span>
        ${(atRisk + noCredentialsProviders.length) > 0 ? `<span class="nav-badge warn">${atRisk + noCredentialsProviders.length}</span>` : ''}
      </button>
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-stats">
        <div class="sidebar-stat"><span class="sidebar-stat-num">${complete}</span><span class="sidebar-stat-label">Complete</span></div>
        <div class="sidebar-stat warn"><span class="sidebar-stat-num">${atRisk}</span><span class="sidebar-stat-label">At Risk</span></div>
      </div>
    </div>
  </aside>

  <!-- Mobile Sidebar Toggle -->
  <button class="sidebar-toggle" onclick="toggleSidebar()" id="sidebarToggle">☰</button>

  <!-- Main Content Area -->
  <main class="main-content">
    <!-- ── Stats ──────────────────────────────────────────────────────────── -->
    <div class="stats">
      <div class="stat-card total"><div class="num">${total}</div><div class="lbl">Clinical Team Members</div></div>
      <div class="stat-card ok">  <div class="num">${complete}</div><div class="lbl">Complete</div></div>
      <div class="stat-card prog"><div class="num">${inProg}</div><div class="lbl">In Progress</div></div>
      <div class="stat-card risk"><div class="num">${atRisk}</div><div class="lbl">At Risk</div></div>
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
      <div class="dash-stat-icon">✗</div>
      <div class="dash-stat-content">
        <div class="dash-stat-num">${noCredentialsProviders.length}</div>
        <div class="dash-stat-label">No Creds</div>
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
        ${noCredentialsProviders.length > 0 ? `
        <div class="dash-action-item dash-action-info" onclick="showTab('providers'); document.getElementById('noCredsFilter').checked = true; filterCards();">
          <span class="dash-action-icon">○</span>
          <span class="dash-action-text"><strong>${noCredentialsProviders.length}</strong> missing CE credentials</span>
          <span class="dash-action-arrow">→</span>
        </div>` : ''}
        ${loginErrors.length > 0 ? `
        <div class="dash-action-item dash-action-error" onclick="showTab('reports'); showReportView('runlog');">
          <span class="dash-action-icon">✗</span>
          <span class="dash-action-text"><strong>${loginErrors.length}</strong> login error${loginErrors.length !== 1 ? 's' : ''}</span>
          <span class="dash-action-arrow">→</span>
        </div>` : ''}
        ${atRisk === 0 && noCredentialsProviders.length === 0 && loginErrors.length === 0 ? `
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
          <span class="dash-preview-name">${escHtml(r.providerName?.split(',')[0] || '?')}</span>
          <span class="dash-preview-state">${escHtml(r.state || '?')}</span>
          <span class="dash-preview-days">${r.days}d</span>
        </div>`).join('')}
        ${deadlines30.length > 5 ? `<div class="dash-preview-more">+${deadlines30.length - 5} more</div>` : ''}
      </div>` : ''}
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
        <span class="run-stat-label">CE Broker</span>
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
  <!-- View Toggle Bar -->
  <div class="view-toggle-bar">
    <button class="view-toggle active" onclick="showProviderView('all')">All Providers <span class="view-count">${providerEntries.length}</span></button>
    <button class="view-toggle" onclick="showProviderView('deadline')">By Deadline <span class="view-count ${deadlineProviders30.length > 0 ? 'warning' : ''}">${deadlineProviders30.length + deadlineProviders60.length + deadlineProviders90.length}</span></button>
    <button class="view-toggle" onclick="showProviderView('state')">By State</button>
    <button class="view-toggle" onclick="showProviderView('type')">By Type</button>
    <button class="view-toggle" onclick="showProviderView('favorites')">Pinned <span class="view-count">0</span></button>
    <button class="view-toggle" onclick="showProviderView('actions')">Action Items <span class="view-count ${actionItems.critical.length > 0 ? 'warning' : ''}">${actionItems.critical.length + actionItems.urgent.length}</span></button>
    <button class="view-toggle" onclick="showProviderView('aanp')">AANP Cert <span class="view-count">${aanpCertData.length}</span></button>
    <button class="view-toggle" onclick="showProviderView('stats')">State Stats</button>
    <button class="view-toggle" onclick="showProviderView('timeline')">Timeline</button>
    <button class="export-btn" onclick="exportMissingCredentials()">Export Missing Creds</button>
    <button class="export-btn" onclick="exportFilteredResults()">Export Filtered</button>
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
        <option value="Unknown">Unknown</option>
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
      <select class="filter-select" id="cardSort" onchange="sortCards()">
        <option value="name">Sort: Name (A-Z)</option>
        <option value="name-desc">Sort: Name (Z-A)</option>
        <option value="status">Sort: Risk First</option>
        <option value="status-asc">Sort: Complete First</option>
        <option value="deadline">Sort: Deadline (Soonest)</option>
      </select>
      <label class="creds-toggle">
        <input type="checkbox" id="noCredsFilter" onchange="filterCards()">
        <span>No Creds Only</span>
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

    <!-- Provider Count -->
    <div class="providers-count">
      <span id="providerFilterCount">${providerEntries.length} of ${providerEntries.length} providers</span>
      <button class="reset-btn" onclick="resetProviderFilters()">Reset</button>
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
    <div class="type-groups">
      ${Object.entries(providersByType).filter(([type, providers]) => providers.length > 0).map(([type, typeProviders]) => {
        const typeLabel = { NP: 'Nurse Practitioners', MD: 'Physicians (MD)', DO: 'Physicians (DO)', RN: 'Registered Nurses', Other: 'Other' }[type] || type;
        return `<div class="type-group collapsible">
          <div class="type-group-header" onclick="toggleStateGroup(this)">
            <span class="collapse-icon">▼</span>
            <span class="type-name">${typeLabel}</span>
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
      <span class="favorites-hint">Click the star on any provider card to pin them here for quick access</span>
    </div>
    <div class="cards-grid favorites-cards">
      <div class="empty-favorites">No pinned providers. Click the star on any provider card to pin them here.</div>
    </div>
  </div>

  <!-- Action Items View -->
  <div class="provider-view" id="provider-actions">
    <div class="action-queue">
      <!-- Critical Actions -->
      ${actionItems.critical.length > 0 ? `
      <div class="action-section action-critical">
        <div class="action-section-header">
          <span class="action-icon">⚠</span>
          <span class="action-section-title">Critical - At Risk</span>
          <span class="action-section-count">${actionItems.critical.length}</span>
        </div>
        <div class="action-items-list">
          ${actionItems.critical.map(item => `
            <div class="action-item-card" onclick="openProvider('${escHtml(item.name).replace(/'/g, '&#39;')}')">
              <div class="action-item-name">${escHtml(item.name)}</div>
              <div class="action-item-details">
                <span class="action-detail">${item.deadline >= 0 ? item.deadline + ' days left' : Math.abs(item.deadline) + ' days overdue'}</span>
                <span class="action-detail">${item.hoursNeeded} hrs needed</span>
              </div>
              <div class="action-item-reason">${escHtml(item.reason)}</div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- Urgent Actions -->
      ${actionItems.urgent.length > 0 ? `
      <div class="action-section action-urgent">
        <div class="action-section-header">
          <span class="action-icon">◷</span>
          <span class="action-section-title">Urgent - 30 Day Deadline</span>
          <span class="action-section-count">${actionItems.urgent.length}</span>
        </div>
        <div class="action-items-list">
          ${actionItems.urgent.map(item => `
            <div class="action-item-card" onclick="openProvider('${escHtml(item.name).replace(/'/g, '&#39;')}')">
              <div class="action-item-name">${escHtml(item.name)}</div>
              <div class="action-item-details">
                <span class="action-detail">${item.deadline} days left</span>
                <span class="action-detail">${item.hoursNeeded} hrs needed</span>
              </div>
              <div class="action-item-reason">${escHtml(item.reason)}</div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- Warning Actions -->
      ${actionItems.warning.length > 0 ? `
      <div class="action-section action-warning">
        <div class="action-section-header">
          <span class="action-icon">○</span>
          <span class="action-section-title">Attention - 60 Day Deadline</span>
          <span class="action-section-count">${actionItems.warning.length}</span>
        </div>
        <div class="action-items-list">
          ${actionItems.warning.map(item => `
            <div class="action-item-card" onclick="openProvider('${escHtml(item.name).replace(/'/g, '&#39;')}')">
              <div class="action-item-name">${escHtml(item.name)}</div>
              <div class="action-item-details">
                <span class="action-detail">${item.deadline} days left</span>
                <span class="action-detail">${item.hoursNeeded} hrs needed</span>
              </div>
              <div class="action-item-reason">${escHtml(item.reason)}</div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- Info Actions -->
      ${actionItems.info.length > 0 ? `
      <div class="action-section action-info">
        <div class="action-section-header">
          <span class="action-icon">○</span>
          <span class="action-section-title">Missing Credentials</span>
          <span class="action-section-count">${actionItems.info.length}</span>
        </div>
        <div class="action-items-list">
          ${actionItems.info.map(item => `
            <div class="action-item-card" onclick="openProvider('${escHtml(item.name).replace(/'/g, '&#39;')}')">
              <div class="action-item-name">${escHtml(item.name)}</div>
              <div class="action-item-reason">${escHtml(item.reason)}</div>
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      ${actionItems.critical.length + actionItems.urgent.length + actionItems.warning.length + actionItems.info.length === 0 ? `
      <div class="empty-actions">
        <span class="empty-icon">✓</span>
        <span class="empty-text">No action items! All providers are on track.</span>
      </div>` : ''}
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
    <button class="view-toggle" onclick="showPlatformView('cards')">Platform Cards</button>
    <button class="view-toggle" onclick="showPlatformView('gaps')">Credential Gaps</button>
  </div>

  <!-- Coverage Matrix View -->
  <div class="platform-view active" id="platform-matrix">
    <div class="matrix-legend">
      <span class="legend-item"><span class="legend-dot cov-yes"></span> Connected</span>
      <span class="legend-item"><span class="legend-dot cov-fail"></span> Failed</span>
      <span class="legend-item"><span class="legend-dot cov-no"></span> Not configured</span>
    </div>
    <div class="matrix-wrap">
      <table class="coverage-matrix">
        <thead>
          <tr>
            <th class="cov-provider-hdr">Provider</th>
            <th>NetCE</th>
            <th>CEUfast</th>
            <th>AANP Cert</th>
            <th>ExclamationCE</th>
          </tr>
        </thead>
        <tbody>
          ${providerEntries.map(([name, info]) => {
            const providerPlatforms = platformByProvider[name] || [];
            const platforms = ['NetCE', 'CEUfast', 'AANP Cert', 'ExclamationCE'];
            const cells = platforms.map(plat => {
              const result = providerPlatforms.find(p => p.platform === plat);
              if (!result) return '<td class="cov-no">—</td>';
              if (result.status === 'success') {
                const hours = result.hoursEarned !== null ? result.hoursEarned + 'h' : '✓';
                return '<td class="cov-yes">' + hours + '</td>';
              }
              return '<td class="cov-fail">✗</td>';
            }).join('');
            const safeName = escHtml(name).replace(/'/g, '&#39;');
            return '<tr><td class="cov-provider" onclick="openProvider(\'' + safeName + '\')">' + escHtml(name) + '</td>' + cells + '</tr>';
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Platform Cards View -->
  <div class="platform-view" id="platform-cards">
    <div class="platform-summary-grid">
      ${['NetCE', 'CEUfast', 'AANP Cert', 'ExclamationCE'].map(plat => {
        const stats = platformStats[plat] || { providers: [], totalHours: 0 };
        const results = platformData.filter(p => p.platform === plat);
        const successCount = results.filter(r => r.status === 'success').length;
        const failCount = results.filter(r => r.status === 'failed').length;
        const providerList = [...new Set(stats.providers)].sort();
        const platSlug = plat === 'NetCE' ? 'netce' : plat === 'CEUfast' ? 'ceufast' : plat === 'AANP Cert' ? 'aanp' : 'excl';
        const platUrl = plat === 'NetCE' ? 'https://www.netce.com' : plat === 'CEUfast' ? 'https://www.ceufast.com' : plat === 'AANP Cert' ? 'https://www.aanpcert.org' : 'https://www.exclamationce.com';
        return '<div class="platform-summary-card plat-card-' + platSlug + '">' +
          '<div class="plat-header">' +
            '<span class="plat-name">' + escHtml(plat) + '</span>' +
            '<a href="' + platUrl + '" target="_blank" class="plat-link">↗</a>' +
          '</div>' +
          '<div class="plat-stats">' +
            '<div class="plat-stat"><span class="plat-stat-num">' + providerList.length + '</span><span class="plat-stat-label">Providers</span></div>' +
            '<div class="plat-stat"><span class="plat-stat-num plat-stat-success">' + successCount + '</span><span class="plat-stat-label">Connected</span></div>' +
            (failCount > 0 ? '<div class="plat-stat"><span class="plat-stat-num plat-stat-fail">' + failCount + '</span><span class="plat-stat-label">Failed</span></div>' : '') +
            '<div class="plat-stat"><span class="plat-stat-num">' + Math.round(stats.totalHours) + '</span><span class="plat-stat-label">Total Hours</span></div>' +
          '</div>' +
          '<div class="plat-providers-section">' +
            '<div class="plat-providers-title">Connected Providers</div>' +
            '<div class="plat-providers-list">' +
              (providerList.length > 0 ? providerList.map(p => { const safeP = escHtml(p).replace(/'/g, '&#39;'); return '<span class="plat-provider-chip" onclick="openProvider(\'' + safeP + '\')">' + escHtml(p.split(',')[0]) + '</span>'; }).join('') : '<span class="no-providers">No providers configured</span>') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('')}
    </div>
  </div>

  <!-- Credential Gaps View -->
  <div class="platform-view" id="platform-gaps">
    <div class="credential-gaps-grid">
      <!-- Missing CE Broker -->
      <div class="cred-gap-card">
        <div class="cred-gap-header cred-gap-cebroker">
          <span class="cred-gap-icon">🔑</span>
          <span class="cred-gap-title">Missing CE Broker Credentials</span>
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

<footer>CEU Tracker &nbsp;·&nbsp; Last scraped: ${escHtml(runDate)}</footer>

<script>
  // ── Theme Toggle ──
  function toggleTheme() {
    const html = document.documentElement;
    const current = html.dataset.theme;
    const newTheme = current === 'dark' ? 'light' : 'dark';
    html.dataset.theme = newTheme;
    localStorage.setItem('ceu-theme', newTheme);
    document.getElementById('themeToggle').textContent = newTheme === 'dark' ? '☀️' : '🌙';
  }
  // Restore theme on load
  (function() {
    const saved = localStorage.getItem('ceu-theme');
    if (saved === 'dark') {
      document.documentElement.dataset.theme = 'dark';
      document.getElementById('themeToggle').textContent = '☀️';
    }
  })();

  // ── Sticky Header Shadow ──
  window.addEventListener('scroll', () => {
    const header = document.querySelector('header');
    if (header) header.classList.toggle('scrolled', window.scrollY > 10);
  });

  // ── Tabs ──
  function showTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name)?.classList.add('active');
    const btns = document.querySelectorAll('.tab-btn');
    const labels = ['dashboard','providers','platforms','reports'];
    btns[labels.indexOf(name)]?.classList.add('active');
    // Update sidebar nav
    document.querySelector('.nav-item[data-tab="' + name + '"]')?.classList.add('active');
    if (name === 'reports') initCharts();
    // Close sidebar on mobile after selection
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
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
    const labels = ['matrix','cards','gaps'];
    btns[labels.indexOf(name)]?.classList.add('active');
  }

  // ── Provider View Toggles ──
  function showProviderView(name) {
    const providersTab = document.getElementById('tab-providers');
    providersTab.querySelectorAll('.provider-view').forEach(v => v.classList.remove('active'));
    providersTab.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
    document.getElementById('provider-' + name)?.classList.add('active');
    const btns = providersTab.querySelectorAll('.view-toggle');
    const labels = ['all','deadline','state','type','favorites','actions','aanp','stats','timeline'];
    btns[labels.indexOf(name)]?.classList.add('active');
    // Initialize timeline when selected
    if (name === 'timeline' && typeof updateTimeline === 'function') {
      updateTimeline();
    }
  }

  // ── Toggle Collapsible Groups ──
  function toggleStateGroup(header) {
    const group = header.closest('.collapsible');
    if (group) group.classList.toggle('collapsed');
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

    // Load all cards if searching or filtering (so all results are available)
    if (q || noCredsOnly || stateFilter !== 'all' || cardFilter !== 'all' || typeFilter !== 'all') {
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

      // Advanced filter matches
      const matchDeadlineMin = deadlineMin === null || deadline >= deadlineMin;
      const matchDeadlineMax = deadlineMax === null || deadline <= deadlineMax;
      const matchOverdue = !filterOverdue || deadline < 0;
      const matchUrgent = !filterUrgent || (deadline >= 0 && deadline <= 30);

      const visible = matchQ && matchF && matchS && matchT && matchC && matchDeadlineMin && matchDeadlineMax && ((!filterOverdue && !filterUrgent) || matchOverdue || matchUrgent);
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
  }
  function closeProvider() {
    document.getElementById('drawerOverlay').classList.remove('open');
    document.body.style.overflow = '';
  }
  function printProvider() {
    window.print();
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProvider(); });

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
    chartsInit = true;

    // Bar chart: Completed vs Required per license
    const ctx1 = document.getElementById('hoursChart').getContext('2d');
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
    const ctx2 = document.getElementById('historyChart').getContext('2d');
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
</script>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');

  // Mirror to public/index.html so Vercel serves it at the root URL
  ensurePublicDir();
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');

  return OUTPUT_HTML;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

module.exports = { buildDashboard };
