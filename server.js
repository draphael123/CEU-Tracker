// server.js — Express web server for the CE Broker Compliance Dashboard

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const HISTORY_FILE   = path.join(__dirname, 'history.json');
const LAST_RUN_FILE  = path.join(__dirname, 'last_run.json');

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve the generated dashboard
app.get('/', (req, res) => {
  if (!fs.existsSync(DASHBOARD_FILE)) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:40px;color:#475569">
        <h2>Dashboard not generated yet</h2>
        <p>Run <code>npm start</code> to scrape data and generate the dashboard.</p>
      </body></html>
    `);
  }
  res.sendFile(DASHBOARD_FILE);
});

// API: full run history (for dynamic refresh or external tooling)
app.get('/api/history', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.json([]);
  }
});

// API: last run summary
app.get('/api/status', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.json({ error: 'No run data yet. Run npm start to scrape.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nCE Broker Dashboard running at http://localhost:${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  GET /           — Dashboard`);
  console.log(`  GET /api/status — Last run summary`);
  console.log(`  GET /api/history — Full history\n`);
});
