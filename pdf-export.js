// pdf-export.js — Generate PDF compliance reports
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * Generate a PDF compliance report
 * @param {Array} providers - Array of provider data
 * @param {Object} options - Options (title, outputPath, selectedOnly)
 */
function generatePDF(providers, options = {}) {
  const {
    title = 'CEU Compliance Report',
    outputPath = path.join(__dirname, 'ceu_compliance_report.pdf'),
    includeDetails = true
  } = options;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: 'LETTER',
        bufferPages: true
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // Colors
      const colors = {
        primary: '#1e293b',
        success: '#059669',
        warning: '#d97706',
        danger: '#dc2626',
        muted: '#64748b',
        light: '#f1f5f9'
      };

      // Header
      doc.fillColor(colors.primary)
         .fontSize(24)
         .font('Helvetica-Bold')
         .text(title, { align: 'center' });

      doc.moveDown(0.5);
      doc.fillColor(colors.muted)
         .fontSize(10)
         .font('Helvetica')
         .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });

      doc.moveDown(0.3);
      doc.text(`Total Providers: ${providers.length}`, { align: 'center' });

      // Summary stats
      const complete = providers.filter(p => p.status === 'Complete').length;
      const inProgress = providers.filter(p => p.status === 'In Progress').length;
      const atRisk = providers.filter(p => p.status === 'At Risk').length;

      doc.moveDown(1);

      // Summary boxes
      const boxY = doc.y;
      const boxWidth = 150;
      const boxHeight = 50;
      const startX = (doc.page.width - (boxWidth * 3 + 40)) / 2;

      // Complete box
      doc.fillColor(colors.success)
         .rect(startX, boxY, boxWidth, boxHeight)
         .fill();
      doc.fillColor('white')
         .fontSize(20)
         .font('Helvetica-Bold')
         .text(complete.toString(), startX, boxY + 10, { width: boxWidth, align: 'center' });
      doc.fontSize(10)
         .font('Helvetica')
         .text('Complete', startX, boxY + 32, { width: boxWidth, align: 'center' });

      // In Progress box
      doc.fillColor(colors.warning)
         .rect(startX + boxWidth + 20, boxY, boxWidth, boxHeight)
         .fill();
      doc.fillColor('white')
         .fontSize(20)
         .font('Helvetica-Bold')
         .text(inProgress.toString(), startX + boxWidth + 20, boxY + 10, { width: boxWidth, align: 'center' });
      doc.fontSize(10)
         .font('Helvetica')
         .text('In Progress', startX + boxWidth + 20, boxY + 32, { width: boxWidth, align: 'center' });

      // At Risk box
      doc.fillColor(colors.danger)
         .rect(startX + (boxWidth + 20) * 2, boxY, boxWidth, boxHeight)
         .fill();
      doc.fillColor('white')
         .fontSize(20)
         .font('Helvetica-Bold')
         .text(atRisk.toString(), startX + (boxWidth + 20) * 2, boxY + 10, { width: boxWidth, align: 'center' });
      doc.fontSize(10)
         .font('Helvetica')
         .text('At Risk', startX + (boxWidth + 20) * 2, boxY + 32, { width: boxWidth, align: 'center' });

      doc.y = boxY + boxHeight + 30;

      // Divider
      doc.strokeColor(colors.light)
         .lineWidth(2)
         .moveTo(50, doc.y)
         .lineTo(doc.page.width - 50, doc.y)
         .stroke();

      doc.moveDown(1);

      // Provider table header
      doc.fillColor(colors.primary)
         .fontSize(14)
         .font('Helvetica-Bold')
         .text('Provider Details', 50);

      doc.moveDown(0.5);

      // Table header
      const tableTop = doc.y;
      const colWidths = [180, 80, 70, 70, 80, 80];
      const colX = [50, 230, 310, 380, 450, 530];

      doc.fillColor(colors.light)
         .rect(50, tableTop, 512, 20)
         .fill();

      doc.fillColor(colors.primary)
         .fontSize(9)
         .font('Helvetica-Bold');

      doc.text('Provider', colX[0] + 5, tableTop + 5);
      doc.text('State', colX[1] + 5, tableTop + 5);
      doc.text('Status', colX[2] + 5, tableTop + 5);
      doc.text('Completed', colX[3] + 5, tableTop + 5);
      doc.text('Required', colX[4] + 5, tableTop + 5);
      doc.text('Remaining', colX[5] + 5, tableTop + 5);

      let rowY = tableTop + 25;

      // Sort: At Risk first, then In Progress, then Complete
      const statusOrder = { 'At Risk': 0, 'In Progress': 1, 'Complete': 2 };
      const sortedProviders = [...providers].sort((a, b) => {
        return (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3);
      });

      for (const provider of sortedProviders) {
        // Check if we need a new page
        if (rowY > doc.page.height - 80) {
          doc.addPage();
          rowY = 50;

          // Repeat header on new page
          doc.fillColor(colors.light)
             .rect(50, rowY, 512, 20)
             .fill();

          doc.fillColor(colors.primary)
             .fontSize(9)
             .font('Helvetica-Bold');

          doc.text('Provider', colX[0] + 5, rowY + 5);
          doc.text('State', colX[1] + 5, rowY + 5);
          doc.text('Status', colX[2] + 5, rowY + 5);
          doc.text('Completed', colX[3] + 5, rowY + 5);
          doc.text('Required', colX[4] + 5, rowY + 5);
          doc.text('Remaining', colX[5] + 5, rowY + 5);

          rowY += 25;
        }

        // Alternate row background
        if (sortedProviders.indexOf(provider) % 2 === 0) {
          doc.fillColor('#fafafa')
             .rect(50, rowY - 3, 512, 18)
             .fill();
        }

        // Status color
        let statusColor = colors.muted;
        if (provider.status === 'Complete') statusColor = colors.success;
        else if (provider.status === 'In Progress') statusColor = colors.warning;
        else if (provider.status === 'At Risk') statusColor = colors.danger;

        doc.fillColor(colors.primary)
           .fontSize(8)
           .font('Helvetica');

        // Truncate long names
        let name = provider.name || 'Unknown';
        if (name.length > 28) name = name.substring(0, 25) + '...';

        doc.text(name, colX[0] + 5, rowY, { width: colWidths[0] - 10 });
        doc.text(provider.state || 'N/A', colX[1] + 5, rowY);

        doc.fillColor(statusColor)
           .font('Helvetica-Bold')
           .text(provider.status || 'Unknown', colX[2] + 5, rowY);

        doc.fillColor(colors.primary)
           .font('Helvetica')
           .text((provider.completed || 0) + 'h', colX[3] + 5, rowY);
        doc.text((provider.required || 0) + 'h', colX[4] + 5, rowY);

        const remaining = provider.remaining || 0;
        doc.fillColor(remaining > 0 ? colors.danger : colors.success)
           .text(remaining + 'h', colX[5] + 5, rowY);

        rowY += 18;
      }

      // Footer on each page
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc.fillColor(colors.muted)
           .fontSize(8)
           .font('Helvetica')
           .text(
             `Page ${i + 1} of ${pages.count}`,
             50,
             doc.page.height - 30,
             { align: 'center', width: doc.page.width - 100 }
           );
      }

      doc.end();

      stream.on('finish', () => {
        resolve(outputPath);
      });

      stream.on('error', reject);

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate PDF from history.json data
 */
async function generateFromHistory(outputPath) {
  const historyPath = path.join(__dirname, 'history.json');

  if (!fs.existsSync(historyPath)) {
    throw new Error('No history.json found. Run a scrape first.');
  }

  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const latestRun = history[history.length - 1];

  if (!latestRun || !latestRun.providers) {
    throw new Error('No provider data found in history.');
  }

  // Flatten provider data for PDF
  const providers = latestRun.providers.map(p => ({
    name: p.name,
    state: p.states?.[0]?.state || p.state || 'N/A',
    status: p.states?.[0]?.status || p.status || 'Unknown',
    completed: p.states?.[0]?.completed || p.completed || 0,
    required: p.states?.[0]?.required || p.required || 0,
    remaining: p.states?.[0]?.remaining || p.remaining || 0
  }));

  return generatePDF(providers, { outputPath });
}

// CLI usage
if (require.main === module) {
  const outputPath = process.argv[2] || path.join(__dirname, 'ceu_compliance_report.pdf');

  generateFromHistory(outputPath)
    .then(path => console.log(`PDF saved: ${path}`))
    .catch(err => console.error('Error:', err.message));
}

module.exports = { generatePDF, generateFromHistory };
