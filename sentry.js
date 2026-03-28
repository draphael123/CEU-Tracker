// sentry.js — Error tracking with Sentry
// Initialize early in the application lifecycle

'use strict';

const Sentry = require('@sentry/node');

const SENTRY_DSN = process.env.SENTRY_DSN;
const ENVIRONMENT = process.env.NODE_ENV || 'development';

let initialized = false;

/**
 * Initialize Sentry error tracking
 * Call this at the start of your application
 */
function initSentry() {
  if (initialized) return;

  if (!SENTRY_DSN) {
    console.log('[Sentry] No SENTRY_DSN configured - error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: ENVIRONMENT,
    tracesSampleRate: 0.1, // 10% of transactions for performance monitoring

    // Filter out non-critical errors
    beforeSend(event, hint) {
      const error = hint.originalException;

      // Don't send expected errors
      if (error?.message?.includes('nothing to commit')) {
        return null;
      }

      return event;
    },

    // Add custom tags
    initialScope: {
      tags: {
        component: 'ceu-tracker',
      },
    },
  });

  initialized = true;
  console.log(`[Sentry] Initialized (${ENVIRONMENT})`);
}

/**
 * Capture an exception and send to Sentry
 * @param {Error} error - The error to capture
 * @param {Object} context - Additional context (provider, platform, etc.)
 */
function captureError(error, context = {}) {
  if (!initialized) {
    console.error('[Sentry] Not initialized, error not sent:', error.message);
    return;
  }

  Sentry.withScope((scope) => {
    // Add context as tags and extra data
    if (context.provider) {
      scope.setTag('provider', context.provider);
    }
    if (context.platform) {
      scope.setTag('platform', context.platform);
    }
    if (context.operation) {
      scope.setTag('operation', context.operation);
    }

    scope.setExtras(context);
    Sentry.captureException(error);
  });
}

/**
 * Capture a message (non-error event)
 * @param {string} message - The message to capture
 * @param {string} level - Severity level (info, warning, error)
 * @param {Object} context - Additional context
 */
function captureMessage(message, level = 'info', context = {}) {
  if (!initialized) return;

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setExtras(context);
    Sentry.captureMessage(message);
  });
}

/**
 * Set user context for error tracking
 * @param {Object} user - User info (id, email, name)
 */
function setUser(user) {
  if (!initialized) return;
  Sentry.setUser(user);
}

/**
 * Add breadcrumb for debugging
 * @param {string} message - Breadcrumb message
 * @param {string} category - Category (scraper, platform, auth, etc.)
 * @param {Object} data - Additional data
 */
function addBreadcrumb(message, category = 'default', data = {}) {
  if (!initialized) return;

  Sentry.addBreadcrumb({
    message,
    category,
    data,
    level: 'info',
  });
}

/**
 * Start a transaction for performance monitoring
 * @param {string} name - Transaction name
 * @param {string} op - Operation type
 */
function startTransaction(name, op = 'task') {
  if (!initialized) return null;

  return Sentry.startTransaction({
    name,
    op,
  });
}

/**
 * Flush pending events before process exit
 */
async function flush(timeout = 2000) {
  if (!initialized) return;
  await Sentry.flush(timeout);
}

module.exports = {
  initSentry,
  captureError,
  captureMessage,
  setUser,
  addBreadcrumb,
  startTransaction,
  flush,
  Sentry, // Export raw Sentry for advanced usage
};
