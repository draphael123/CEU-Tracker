// server.js — Express web server for the CE Broker Compliance Dashboard

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { loadJson } = require('./utils');

const app  = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const CMO_FILE       = path.join(__dirname, 'cmo.html');
const HISTORY_FILE   = path.join(__dirname, 'history.json');
const LAST_RUN_FILE  = path.join(__dirname, 'last_run.json');

// ── Static Files ──────────────────────────────────────────────────────────────
app.use(express.static(__dirname));

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

// Serve the CMO executive dashboard
app.get('/cmo', (req, res) => {
  if (!fs.existsSync(CMO_FILE)) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:40px;color:#475569">
        <h2>CMO Dashboard not found</h2>
        <p>The CMO dashboard file is missing.</p>
      </body></html>
    `);
  }
  res.sendFile(CMO_FILE);
});

// API: full run history (for dynamic refresh or external tooling)
app.get('/api/history', (req, res) => {
  const data = loadJson(HISTORY_FILE, []);
  res.json(data);
});

// API: last run summary
app.get('/api/status', (req, res) => {
  const data = loadJson(LAST_RUN_FILE, { error: 'No run data yet. Run npm start to scrape.' });
  res.json(data);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nCE Broker Dashboard running at http://localhost:${PORT}`);
  console.log(`Routes:`);
  console.log(`  GET /           — Main Dashboard`);
  console.log(`  GET /cmo        — CMO Executive Dashboard`);
  console.log(`API endpoints:`);
  console.log(`  GET /api/status — Last run summary`);
  console.log(`  GET /api/history — Full history\n`);
});
