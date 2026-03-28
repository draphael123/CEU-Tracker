// Compliance Forecasting Module
// Predicts likelihood of meeting CEU requirements before deadline

import type {
  Provider,
  Course,
  ComplianceForecast,
  ScenarioResult,
  VelocityMetrics,
} from '@/types';
import {
  daysUntil,
  addWeeks,
  getRecentCourses,
  sumHours,
  groupCoursesByWeek,
} from '@/lib/utils';

/**
 * Generate a compliance forecast for a provider
 */
export function generateForecast(provider: Provider, courses: Course[]): ComplianceForecast {
  const velocity = calculateVelocityMetrics(courses);
  const days = daysUntil(provider.renewalDeadline);

  // If already complete
  if (provider.hoursRemaining <= 0) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      completionProbability: 100,
      projectedCompletionDate: null, // Already complete
      scenarios: {
        optimistic: createScenario(true, null, 0, 0),
        realistic: createScenario(true, null, 0, 0),
        pessimistic: createScenario(true, null, 0, 0),
      },
    };
  }

  // Calculate scenarios
  const scenarios = {
    optimistic: simulateCompletion(provider, velocity.avgWeeklyHours * 1.5),
    realistic: simulateCompletion(provider, velocity.avgWeeklyHours),
    pessimistic: simulateCompletion(
      provider,
      Math.max(velocity.avgWeeklyHours * 0.5, 0.5)
    ),
  };

  // Calculate completion probability
  const completionProbability = calculateCompletionProbability(
    provider,
    velocity,
    scenarios,
    days
  );

  return {
    providerId: provider.id,
    providerName: provider.name,
    completionProbability,
    projectedCompletionDate: scenarios.realistic.projectedDate,
    scenarios,
  };
}

/**
 * Calculate velocity metrics from course history
 */
export function calculateVelocityMetrics(courses: Course[]): VelocityMetrics {
  const last30 = getRecentCourses(courses, 30);
  const last60 = getRecentCourses(courses, 60);
  const last90 = getRecentCourses(courses, 90);

  const hoursLast30 = sumHours(last30);
  const hoursLast60 = sumHours(last60);
  const hoursLast90 = sumHours(last90);

  // Calculate weekly rates from the last 12 weeks
  const weeklyData = groupCoursesByWeek(getRecentCourses(courses, 84)); // 12 weeks
  const weeklyRates: number[] = [];
  const now = new Date();

  for (let i = 0; i < 12; i++) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (i + 1) * 7);
    const day = weekStart.getDay();
    const monday = new Date(weekStart);
    monday.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
    const weekKey = monday.toISOString().split('T')[0];

    const weekData = weeklyData.get(weekKey);
    weeklyRates.push(weekData?.totalHours || 0);
  }

  // Calculate average weekly hours (use time-weighted approach)
  const avgWeeklyHours = exponentialSmoothing(weeklyRates.reverse(), 0.3);

  // Determine trend
  const recentAvg = (hoursLast30 / 30) * 7; // Weekly rate from last 30 days
  const priorAvg = ((hoursLast90 - hoursLast30) / 60) * 7; // Weekly rate from prior 60 days

  let trend: VelocityMetrics['trend'];
  if (hoursLast90 === 0) {
    trend = 'inactive';
  } else if (recentAvg > priorAvg * 1.3) {
    trend = 'accelerating';
  } else if (recentAvg < priorAvg * 0.7) {
    trend = 'decelerating';
  } else {
    trend = 'steady';
  }

  return {
    avgWeeklyHours: Math.max(avgWeeklyHours, 0),
    last30DaysHours: hoursLast30,
    last60DaysHours: hoursLast60,
    last90DaysHours: hoursLast90,
    trend,
    weeklyRates,
  };
}

/**
 * Exponential smoothing for time-weighted averaging
 * More recent data gets higher weight
 */
