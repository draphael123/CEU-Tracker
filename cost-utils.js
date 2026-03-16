// cost-utils.js — Cost tracking and spending calculation utilities

'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('./utils');

const COSTS_FILE = path.join(__dirname, 'costs.json');

// ─── Load/Save Costs ─────────────────────────────────────────────────────────

/**
 * Load cost data from costs.json
 * @returns {Object} Cost data with subscriptions and manualCosts
 */
function loadCosts() {
  try {
    if (fs.existsSync(COSTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
      return {
        subscriptions: data.subscriptions || { organization: [], perProvider: {} },
        manualCosts: data.manualCosts || {},
      };
    }
  } catch (err) {
    logger.warn(`Could not load costs.json: ${err.message}`);
  }
  return { subscriptions: { organization: [], perProvider: {} }, manualCosts: {} };
}

/**
 * Save cost data to costs.json
 * @param {Object} costData
 */
function saveCosts(costData) {
  try {
    fs.writeFileSync(COSTS_FILE, JSON.stringify(costData, null, 2));
    logger.info('Saved costs.json');
  } catch (err) {
    logger.error(`Could not save costs.json: ${err.message}`);
  }
}

// ─── Cost Calculations ───────────────────────────────────────────────────────

/**
 * Check if a date is within the last N months from today
 * @param {string|Date} dateStr - Date to check
 * @param {number} months - Number of months to look back
 * @returns {boolean}
 */
function isWithinMonths(dateStr, months) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  cutoff.setHours(0, 0, 0, 0);

  return date >= cutoff;
}

/**
 * Calculate rolling 12-month spending for a provider
 * @param {string} providerName
 * @param {Array} courses - Array of courses with cost field
 * @param {Object} subscriptions - Subscriptions data
 * @param {Object} platformDefaults - Default pricing for platforms
 * @returns {Object} { courseCosts, subscriptionCosts, totalSpend, estimatedCosts }
 */
function calculateRolling12MonthSpending(providerName, courses, subscriptions, platformDefaults = {}) {
  const result = {
    courseCosts: 0,
    estimatedCosts: 0,
    subscriptionCosts: 0,
    totalSpend: 0,
    courseCount: 0,
    courseDetails: [],
  };

  // Sum course costs within last 12 months
  if (courses && Array.isArray(courses)) {
    for (const course of courses) {
      if (isWithinMonths(course.date, 12)) {
        result.courseCount++;
        const platform = course.platform || 'Unknown';

        if (course.cost) {
          // Use actual cost
          const cost = parseFloat(course.cost) || 0;
          result.courseCosts += cost;
          result.courseDetails.push({
            name: course.name,
            cost: cost,
            date: course.date,
            platform: platform,
            isEstimate: false,
          });
        } else if (platformDefaults[platform]?.avgCoursePrice) {
          // Use platform default estimate
          const estimatedCost = platformDefaults[platform].avgCoursePrice;
          result.estimatedCosts += estimatedCost;
          result.courseDetails.push({
            name: course.name,
            cost: estimatedCost,
            date: course.date,
            platform: platform,
            isEstimate: true,
          });
        }
      }
    }
  }

  // Add organization subscriptions (prorated to 12 months)
  if (subscriptions?.organization) {
    for (const sub of subscriptions.organization) {
      if (sub.cost && isWithinMonths(sub.startDate, 12)) {
        const cost = parseFloat(sub.cost) || 0;
        // For annual subscriptions, include full cost; for monthly, multiply by 12
        const annualCost = sub.period === 'monthly' ? cost * 12 : cost;
        result.subscriptionCosts += annualCost;
      }
    }
  }

  // Add per-provider subscriptions
  if (subscriptions?.perProvider?.[providerName]) {
    for (const sub of subscriptions.perProvider[providerName]) {
      if (sub.cost && isWithinMonths(sub.startDate, 12)) {
        const cost = parseFloat(sub.cost) || 0;
        const annualCost = sub.period === 'monthly' ? cost * 12 : cost;
        result.subscriptionCosts += annualCost;
      }
    }
  }

  result.totalSpend = Math.round((result.courseCosts + result.estimatedCosts + result.subscriptionCosts) * 100) / 100;
  result.courseCosts = Math.round(result.courseCosts * 100) / 100;
  result.estimatedCosts = Math.round(result.estimatedCosts * 100) / 100;
  result.subscriptionCosts = Math.round(result.subscriptionCosts * 100) / 100;

  return result;
}

/**
 * Calculate spending breakdown by platform
 * @param {Array} courses - Array of courses with cost and platform fields
 * @returns {Object} { platformName: totalCost }
 */
function calculateSpendingByPlatform(courses) {
  const byPlatform = {};

  if (courses && Array.isArray(courses)) {
    for (const course of courses) {
      if (course.cost && isWithinMonths(course.date, 12)) {
        const platform = course.platform || 'Unknown';
        const cost = parseFloat(course.cost) || 0;
        byPlatform[platform] = (byPlatform[platform] || 0) + cost;
      }
    }
  }

  // Round all values
  for (const key of Object.keys(byPlatform)) {
    byPlatform[key] = Math.round(byPlatform[key] * 100) / 100;
  }

  return byPlatform;
}

