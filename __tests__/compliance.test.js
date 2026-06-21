const { licenseStatus, computeComplianceSummary } = require('../utils');

// Build an ISO date string N days from today so deadline-based tests are
// deterministic regardless of when they run.
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('licenseStatus', () => {
  test('Complete when no hours remain', () => {
    expect(licenseStatus({ hoursRemaining: 0, hoursRequired: 20, renewalDeadline: daysFromNow(365) })).toBe('Complete');
    expect(licenseStatus({ hoursRemaining: -3, hoursRequired: 20, renewalDeadline: daysFromNow(10) })).toBe('Complete');
  });

  test('At Risk when hours remain and deadline is within 60 days', () => {
    expect(licenseStatus({ hoursRemaining: 10, hoursRequired: 20, renewalDeadline: daysFromNow(30) })).toBe('At Risk');
  });

  test('In Progress when hours remain but deadline is far off', () => {
    expect(licenseStatus({ hoursRemaining: 10, hoursRequired: 20, renewalDeadline: daysFromNow(200) })).toBe('In Progress');
  });

  test('Unknown when there are no scraped hours', () => {
    expect(licenseStatus({ hoursRemaining: null, hoursRequired: null, renewalDeadline: null })).toBe('Unknown');
  });
});

describe('computeComplianceSummary', () => {
  // Regression for the misleading "18%" headline: no-data ("Unknown") licenses
  // must NOT be counted as non-compliant — they are excluded and reported as
  // untracked, so the completion rate is measured only over tracked licenses.
  test('excludes no-data licenses from the denominator', () => {
    const records = [];
    for (let i = 0; i < 6; i++) records.push({ hoursRemaining: 0,  hoursRequired: 20, renewalDeadline: daysFromNow(365), providerType: 'NP', state: 'FL' });
    for (let i = 0; i < 6; i++) records.push({ hoursRemaining: 10, hoursRequired: 20, renewalDeadline: daysFromNow(365), providerType: 'RN', state: 'TX' });
    for (let i = 0; i < 21; i++) records.push({ hoursRemaining: null, hoursRequired: null, renewalDeadline: null, providerType: 'MD', state: 'CA' });

    const s = computeComplianceSummary(records);
    expect(s.total).toBe(33);
    expect(s.tracked).toBe(12);
    expect(s.completed).toBe(6);
    expect(s.untracked).toBe(21);
    expect(s.overallPct).toBe(50);   // 6 / 12, NOT 6 / 33 (which would be 18%)
  });

  test('no-data licenses are dropped from byType/byState groupings', () => {
    const records = [
      { hoursRemaining: 0, hoursRequired: 20, renewalDeadline: daysFromNow(365), providerType: 'NP', state: 'FL' },
      { hoursRemaining: null, hoursRequired: null, renewalDeadline: null, providerType: 'MD', state: 'CA' },
    ];
    const s = computeComplianceSummary(records);
    expect(s.byType.map((r) => r.type)).toEqual(['NP']); // MD had no data → not shown
    expect(s.byState.map((r) => r.state)).toEqual(['FL']);
    expect(s.byType[0]).toMatchObject({ type: 'NP', total: 1, compliant: 1, pct: 100 });
  });

  test('all-unknown input reports 0% over 0 tracked', () => {
    const records = [
      { hoursRemaining: null, renewalDeadline: null, hoursRequired: null, providerType: 'NP', state: 'FL' },
      { hoursRemaining: null, renewalDeadline: null, hoursRequired: null, providerType: 'RN', state: 'TX' },
    ];
    const s = computeComplianceSummary(records);
    expect(s).toMatchObject({ total: 2, tracked: 0, completed: 0, untracked: 2, overallPct: 0 });
    expect(s.byType).toEqual([]);
  });

  test('empty / nullish input is safe', () => {
    expect(computeComplianceSummary([])).toMatchObject({ total: 0, tracked: 0, completed: 0, untracked: 0, overallPct: 0, byType: [], byState: [] });
    expect(computeComplianceSummary(null)).toMatchObject({ total: 0, tracked: 0, overallPct: 0 });
  });

  test('byState percentages are computed over tracked licenses only', () => {
    const records = [
      { hoursRemaining: 0,  hoursRequired: 20, renewalDeadline: daysFromNow(365), providerType: 'NP', state: 'FL' },
      { hoursRemaining: 10, hoursRequired: 20, renewalDeadline: daysFromNow(365), providerType: 'NP', state: 'FL' },
      { hoursRemaining: null, hoursRequired: null, renewalDeadline: null, providerType: 'NP', state: 'FL' },
    ];
    const fl = computeComplianceSummary(records).byState.find((r) => r.state === 'FL');
    expect(fl).toMatchObject({ total: 2, compliant: 1, pct: 50 }); // the no-data FL row is excluded
  });
});
