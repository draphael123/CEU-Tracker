const {
  parseDate,
  daysUntil,
  getStatus,
  filterCoursesByLookback,
  calculateSubjectHoursWithLookback,
  cleanupOldScreenshots,
} = require('../utils');

describe('parseDate', () => {
  it('should parse valid date strings', () => {
    const result = parseDate('2025-03-15');
    expect(result).toBeInstanceOf(Date);
    expect(result.getFullYear()).toBe(2025);
    // Note: getMonth() and getDate() can vary by timezone, just check it's a valid date
    expect(result.getTime()).not.toBeNaN();
  });

  it('should return null for invalid dates', () => {
    expect(parseDate('invalid')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});

describe('daysUntil', () => {
  it('should return positive days for future dates', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const result = daysUntil(futureDate);
    expect(result).toBe(30);
  });

  it('should return negative days for past dates', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 10);
    const result = daysUntil(pastDate);
    expect(result).toBe(-10);
  });

  it('should return 0 for today', () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const result = daysUntil(today);
    expect(result).toBe(0);
  });

  it('should return null for invalid input', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
  });
});

describe('getStatus', () => {
  it('should return Complete when hours remaining is 0 or less', () => {
    expect(getStatus(0, 30, 20)).toBe('Complete');
    expect(getStatus(-5, 30, 20)).toBe('Complete');
  });

  it('should return Complete when hours required is 0', () => {
    expect(getStatus(null, 30, 0)).toBe('Complete');
  });

  it('should return At Risk when deadline is within 60 days', () => {
    expect(getStatus(10, 30, 20)).toBe('At Risk');
    expect(getStatus(10, 60, 20)).toBe('At Risk');
  });

  it('should return In Progress for normal cases', () => {
    expect(getStatus(10, 90, 20)).toBe('In Progress');
    expect(getStatus(5, 120, 20)).toBe('In Progress');
  });

  it('should return Unknown for null hours remaining', () => {
    expect(getStatus(null, 30, 20)).toBe('Unknown');
    expect(getStatus(undefined, 30, 20)).toBe('Unknown');
  });
});

describe('filterCoursesByLookback', () => {
  it('should filter courses within lookback period', () => {
    // Use dynamic dates relative to today
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    const twoYearsAgo = new Date(today);
    twoYearsAgo.setFullYear(today.getFullYear() - 2);
    const threeYearsAgo = new Date(today);
    threeYearsAgo.setFullYear(today.getFullYear() - 3);

    const courses = [
      { name: 'Course 1', hours: 2, date: today.toISOString().split('T')[0] },
      { name: 'Course 2', hours: 3, date: oneYearAgo.toISOString().split('T')[0] },
      { name: 'Course 3', hours: 1, date: twoYearsAgo.toISOString().split('T')[0] },
      { name: 'Course 4', hours: 4, date: threeYearsAgo.toISOString().split('T')[0] },
    ];

    const result = filterCoursesByLookback(courses, 2);
    // Should include courses from the last 2 years (Course 1 and Course 2)
    expect(result.length).toBe(2);
    expect(result.map(c => c.name)).toContain('Course 1');
    expect(result.map(c => c.name)).toContain('Course 2');
  });

  it('should return all courses when lookback is null', () => {
    const courses = [
      { name: 'Course 1', hours: 2, date: '2024-01-15' },
      { name: 'Course 2', hours: 3, date: '2023-06-15' },
    ];
    const result = filterCoursesByLookback(courses, null);
    expect(result).toEqual(courses);
  });

  it('should handle empty course array', () => {
    const result = filterCoursesByLookback([], 2);
    expect(result).toEqual([]);
  });

  it('should handle null/undefined courses', () => {
    expect(filterCoursesByLookback(null, 2)).toEqual([]);
    expect(filterCoursesByLookback(undefined, 2)).toEqual([]);
  });
});

describe('calculateSubjectHoursWithLookback', () => {
  const today = new Date();
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(today.getMonth() - 6);
  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(today.getFullYear() - 2);

  const courses = [
    { name: 'Pharmacology 101', hours: 2, date: sixMonthsAgo.toISOString().split('T')[0], category: 'Pharmacology' },
    { name: 'Ethics Course', hours: 3, date: sixMonthsAgo.toISOString().split('T')[0], category: 'Ethics' },
    { name: 'Advanced Pharmacology', hours: 4, date: twoYearsAgo.toISOString().split('T')[0], category: 'Pharmacology' },
  ];

  it('should calculate hours for matching subject pattern', () => {
    const result = calculateSubjectHoursWithLookback(courses, 'Pharmacology', null);
    expect(result.totalHours).toBe(6); // 2 + 4
    expect(result.totalCourses.length).toBe(2);
  });

  it('should filter by lookback period', () => {
    const result = calculateSubjectHoursWithLookback(courses, 'Pharmacology', 1);
    // Only courses within last year (Pharmacology 101)
    expect(result.validHours).toBe(2);
    expect(result.validCourses.length).toBe(1);
  });

  it('should handle no matching courses', () => {
    const result = calculateSubjectHoursWithLookback(courses, 'NonExistent', null);
    expect(result.totalHours).toBe(0);
    expect(result.totalCourses.length).toBe(0);
  });

  it('should handle empty courses array', () => {
    const result = calculateSubjectHoursWithLookback([], 'Pharmacology', null);
    expect(result.totalHours).toBe(0);
    expect(result.validHours).toBe(0);
  });
});