function exponentialSmoothing(data: number[], alpha: number): number {
  if (data.length === 0) return 0;

  let smoothed = data[0];
  for (let i = 1; i < data.length; i++) {
    smoothed = alpha * data[i] + (1 - alpha) * smoothed;
  }
  return smoothed;
}

/**
 * Simulate completion at a given pace
 */
function simulateCompletion(provider: Provider, hoursPerWeek: number): ScenarioResult {
  const { hoursRemaining, renewalDeadline } = provider;
  const days = daysUntil(renewalDeadline);

  // Already complete
  if (hoursRemaining <= 0) {
    return createScenario(true, null, 0, hoursPerWeek);
  }

  // No pace = won't complete
  if (hoursPerWeek <= 0) {
    return createScenario(false, null, Infinity, 0);
  }

  // Calculate weeks needed
  const weeksNeeded = hoursRemaining / hoursPerWeek;
  const daysNeeded = Math.ceil(weeksNeeded * 7);

  // Project completion date
  const projectedDate = addWeeks(new Date(), weeksNeeded).toISOString().split('T')[0];

  // Will complete if projected date is before deadline
  const willComplete = days === null || daysNeeded <= days;

  return createScenario(willComplete, projectedDate, daysNeeded, hoursPerWeek);
}

/**
 * Create a scenario result object
 */
function createScenario(
  willComplete: boolean,
  projectedDate: string | null,
  daysNeeded: number,
  hoursPerWeek: number
): ScenarioResult {
  return {
    willComplete,
    projectedDate,
    daysNeeded,
    hoursPerWeek,
  };
}

/**
 * Calculate completion probability based on scenarios and historical patterns
 */
function calculateCompletionProbability(
  provider: Provider,
  velocity: VelocityMetrics,
  scenarios: ComplianceForecast['scenarios'],
  daysToDeadline: number | null
): number {
  // Already complete
  if (provider.hoursRemaining <= 0) return 100;

  // No deadline known - base on realistic scenario
  if (daysToDeadline === null) {
    return scenarios.realistic.willComplete ? 70 : 30;
  }

  // Overdue
  if (daysToDeadline <= 0) return 0;

  // Base probability from realistic scenario
  let probability = scenarios.realistic.willComplete ? 75 : 25;

  // Adjust based on velocity trend
  switch (velocity.trend) {
    case 'accelerating':
      probability += 15;
      break;
    case 'steady':
      probability += 5;
      break;
    case 'decelerating':
      probability -= 15;
      break;
    case 'inactive':
      probability -= 25;
      break;
  }

  // Adjust based on buffer time
  if (scenarios.realistic.willComplete) {
    const buffer = daysToDeadline - scenarios.realistic.daysNeeded;
    if (buffer > 60) probability += 10;
    else if (buffer > 30) probability += 5;
    else if (buffer < 7) probability -= 10;
  }

  // Adjust based on hours per week required vs typical
  const requiredPace = provider.hoursRemaining / (daysToDeadline / 7);
  const actualPace = velocity.avgWeeklyHours;

  if (actualPace >= requiredPace * 1.5) {
    probability += 10;
  } else if (actualPace >= requiredPace) {
    probability += 5;
  } else if (actualPace < requiredPace * 0.5) {
    probability -= 15;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, Math.round(probability)));
}

/**
 * Get forecast status message
 */
export function getForecastMessage(forecast: ComplianceForecast): string {
  if (forecast.completionProbability === 100) {
    return 'All requirements complete';
  }

  if (forecast.completionProbability >= 80) {
    return 'On track to complete on time';
  }

  if (forecast.completionProbability >= 60) {
    return 'Likely to complete, but pace should be maintained';
  }

  if (forecast.completionProbability >= 40) {
    return 'At risk - may need to increase completion pace';
  }

  if (forecast.completionProbability >= 20) {
    return 'High risk - immediate action needed';
  }

  return 'Critical - unlikely to meet deadline at current pace';
}
