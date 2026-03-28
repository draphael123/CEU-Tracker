// Alert Engine for CEU Compliance
// Generates smart alerts based on risk factors and provider status

import type { Provider, Course, Alert, AlertType, AlertSeverity } from '@/types';
import { daysUntil, getRecentCourses, sumHours } from '@/lib/utils';
import { calculateRiskScore } from './risk-scoring';
import { generateForecast, calculateVelocityMetrics } from './compliance-forecast';

/**
 * Generate all alerts for a set of providers
 */
export function generateAlerts(
  providers: Provider[],
  coursesByProvider: Record<string, Course[]>
): Alert[] {
  const alerts: Alert[] = [];

  for (const provider of providers) {
    const courses = coursesByProvider[provider.name] || [];
    const providerAlerts = generateProviderAlerts(provider, courses);
    alerts.push(...providerAlerts);
  }

  // Sort by severity and date
  return sortAlerts(alerts);
}

/**
 * Generate alerts for a single provider
 */
export function generateProviderAlerts(provider: Provider, courses: Course[]): Alert[] {
  const alerts: Alert[] = [];
  const days = daysUntil(provider.renewalDeadline);
  const risk = calculateRiskScore(provider, courses);
  const forecast = generateForecast(provider, courses);
  const velocity = calculateVelocityMetrics(courses);

  // Alert: Overdue
  if (days !== null && days < 0 && provider.hoursRemaining > 0) {
    alerts.push(
      createAlert(provider, 'overdue', 'critical', {
        title: `${provider.name} is overdue`,
        message: `Deadline passed ${Math.abs(days)} days ago with ${provider.hoursRemaining} hours still needed.`,
      })
    );
  }

  // Alert: Deadline Imminent (30 days)
  else if (days !== null && days <= 30 && provider.hoursRemaining > 0) {
    alerts.push(
      createAlert(provider, 'deadline-imminent', 'critical', {
        title: `${days} days until deadline`,
        message: `${provider.name} needs ${provider.hoursRemaining} hours in ${days} days.`,
      })
    );
  }

  // Alert: Pace Insufficient
  if (forecast.completionProbability < 50 && provider.hoursRemaining > 0 && days !== null && days > 0) {
    alerts.push(
      createAlert(provider, 'pace-insufficient', 'warning', {
        title: 'Current pace may not meet deadline',
        message: `${provider.name} has ${forecast.completionProbability}% chance of completion at current pace.`,
      })
    );
  }

  // Alert: No Recent Activity
  const recentCourses = getRecentCourses(courses, 60);
  if (recentCourses.length === 0 && provider.hoursRemaining > 0 && (days === null || days > 0)) {
    alerts.push(
      createAlert(provider, 'no-activity', 'warning', {
        title: 'No recent course completions',
        message: `${provider.name} hasn't completed any courses in 60+ days and still needs ${provider.hoursRemaining} hours.`,
      })
    );
  }

  // Alert: Velocity Drop
  if (
    velocity.trend === 'decelerating' &&
    provider.hoursRemaining > 0 &&
    velocity.last90DaysHours > 0
  ) {
    const dropPercent = Math.round(
      (1 - velocity.last30DaysHours / ((velocity.last90DaysHours - velocity.last30DaysHours) / 2)) * 100
    );
    if (dropPercent > 50) {
      alerts.push(
        createAlert(provider, 'velocity-drop', 'warning', {
          title: 'Significant slowdown detected',
          message: `${provider.name}'s completion rate has dropped by ${Math.abs(dropPercent)}% compared to prior months.`,
        })
      );
    }
  }

  // Alert: Subject Area Gaps
  const subjectGaps = analyzeSubjectGaps(provider);
  for (const gap of subjectGaps.filter((g) => g.hoursNeeded > 0)) {
    alerts.push(
      createAlert(provider, 'subject-gap', 'warning', {
        title: `${gap.subject} hours needed`,
        message: `${provider.name} needs ${gap.hoursNeeded} more ${gap.subject} hours for ${gap.state || provider.state}.`,
      })
    );
  }

  // Alert: High Risk Score
  if (risk.level === 'critical' && !alerts.some((a) => a.type === 'overdue' || a.type === 'deadline-imminent')) {
    alerts.push(
      createAlert(provider, 'completion-risk', 'critical', {
        title: 'Critical compliance risk',
        message: `${provider.name} has a risk score of ${risk.score}/100. Immediate action recommended.`,
      })
    );
  }

  // Alert: Renewal Approaching (info, 90 days)
  if (
    days !== null &&
    days <= 90 &&
    days > 60 &&
    provider.hoursRemaining > 0 &&
    !alerts.some((a) => a.severity === 'critical' || a.severity === 'warning')
  ) {
    alerts.push(
      createAlert(provider, 'renewal-approaching', 'info', {
        title: 'Renewal in 90 days',
        message: `${provider.name}'s deadline is approaching. ${provider.hoursRemaining} hours still needed.`,
      })
    );
  }

  return alerts;
}

/**
 * Analyze subject area gaps for a provider
 */
function analyzeSubjectGaps(
  provider: Provider
): { subject: string; hoursNeeded: number; state: string | null }[] {
  const gaps: { subject: string; hoursNeeded: number; state: string | null }[] = [];

  for (const area of provider.subjectAreas) {
    if (area.hoursRemaining > 0) {
      gaps.push({
        subject: area.name,
        hoursNeeded: area.hoursRemaining,
        state: provider.state,
      });
    }
  }

  return gaps;
}

/**
 * Create an alert object
 */
function createAlert(
  provider: Provider,
  type: AlertType,
  severity: AlertSeverity,
  content: { title: string; message: string; actionUrl?: string }
): Alert {
  return {
    id: `${provider.id}-${type}-${Date.now()}`,
    providerId: provider.id,
    providerName: provider.name,
    type,
    severity,
    title: content.title,
    message: content.message,
    actionUrl: content.actionUrl,
    createdAt: new Date().toISOString(),
    acknowledged: false,
  };
}

/**
 * Sort alerts by severity and date
 */
function sortAlerts(alerts: Alert[]): Alert[] {
  const severityOrder: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return alerts.sort((a, b) => {
    // First by severity
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    // Then by date (newest first)
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Get alert summary counts
 */
export function getAlertSummary(alerts: Alert[]): {
  critical: number;
  warning: number;
  info: number;
  total: number;
} {
  return {
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => a.severity === 'info').length,
    total: alerts.length,
  };
}

/**
 * Filter alerts by severity
 */
export function filterAlertsBySeverity(
  alerts: Alert[],
  severity: AlertSeverity | 'all'
): Alert[] {
  if (severity === 'all') return alerts;
  return alerts.filter((a) => a.severity === severity);
}

/**
 * Get alert icon for UI
 */
export function getAlertIcon(type: AlertType): string {
  switch (type) {
    case 'overdue':
      return '!';
    case 'deadline-imminent':
      return '!';
    case 'pace-insufficient':
      return '↓';
    case 'no-activity':
      return '⏸';
    case 'subject-gap':
      return '○';
    case 'velocity-drop':
      return '↘';
    case 'renewal-approaching':
      return '◷';
    case 'completion-risk':
      return '⚠';
    case 'credential-failing':
      return '🔑';
    default:
      return '•';
  }
}

/**
 * Get alert color for UI
 */
export function getAlertColor(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical':
      return 'text-red-600 bg-red-50 border-red-200';
    case 'warning':
      return 'text-amber-600 bg-amber-50 border-amber-200';
    case 'info':
      return 'text-blue-600 bg-blue-50 border-blue-200';
  }
}
