// exporter.js — ExcelJS spreadsheet builder for CEU status report

const ExcelJS  = require('exceljs');
const path     = require('path');
const fs       = require('fs');
const { daysUntil, parseDate, getStatus, courseSearchUrl, logger } = require('./utils');
const { loadCosts, calculateAllProviderSpending } = require('./cost-utils');

const OUTPUT_FILE = path.join(__dirname, 'ceu_status_report.xlsx');

// ─── Color Palette ───────────────────────────────────────────────────────────
const COLORS = {
  // Status fills
  complete:   'FF92D050', // green
  inProgress: 'FFFFC000', // yellow/amber
  atRisk:     'FFFF0000', // red
  unknown:    'FFD9D9D9', // light gray

  // Header fills
  headerBg:   'FF2E4057', // dark navy
  headerFont: 'FFFFFFFF', // white

  // Alternating row fills
  rowAlt:     'FFF2F2F2', // very light gray
  rowNormal:  'FFFFFFFF', // white
};

// ─── Styles ──────────────────────────────────────────────────────────────────
const HEADER_STYLE = {
  font:      { bold: true, color: { argb: COLORS.headerFont }, size: 11 },
  fill:      { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } },
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
  border: {
    top:    { style: 'thin' },
    left:   { style: 'thin' },
    bottom: { style: 'thin' },
    right:  { style: 'thin' },
  },
};

function cellBorder() {
  return {
    top:    { style: 'hair' },
    left:   { style: 'hair' },
    bottom: { style: 'hair' },
    right:  { style: 'hair' },
  };
}

// ─── Main Export Function ────────────────────────────────────────────────────

/**
 * Build and save the full XLSX report.
 *
 * @param {LicenseRecord[][]} allProviderRecords
 *   Array of arrays — outer: one per provider, inner: one per license.
 */
async function buildReport(allProviderRecords, platformData = []) {
  logger.info('Building Excel report...');
  const workbook = new ExcelJS.Workbook();

  workbook.creator  = 'CE Broker Automation';
  workbook.created  = new Date();
  workbook.modified = new Date();

  // Flatten to a single list of license records (with provider info attached)
  const flat = allProviderRecords.flat();

  // Load cost data for spending sheet
  const costData = loadCosts();
  const courseHistoryFile = path.join(__dirname, 'course-history.json');
  let courseHistory = {};
  try {
    courseHistory = JSON.parse(fs.readFileSync(courseHistoryFile, 'utf8'));
  } catch (e) {
    // No course history yet
  }
  const spendingStats = calculateAllProviderSpending(courseHistory, costData);

  await buildSummarySheet(workbook, flat, spendingStats);
  await buildDetailSheet(workbook, flat);
  await buildSpendingSheet(workbook, flat, spendingStats, platformData);

  await workbook.xlsx.writeFile(OUTPUT_FILE);
  logger.success(`Report saved: ${OUTPUT_FILE}`);
  return OUTPUT_FILE;
}

// ─── Sheet 1: Summary ────────────────────────────────────────────────────────

