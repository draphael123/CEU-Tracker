// Course calculation utilities - ported from utils.js

import type { Course } from '@/types';
import { parseDate, getLookbackCutoffDate } from './dates';

/**
 * Filter courses completed within a lookback period.
 */
export function filterCoursesByLookback(
  courses: Course[] | null | undefined,
  lookbackYears: number | null | undefined
): Course[] {
  if (!lookbackYears || !courses || !Array.isArray(courses)) return courses || [];

  const cutoffDate = getLookbackCutoffDate(lookbackYears);

  return courses.filter((course) => {
    const courseDate = parseDate(course.date);
    return courseDate && courseDate >= cutoffDate;
  });
}

/**
 * Calculate hours for a subject within a lookback period.
 */
export function calculateSubjectHoursWithLookback(
  courses: Course[] | null | undefined,
  subjectPattern: string,
  lookbackYears: number | null
): {
  totalHours: number;
  validHours: number;
  expiredHours: number;
  totalCourses: Course[];
  validCourses: Course[];
} {
  if (!courses || !Array.isArray(courses)) {
    return {
      totalHours: 0,
      validHours: 0,
      expiredHours: 0,
      totalCourses: [],
      validCourses: [],
    };
  }

  const pattern = new RegExp(subjectPattern, 'i');

  // Filter courses matching the subject
  const subjectCourses = courses.filter(
    (c) => pattern.test(c.name || '') || pattern.test(c.category || '')
  );

  const totalHours = subjectCourses.reduce((sum, c) => sum + (parseFloat(String(c.hours)) || 0), 0);

  // Filter by lookback period if specified
  const validCourses = lookbackYears
    ? filterCoursesByLookback(subjectCourses, lookbackYears)
    : subjectCourses;
  const validHours = validCourses.reduce((sum, c) => sum + (parseFloat(String(c.hours)) || 0), 0);

  return {
    totalHours: Math.round(totalHours * 10) / 10,
    validHours: Math.round(validHours * 10) / 10,
    expiredHours: Math.round((totalHours - validHours) * 10) / 10,
    totalCourses: subjectCourses,
    validCourses,
  };
}

/**
 * Sum hours from courses
 */
export function sumHours(courses: Course[]): number {
  return courses.reduce((sum, c) => sum + (parseFloat(String(c.hours)) || 0), 0);
}

/**
 * Get courses within the last N days
 */
export function getRecentCourses(courses: Course[], days: number): Course[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);

  return courses.filter((course) => {
    const courseDate = parseDate(course.date);
    return courseDate && courseDate >= cutoff;
  });
}

/**
 * Group courses by week for velocity calculations
 */
export function groupCoursesByWeek(
  courses: Course[]
): Map<string, { courses: Course[]; totalHours: number }> {
  const weeks = new Map<string, { courses: Course[]; totalHours: number }>();

  courses.forEach((course) => {
    const date = parseDate(course.date);
    if (!date) return;

    // Get the Monday of the week
    const day = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
    const weekKey = monday.toISOString().split('T')[0];

    if (!weeks.has(weekKey)) {
      weeks.set(weekKey, { courses: [], totalHours: 0 });
    }

    const week = weeks.get(weekKey)!;
    week.courses.push(course);
    week.totalHours += parseFloat(String(course.hours)) || 0;
  });

  return weeks;
}

/**
 * Build the course-search URL for a given state + license type.
 */
export function courseSearchUrl(state: string | null, licenseType: string | null): string {
  const s = (state || '').toUpperCase();
  const lt = (licenseType || '').toUpperCase();
  return `https://cebroker.com/#!/courses/search?state=${s}&licenseType=${lt}`;
}
