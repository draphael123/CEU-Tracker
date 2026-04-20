// email-digest.js — Send weekly CEU compliance email digests
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { generatePDF } = require('./pdf-export');

// Load config from environment or config file
function loadConfig() {
  const configPath = path.join(__dirname, 'email-config.json');

  // Try config file first
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  // Fall back to environment variables
  return {
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    },
    from: process.env.EMAIL_FROM || 'CEU Tracker <noreply@example.com>',
    recipients: (process.env.EMAIL_RECIPIENTS || '').split(',').filter(Boolean)
  };
}

/**
 * Create email transporter
 */
function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.auth
  });
}

/**
 * Generate Training Required section HTML
 */
function generateTrainingRequiredHTML(providers) {
  const needsTraining = providers.filter(p => p.status !== 'Complete' && p.remaining > 0);
  if (needsTraining.length === 0) return '';

  const rows = needsTraining.map((p, i) => {
    // Build training requirements list
    const requirements = [];
    if (p.subjectAreas && p.subjectAreas.length > 0) {
      for (const sa of p.subjectAreas) {
        if (sa.needed > 0) {
          requirements.push(`${sa.needed}h ${sa.topic}`);
        }
      }
    }
    // Add general CEUs if there's remaining hours not covered by specific topics
    const specificTotal = (p.subjectAreas || []).reduce((sum, sa) => sum + (sa.needed || 0), 0);
    const generalNeeded = p.remaining - specificTotal;
    if (generalNeeded > 0 || requirements.length === 0) {
      requirements.push(`${p.remaining}h General CEUs`);
    }

    const reqHtml = requirements.map(r => `<div style="margin-bottom: 2px;">• ${r}</div>`).join('');
    const bgColor = i % 2 === 0 ? '#ffffff' : '#f8fafc';

    return `
      <tr style="background-color: ${bgColor};">
        <td style="padding: 10px; font-size: 13px; color: #1e293b; font-weight: 500;">${p.name}</td>
        <td style="padding: 10px; font-size: 13px; color: #64748b;">${p.state || 'N/A'}</td>
        <td style="padding: 10px; font-size: 12px; color: #1e40af;">${reqHtml}</td>
        <td style="padding: 10px; text-align: center; font-size: 12px; color: #64748b;">${p.deadline || 'N/A'}</td>
      </tr>`;
  }).join('');

  return `
    <tr>
      <td style="padding: 0 30px 30px;">
        <h2 style="color: #2563eb; font-size: 16px; margin: 0 0 15px; padding-bottom: 10px; border-bottom: 2px solid #bfdbfe;">
          📚 Training Required (${needsTraining.length} providers)
        </h2>
        <p style="margin: 0 0 15px; font-size: 13px; color: #64748b;">
          The following providers have CEU hours remaining to complete before their renewal deadline:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <tr style="background-color: #eff6ff;">
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #1e40af;">Provider</th>
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #1e40af;">State</th>
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #1e40af;">Training Needed</th>
            <th style="padding: 10px; text-align: center; font-size: 12px; color: #1e40af;">Deadline</th>
          </tr>
          ${rows}
        </table>
      </td>
    </tr>`;
}

/**
 * Generate Progress Since Last Run section HTML
 */