async function buildSummarySheet(workbook, records, spendingStats = {}) {
  const sheet = workbook.addWorksheet('Summary', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Title row
  sheet.mergeCells('A1:K1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `CE Broker — Compliance Status Report   (Generated: ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })})`;
  titleCell.font  = { bold: true, size: 13, color: { argb: COLORS.headerFont } };
  titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 28;

  // Column headers
  const COLUMNS = [
    { header: 'Provider Name',     key: 'providerName',     width: 26 },
    { header: 'Type',              key: 'providerType',     width: 8  },
    { header: 'State',             key: 'state',            width: 8  },
    { header: 'Renewal Deadline',  key: 'renewalDeadline',  width: 18 },
    { header: 'Hours Required',    key: 'hoursRequired',    width: 16 },
    { header: 'Hours Completed',   key: 'hoursCompleted',   width: 16 },
    { header: 'Hours Remaining',   key: 'hoursRemaining',   width: 16 },
    { header: 'Status',            key: 'status',           width: 14 },
    { header: '12-Mo Spend',       key: 'spend12mo',        width: 14 },
    { header: '$/CEU Hour',        key: 'costPerHour',      width: 12 },
    { header: 'Course Search Link',key: 'courseLink',       width: 36 },
  ];

  sheet.columns = COLUMNS;
  sheet.getRow(2).values = COLUMNS.map((c) => c.header);

  // Apply header styling to row 2
  const headerRow = sheet.getRow(2);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    Object.assign(cell, { font: HEADER_STYLE.font, fill: HEADER_STYLE.fill,
      alignment: HEADER_STYLE.alignment, border: HEADER_STYLE.border });
  });

  // Data rows
  records.forEach((rec, idx) => {
    const rowNum = idx + 3; // row 1 = title, row 2 = headers
    const isAlt  = idx % 2 === 1;

    const deadline      = parseDate(rec.renewalDeadline);
    const days          = daysUntil(deadline);
    const status        = getStatus(rec.hoursRemaining, days);
    const statusColor   = {
      Complete:    COLORS.complete,
      'At Risk':   COLORS.atRisk,
      'In Progress': COLORS.inProgress,
      Unknown:     COLORS.unknown,
    }[status] || COLORS.unknown;

    // Pick "most urgent" state for course link
    const state    = rec.state    || '';
    const licType  = rec.licenseType || rec.providerType || '';
    const courseUrl = courseSearchUrl(state, licType);

    // Get spending data for this provider
    const providerSpending = spendingStats.byProvider?.[rec.providerName] || {};
    const spend12mo = providerSpending.totalSpend || null;
    const costPerHour = providerSpending.costPerHour || null;

    const row = sheet.getRow(rowNum);
    row.values = [
      rec.providerName    || '',
      rec.providerType    || '',
      state,
      rec.renewalDeadline || '',
      rec.hoursRequired   ?? '',
      rec.hoursCompleted  ?? '',
      rec.hoursRemaining  ?? '',
      status,
      spend12mo !== null ? `$${spend12mo.toFixed(2)}` : '',
      costPerHour !== null ? `$${costPerHour.toFixed(2)}` : '',
      courseUrl,
    ];
    row.height = 20;

    // Row background (alternating)
    const rowFill = { type: 'pattern', pattern: 'solid',
      fgColor: { argb: isAlt ? COLORS.rowAlt : COLORS.rowNormal } };

    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.border    = cellBorder();
      cell.alignment = { vertical: 'middle', wrapText: false };

      // Default alternating fill
      cell.fill = rowFill;

      // Status cell: colour-coded fill (column 8)
      if (colNum === 8) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor } };
        cell.font = { bold: true };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Course link: hyperlink (column 11)
      if (colNum === 11 && courseUrl) {
        cell.value = { text: `Search Courses (${state || '?'} ${licType || '?'})`, hyperlink: courseUrl };
        cell.font  = { color: { argb: 'FF0563C1' }, underline: true };
      }

      // Numeric alignment (hours columns + spending columns)
      if ([5, 6, 7, 9, 10].includes(colNum)) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });

    row.commit();
  });

  // Freeze + auto-filter
  sheet.autoFilter = { from: 'A2', to: 'K2' };

  // Summary stats at the bottom
  const lastDataRow = records.length + 3;
  const totalSpend = spendingStats.totalOrgSpend || 0;
  sheet.getCell(`A${lastDataRow}`).value = `Total providers: ${records.length}`;
  sheet.getCell(`A${lastDataRow}`).font  = { italic: true, color: { argb: 'FF888888' } };
  sheet.getCell(`I${lastDataRow}`).value = `Total: $${totalSpend.toFixed(2)}`;
  sheet.getCell(`I${lastDataRow}`).font  = { italic: true, bold: true, color: { argb: 'FF166534' } };
}

// ─── Sheet 2: Detail (subject-area breakdown) ─────────────────────────────────

