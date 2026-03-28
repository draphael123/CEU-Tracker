// risk-prediction.js — ML-based risk prediction for CEU compliance
// Uses statistical analysis and historical patterns to predict compliance risks

'use strict';

/**
 * Risk Prediction Model
 * Analyzes provider compliance data to predict risk levels
 */
class RiskPredictor {
  constructor() {
    // Model weights (can be tuned based on historical data)
    this.weights = {
      daysToDeadline: 0.35,      // How close is the deadline
      hoursRemaining: 0.25,       // How many hours left to complete
      completionRate: 0.20,       // Historical completion rate
      courseFrequency: 0.10,      // How often they complete courses
      lastActivity: 0.10,         // Recency of last course completion
    };

    // Risk thresholds
    this.thresholds = {
      critical: 0.8,  // 80%+ risk
      high: 0.6,      // 60-80% risk
      medium: 0.4,    // 40-60% risk
      low: 0.2,       // 20-40% risk
    };
  }

  /**
   * Calculate risk score for a provider
   * @param {Object} provider - Provider data with compliance info
   * @param {Object} history - Historical course completion data
   * @returns {Object} Risk assessment with score and recommendations
   */
  calculateRisk(provider, history = {}) {
    const factors = {
      daysToDeadline: this.calculateDeadlineFactor(provider.renewalDeadline),
      hoursRemaining: this.calculateHoursFactor(provider.hoursRemaining, provider.hoursRequired),
      completionRate: this.calculateCompletionRate(history.courses || []),
      courseFrequency: this.calculateFrequencyFactor(history.courses || []),
      lastActivity: this.calculateActivityFactor(history.lastCourseDate),
    };

    // Calculate weighted risk score
    let riskScore = 0;
    for (const [factor, weight] of Object.entries(this.weights)) {
      riskScore += (factors[factor] || 0) * weight;
    }

    // Clamp to 0-1 range
    riskScore = Math.max(0, Math.min(1, riskScore));

    return {
      score: Math.round(riskScore * 100) / 100,
      percentage: Math.round(riskScore * 100),
      level: this.getRiskLevel(riskScore),
      factors,
      recommendations: this.generateRecommendations(factors, provider),
      predictedCompletion: this.predictCompletion(provider, factors),
    };
  }