function generateProgressHTML(providers) {
  const improved = providers.filter(p => p.progressChange?.type === 'improved');
  const regressed = providers.filter(p => p.progressChange?.type === 'regressed');
  if (improved.length === 0 && regressed.length === 0) return '';

  let improvedHtml = '';
  if (improved.length > 0) {
    const items = improved.map(p => `
      <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px;">
        <span style="color: #1e293b;">${p.name}</span>
        <span style="color: #059669; font-weight: 600;">+${p.progressChange.hours}h</span>
      </div>`).join('');
    improvedHtml = `
      <div style="margin-bottom: 15px;">
        <div style="font-size: 13px; font-weight: 600; color: #059669; margin-bottom: 8px;">✓ Providers who completed more training:</div>
        <div style="background-color: #ecfdf5; border-radius: 8px; padding: 12px;">${items}</div>
      </div>`;
  }

  let regressedHtml = '';
  if (regressed.length > 0) {
    const items = regressed.map(p => `
      <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px;">
        <span style="color: #1e293b;">${p.name}</span>
        <span style="color: #dc2626; font-weight: 600;">-${p.progressChange.hours}h</span>
      </div>`).join('');
    regressedHtml = `
      <div>
        <div style="font-size: 13px; font-weight: 600; color: #dc2626; margin-bottom: 8px;">⚠ Hours decreased (requirements may have changed):</div>
        <div style="background-color: #fef2f2; border-radius: 8px; padding: 12px;">${items}</div>
      </div>`;
  }

  return `
    <tr>
      <td style="padding: 0 30px 30px;">
        <h2 style="color: #059669; font-size: 16px; margin: 0 0 15px; padding-bottom: 10px; border-bottom: 2px solid #a7f3d0;">
          📈 Progress Since Last Run
        </h2>
        ${improvedHtml}
        ${regressedHtml}
      </td>
    </tr>`;
}

/**
 * Generate Platform Coverage section HTML
 */
function generatePlatformCoverageHTML(providers) {
  const noPlatforms = providers.filter(p => !p.platforms || p.platforms.length === 0);
  const hasCEBrokerOnly = providers.filter(p => p.platforms?.length === 1 && p.platforms[0] === 'CE Broker');
  const hasMultiple = providers.filter(p => p.platforms?.length > 1);

  let missingCredsHtml = '';
  if (noPlatforms.length > 0) {
    missingCredsHtml = `
      <div style="background-color: #fef2f2; border-radius: 8px; padding: 12px; margin-top: 10px;">
        <div style="font-size: 12px; font-weight: 600; color: #991b1b; margin-bottom: 5px;">Providers missing credentials:</div>
        <div style="font-size: 12px; color: #7f1d1d;">${noPlatforms.map(p => p.name).join(', ')}</div>
      </div>`;
  }

  return `
    <tr>
      <td style="padding: 0 30px 30px;">
        <h2 style="color: #7c3aed; font-size: 16px; margin: 0 0 15px; padding-bottom: 10px; border-bottom: 2px solid #ddd6fe;">
          🔗 Platform Coverage
        </h2>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="33%" style="text-align: center; padding: 10px;">
              <div style="background-color: #faf5ff; border-radius: 8px; padding: 15px;">
                <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${hasMultiple.length}</div>
                <div style="font-size: 11px; color: #6b21a8;">Multiple Platforms</div>
              </div>
            </td>
            <td width="33%" style="text-align: center; padding: 10px;">
              <div style="background-color: #f0fdf4; border-radius: 8px; padding: 15px;">
                <div style="font-size: 24px; font-weight: 700; color: #059669;">${hasCEBrokerOnly.length}</div>
                <div style="font-size: 11px; color: #065f46;">CE Broker Only</div>
              </div>
            </td>
            <td width="33%" style="text-align: center; padding: 10px;">
              <div style="background-color: #fef2f2; border-radius: 8px; padding: 15px;">
                <div style="font-size: 24px; font-weight: 700; color: #dc2626;">${noPlatforms.length}</div>
                <div style="font-size: 11px; color: #991b1b;">No Credentials</div>
              </div>
            </td>
          </tr>
        </table>
        ${missingCredsHtml}
      </td>
    </tr>`;
}

/**
 * Generate HTML email content
 */
