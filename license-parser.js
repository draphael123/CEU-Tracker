/**
 * License Data Parser
 * Parses license, application, and renewal data from the Provider Compliance Dashboard spreadsheet
 */

const ExcelJS = require('exceljs');
const path = require('path');
const { logger } = require('./utils');

// Map of sheet names to full provider names (for matching with providers.json)
const PROVIDER_SHEET_MAP = {
  'Ashley E- NP': 'Ashley Esposito, NP',
  'Bryana A, NP': 'Bryana Anderson, NP',
  'Alexis F-H, NP': 'Alexis Foster-Horton, NP',
  'Ashley G': 'Ashley Grout, NP',
  'Bill C, NP': 'Bill Carbonneau, NP',
  'Brittany A, RN': 'Brittany Alexander, RN',
  'Brooklyn K, RN': 'Brooklyn Kimble, RN',
  'Bryce A, NP': 'Bryce Amos, NP',
  'Bryce H, RN': 'Bryce Hanley, RN',
  'Camryn B, RN': 'Camryn Burden, RN',
  'Catherine H, MD': 'Catherine Herrington, MD',
  'Danielle B, NP': 'Danielle Board, NP',
  'Daniel F, RN': 'Daniel Fis, RN',
  'Deanna M, NP': 'DeAnna Maher, NP',
  'Doron S, MD': 'Doron Stember, MD',
  'Hilary M, RN': 'Hilary Morgan, RN',
  'Jacquelyn S, NP': 'Jacquelyn Sexton, NP',
  'Lauren D, RN': 'Lauren Dovin, RN',
  'Lindsay B, NP': 'Lindsay Burden, NP',
  'Liz G, NP': 'Liz Gloor, NP',
  'Mackinzie J, RN': 'Mackinzie Johnson, RN',
  'Martin V, NP': 'Martin Van Dongen, NP',
  'Megan R-R, NP': 'Megan Ryan-Riffle, NP',
  'Michele F, NP': 'Michele Foster, NP',
  'Priya C, NP': 'Priya Chaudhari, NP',
  'Rachel Razi, NP': 'Rachel Razi, NP',
  'Sanjay Khubchandani, MD': 'Sanjay Khubchandani, MD',
  'Shelby B, RN': 'Shelby Bailey, RN',
  'Skye S, NP': 'Skye Sauls, NP',
  'Summer D, NP': 'Summer Denny, NP',
  'Terray H, NP': 'Terray Humphrey, NP',
  'TIm M, NP': 'Tim Mack, NP',
  'Tzvi D, DO': 'Tzvi Doron, DO',
  'Victor L, NP': 'Victor Lopez, NP',
  'Vivien L, NP': 'Vivien Lee, NP',
  'Florence O, Rn': 'Florence O, RN'
};

// State abbreviations for validation
const STATE_ABBREVS = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
];

/**
 * Extract cell value handling various Excel cell types
 */
function getCellValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return '';
  const val = cell.value;
  if (val.text) return val.text;
  if (val.result !== undefined) return val.result;
  if (val instanceof Date) return val;
  if (typeof val === 'object' && val.richText) {
    return val.richText.map(r => r.text).join('');
  }
  return val;
}

/**
 * Format date to MM/DD/YYYY string
 */
function formatDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return `${(val.getMonth() + 1).toString().padStart(2, '0')}/${val.getDate().toString().padStart(2, '0')}/${val.getFullYear()}`;
  }
  if (typeof val === 'string') {
    // Try to parse string date
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
    }
    return val;
  }
  return String(val);
}

/**
 * Parse state and license type from combined string like "FL NP", "CA RN", "FL DEA"
 */
function parseStateLicenseType(stateCol) {
  if (!stateCol) return { state: '', licenseType: '' };
  const str = String(stateCol).trim();

  // Handle special cases like "FL DEA", "ANCC", "ABUM"
  if (str === 'ANCC' || str === 'ABUM') {
    return { state: 'National', licenseType: str };
  }

  // Check for state abbreviation at the start
  const parts = str.split(/\s+/);
  const stateCandidate = parts[0].replace('*', '').toUpperCase();

  if (STATE_ABBREVS.includes(stateCandidate)) {
    return {
      state: stateCandidate,
      licenseType: parts.slice(1).join(' ') || 'License'
    };
  }

  return { state: '', licenseType: str };
}

