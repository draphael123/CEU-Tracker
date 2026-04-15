/**
 * dashboard-helpers.js - Extracted utility functions from dashboard-builder.js
 *
 * This module contains helper functions for the dashboard builder to reduce
 * the size of the main dashboard-builder.js file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── HTML Escaping ────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Date Formatting ──────────────────────────────────────────────────────────

/**
 * Format a date as a readable string
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Format a date and time as a readable string
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted datetime string
 */
function formatDateTime(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

// ─── Status Colors ────────────────────────────────────────────────────────────

/**
 * Get the CSS color class for a status
 * @param {string} status - Status string
 * @returns {string} CSS color class
 */
function getStatusColor(status) {
  const colors = {
    'Complete': 'status-complete',
    'At Risk': 'status-risk',
    'In Progress': 'status-progress',
    'Unknown': 'status-unknown',
    'healthy': 'health-healthy',
    'degraded': 'health-degraded',
    'warning': 'health-warning',
    'critical': 'health-critical'
  };
  return colors[status] || 'status-unknown';
}

/**
 * Get the badge HTML for a status
 * @param {string} status - Status string
 * @returns {string} Badge HTML
 */
function getStatusBadge(status) {
  const color = getStatusColor(status);
  return `<span class="badge ${color}">${escapeHtml(status)}</span>`;
}

// ─── Number Formatting ────────────────────────────────────────────────────────

/**
 * Format hours with one decimal place
 * @param {number} hours - Hours to format
 * @returns {string} Formatted hours string
 */
function formatHours(hours) {
  if (hours === null || hours === undefined) return '—';
  return Number(hours).toFixed(1);
}

/**
 * Format currency amount
 * @param {number} amount - Amount to format
 * @returns {string} Formatted currency string
 */
function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '$0.00';
  return '$' + Number(amount).toFixed(2);
}

/**
 * Format a percentage
 * @param {number} value - Value (0-1 or 0-100)
 * @param {boolean} isDecimal - Whether value is decimal (0-1) or percentage (0-100)
 * @returns {string} Formatted percentage string
 */
function formatPercent(value, isDecimal = true) {
  if (value === null || value === undefined) return '0%';
  const pct = isDecimal ? value * 100 : value;
  return Math.round(pct) + '%';
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

/**
 * Generate HTML for a progress bar
 * @param {number} completed - Completed value
 * @param {number} required - Required/total value
 * @param {object} options - Options for the progress bar
 * @returns {string} Progress bar HTML
 */
function generateProgressBar(completed, required, options = {}) {
  const {
    showLabel = true,
    height = '8px',
    colorComplete = '#10b981',
    colorIncomplete = '#e5e7eb',
    colorOverflow = '#3b82f6'
  } = options;

  if (required === null || required === 0) {
    return '<div class="progress-bar-container">N/A</div>';
  }

  const pct = Math.min(100, Math.max(0, (completed / required) * 100));
  const isComplete = completed >= required;
  const color = isComplete ? colorComplete : colorIncomplete;

  let html = `
    <div class="progress-bar-container" style="height: ${height}; background: ${colorIncomplete}; border-radius: 4px; overflow: hidden;">
      <div class="progress-bar-fill" style="width: ${pct}%; height: 100%; background: ${isComplete ? colorComplete : '#fbbf24'}; transition: width 0.3s ease;"></div>
    </div>
  `;

  if (showLabel) {
    html += `<div class="progress-label">${formatHours(completed)} / ${formatHours(required)} hours</div>`;
  }

  return html;
}

// ─── Error Icons ──────────────────────────────────────────────────────────────

/**
 * Get the icon for an error code
 * @param {string} errorCode - Error code
 * @returns {string} Icon emoji
 */
function getErrorIcon(errorCode) {
  const icons = {
    'invalid_credentials': '🔑',
    'account_locked': '🔒',
    'mfa_required': '📱',
    'timeout': '⏱️',
    'site_changed': '🔧',
    'network_error': '🌐',
    'session_error': '🔄',
    'unknown': '❓'
  };
  return icons[errorCode] || '❓';
}

/**
 * Get the human-readable reason for an error code
 * @param {string} errorCode - Error code
 * @returns {string} Human-readable reason
 */
function getErrorReason(errorCode) {
  const reasons = {
    'invalid_credentials': 'Invalid credentials',
    'account_locked': 'Account locked',
    'mfa_required': '2FA required',
    'timeout': 'Timeout',
    'site_changed': 'Site changed',
    'network_error': 'Network error',
    'session_error': 'Session error',
    'unknown': 'Unknown error'
  };
  return reasons[errorCode] || 'Unknown';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // HTML
  escapeHtml,
  // Dates
  formatDate,
  formatDateTime,
  // Status
  getStatusColor,
  getStatusBadge,
  // Numbers
  formatHours,
  formatCurrency,
  formatPercent,
  // UI Components
  generateProgressBar,
  // Errors
  getErrorIcon,
  getErrorReason,
};