function generateEmailHTML(providers, summary) {
  const { complete, inProgress, atRisk, total } = summary;

  // Get providers at risk for highlighting
  const atRiskProviders = providers.filter(p => p.status === 'At Risk');
  const upcomingDeadlines = providers.filter(p => {
    const remaining = p.remaining || 0;
    const required = p.required || 0;
    return remaining > 0 && remaining < required * 0.5;
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CEU Compliance Digest</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CEU Compliance Digest</h1>
        <p style="color: #94a3b8; margin: 10px 0 0; font-size: 14px;">Weekly Summary Report</p>
      </td>
    </tr>

    <!-- Summary Stats -->
    <tr>
      <td style="padding: 30px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="33%" style="text-align: center; padding: 15px;">
              <div style="background-color: #d1fae5; border-radius: 12px; padding: 20px;">
                <div style="font-size: 32px; font-weight: 700; color: #059669;">${complete}</div>
                <div style="font-size: 12px; color: #065f46; margin-top: 5px;">Complete</div>
              </div>
            </td>
            <td width="33%" style="text-align: center; padding: 15px;">
              <div style="background-color: #fef3c7; border-radius: 12px; padding: 20px;">
                <div style="font-size: 32px; font-weight: 700; color: #d97706;">${inProgress}</div>
                <div style="font-size: 12px; color: #92400e; margin-top: 5px;">In Progress</div>
              </div>
            </td>
            <td width="33%" style="text-align: center; padding: 15px;">
              <div style="background-color: #fecaca; border-radius: 12px; padding: 20px;">
                <div style="font-size: 32px; font-weight: 700; color: #dc2626;">${atRisk}</div>
                <div style="font-size: 12px; color: #991b1b; margin-top: 5px;">At Risk</div>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    ${atRiskProviders.length > 0 ? `
    <!-- At Risk Section -->
    <tr>
      <td style="padding: 0 30px 30px;">
        <h2 style="color: #dc2626; font-size: 16px; margin: 0 0 15px; padding-bottom: 10px; border-bottom: 2px solid #fecaca;">
          ⚠️ Providers At Risk (${atRiskProviders.length})
        </h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #fecaca; border-radius: 8px; overflow: hidden;">
          <tr style="background-color: #fef2f2;">
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #991b1b;">Provider</th>
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #991b1b;">State</th>
            <th style="padding: 10px; text-align: center; font-size: 12px; color: #991b1b;">Remaining</th>
          </tr>
          ${atRiskProviders.map((p, i) => `
          <tr style="background-color: ${i % 2 === 0 ? '#ffffff' : '#fef2f2'};">
            <td style="padding: 10px; font-size: 13px; color: #1e293b;">${p.name}</td>
            <td style="padding: 10px; font-size: 13px; color: #64748b;">${p.state || 'N/A'}</td>
            <td style="padding: 10px; text-align: center; font-size: 13px; color: #dc2626; font-weight: 600;">${p.remaining || 0}h</td>
          </tr>
          `).join('')}
        </table>
      </td>
    </tr>
    ` : ''}

    ${generateTrainingRequiredHTML(providers)}

    ${generateProgressHTML(providers)}

    ${generatePlatformCoverageHTML(providers)}

    <!-- All Providers Summary -->
    <tr>
      <td style="padding: 0 30px 30px;">
        <h2 style="color: #1e293b; font-size: 16px; margin: 0 0 15px; padding-bottom: 10px; border-bottom: 2px solid #e2e8f0;">
          📋 All Providers (${total})
        </h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <tr style="background-color: #f8fafc;">
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #64748b;">Provider</th>
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #64748b;">State</th>
            <th style="padding: 10px; text-align: center; font-size: 12px; color: #64748b;">Status</th>
            <th style="padding: 10px; text-align: center; font-size: 12px; color: #64748b;">Progress</th>
          </tr>
          ${providers.slice(0, 15).map((p, i) => {
            const statusColor = p.status === 'Complete' ? '#059669' : p.status === 'At Risk' ? '#dc2626' : '#d97706';
            const statusBg = p.status === 'Complete' ? '#d1fae5' : p.status === 'At Risk' ? '#fecaca' : '#fef3c7';
            return `
          <tr style="background-color: ${i % 2 === 0 ? '#ffffff' : '#f8fafc'};">
            <td style="padding: 10px; font-size: 13px; color: #1e293b;">${p.name}</td>
            <td style="padding: 10px; font-size: 13px; color: #64748b;">${p.state || 'N/A'}</td>
            <td style="padding: 10px; text-align: center;">
              <span style="display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; background-color: ${statusBg}; color: ${statusColor};">
                ${p.status || 'Unknown'}
              </span>
            </td>
            <td style="padding: 10px; text-align: center; font-size: 13px; color: #64748b;">${p.completed || 0}/${p.required || 0}h</td>
          </tr>
            `;
          }).join('')}
          ${providers.length > 15 ? `
          <tr style="background-color: #f8fafc;">
            <td colspan="4" style="padding: 10px; text-align: center; font-size: 12px; color: #64748b;">
              ... and ${providers.length - 15} more providers (see attached PDF for full report)
            </td>
          </tr>
          ` : ''}
        </table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
        <p style="margin: 0; font-size: 12px; color: #64748b;">
          Generated on ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
        <p style="margin: 10px 0 0; font-size: 11px; color: #94a3b8;">
          CEU Tracker — Automated Compliance Monitoring
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/**
 * Send the weekly digest email
 */
async function sendDigest(options = {}) {
  const config = loadConfig();

  if (!config.smtp.auth.user || !config.smtp.auth.pass) {
    throw new Error('Email not configured. Set SMTP_USER and SMTP_PASS environment variables or create email-config.json');
  }

  if (config.recipients.length === 0) {
    throw new Error('No recipients configured. Set EMAIL_RECIPIENTS environment variable or update email-config.json');
  }

  // Load history data
  const historyPath = path.join(__dirname, 'history.json');
  if (!fs.existsSync(historyPath)) {
    throw new Error('No history.json found. Run a scrape first.');
  }

  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const latestRun = history[history.length - 1];
  const previousRun = history.length > 1 ? history[history.length - 2] : null;

  if (!latestRun || !latestRun.providers) {
    throw new Error('No provider data found in history.');
  }

  // Load providers.json for platform coverage
  let providersConfig = [];
  try {
    const providersPath = path.join(__dirname, 'providers.json');
    if (fs.existsSync(providersPath)) {
      providersConfig = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
    }
  } catch (e) {
    console.log('Could not load providers.json for platform coverage');
  }

  // Build platform coverage map
  const platformCoverage = {};
  for (const p of providersConfig) {
    const platforms = [];
    if (p.username && p.password) platforms.push('CE Broker');
    if (p.platforms) {
      for (const plat of p.platforms) {
        if (plat.platform && !platforms.includes(plat.platform)) {
          platforms.push(plat.platform);
        }
      }
    }
    platformCoverage[p.name] = platforms;
  }

  // Build previous run lookup for progress comparison
  const previousData = {};
  if (previousRun && previousRun.providers) {
    for (const p of previousRun.providers) {
      previousData[p.name] = {
        completed: p.hoursCompleted || 0,
        remaining: p.hoursRemaining || 0
      };
    }
  }

  // Flatten provider data (map field names from history.json format)
  const providers = latestRun.providers.map(p => {
    const completed = p.states?.[0]?.completed || p.hoursCompleted || p.completed || 0;
    const required = p.states?.[0]?.required || p.hoursRequired || p.required || 0;
    const remaining = p.states?.[0]?.remaining || p.hoursRemaining || p.remaining || 0;
    const deadline = p.states?.[0]?.deadline || p.renewalDeadline || p.deadline || null;

    // Calculate status if not provided
    let status = p.states?.[0]?.status || p.status;
    if (!status) {
      if (remaining <= 0) {
        status = 'Complete';
      } else {
        // Check if deadline is approaching and they're behind
        const daysLeft = deadline ? Math.ceil((new Date(deadline) - new Date()) / (1000 * 60 * 60 * 24)) : null;
        if (daysLeft !== null && daysLeft <= 90 && remaining > 0) {
          status = 'At Risk';
        } else {
          status = 'In Progress';
        }
      }
    }

    // Calculate progress since last run
    const prev = previousData[p.name];
    let progressChange = null;
    if (prev) {
      const hoursGained = completed - prev.completed;
      if (hoursGained > 0) progressChange = { type: 'improved', hours: hoursGained };
      else if (hoursGained < 0) progressChange = { type: 'regressed', hours: Math.abs(hoursGained) };
    }

    return {
      name: p.name,
      state: p.states?.[0]?.state || p.state || 'N/A',
      status,
      completed,
      required,
      remaining,
      deadline,
      subjectAreas: p.subjectAreas || [],
      platforms: platformCoverage[p.name] || [],
      progressChange
    };
  });

  // Sort: At Risk first
  const statusOrder = { 'At Risk': 0, 'In Progress': 1, 'Complete': 2 };
  providers.sort((a, b) => (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3));

  // Calculate summary
  const summary = {
    total: providers.length,
    complete: providers.filter(p => p.status === 'Complete').length,
    inProgress: providers.filter(p => p.status === 'In Progress').length,
    atRisk: providers.filter(p => p.status === 'At Risk').length
  };

  // Generate PDF attachment
  const pdfPath = path.join(__dirname, 'ceu_compliance_report.pdf');
  await generatePDF(providers, { outputPath: pdfPath });

  // Create transporter and send
  const transporter = createTransporter(config);

  const mailOptions = {
    from: config.from,
    to: config.recipients.join(', '),
    subject: `CEU Compliance Digest — ${summary.atRisk > 0 ? `⚠️ ${summary.atRisk} At Risk` : '✅ All On Track'} — ${new Date().toLocaleDateString()}`,
    html: generateEmailHTML(providers, summary),
    attachments: [
      {
        filename: `CEU_Compliance_Report_${new Date().toISOString().split('T')[0]}.pdf`,
        path: pdfPath
      }
    ]
  };

  const result = await transporter.sendMail(mailOptions);
  console.log(`Email sent to ${config.recipients.length} recipient(s): ${result.messageId}`);

  return result;
}

/**
 * Create sample config file
 */
function createSampleConfig() {
  const sampleConfig = {
    smtp: {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: 'your-email@gmail.com',
        pass: 'your-app-password'
      }
    },
    from: 'CEU Tracker <your-email@gmail.com>',
    recipients: [
      'recipient1@example.com',
      'recipient2@example.com'
    ]
  };

  const configPath = path.join(__dirname, 'email-config.sample.json');
  fs.writeFileSync(configPath, JSON.stringify(sampleConfig, null, 2));
  console.log(`Sample config created: ${configPath}`);
  console.log('Copy to email-config.json and update with your SMTP settings.');
}

// CLI usage
if (require.main === module) {
  const arg = process.argv[2];

  if (arg === '--setup') {
    createSampleConfig();
  } else {
    sendDigest()
      .then(() => console.log('Digest sent successfully!'))
      .catch(err => console.error('Error:', err.message));
  }
}

/**
 * Generate HTML for login errors section in emails
 */
function generateLoginErrorsHTML(loginErrors) {
  if (!loginErrors || loginErrors.length === 0) return '';

  // Map error codes to user-friendly labels and icons
  const errorLabels = {
    'invalid_credentials': { label: 'Invalid Credentials', icon: '🔐', color: '#dc2626' },
    'account_locked': { label: 'Account Locked', icon: '🔒', color: '#7c3aed' },
    'mfa_required': { label: '2FA Required', icon: '📱', color: '#2563eb' },
    'timeout': { label: 'Connection Timeout', icon: '⏱️', color: '#d97706' },
    'site_changed': { label: 'Site Changed', icon: '🔧', color: '#dc2626' },
    'network_error': { label: 'Network Error', icon: '📡', color: '#d97706' },
    'session_error': { label: 'Session Error', icon: '🔄', color: '#d97706' },
    'unknown': { label: 'Login Failed', icon: '❓', color: '#64748b' }
  };

  // Group errors by error code
  const errorGroups = {};
  loginErrors.forEach(e => {
    const code = e.errorCode || 'unknown';
    if (!errorGroups[code]) errorGroups[code] = [];
    errorGroups[code].push(e);
  });

  let errorRows = '';
  Object.entries(errorGroups).forEach(([code, errors]) => {
    const info = errorLabels[code] || errorLabels['unknown'];
    const names = errors.map(e => e.name).join(', ');
    const action = errors[0]?.errorAction || 'Check screenshot for details';

    errorRows += `
      <tr style="background-color: #ffffff;">
        <td style="padding: 12px; font-size: 13px; vertical-align: top;">
          <span style="font-size: 16px;">${info.icon}</span>
          <strong style="color: ${info.color};">${info.label}</strong>
        </td>
        <td style="padding: 12px; font-size: 13px; color: #1e293b;">${names}</td>
        <td style="padding: 12px; font-size: 12px; color: #64748b; font-style: italic;">${action}</td>
      </tr>
    `;
  });

  return `
    <!-- Login Errors Section -->
    <tr>
      <td style="padding: 0 30px 30px;">
        <h2 style="color: #dc2626; font-size: 16px; margin: 0 0 15px; padding-bottom: 10px; border-bottom: 2px solid #fecaca;">
          ⚠️ Login Errors (${loginErrors.length} provider${loginErrors.length !== 1 ? 's' : ''})
        </h2>
        <p style="margin: 0 0 15px; font-size: 13px; color: #64748b;">
          The following providers could not be synced due to login issues. Data shown may be outdated.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #fecaca; border-radius: 8px; overflow: hidden;">
          <tr style="background-color: #fef2f2;">
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #991b1b; width: 25%;">Error Type</th>
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #991b1b; width: 40%;">Providers</th>
            <th style="padding: 10px; text-align: left; font-size: 12px; color: #991b1b; width: 35%;">Recommended Action</th>
          </tr>
          ${errorRows}
        </table>
      </td>
    </tr>
  `;
}

/**
 * Generate HTML for renewal reminder email (90 days or less)
 */
function generateRenewalReminderHTML(providers, loginErrors = []) {
  const sortedProviders = providers.sort((a, b) => a.daysLeft - b.daysLeft);
  const loginErrorsSection = generateLoginErrorsHTML(loginErrors);
  const hasLoginErrors = loginErrors && loginErrors.length > 0;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CEU Renewal Reminder</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #ea580c 0%, #dc2626 100%); padding: 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CEU Renewal Reminder</h1>
        <p style="color: #fed7aa; margin: 10px 0 0; font-size: 14px;">${sortedProviders.length} provider${sortedProviders.length !== 1 ? 's' : ''} with renewals due within 90 days${hasLoginErrors ? ` • ${loginErrors.length} login error${loginErrors.length !== 1 ? 's' : ''}` : ''}</p>
      </td>
    </tr>

    <!-- Alert Banner -->
    <tr>
      <td style="padding: 20px 30px; background-color: #fef3c7; border-bottom: 2px solid #f59e0b;">
        <p style="margin: 0; font-size: 14px; color: #92400e; text-align: center;">
          <strong>Action Required:</strong> ${sortedProviders.length > 0 ? 'The following providers have CE requirements due soon and may need follow-up.' : 'Login errors detected that require attention.'}
        </p>
      </td>
    </tr>

    ${sortedProviders.length > 0 ? `
    <!-- Providers List -->
    <tr>
      <td style="padding: 30px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #fecaca; border-radius: 8px; overflow: hidden;">
          <tr style="background-color: #fef2f2;">
            <th style="padding: 12px; text-align: left; font-size: 12px; color: #991b1b; font-weight: 600;">Provider</th>
            <th style="padding: 12px; text-align: left; font-size: 12px; color: #991b1b; font-weight: 600;">State</th>
            <th style="padding: 12px; text-align: center; font-size: 12px; color: #991b1b; font-weight: 600;">Deadline</th>
            <th style="padding: 12px; text-align: center; font-size: 12px; color: #991b1b; font-weight: 600;">Days Left</th>
            <th style="padding: 12px; text-align: center; font-size: 12px; color: #991b1b; font-weight: 600;">Hours Needed</th>
          </tr>
          ${sortedProviders.map((p, i) => {
            const urgencyColor = p.daysLeft <= 7 ? '#dc2626' : p.daysLeft <= 14 ? '#ea580c' : '#d97706';
            const rowBg = i % 2 === 0 ? '#ffffff' : '#fef2f2';
            return `
          <tr style="background-color: ${rowBg};">
            <td style="padding: 12px; font-size: 13px; color: #1e293b; font-weight: 500;">${p.name}</td>
            <td style="padding: 12px; font-size: 13px; color: #64748b;">${p.state || 'N/A'}</td>
            <td style="padding: 12px; text-align: center; font-size: 13px; color: #64748b;">${p.deadline || 'N/A'}</td>
            <td style="padding: 12px; text-align: center;">
              <span style="display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 700; background-color: #fecaca; color: ${urgencyColor};">
                ${p.daysLeft}d
              </span>
            </td>
            <td style="padding: 12px; text-align: center; font-size: 13px; color: #dc2626; font-weight: 600;">${p.remaining || 0}h</td>
          </tr>
            `;
          }).join('')}
        </table>
      </td>
    </tr>
    ` : ''}

    ${loginErrorsSection}

    <!-- Action Section -->
    <tr>
      <td style="padding: 0 30px 30px;">
        <div style="background-color: #eff6ff; border-radius: 8px; padding: 20px; border-left: 4px solid #3b82f6;">
          <p style="margin: 0; font-size: 14px; color: #1e40af; font-weight: 600;">Recommended Actions:</p>
          <ul style="margin: 10px 0 0; padding-left: 20px; font-size: 13px; color: #1e3a5f;">
            <li>Contact providers who have not started their CE requirements</li>
            <li>Verify providers are aware of upcoming deadlines</li>
            <li>Check if providers need assistance finding approved courses</li>
            ${hasLoginErrors ? '<li><strong>Resolve login errors</strong> to ensure data is up-to-date</li>' : ''}
          </ul>
        </div>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
        <p style="margin: 0; font-size: 12px; color: #64748b;">
          Generated on ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${new Date().toLocaleTimeString()}
        </p>
        <p style="margin: 10px 0 0; font-size: 11px; color: #94a3b8;">
          CEU Tracker — Daily Renewal Reminders
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/**
 * Send daily renewal reminders for providers with deadlines within 90 days
 * Only sends if there are providers who are NOT complete and have deadlines <=90 days
 */
async function sendRenewalReminders(options = {}) {
  const config = loadConfig();

  // Use specific renewal reminder recipients if configured, otherwise fall back to main recipients
  const reminderRecipients = config.renewalReminderRecipients || config.recipients;

  if (!config.smtp.auth.user || !config.smtp.auth.pass) {
    throw new Error('Email not configured. Set SMTP_USER and SMTP_PASS environment variables or create email-config.json');
  }

  if (!reminderRecipients || reminderRecipients.length === 0) {
    throw new Error('No recipients configured for renewal reminders.');
  }

  // Load history data
  const historyPath = path.join(__dirname, 'history.json');
  if (!fs.existsSync(historyPath)) {
    console.log('No history.json found. Skipping renewal reminders.');
    return null;
  }

  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const latestRun = history[history.length - 1];

  if (!latestRun || !latestRun.providers) {
    console.log('No provider data found in history. Skipping renewal reminders.');
    return null;
  }

  // Calculate days until deadline for each provider
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const providersNeedingReminder = [];

  for (const p of latestRun.providers) {
    // Check each state/license for this provider (map field names from history.json format)
    const remaining = p.states?.[0]?.remaining || p.hoursRemaining || p.remaining || 0;
    const deadline = p.states?.[0]?.deadline || p.renewalDeadline || p.deadline || null;
    const state = p.states?.[0]?.state || p.state || 'N/A';

    // Calculate status if not provided
    let status = p.states?.[0]?.status || p.status;
    if (!status) {
      status = remaining <= 0 ? 'Complete' : 'In Progress';
    }

    const states = p.states || [{ state, deadline, status, remaining }];

    for (const stateData of states) {
      const stateDeadline = stateData.deadline || deadline;
      const stateRemaining = stateData.remaining ?? stateData.hoursRemaining ?? remaining;
      const stateStatus = stateData.status || (stateRemaining <= 0 ? 'Complete' : 'In Progress');

      if (!stateDeadline) continue;

      // Parse deadline
      const deadlineDate = new Date(stateDeadline);
      if (isNaN(deadlineDate.getTime())) continue;

      deadlineDate.setHours(0, 0, 0, 0);
      const daysLeft = Math.ceil((deadlineDate - today) / (1000 * 60 * 60 * 24));

      // Only include if:
      // 1. Deadline is within 90 days (and not past)
      // 2. Status is NOT Complete (they still have requirements left)
      if (daysLeft > 0 && daysLeft <= 90 && stateStatus !== 'Complete') {
        providersNeedingReminder.push({
          name: p.name,
          state: stateData.state || state || 'N/A',
          deadline: stateDeadline,
          daysLeft,
          remaining: stateRemaining,
          status: stateStatus
        });
      }
    }
  }

  // Get login errors from latest run (if available)
  const loginErrors = latestRun.loginErrors || [];

  // If no providers need reminders AND no login errors, skip sending
  if (providersNeedingReminder.length === 0 && loginErrors.length === 0) {
    console.log('No providers with upcoming renewals (within 90 days) that are incomplete, and no login errors. Skipping reminder.');
    return null;
  }

  // Create transporter and send
  const transporter = createTransporter(config);

  // Build subject line
  const urgentCount = providersNeedingReminder.filter(p => p.daysLeft <= 14).length;
  let subjectParts = [];

  if (urgentCount > 0) {
    subjectParts.push(`🔥 ${urgentCount} URGENT renewal${urgentCount !== 1 ? 's' : ''}`);
  } else if (providersNeedingReminder.length > 0) {
    subjectParts.push(`⚠️ ${providersNeedingReminder.length} renewal${providersNeedingReminder.length !== 1 ? 's' : ''} due`);
  }

  if (loginErrors.length > 0) {
    subjectParts.push(`🔐 ${loginErrors.length} login error${loginErrors.length !== 1 ? 's' : ''}`);
  }

  const subjectPrefix = subjectParts.join(' • ') || 'CEU Status Update';

  const mailOptions = {
    from: config.from,
    to: reminderRecipients.join(', '),
    subject: `${subjectPrefix} — ${new Date().toLocaleDateString()}`,
    html: generateRenewalReminderHTML(providersNeedingReminder, loginErrors)
  };

  const result = await transporter.sendMail(mailOptions);
  console.log(`Renewal reminder sent to ${reminderRecipients.length} recipient(s): ${result.messageId}`);
  console.log(`  - ${providersNeedingReminder.length} providers with renewals due within 90 days`);
  console.log(`  - ${urgentCount} critical (14 days or less)`);
  if (loginErrors.length > 0) {
    console.log(`  - ${loginErrors.length} login error(s) included`);
  }

  return result;
}

module.exports = { sendDigest, sendRenewalReminders, createSampleConfig };
