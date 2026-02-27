// dashboard-builder.js — Generates dashboard.html from scraped records

const fs   = require('fs');
const path = require('path');
const { daysUntil, parseDate, getStatus, courseSearchUrl } = require('./utils');

const OUTPUT_HTML    = path.join(__dirname, 'dashboard.html');
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

  // ── RN identification (first name matching) ─────────────────────────────
  const RN_FIRST_NAMES = ['Camryn', 'Daniel', 'Brooklyn', 'Brittany', 'Shelby', 'Mackinzie', 'Bryce', 'Hilary'];
  const isRN = (name, type) => {
    if (type === 'RN') return true;
    const firstName = name.split(/[\s,]+/)[0];
    return RN_FIRST_NAMES.some(rn => firstName.toLowerCase().startsWith(rn.toLowerCase()));
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

  // ── No CE Credentials Found (providers flagged with noCredentials: true) ──
  const providers = require('./providers.json');
  const noCredentialsProviders = providers.filter(p => p.noCredentials === true).map(p => p.name);

  // ── Split providers into clinicians and RNs ──────────────────────────────
  const providerEntries = Object.entries(providerMap);
  const clinicianEntries = providerEntries.filter(([name, info]) => !isRN(name, info.type));
  const rnEntries = providerEntries.filter(([name, info]) => isRN(name, info.type));

  const clinicianCards = clinicianEntries.map(buildProviderCard).join('');
  const rnCards = rnEntries.map(buildProviderCard).join('');
  const profileCards = providerEntries.map(buildProviderCard).join(''); // Keep for backward compat

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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f2; color: #1e3a8a; min-height: 100vh; }

    /* ─ Header ─ */
    header {
      background-color: #0f172a;
      background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 18px,
        rgba(255,255,255,0.03) 18px,
        rgba(255,255,255,0.03) 36px
      );
      color: #fff;
      padding: 20px 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,.5);
    }
    .header-brand { display: flex; align-items: center; gap: 16px; }
    .header-logo  { height: 38px; width: auto; display: block; }
    .header-divider {
      width: 1px; height: 32px; background: rgba(255,255,255,0.3); flex-shrink: 0;
    }
    header h1 { font-size: 1.4rem; font-weight: 700; }
    header h1 span { color: #5eead4; }
    .header-meta { text-align: right; }
    .last-scraped-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1px; color: #64748b; }
    .last-scraped-value { font-size: 0.95rem; color: #e2e8f0; font-weight: 500; margin-top: 2px; }
    .last-scraped-ago { font-size: 0.72rem; color: #5eead4; margin-top: 1px; }
    .run-badge { margin-top: 6px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .run-pill { padding: 3px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .run-pill.ok   { background: #166534; color: #dcfce7; }
    .run-pill.notconfig { background: #475569; color: #e2e8f0; }
    .run-pill.fail { background: #7f1d1d; color: #fee2e2; }

    /* ─ Stat cards ─ */
    .stats { display: flex; gap: 14px; padding: 28px 40px 0; flex-wrap: wrap; }
    .stat-card { background: #fff; border-radius: 12px; padding: 18px 22px; min-width: 130px; box-shadow: 0 2px 8px rgba(0,0,0,.07); border-top: 4px solid #e2e8f0; }
    .stat-card .num { font-size: 2.4rem; font-weight: 800; line-height: 1; }
    .stat-card .lbl { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .8px; color: #64748b; margin-top: 6px; }
    .stat-card.total { border-top-color: #6366f1; }
    .stat-card.total .num { color: #4f46e5; }
    .stat-card.ok    { border-top-color: #16a34a; }
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
      background: #fff;
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,.07);
      border-left: 5px solid #cbd5e1;
      transition: box-shadow .15s, transform .15s;
    }
    .provider-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,.12); transform: translateY(-2px); }
    .provider-card.card-ok   { border-left-color: #16a34a; }
    .provider-card.card-prog { border-left-color: #d97706; }
    .provider-card.card-risk { border-left-color: #dc2626; }
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
      background: #f1f5f9;
      color: #64748b;
      border: 1px solid #e2e8f0;
    }
    .unknown-reason.unknown-partial {
      background: #eff6ff;
      color: #1e40af;
      border: 1px solid #bfdbfe;
    }
    .unknown-reason.unknown-error {
      background: #fef2f2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }
    .unknown-reason.unknown-default {
      background: #f8fafc;
      color: #475569;
      border: 1px solid #e2e8f0;
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
      border: 1.5px solid #cbd5e1;
      border-radius: 8px;
      font-size: 0.88rem;
      width: 220px;
      outline: none;
    }
    .search-box:focus { border-color: #1d4ed8; }
    .filter-btn {
      padding: 7px 16px;
      border: 1.5px solid #cbd5e1;
      border-radius: 8px;
      background: #fff;
      cursor: pointer;
      font-size: 0.82rem;
      transition: all .15s;
    }
    .filter-btn:hover, .filter-btn.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
    .filter-select {
      padding: 7px 12px;
      border: 1.5px solid #cbd5e1;
      border-radius: 8px;
      background: #fff;
      font-size: 0.82rem;
      cursor: pointer;
      min-width: 140px;
    }
    .filter-select:focus { border-color: #1d4ed8; outline: none; }
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
    footer { text-align: center; padding: 16px; font-size: .76rem; color: #94a3b8; border-top: 1px solid #e2e8f0; margin-top: 8px; }

    /* ─ Tabs ─ */
    .tab-bar { display: flex; gap: 4px; padding: 28px 40px 0; border-bottom: 2px solid #e2e8f0; margin-bottom: 0; }
    .tab-btn {
      padding: 9px 20px;
      border: none;
      border-bottom: 3px solid transparent;
      background: none;
      cursor: pointer;
      font-size: 0.88rem;
      font-weight: 600;
      color: #64748b;
      margin-bottom: -2px;
      border-radius: 8px 8px 0 0;
      transition: all .15s;
    }
    .tab-btn:hover { background: #e8f0ee; color: #1e293b; }
    .tab-btn.active {
      color: #0f172a;
      border-bottom-color: #0d9488;
      background: #fff;
      box-shadow: 0 -2px 6px rgba(0,0,0,.05);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ─ State chips ─ */
    .state-chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 40px 0; }
    .state-chip {
      padding: 5px 14px; border-radius: 99px; border: 1.5px solid #cbd5e1;
      background: #fff; cursor: pointer; font-size: 0.78rem; font-weight: 600; color: #475569;
      transition: all .15s;
    }
    .state-chip:hover, .state-chip.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }

    /* ─ Clickable card ─ */
    .card-clickable { cursor: pointer; }
    .card-clickable:hover { box-shadow: 0 8px 24px rgba(0,0,0,.14); transform: translateY(-3px); }
    .card-arrow { color: #94a3b8; font-size: 1rem; transition: color .15s; }
    .card-clickable:hover .card-arrow { color: #1d4ed8; }
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
    .providers-filter-bar { display: flex; gap: 12px; padding: 20px 40px 12px; flex-wrap: wrap; align-items: center; }
    .providers-filter-bar .search-box { flex: 1; min-width: 200px; }
    .providers-filter-bar .filter-select { min-width: 120px; }
    .providers-count { display: flex; justify-content: space-between; align-items: center; padding: 0 40px 16px; font-size: 0.85rem; color: #64748b; }

    /* ─ View Toggle Buttons ─ */
    .view-toggle-bar { display: flex; gap: 8px; padding: 20px 40px 0; flex-wrap: wrap; }
    .view-toggle { padding: 8px 16px; border: 2px solid #e2e8f0; border-radius: 8px; background: #fff; cursor: pointer; font-size: 0.85rem; font-weight: 600; color: #64748b; transition: all .15s; display: flex; align-items: center; gap: 8px; }
    .view-toggle:hover { border-color: #cbd5e1; color: #475569; }
    .view-toggle.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
    .view-count { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,.1); }
    .view-toggle.active .view-count { background: rgba(255,255,255,.2); }
    .view-count.warning { background: #d97706; color: #fff; }

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
    .drawer-overlay.open { display: flex; }
    .drawer-panel {
      background: #fff; border-radius: 18px; padding: 36px;
      width: 100%; max-width: 740px; position: relative;
      box-shadow: 0 24px 64px rgba(0,0,0,.22); margin: auto;
      animation: slideUp .2s ease;
    }
    @keyframes slideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
    .drawer-close {
      position: absolute; top: 18px; right: 18px;
      background: #f1f5f9; border: none; border-radius: 50%;
      width: 34px; height: 34px; cursor: pointer; font-size: 1rem;
      color: #475569; display: flex; align-items: center; justify-content: center;
    }
    .drawer-close:hover { background: #e2e8f0; }

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
</header>

<!-- ── Stats ──────────────────────────────────────────────────────────── -->
<div class="stats">
  <div class="stat-card total"><div class="num">${total}</div><div class="lbl">Clinical Team Members</div></div>
  <div class="stat-card ok">  <div class="num">${complete}</div><div class="lbl">Complete</div></div>
  <div class="stat-card prog"><div class="num">${inProg}</div><div class="lbl">In Progress</div></div>
  <div class="stat-card risk"><div class="num">${atRisk}</div><div class="lbl">At Risk</div></div>
</div>

<!-- ── Tabs ───────────────────────────────────────────────────────────── -->
<div class="tab-bar">
  <button class="tab-btn active" onclick="showTab('dashboard')">Dashboard${(atRisk + noCredentialsProviders.length) > 0 ? ` <span class="tab-badge">${atRisk + noCredentialsProviders.length}</span>` : ''}</button>
  <button class="tab-btn"        onclick="showTab('providers')">Providers</button>
  <button class="tab-btn"        onclick="showTab('reports')">Reports</button>
</div>

<!-- ── Tab: Overview ──────────────────────────────────────────────────── -->
<!-- ── Tab: Dashboard (Consolidated Overview) ────────────────────────────── -->
<div class="tab-panel active" id="tab-dashboard">
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
<div class="tab-panel" id="tab-providers">
  <!-- Unified Filter Bar -->
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
  </div>

  <!-- Provider Count -->
  <div class="providers-count">
    <span id="providerFilterCount">${providerEntries.length} of ${providerEntries.length} providers</span>
    <button class="reset-btn" onclick="resetProviderFilters()">Reset</button>
  </div>

  <!-- All Providers Cards Grid -->
  <div class="cards-grid" id="allCardsGrid">
    ${profileCards}
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

<footer>CEU Tracker &nbsp;·&nbsp; Last scraped: ${escHtml(runDate)}</footer>

<script>
  // ── Tabs ──
  function showTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name)?.classList.add('active');
    const btns = document.querySelectorAll('.tab-btn');
    const labels = ['dashboard','providers','reports'];
    btns[labels.indexOf(name)]?.classList.add('active');
    if (name === 'reports') initCharts();
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

    let visibleCount = 0;
    const totalCount = grid.querySelectorAll('.provider-card').length;

    grid.querySelectorAll('.provider-card').forEach(card => {
      const name   = (card.dataset.provider || '').toLowerCase();
      const status = card.dataset.status || '';
      const states = (card.dataset.states || '').split(',');
      const type   = card.dataset.type || '';
      const noCreds = card.dataset.noCreds === 'true';
      const matchQ = !q || name.includes(q);
      const matchF = cardFilter === 'all' || status === cardFilter;
      const matchS = stateFilter === 'all' || states.includes(stateFilter);
      const matchT = typeFilter === 'all' || type === typeFilter;
      const matchC = !noCredsOnly || noCreds;
      const visible = matchQ && matchF && matchS && matchT && matchC;
      card.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    });

    // Update count display
    const countEl = document.getElementById('providerFilterCount');
    if (countEl) countEl.textContent = visibleCount + ' of ' + totalCount + ' providers';
  }

  function resetProviderFilters() {
    document.getElementById('cardSearch').value = '';
    document.getElementById('statusFilter').value = 'all';
    document.getElementById('typeFilter').value = 'all';
    document.getElementById('stateFilter').value = 'all';
    document.getElementById('cardSort').value = 'name';
    document.getElementById('noCredsFilter').checked = false;
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

module.exports = { buildDashboard };