async function buildDetailSheet(workbook, records) {
  const sheet = workbook.addWorksheet('Detail', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Title row
  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'CE Broker — Subject-Area Requirement Detail';
  titleCell.font  = { bold: true, size: 13, color: { argb: COLORS.headerFont } };
  titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 28;

  const COLUMNS = [
    { header: 'Provider Name',   key: 'providerName',  width: 26 },
    { header: 'State',           key: 'state',         width: 8  },
    { header: 'License Type',    key: 'licenseType',   width: 14 },
    { header: 'Topic / Subject', key: 'topicName',     width: 36 },
    { header: 'Hours Required',  key: 'hoursRequired', width: 16 },
    { header: 'Hours Completed', key: 'hoursCompleted',width: 16 },
    { header: 'Status',          key: 'status',        width: 14 },
  ];

  sheet.columns = COLUMNS;
  sheet.getRow(2).values = COLUMNS.map((c) => c.header);

  const headerRow = sheet.getRow(2);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    Object.assign(cell, { font: HEADER_STYLE.font, fill: HEADER_STYLE.fill,
      alignment: HEADER_STYLE.alignment, border: HEADER_STYLE.border });
  });

  let rowNum = 3;
  let altToggle = false;

  for (const rec of records) {
    const subjectAreas = rec.subjectAreas || [];

    if (subjectAreas.length === 0) {
      // Insert a single row with "No detail available"
      const row = sheet.getRow(rowNum++);
      row.values = [rec.providerName || '', rec.state || '', rec.licenseType || rec.providerType || '',
        'No detailed subject data available', '', '', ''];
      styleDetailRow(row, altToggle, COLORS.unknown);
      altToggle = !altToggle;
      row.commit();
      continue;
    }

    for (const area of subjectAreas) {
      const req  = area.hoursRequired  ?? null;
      const comp = area.hoursCompleted ?? null;
      const rem  = (req !== null && comp !== null) ? Math.max(0, req - comp) : null;
      const status = getStatus(rem, null); // no deadline context at topic level

      const statusColor = {
        Complete:    COLORS.complete,
        'At Risk':   COLORS.atRisk,
        'In Progress': COLORS.inProgress,
        Unknown:     COLORS.unknown,
      }[status] || COLORS.unknown;

      const row = sheet.getRow(rowNum++);
      row.values = [
        rec.providerName   || '',
        rec.state          || '',
        rec.licenseType    || rec.providerType || '',
        area.topicName     || '',
        req  ?? '',
        comp ?? '',
        status,
      ];
      styleDetailRow(row, altToggle, statusColor);
      altToggle = !altToggle;
      row.commit();
    }
  }

  sheet.autoFilter = { from: 'A2', to: 'G2' };
}

function styleDetailRow(row, isAlt, statusArgb) {
  const rowFill = { type: 'pattern', pattern: 'solid',
    fgColor: { argb: isAlt ? COLORS.rowAlt : COLORS.rowNormal } };
  row.height = 20;
  row.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.border    = cellBorder();
    cell.alignment = { vertical: 'middle' };
    cell.fill      = rowFill;
    if (colNum === 7) {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusArgb } };
      cell.font      = { bold: true };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    }
    if ([5, 6].includes(colNum)) {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    }
  });
}

// ─── Sheet 3: Spending ─────────────────────────────────────────────────────