/**
 * Calculate license status based on expiration date
 */
function getLicenseStatus(expiresDate) {
  if (!expiresDate) return { status: 'Unknown', daysUntil: null };

  const now = new Date();
  const expires = expiresDate instanceof Date ? expiresDate : new Date(expiresDate);

  if (isNaN(expires.getTime())) return { status: 'Unknown', daysUntil: null };

  const diffTime = expires.getTime() - now.getTime();
  const daysUntil = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (daysUntil < 0) return { status: 'Expired', daysUntil };
  if (daysUntil <= 30) return { status: 'Critical', daysUntil };
  if (daysUntil <= 90) return { status: 'Warning', daysUntil };
  return { status: 'Active', daysUntil };
}

/**
 * Parse licenses from individual provider sheets
 */
async function parseLicenses(workbook) {
  const licenses = [];

  for (const [sheetName, providerName] of Object.entries(PROVIDER_SHEET_MAP)) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      logger.warn(`Sheet not found: ${sheetName}`);
      continue;
    }

    sheet.eachRow((row, rowNum) => {
      // Skip header row and rows without license data
      if (rowNum === 1) return;

      const stateCol = getCellValue(row.getCell(2));
      const licenseNum = getCellValue(row.getCell(3));
      const issued = getCellValue(row.getCell(4));
      const expires = getCellValue(row.getCell(5));
      const notes = getCellValue(row.getCell(6));

      // Skip rows without state/license info
      if (!stateCol || !licenseNum) return;

      const { state, licenseType } = parseStateLicenseType(stateCol);

      // Skip if we couldn't identify a state (likely not a license row)
      if (!state) return;

      const expiresDate = expires instanceof Date ? expires : (expires ? new Date(expires) : null);
      const { status, daysUntil } = getLicenseStatus(expiresDate);

      licenses.push({
        provider: providerName,
        state,
        licenseType,
        licenseNumber: String(licenseNum).trim(),
        issued: formatDate(issued),
        expires: formatDate(expires),
        expiresDate: expiresDate && !isNaN(expiresDate.getTime()) ? expiresDate : null,
        status,
        daysUntil,
        notes: String(notes || '').trim()
      });
    });
  }

  // Sort by expiration date (soonest first)
  licenses.sort((a, b) => {
    if (!a.expiresDate && !b.expiresDate) return 0;
    if (!a.expiresDate) return 1;
    if (!b.expiresDate) return -1;
    return a.expiresDate.getTime() - b.expiresDate.getTime();
  });

  return licenses;
}

/**
 * Parse pending applications from "Provider New AppsTo do List" sheet
 */
async function parseApplications(workbook) {
  const applications = [];
  const sheet = workbook.getWorksheet('Provider New AppsTo do List');

  if (!sheet) {
    logger.warn('Applications sheet not found');
    return applications;
  }

  sheet.eachRow((row, rowNum) => {
    // Skip header row
    if (rowNum === 1) return;

    const name = getCellValue(row.getCell(1));
    const state = getCellValue(row.getCell(2));
    const type = getCellValue(row.getCell(3)); // New/Reinstate
    const dateRequested = getCellValue(row.getCell(4));
    const licenseType = getCellValue(row.getCell(5));
    const submissionDate = getCellValue(row.getCell(6));
    const process = getCellValue(row.getCell(7));
    const notes = getCellValue(row.getCell(8));
    const statusFollowUp = getCellValue(row.getCell(9));

    // Skip empty rows
    if (!name || !state) return;

    // Normalize status
    let status = String(process || '').toLowerCase().trim();
    if (status.includes('license issued')) status = 'Issued';
    else if (status.includes('submitted') || status.includes('waiting')) status = 'Submitted';
    else if (status.includes('prepping')) status = 'In Progress';
    else if (status.includes('not started')) status = 'Not Started';
    else if (status) status = process;
    else status = 'Unknown';

    applications.push({
      provider: String(name).trim(),
      state: String(state).trim().toUpperCase(),
      type: String(type || 'New').trim(),
      licenseType: String(licenseType || '').trim(),
      status,
      dateRequested: formatDate(dateRequested),
      submissionDate: formatDate(submissionDate),
      notes: String(notes || statusFollowUp || '').trim()
    });
  });

  return applications;
}

