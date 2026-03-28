// Date utility functions - ported from utils.js

/**
 * Parse a date string into a JS Date, returning null if unparseable.
 */
export function parseDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Return the number of days between today and a future date.
 * Negative if the date has passed.
 */
export function daysUntil(date: string | Date | null | undefined): number | null {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Add weeks to a date
 */
export function addWeeks(date: Date, weeks: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + weeks * 7);
  return result;
}

/**
 * Add days to a date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Check if a date is within the last N days
 */
export function isWithinDays(dateStr: string | null | undefined, days: number): boolean {
  const date = parseDate(dateStr);
  if (!date) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return date >= cutoff;
}

/**
 * Get the cutoff date for a lookback period.
 */
export function getLookbackCutoffDate(lookbackYears: number): Date {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - lookbackYears);
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}

/**
 * Format a lookback cutoff date for display.
 */
export function formatLookbackCutoff(lookbackYears: number): string {
  const cutoff = getLookbackCutoffDate(lookbackYears);
  return cutoff.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  });
}

/**
 * Format a date for display
 */
export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  const d = typeof date === 'string' ? parseDate(date) : date;
  if (!d) return 'N/A';
  return d.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  });
}

/**
 * Get relative time string (e.g., "2 days ago", "in 3 weeks")
 */
export function getRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  const d = typeof date === 'string' ? parseDate(date) : date;
  if (!d) return 'N/A';

  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  if (diffDays > 0 && diffDays < 7) return `in ${diffDays} days`;
  if (diffDays < 0 && diffDays > -7) return `${Math.abs(diffDays)} days ago`;
  if (diffDays > 0 && diffDays < 30) return `in ${Math.round(diffDays / 7)} weeks`;
  if (diffDays < 0 && diffDays > -30) return `${Math.round(Math.abs(diffDays) / 7)} weeks ago`;
  if (diffDays > 0) return `in ${Math.round(diffDays / 30)} months`;
  return `${Math.round(Math.abs(diffDays) / 30)} months ago`;
}
