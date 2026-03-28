// Risk Scoring Algorithm for CEU Compliance
// Balanced approach: catches real issues without excessive false positives

import type { Provider, Course, RiskAssessment, RiskFactor, RiskLevel } from '@/types';
import { daysUntil, getRecentCourses, sumHours } from '@/lib/utils';

/**
 * Risk factor weights (total: 100 points)
 */
const WEIGHTS = {
  TIME_URGENCY: 40, // Deadline proximity
  COMPLETION_GAP: 30, // Hours remaining vs time available
  VELOCITY_TREND: 15, // Recent completion rate trend
  HISTORICAL_PATTERN: 10, // Past compliance history
  CREDENTIAL_HEALTH: 5, // Platform login reliability
};

/**
 * Risk level thresholds (balanced approach)
 */
const RISK_THRESHOLDS = {
  LOW: 25,
  MEDIUM: 50,
  HIGH: 75,
  // Above 75 = CRITICAL
};

/**
 * Calculate the overall risk score for a provider
 */
export function calculateRiskScore(
  provider: Provider,
  courses: Course[] = [],
  credentialHealthScore: number = 0 // 0-5, where 0 is healthy
): RiskAssessment {
  const factors: RiskFactor[] = [];

  // Factor 1: Time Urgency (0-40 points)
  const timeUrgency = calculateTimeUrgency(provider);
  factors.push({
    name: 'Time Urgency',
    score: timeUrgency.score,
    maxScore: WEIGHTS.TIME_URGENCY,
    description: timeUrgency.description,
  });

  // Factor 2: Completion Gap (0-30 points)
  const completionGap = calculateCompletionGap(provider);
  factors.push({
    name: 'Completion Gap',
    score: completionGap.score,
    maxScore: WEIGHTS.COMPLETION_GAP,
    description: completionGap.description,
  });

  // Factor 3: Velocity Trend (0-15 points)
  const velocityTrend = calculateVelocityTrend(provider, courses);
  factors.push({
    name: 'Velocity Trend',
    score: velocityTrend.score,
    maxScore: WEIGHTS.VELOCITY_TREND,
    description: velocityTrend.description,
  });

  // Factor 4: Historical Pattern (0-10 points)
  const historicalPattern = calculateHistoricalPattern(provider, courses);
  factors.push({
    name: 'Historical Pattern',
    score: historicalPattern.score,
    maxScore: WEIGHTS.HISTORICAL_PATTERN,
    description: historicalPattern.description,
  });

  // Factor 5: Credential Health (0-5 points)
  factors.push({
    name: 'Credential Health',
    score: credentialHealthScore,
    maxScore: WEIGHTS.CREDENTIAL_HEALTH,
    description:
      credentialHealthScore === 0
        ? 'All platform logins working'
        : `${credentialHealthScore} credential issue(s) detected`,
  });

  // Calculate total score
  const totalScore = factors.reduce((sum, f) => sum + f.score, 0);

  // Determine risk level
  const level = getRiskLevel(totalScore);

  // Calculate confidence based on data availability
  const confidence = calculateConfidence(provider, courses);

  return {
    score: totalScore,
    level,
    factors,
    confidence,
  };
}

/**
 * Calculate time urgency factor (0-40 points)
 * Uses exponential curve for deadline proximity
 */
function calculateTimeUrgency(provider: Provider): { score: number; description: string } {
  const days = daysUntil(provider.renewalDeadline);

  // If complete, no time urgency
  if (provider.hoursRemaining <= 0) {
    return { score: 0, description: 'All requirements complete' };
  }

  if (days === null) {
    return { score: 20, description: 'Deadline unknown - medium concern' };
  }

  // Exponential urgency curve
  if (days <= 0) {
    return { score: 40, description: `Overdue by ${Math.abs(days)} days` };
  }
  if (days <= 30) {
    return { score: 35, description: `Only ${days} days until deadline - critical` };
  }
  if (days <= 60) {
    return { score: 25, description: `${days} days until deadline - high urgency` };
  }
  if (days <= 90) {
    return { score: 15, description: `${days} days until deadline - medium urgency` };
  }
  if (days <= 180) {
    return { score: 8, description: `${days} days until deadline - low urgency` };
  }
  return { score: 0, description: `${days} days until deadline - comfortable` };
}

/**
 * Calculate completion gap factor (0-30 points)
 * Based on required pace vs typical completion rates
 */