/**
 * Parse upcoming renewals from "ProviderRN Renewals" sheet
 */
async function parseRenewals(workbook) {
  const renewals = [];
  const sheet = workbook.getWorksheet('ProviderRN Renewals');

  if (!sheet) {
    logger.warn('Renewals sheet not found');
    return renewals;
  }

  sheet.eachRow((row, rowNum) => {
    // Skip header rows (1 and 2)
    if (rowNum <= 2) return;

    const provider = getCellValue(row.getCell(1));
    const state = getCellValue(row.getCell(2));
    const renewalType = getCellValue(row.getCell(3)); // Renewal/Reinstate
    const licenseType = getCellValue(row.getCell(4));
    const status = getCellValue(row.getCell(5));
    const expires = getCellValue(row.getCell(6));
    const assigned = getCellValue(row.getCell(7));
    const notes = getCellValue(row.getCell(8));

    // Skip empty rows
    if (!provider || !state) return;

    const expiresDate = expires instanceof Date ? expires : (expires ? new Date(expires) : null);
    const { status: licenseStatus, daysUntil } = getLicenseStatus(expiresDate);

    renewals.push({
      provider: String(provider).trim(),
      state: String(state).trim().toUpperCase(),
      type: String(renewalType || 'Renewal').trim(),
      licenseType: String(licenseType || '').trim(),
      status: String(status || '').trim() || 'Pending',
      expires: formatDate(expires),
      expiresDate: expiresDate && !isNaN(expiresDate.getTime()) ? expiresDate : null,
      licenseStatus,
      daysUntil,
      assigned: String(assigned || '').trim(),
      notes: String(notes || '').trim()
    });
  });

  // Sort by expiration date (soonest first)
  renewals.sort((a, b) => {
    if (!a.expiresDate && !b.expiresDate) return 0;
    if (!a.expiresDate) return 1;
    if (!b.expiresDate) return -1;
    return a.expiresDate.getTime() - b.expiresDate.getTime();
  });

  return renewals;
}

/**
 * Main function to parse all license data from the spreadsheet
 */
async function parseLicenseData() {
  const spreadsheetPath = path.join(__dirname, 'Source Doc', 'Provider _ Compliance Dashboard (2).xlsx');

  logger.info('Parsing license data from spreadsheet...');

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(spreadsheetPath);

    const [licenses, applications, renewals] = await Promise.all([
      parseLicenses(workbook),
      parseApplications(workbook),
      parseRenewals(workbook)
    ]);

    logger.success(`Parsed ${licenses.length} licenses, ${applications.length} applications, ${renewals.length} renewals`);

    // Calculate summary stats
    const stats = {
      totalLicenses: licenses.length,
      activeLicenses: licenses.filter(l => l.status === 'Active').length,
      warningLicenses: licenses.filter(l => l.status === 'Warning').length,
      criticalLicenses: licenses.filter(l => l.status === 'Critical').length,
      expiredLicenses: licenses.filter(l => l.status === 'Expired').length,
      pendingApplications: applications.filter(a => a.status !== 'Issued').length,
      upcomingRenewals: renewals.length
    };

    return {
      licenses,
      applications,
      renewals,
      stats,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Failed to parse license data: ${error.message}`);
    return {
      licenses: [],
      applications: [],
      renewals: [],
      stats: {},
      lastUpdated: new Date().toISOString(),
      error: error.message
    };
  }
}

module.exports = { parseLicenseData };
