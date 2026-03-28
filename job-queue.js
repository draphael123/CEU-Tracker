// job-queue.js — BullMQ job queue for scheduled scraping tasks
// Requires Redis for persistence

'use strict';

const { Queue, Worker, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE_NAME = 'ceu-scraper';

let connection = null;
let queue = null;
let worker = null;

/**
 * Get Redis connection (lazy initialization)
 */
function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    connection.on('error', (err) => {
      console.error('[JobQueue] Redis connection error:', err.message);
    });

    connection.on('connect', () => {
      console.log('[JobQueue] Connected to Redis');
    });
  }
  return connection;
}

/**
 * Initialize the job queue
 */
function initQueue() {
  if (queue) return queue;

  const conn = getConnection();
  queue = new Queue(QUEUE_NAME, { connection: conn });

  console.log('[JobQueue] Queue initialized:', QUEUE_NAME);
  return queue;
}

/**
 * Add a scrape job to the queue
 * @param {Object} options - Job options
 * @param {string[]} options.providerNames - Optional list of provider names to scrape
 * @param {boolean} options.fullRun - Whether to run all providers
 * @param {number} options.priority - Job priority (lower = higher priority)
 */
async function addScrapeJob(options = {}) {
  const q = initQueue();

  const job = await q.add('scrape', {
    providerNames: options.providerNames || null,
    fullRun: options.fullRun !== false,
    requestedAt: new Date().toISOString(),
  }, {
    priority: options.priority || 10,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000, // 1 minute initial delay
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 100,     // Keep last 100 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  });

  console.log(`[JobQueue] Added scrape job: ${job.id}`);
  return job;
}

/**
 * Schedule a recurring scrape job
 * @param {string} cronExpression - Cron expression (e.g., '0 22 * * *' for 10 PM daily)
 * @param {Object} options - Job options
 */
async function scheduleRecurringScrape(cronExpression, options = {}) {
  const q = initQueue();

  // Remove existing scheduled job
  const repeatableJobs = await q.getRepeatableJobs();
  for (const job of repeatableJobs) {
    if (job.name === 'scheduled-scrape') {
      await q.removeRepeatableByKey(job.key);
    }
  }

  // Add new scheduled job
  await q.add('scheduled-scrape', {
    fullRun: true,
    scheduled: true,
    ...options,
  }, {
    repeat: {
      pattern: cronExpression,
      tz: 'America/New_York',
    },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000,
    },
  });

  console.log(`[JobQueue] Scheduled recurring scrape: ${cronExpression}`);
}

/**
 * Start the worker to process jobs
 * @param {Function} scrapeHandler - Function to handle scrape jobs
 */
function startWorker(scrapeHandler) {
  if (worker) {
    console.log('[JobQueue] Worker already running');
    return worker;
  }

  const conn = getConnection();

  worker = new Worker(QUEUE_NAME, async (job) => {
    console.log(`[JobQueue] Processing job: ${job.id} (${job.name})`);

    const startTime = Date.now();

    try {
      const result = await scrapeHandler(job.data);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[JobQueue] Job ${job.id} completed in ${duration}s`);

      return result;
    } catch (error) {
      console.error(`[JobQueue] Job ${job.id} failed:`, error.message);
      throw error;
    }
  }, {
    connection: conn,
    concurrency: 1, // Only one scrape at a time
  });

  worker.on('completed', (job, result) => {
    console.log(`[JobQueue] Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[JobQueue] Job ${job?.id} failed:`, error.message);
  });

  worker.on('error', (error) => {
    console.error('[JobQueue] Worker error:', error.message);
  });

  console.log('[JobQueue] Worker started');
  return worker;
}

/**
 * Get queue status
 */
async function getQueueStatus() {
  const q = initQueue();

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getCompletedCount(),
    q.getFailedCount(),
    q.getDelayedCount(),
  ]);

  const repeatableJobs = await q.getRepeatableJobs();

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    scheduledJobs: repeatableJobs.map(j => ({
      name: j.name,
      pattern: j.pattern,
      next: j.next ? new Date(j.next).toISOString() : null,
    })),
  };
}

/**
 * Get recent jobs
 */
async function getRecentJobs(limit = 10) {
  const q = initQueue();

  const [completed, failed, active, waiting] = await Promise.all([
    q.getCompleted(0, limit),
    q.getFailed(0, limit),
    q.getActive(0, limit),
    q.getWaiting(0, limit),
  ]);

  return {
    completed: completed.map(formatJob),
    failed: failed.map(formatJob),
    active: active.map(formatJob),
    waiting: waiting.map(formatJob),
  };
}

function formatJob(job) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    status: job.finishedOn ? 'completed' : job.failedReason ? 'failed' : 'active',
    createdAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    failedReason: job.failedReason || null,
    attemptsMade: job.attemptsMade,
  };
}

/**
 * Trigger a manual scrape via the queue
 */
async function triggerManualScrape(providerNames = null) {
  return addScrapeJob({
    providerNames,
    fullRun: !providerNames,
    priority: 1, // High priority for manual runs
  });
}

/**
 * Close all connections
 */
async function closeQueue() {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
  console.log('[JobQueue] Closed all connections');
}

module.exports = {
  initQueue,
  addScrapeJob,
  scheduleRecurringScrape,
  startWorker,
  getQueueStatus,
  getRecentJobs,
  triggerManualScrape,
  closeQueue,
};
