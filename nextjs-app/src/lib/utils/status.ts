// Status calculation utilities - ported from utils.js

import type { ProviderStatus } from '@/types';
import { daysUntil } from './dates';

/**
 * Determine traffic-light status for a provider license.
 * - Complete: No hours remaining or 0 hours required
 * - At Risk: Hours remaining and deadline within 60 days
 * - In Progress: Hours remaining but deadline > 60 days
 * - Unknown: Missing data
 */
export function getStatus(
  hoursRemaining: number | null | undefined,
  daysToDeadline: number | null,
  hoursRequired?: number | null
): ProviderStatus {
  if (hoursRequired === 0) return 'Complete';
  if (hoursRemaining === null || hoursRemaining === undefined) return 'Unknown';
  if (hoursRemaining <= 0) return 'Complete';
  if (daysToDeadline !== null && daysToDeadline <= 60) return 'At Risk';
  return 'In Progress';
}

/**
 * Get status from a provider record
 */
export function getProviderStatus(provider: {
  hoursRemaining: number | null;
  renewalDeadline: string | null;
  hoursRequired?: number | null;
}): ProviderStatus {
  const days = daysUntil(provider.renewalDeadline);
  return getStatus(provider.hoursRemaining, days, provider.hoursRequired);
}

/**
 * Get CSS class for status
 */
export function getStatusColor(status: ProviderStatus): string {
  switch (status) {
    case 'Complete':
      return 'text-green-600 bg-green-100';
    case 'At Risk':
      return 'text-red-600 bg-red-100';
    case 'In Progress':
      return 'text-amber-600 bg-amber-100';
    case 'Unknown':
    default:
      return 'text-gray-600 bg-gray-100';
  }
}

/**
 * Get status badge variant for UI components
 */
export function getStatusVariant(
  status: ProviderStatus
): 'success' | 'danger' | 'warning' | 'default' {
  switch (status) {
    case 'Complete':
      return 'success';
    case 'At Risk':
      return 'danger';
    case 'In Progress':
      return 'warning';
    case 'Unknown':
    default:
      return 'default';
  }
}

/**
 * Calculate progress percentage
 */
export function calculateProgress(
  hoursCompleted: number | null,
  hoursRequired: number | null
): number {
  if (!hoursRequired || hoursRequired === 0) return 100;
  if (!hoursCompleted) return 0;
  return Math.min(100, Math.round((hoursCompleted / hoursRequired) * 100));
}