function calculateCompletionGap(provider: Provider): { score: number; description: string } {
  const { hoursRemaining, hoursRequired } = provider;
  const days = daysUntil(provider.renewalDeadline);

  // If complete, no gap
  if (hoursRemaining <= 0) {
    return { score: 0, description: 'Requirements met' };
  }

  // If no deadline, moderate concern
  if (days === null || days <= 0) {
    if (days !== null && days <= 0) {
      return { score: 30, description: `${hoursRemaining} hours overdue` };
    }
    return { score: 15, description: `${hoursRemaining} hours needed, deadline unknown` };
  }

  // Calculate required pace (hours per week)
  const weeksRemaining = days / 7;
  const requiredPace = hoursRemaining / weeksRemaining;

  // Typical completion rate: 2-4 hours per week is reasonable
  if (requiredPace > 10) {
    return {
      score: 30,
      description: `Need ${requiredPace.toFixed(1)} hrs/week - nearly impossible pace`,
    };
  }
  if (requiredPace > 5) {
    return {
      score: 22,
      description: `Need ${requiredPace.toFixed(1)} hrs/week - very aggressive pace`,
    };
  }
  if (requiredPace > 3) {
    return {
      score: 15,
      description: `Need ${requiredPace.toFixed(1)} hrs/week - challenging pace`,
    };
  }
  if (requiredPace > 1) {
    return {
      score: 8,
      description: `Need ${requiredPace.toFixed(1)} hrs/week - moderate pace`,
    };
  }
  return {
    score: 2,
    description: `Need ${requiredPace.toFixed(1)} hrs/week - easy pace`,
  };
}

/**
 * Calculate velocity trend factor (0-15 points)
 * Analyzes course completion patterns over last 90 days
 */
function calculateVelocityTrend(
  provider: Provider,
  courses: Course[]
): { score: number; description: string } {
  // If complete, velocity doesn't matter
  if (provider.hoursRemaining <= 0) {
    return { score: 0, description: 'Requirements already met' };
  }

  const last30 = getRecentCourses(courses, 30);
  const last60 = getRecentCourses(courses, 60);
  const last90 = getRecentCourses(courses, 90);

  const hoursLast30 = sumHours(last30);
  const hoursLast60 = sumHours(last60);
  const hoursLast90 = sumHours(last90);

  // No activity at all
  if (hoursLast90 === 0) {
    return {
      score: 15,
      description: 'No course completions in last 90 days',
    };
  }

  // Calculate trend (comparing recent vs prior)
  const recentPace = hoursLast30; // Last 30 days
  const priorPace = (hoursLast90 - hoursLast30) / 2; // Average of prior 60 days (per 30-day period)

  // No recent activity
  if (recentPace === 0 && provider.hoursRemaining > 0) {
    return {
      score: 12,
      description: 'No activity in last 30 days',
    };
  }

  // Accelerating
  if (recentPace > priorPace * 1.5) {
    return {
      score: 0,
      description: `Accelerating: ${hoursLast30.toFixed(1)} hrs in last 30 days`,
    };
  }

  // Steady
  if (recentPace >= priorPace * 0.8) {
    return {
      score: 5,
      description: `Steady pace: ${hoursLast30.toFixed(1)} hrs in last 30 days`,
    };
  }

  // Slowing down
  if (recentPace >= priorPace * 0.5) {
    return {
      score: 10,
      description: 'Pace slowing down',
    };
  }

  // Significant slowdown
  return {
    score: 15,
    description: 'Significant slowdown in course completion',
  };
}

/**
 * Calculate historical pattern factor (0-10 points)
 * Based on course completion history patterns
 */
function calculateHistoricalPattern(
  provider: Provider,
  courses: Course[]
): { score: number; description: string } {
  // If complete, good pattern
  if (provider.hoursRemaining <= 0) {
    return { score: 0, description: 'Currently compliant' };
  }

  // Check if they have any course history
  if (courses.length === 0) {
    return { score: 5, description: 'No course history available' };
  }

  // Check for consistent activity
  const last180 = getRecentCourses(courses, 180);
  const monthlyActivity = last180.length / 6; // Average courses per month

  if (monthlyActivity >= 2) {
    return { score: 0, description: 'Consistent course activity' };
  }
  if (monthlyActivity >= 1) {
    return { score: 3, description: 'Moderate course activity' };
  }
  if (monthlyActivity >= 0.5) {
    return { score: 6, description: 'Sporadic course activity' };
  }
  return { score: 10, description: 'Minimal course activity in last 6 months' };
}

/**
 * Get risk level from score
 */
export function getRiskLevel(score: number): RiskLevel {
  if (score <= RISK_THRESHOLDS.LOW) return 'low';
  if (score <= RISK_THRESHOLDS.MEDIUM) return 'medium';
  if (score <= RISK_THRESHOLDS.HIGH) return 'high';
  return 'critical';
}

/**
 * Calculate confidence in the risk assessment (0-100%)
 */
function calculateConfidence(provider: Provider, courses: Course[]): number {
  let confidence = 100;

  // Reduce confidence for missing data
  if (provider.renewalDeadline === null) confidence -= 20;
  if (provider.hoursRequired === 0 && provider.hoursCompleted === 0) confidence -= 15;
  if (courses.length === 0) confidence -= 20;
  if (courses.length < 5) confidence -= 10;

  return Math.max(0, confidence);
}

/**
 * Get risk score color for UI
 */
export function getRiskColor(level: RiskLevel): string {
  switch (level) {
    case 'low':
      return 'text-green-600 bg-green-100';
    case 'medium':
      return 'text-amber-600 bg-amber-100';
    case 'high':
      return 'text-orange-600 bg-orange-100';
    case 'critical':
      return 'text-red-600 bg-red-100';
  }
}
