// exporter.js — ExcelJS spreadsheet builder for CEU status report

const ExcelJS  = require('exceljs');
const path     = require('path');
const { daysUntil, parseDate, getStatus, courseSearchUrl, logger } = require('./utils');

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
async function buildReport(allProviderRecords) {
  logger.info('Building Excel report...');
  const workbook = new ExcelJS.Workbook();

  workbook.creator  = 'CE Broker Automation';
  workbook.created  = new Date();
  workbook.modified = new Date();

  // Flatten to a single list of license records (with provider info attached)
  const flat = allProviderRecords.flat();

  await buildSummarySheet(workbook, flat);
  await buildDetailSheet(workbook, flat);

  await workbook.xlsx.writeFile(OUTPUT_FILE);
  logger.success(`Report saved: ${OUTPUT_FILE}`);
  return OUTPUT_FILE;
}

// ─── Sheet 1: Summary ────────────────────────────────────────────────────────

async function buildSummarySheet(workbook, records) {
  const sheet = workbook.addWorksheet('Summary', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Title row
  sheet.mergeCells('A1:I1');
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

      // Status cell: colour-coded fill
      if (colNum === 8) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor } };
        cell.font = { bold: true };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Course link: hyperlink
      if (colNum === 9 && courseUrl) {
        cell.value = { text: `Search Courses (${state || '?'} ${licType || '?'})`, hyperlink: courseUrl };
        cell.font  = { color: { argb: 'FF0563C1' }, underline: true };
      }

      // Numeric alignment
      if ([5, 6, 7].includes(colNum)) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });

    row.commit();
  });

  // Freeze + auto-filter
  sheet.autoFilter = { from: 'A2', to: 'I2' };

  // Summary stats at the bottom
  const lastDataRow = records.length + 3;
  sheet.getCell(`A${lastDataRow}`).value = `Total providers: ${records.length}`;
  sheet.getCell(`A${lastDataRow}`).font  = { italic: true, color: { argb: 'FF888888' } };
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

module.exports = { buildReport };