async function buildSpendingSheet(workbook, records, spendingStats, platformData = []) {
  const sheet = workbook.addWorksheet('Spending', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Title row
  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'CE Spending Report — Rolling 12 Months';
  titleCell.font  = { bold: true, size: 13, color: { argb: COLORS.headerFont } };
  titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 28;

  const COLUMNS = [
    { header: 'Provider Name',         key: 'providerName',     width: 26 },
    { header: 'Type',                  key: 'providerType',     width: 8  },
    { header: 'Course Costs',          key: 'courseCosts',      width: 14 },
    { header: 'Subscriptions',         key: 'subscriptions',    width: 14 },
    { header: 'Total Spend',           key: 'totalSpend',       width: 14 },
    { header: 'CEU Hours',             key: 'hoursCompleted',   width: 12 },
    { header: '$/CEU Hour',            key: 'costPerHour',      width: 12 },
    { header: 'Top Platform',          key: 'topPlatform',      width: 18 },
  ];

  sheet.columns = COLUMNS;
  sheet.getRow(2).values = COLUMNS.map((c) => c.header);

  const headerRow = sheet.getRow(2);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    Object.assign(cell, { font: HEADER_STYLE.font, fill: HEADER_STYLE.fill,
      alignment: HEADER_STYLE.alignment, border: HEADER_STYLE.border });
  });

  // Get unique providers
  const uniqueProviders = [...new Set(records.map(r => r.providerName))];

  // Aggregate orders by provider from platform data
  const ordersByProvider = {};
  for (const pr of platformData) {
    if (pr.orders && pr.orders.length > 0) {
      if (!ordersByProvider[pr.providerName]) ordersByProvider[pr.providerName] = [];
      ordersByProvider[pr.providerName].push(...pr.orders);
    }
    // Also track platform spend
    if (pr.totalSpent) {
      if (!ordersByProvider[pr.providerName]) ordersByProvider[pr.providerName] = [];
      ordersByProvider[pr.providerName].push({ platform: pr.platform, total: pr.totalSpent });
    }
  }

  let rowNum = 3;
  let altToggle = false;
  let grandTotalSpend = 0;

  for (const providerName of uniqueProviders) {
    const rec = records.find(r => r.providerName === providerName) || {};
    const spending = spendingStats.byProvider?.[providerName] || {};
    const orders = ordersByProvider[providerName] || [];

    // Calculate top platform by spending
    const platformSpends = {};
    for (const order of orders) {
      const platform = order.platform || 'Unknown';
      platformSpends[platform] = (platformSpends[platform] || 0) + (order.total || 0);
    }
    const topPlatform = Object.entries(platformSpends)
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p)[0] || '—';

    const row = sheet.getRow(rowNum++);
    row.values = [
      providerName,
      rec.providerType || '',
      spending.courseCosts ? `$${spending.courseCosts.toFixed(2)}` : '$0.00',
      spending.subscriptionCosts ? `$${spending.subscriptionCosts.toFixed(2)}` : '$0.00',
      spending.totalSpend ? `$${spending.totalSpend.toFixed(2)}` : '$0.00',
      spending.hoursCompleted ?? '',
      spending.costPerHour ? `$${spending.costPerHour.toFixed(2)}` : '—',
      topPlatform,
    ];
    row.height = 20;

    grandTotalSpend += spending.totalSpend || 0;

    const rowFill = { type: 'pattern', pattern: 'solid',
      fgColor: { argb: altToggle ? COLORS.rowAlt : COLORS.rowNormal } };
    altToggle = !altToggle;

    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.border    = cellBorder();
      cell.alignment = { vertical: 'middle' };
      cell.fill      = rowFill;
      // Center numeric columns
      if ([3, 4, 5, 6, 7].includes(colNum)) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
      // Highlight total spend column with green tint if > 0
      if (colNum === 5 && spending.totalSpend > 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFdcfce7' } };
        cell.font = { bold: true, color: { argb: 'FF166534' } };
      }
    });

    row.commit();
  }

  sheet.autoFilter = { from: 'A2', to: 'H2' };

  // Summary row
  const summaryRow = sheet.getRow(rowNum + 1);
  summaryRow.getCell(1).value = 'TOTAL';
  summaryRow.getCell(1).font = { bold: true };
  summaryRow.getCell(5).value = `$${grandTotalSpend.toFixed(2)}`;
  summaryRow.getCell(5).font = { bold: true, color: { argb: 'FF166534' } };
  summaryRow.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFbbf7d0' } };

  // Organization subscriptions section
  if (spendingStats.orgSubscriptions > 0) {
    const orgRow = sheet.getRow(rowNum + 3);
    orgRow.getCell(1).value = 'Organization Subscriptions:';
    orgRow.getCell(1).font = { italic: true };
    orgRow.getCell(5).value = `$${spendingStats.orgSubscriptions.toFixed(2)}`;
    orgRow.getCell(5).font = { italic: true, color: { argb: 'FF166534' } };
  }
}

module.exports = { buildReport };