  /**
   * Calculate deadline risk factor (0-1)
   * Higher score = higher risk (deadline approaching)
   */
  calculateDeadlineFactor(deadline) {
    if (!deadline) return 0.5; // Unknown = medium risk

    const daysRemaining = Math.ceil(
      (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    if (daysRemaining < 0) return 1.0;    // Past due
    if (daysRemaining <= 30) return 0.9;  // Critical
    if (daysRemaining <= 60) return 0.7;  // High
    if (daysRemaining <= 90) return 0.5;  // Medium
    if (daysRemaining <= 180) return 0.3; // Low
    return 0.1;                            // Very low
  }

  /**
   * Calculate hours remaining risk factor (0-1)
   * Higher score = more hours remaining = higher risk
   */
  calculateHoursFactor(hoursRemaining, hoursRequired) {
    if (!hoursRequired || hoursRequired === 0) return 0;
    if (!hoursRemaining || hoursRemaining <= 0) return 0;

    const percentageRemaining = hoursRemaining / hoursRequired;

    if (percentageRemaining >= 1.0) return 1.0;   // Nothing completed
    if (percentageRemaining >= 0.75) return 0.8;  // 25% or less done
    if (percentageRemaining >= 0.50) return 0.6;  // 50% or less done
    if (percentageRemaining >= 0.25) return 0.3;  // 75% or less done
    return 0.1;                                    // Almost done
  }

  /**
   * Calculate historical completion rate factor
   * Lower completion rate = higher risk
   */
  calculateCompletionRate(courses) {
    if (!courses || courses.length === 0) return 0.5; // No history = medium risk

    // Look at course patterns over the last 2 years
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    const recentCourses = courses.filter(c => {
      const date = new Date(c.date);
      return date >= twoYearsAgo;
    });

    if (recentCourses.length === 0) return 0.7; // No recent activity

    // Calculate average hours per month
    const totalHours = recentCourses.reduce((sum, c) => sum + (parseFloat(c.hours) || 0), 0);
    const monthsSpan = 24; // 2 years
    const avgHoursPerMonth = totalHours / monthsSpan;

    // Normalize: assume 2 hours/month is good pace
    const paceRatio = avgHoursPerMonth / 2;

    if (paceRatio >= 1.0) return 0.1;  // Ahead of pace
    if (paceRatio >= 0.75) return 0.3; // On pace
    if (paceRatio >= 0.5) return 0.5;  // Behind pace
    if (paceRatio >= 0.25) return 0.7; // Significantly behind
    return 0.9;                         // Very behind
  }

  /**
   * Calculate course frequency factor
   * Irregular completion pattern = higher risk
   */
  calculateFrequencyFactor(courses) {
    if (!courses || courses.length < 3) return 0.5;

    // Calculate standard deviation of gaps between courses
    const sortedDates = courses
      .map(c => new Date(c.date).getTime())
      .sort((a, b) => a - b);

    if (sortedDates.length < 2) return 0.5;

    const gaps = [];
    for (let i = 1; i < sortedDates.length; i++) {
      gaps.push((sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24));
    }

    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length;
    const stdDev = Math.sqrt(variance);

    // High standard deviation = irregular pattern = higher risk
    const coefficientOfVariation = stdDev / avgGap;

    if (coefficientOfVariation <= 0.3) return 0.1;  // Very consistent
    if (coefficientOfVariation <= 0.5) return 0.3;  // Consistent
    if (coefficientOfVariation <= 0.7) return 0.5;  // Somewhat irregular
    if (coefficientOfVariation <= 1.0) return 0.7;  // Irregular
    return 0.9;                                      // Very irregular
  }

  /**
   * Calculate activity recency factor
   * Long time since last course = higher risk
   */
  calculateActivityFactor(lastCourseDate) {
    if (!lastCourseDate) return 0.7; // No activity record

    const daysSinceLastCourse = Math.ceil(
      (Date.now() - new Date(lastCourseDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceLastCourse <= 30) return 0.1;   // Very recent
    if (daysSinceLastCourse <= 60) return 0.2;   // Recent
    if (daysSinceLastCourse <= 90) return 0.3;   // Moderately recent
    if (daysSinceLastCourse <= 180) return 0.5;  // Some time ago
    if (daysSinceLastCourse <= 365) return 0.7;  // Long time ago
    return 0.9;                                   // Very long time ago
  }

  /**
   * Get risk level label from score
   */
  getRiskLevel(score) {
    if (score >= this.thresholds.critical) return 'critical';
    if (score >= this.thresholds.high) return 'high';
    if (score >= this.thresholds.medium) return 'medium';
    if (score >= this.thresholds.low) return 'low';
    return 'minimal';
  }

  /**
   * Generate actionable recommendations based on risk factors
   */
  generateRecommendations(factors, provider) {
    const recommendations = [];

    if (factors.daysToDeadline >= 0.7) {
      const daysLeft = provider.renewalDeadline
        ? Math.ceil((new Date(provider.renewalDeadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;
      recommendations.push({
        priority: 'high',
        category: 'deadline',
        message: `Deadline approaching${daysLeft ? ` in ${daysLeft} days` : ''}. Prioritize course completion.`,
        action: 'Schedule dedicated time for CEU courses this week.',
      });
    }

    if (factors.hoursRemaining >= 0.6) {
      recommendations.push({
        priority: 'high',
        category: 'hours',
        message: `${provider.hoursRemaining || 'Multiple'} hours still needed.`,
        action: 'Consider intensive online courses to catch up quickly.',
      });
    }

    if (factors.completionRate >= 0.6) {
      recommendations.push({
        priority: 'medium',
        category: 'pace',
        message: 'Historical completion rate is below average.',
        action: 'Set up monthly CEU reminders to maintain consistent progress.',
      });
    }

    if (factors.courseFrequency >= 0.6) {
      recommendations.push({
        priority: 'medium',
        category: 'consistency',
        message: 'Course completion pattern is irregular.',
        action: 'Create a regular schedule for completing CEU courses.',
      });
    }

    if (factors.lastActivity >= 0.6) {
      recommendations.push({
        priority: 'medium',
        category: 'activity',
        message: 'No recent course activity detected.',
        action: 'Start with a short course to rebuild momentum.',
      });
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return recommendations;
  }

  /**
   * Predict likelihood of completing requirements on time
   */
  predictCompletion(provider, factors) {
    if (!provider.renewalDeadline || !provider.hoursRemaining) {
      return { likelihood: null, confidence: 'low' };
    }

    const daysRemaining = Math.ceil(
      (new Date(provider.renewalDeadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    if (daysRemaining <= 0) {
      return {
        likelihood: 0,
        confidence: 'high',
        message: 'Deadline has passed.',
      };
    }

    // Calculate required pace (hours per day)
    const requiredPace = provider.hoursRemaining / daysRemaining;

    // Estimate based on historical factors
    const historicalFactor = 1 - (factors.completionRate + factors.courseFrequency) / 2;
    const estimatedDailyPace = historicalFactor * 0.5; // Assume 0.5 hrs/day at 100% historical performance

    const likelihoodRatio = estimatedDailyPace / requiredPace;
    const likelihood = Math.min(1, likelihoodRatio);

    let confidence = 'medium';
    if (factors.completionRate === 0.5 && factors.courseFrequency === 0.5) {
      confidence = 'low'; // No historical data
    } else if (Math.abs(factors.completionRate - factors.courseFrequency) < 0.2) {
      confidence = 'high'; // Consistent patterns
    }

    return {
      likelihood: Math.round(likelihood * 100),
      confidence,
      requiredPacePerWeek: Math.round(requiredPace * 7 * 10) / 10,
      message: likelihood >= 0.8
        ? 'On track to complete requirements.'
        : likelihood >= 0.5
        ? 'May need to increase completion pace.'
        : 'Significant effort needed to meet deadline.',
    };
  }

  /**
   * Batch analyze multiple providers
   */
  analyzeAll(providers, historyMap = {}) {
    return providers.map(provider => ({
      name: provider.name,
      type: provider.type,
      ...this.calculateRisk(provider, historyMap[provider.name] || {}),
    }));
  }

  /**
   * Get summary statistics for a group of providers
   */
  getSummaryStats(predictions) {
    const stats = {
      total: predictions.length,
      byLevel: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        minimal: 0,
      },
      averageRisk: 0,
      highestRisk: null,
      recommendations: [],
    };

    for (const pred of predictions) {
      stats.byLevel[pred.level]++;
      stats.averageRisk += pred.score;

      if (!stats.highestRisk || pred.score > stats.highestRisk.score) {
        stats.highestRisk = { name: pred.name, score: pred.score, level: pred.level };
      }
    }

    stats.averageRisk = predictions.length > 0
      ? Math.round((stats.averageRisk / predictions.length) * 100) / 100
      : 0;

    // Aggregate top recommendations
    const allRecs = predictions.flatMap(p => p.recommendations || []);
    const recCounts = {};
    for (const rec of allRecs) {
      const key = rec.category;
      recCounts[key] = (recCounts[key] || 0) + 1;
    }
    stats.recommendations = Object.entries(recCounts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return stats;
  }
}

// Singleton instance
const predictor = new RiskPredictor();

module.exports = {
  RiskPredictor,
  calculateRisk: (provider, history) => predictor.calculateRisk(provider, history),
  analyzeAll: (providers, historyMap) => predictor.analyzeAll(providers, historyMap),
  getSummaryStats: (predictions) => predictor.getSummaryStats(predictions),
};