/**
 * Calculate total organization-wide subscription costs
 * @param {Object} subscriptions
 * @returns {number}
 */
function getOrganizationSubscriptionCosts(subscriptions) {
  let total = 0;

  if (subscriptions?.organization) {
    for (const sub of subscriptions.organization) {
      if (sub.cost && isWithinMonths(sub.startDate, 12)) {
        const cost = parseFloat(sub.cost) || 0;
        const annualCost = sub.period === 'monthly' ? cost * 12 : cost;
        total += annualCost;
      }
    }
  }

  return Math.round(total * 100) / 100;
}

/**
 * Calculate cost per CEU hour
 * @param {number} totalCost
 * @param {number} totalHours
 * @returns {number|null}
 */
function calculateCostPerHour(totalCost, totalHours) {
  if (!totalCost || !totalHours || totalHours === 0) return null;
  return Math.round((totalCost / totalHours) * 100) / 100;
}

/**
 * Merge scraped costs with manual costs
 * @param {Array} scrapedCourses - Courses with scraped costs
 * @param {Array} manualCosts - Manual cost entries
 * @returns {Array} Merged courses with costs
 */
function mergeCostsIntoCourses(scrapedCourses, manualCosts) {
  const courses = [...(scrapedCourses || [])];

  // Index existing courses by name+date for matching
  const courseIndex = new Map();
  for (let i = 0; i < courses.length; i++) {
    const key = `${courses[i].name}|${courses[i].date}`;
    courseIndex.set(key, i);
  }

  // Apply manual costs
  if (manualCosts && Array.isArray(manualCosts)) {
    for (const manual of manualCosts) {
      const key = `${manual.courseName}|${manual.date}`;
      if (courseIndex.has(key)) {
        // Update existing course
        const idx = courseIndex.get(key);
        courses[idx].cost = manual.cost;
        courses[idx].platform = manual.platform || courses[idx].platform;
      } else {
        // Add as new entry (manual cost without matching course)
        courses.push({
          name: manual.courseName,
          date: manual.date,
          hours: manual.hours || 0,
          cost: manual.cost,
          platform: manual.platform || 'Manual Entry',
        });
      }
    }
  }

  return courses;
}

/**
 * Calculate spending stats for all providers
 * @param {Object} courseHistory - Course history keyed by provider name
 * @param {Object} costData - Cost data from costs.json
 * @returns {Object} Spending stats per provider
 */
function calculateAllProviderSpending(courseHistory, costData) {
  const platformDefaults = costData.platformDefaults || {};

  const stats = {
    byProvider: {},
    totalOrgSpend: 0,
    totalActualCosts: 0,
    totalEstimatedCosts: 0,
    orgSubscriptions: getOrganizationSubscriptionCosts(costData.subscriptions),
    byPlatform: {},
  };

  for (const providerName of Object.keys(courseHistory)) {
    const providerData = courseHistory[providerName];
    const courses = mergeCostsIntoCourses(
      providerData.courses || [],
      costData.manualCosts?.[providerName] || []
    );

    const spending = calculateRolling12MonthSpending(
      providerName,
      courses,
      costData.subscriptions,
      platformDefaults
    );

    const hoursCompleted = courses.reduce((sum, c) => {
      if (isWithinMonths(c.date, 12)) {
        return sum + (parseFloat(c.hours) || 0);
      }
      return sum;
    }, 0);

    stats.byProvider[providerName] = {
      ...spending,
      hoursCompleted: Math.round(hoursCompleted * 10) / 10,
      costPerHour: calculateCostPerHour(spending.totalSpend, hoursCompleted),
    };

    stats.totalOrgSpend += spending.totalSpend;
    stats.totalActualCosts += spending.courseCosts;
    stats.totalEstimatedCosts += spending.estimatedCosts;

    // Aggregate platform spending
    const platformSpend = calculateSpendingByPlatform(courses);
    for (const [platform, cost] of Object.entries(platformSpend)) {
      stats.byPlatform[platform] = (stats.byPlatform[platform] || 0) + cost;
    }
  }

  // Add org subscriptions to total
  stats.totalOrgSpend += stats.orgSubscriptions;
  stats.totalOrgSpend = Math.round(stats.totalOrgSpend * 100) / 100;
  stats.totalActualCosts = Math.round(stats.totalActualCosts * 100) / 100;
  stats.totalEstimatedCosts = Math.round(stats.totalEstimatedCosts * 100) / 100;

  // Round platform totals
  for (const key of Object.keys(stats.byPlatform)) {
    stats.byPlatform[key] = Math.round(stats.byPlatform[key] * 100) / 100;
  }

  return stats;
}

module.exports = {
  loadCosts,
  saveCosts,
  isWithinMonths,
  calculateRolling12MonthSpending,
  calculateSpendingByPlatform,
  getOrganizationSubscriptionCosts,
  calculateCostPerHour,
  mergeCostsIntoCourses,
  calculateAllProviderSpending,
};
