// credential-health.js — Track credential health and login failures

const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, 'credential-health.json');

/**
 * Load existing credential health data
 */
function loadHealthData() {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch {
    return {
      lastUpdated: null,
      credentials: {}
    };
  }
}

/**
 * Save credential health data
 */
function saveHealthData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Record a successful login
 */
function recordSuccess(providerName, platform = 'CE Broker') {
  const data = loadHealthData();
  const key = `${providerName}|${platform}`;

  if (!data.credentials[key]) {
    data.credentials[key] = {
      providerName,
      platform,
      consecutiveFailures: 0,
      lastSuccess: null,
      lastFailure: null,
      failureHistory: []
    };
  }

  data.credentials[key].consecutiveFailures = 0;
  data.credentials[key].lastSuccess = new Date().toISOString();
  data.credentials[key].status = 'healthy';

  saveHealthData(data);
}

/**
 * Record a failed login
 */
function recordFailure(providerName, platform = 'CE Broker', errorMessage = '') {
  const data = loadHealthData();
  const key = `${providerName}|${platform}`;

  if (!data.credentials[key]) {
    data.credentials[key] = {
      providerName,
      platform,
      consecutiveFailures: 0,
      lastSuccess: null,
      lastFailure: null,
      failureHistory: []
    };
  }

  data.credentials[key].consecutiveFailures++;
  data.credentials[key].lastFailure = new Date().toISOString();
  data.credentials[key].lastError = errorMessage;

  // Keep last 10 failures
  data.credentials[key].failureHistory.unshift({
    timestamp: new Date().toISOString(),
    error: errorMessage
  });
  data.credentials[key].failureHistory = data.credentials[key].failureHistory.slice(0, 10);

  // Set status based on consecutive failures
  if (data.credentials[key].consecutiveFailures >= 3) {
    data.credentials[key].status = 'critical';
  } else if (data.credentials[key].consecutiveFailures >= 2) {
    data.credentials[key].status = 'warning';
  } else {
    data.credentials[key].status = 'degraded';
  }

  saveHealthData(data);
}

/**
 * Get health summary for dashboard
 */
function getHealthSummary() {
  const data = loadHealthData();
  const summary = {
    lastUpdated: data.lastUpdated,
    healthy: 0,
    degraded: 0,
    warning: 0,
    critical: 0,
    credentials: []
  };

  for (const [key, cred] of Object.entries(data.credentials)) {
    const status = cred.status || 'unknown';
    if (status === 'healthy') summary.healthy++;
    else if (status === 'degraded') summary.degraded++;
    else if (status === 'warning') summary.warning++;
    else if (status === 'critical') summary.critical++;

    summary.credentials.push({
      providerName: cred.providerName,
      platform: cred.platform,
      status: cred.status || 'unknown',
      consecutiveFailures: cred.consecutiveFailures || 0,
      lastSuccess: cred.lastSuccess,
      lastFailure: cred.lastFailure,
      lastError: cred.lastError
    });
  }

  // Sort: critical first, then warning, degraded, healthy
  const statusOrder = { critical: 0, warning: 1, degraded: 2, healthy: 3, unknown: 4 };
  summary.credentials.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return summary;
}

module.exports = {
  loadHealthData,
  recordSuccess,
  recordFailure,
  getHealthSummary
};
