'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../api/_lib/membership-billing');

const XMAS = [{ from: '2026-12-19', to: '2027-01-03', reason: 'Christmas' }];
const pounds = (p) => (p / 100).toFixed(2);

describe('calendar', () => {
  test('counts four- and five-session months', () => {
    assert.equal(B.sessionsInMonth('grassroots', ['Monday'], '2026-11').length, 5);
    assert.equal(B.sessionsInMonth('grassroots', ['Friday'], '2026-11').length, 4);
    assert.equal(B.sessionsInMonth('grassroots', ['Monday', 'Friday'], '2026-11').length, 9);
  });

  test('removes closures, including programme- and day-specific ones', () => {
    assert.deepEqual(B.sessionsInMonth('grassroots', ['Monday'], '2026-12', XMAS), ['2026-12-07', '2026-12-14']);
    const devFriOnly = [{ date: '2027-03-05', programmeId: 'development', day: 'Friday' }];
    assert.equal(B.sessionsInMonth('development', ['Friday'], '2027-03', devFriOnly).length, 3);
    assert.equal(B.sessionsInMonth('grassroots', ['Friday'], '2027-03', devFriOnly).length, 4, 'other programmes unaffected');
  });

  test('working days skip weekends and bank holidays', () => {
    assert.equal(B.addWorkingDays('2026-12-23', 2), '2026-12-29', '24 Dec, then skips 25-28 Dec');
    assert.equal(B.addWorkingDays('2026-11-27', 1), '2026-11-30', 'Friday to Monday');
  });
});

describe('first Direct Debit date', () => {
  test('uses the coming 1st when there is enough time', () => {
    const q = B.quote({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-23', today: '2026-11-17' });
    assert.equal(q.earliestChargeDate, '2026-11-26');
    assert.equal(q.firstCollectionDate, '2026-12-01');
    assert.equal(q.firstCollectionEstimated, true);
  });

  test('moves to the following 1st when the next 1st is too close', () => {
    const q = B.quote({ membershipId: 'grassroots-2', startDate: '2026-11-27', today: '2026-11-26' });
    assert.equal(q.firstCollectionDate, '2027-01-01');
  });

  test('uses the real GoCardless date when known, instead of the estimate', () => {
    const q = B.quote({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-23', today: '2026-11-17', earliestChargeDate: '2026-12-02' });
    assert.equal(q.firstCollectionEstimated, false);
    assert.equal(q.firstCollectionDate, '2027-01-01');
    assert.deepEqual(q.lines.map((l) => [l.month, l.amountPence]), [['2026-11', 1200], ['2026-12', 3000]]);
  });

  test('never collects before the membership starts', () => {
    assert.equal(B.firstCollectionDate({ startDate: '2027-01-14', earliestChargeDate: '2026-12-10' }), '2027-02-01');
  });
});

describe('upfront payment (worked examples from the proposal)', () => {
  test('A: mid-month, one session: 2 of 5 Mondays = £12.00', () => {
    const q = B.quote({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-23', today: '2026-11-17' });
    assert.equal(q.totalPence, 1200);
    assert.deepEqual(q.lines[0].coveredSessionDates, ['2026-11-23', '2026-11-30']);
  });

  test('B: near month end, two sessions, 1st too close: £11.11 + full December £50 = £61.11', () => {
    const q = B.quote({ membershipId: 'grassroots-2', startDate: '2026-11-27', today: '2026-11-26', closures: XMAS });
    assert.deepEqual(q.lines.map((l) => [l.month, l.sessionsCovered, l.sessionsInMonth, l.amountPence]),
      [['2026-11', 2, 9, 1111], ['2026-12', 5, 5, 5000]]);
    assert.equal(pounds(q.totalPence), '61.11');
    assert.equal(q.coveredTo, '2026-12-31');
  });

  test('C: registering on the 1st pays that month by card; Direct Debit starts next month', () => {
    const q = B.quote({ membershipId: 'development-1', days: ['Thursday'], startDate: '2027-02-04', today: '2027-02-01' });
    assert.equal(q.firstCollectionDate, '2027-03-01');
    assert.equal(q.totalPence, 3000);
  });

  test('D: two sessions with a closure: 6 of 8 = £37.50', () => {
    const q = B.quote({ membershipId: 'development-2', startDate: '2027-01-14', today: '2027-01-12', closures: XMAS });
    assert.equal(q.lines[0].sessionsInMonth, 8, '1 January is closed');
    assert.equal(q.totalPence, 3750);
  });

  test('starting on the 1st with a feasible Direct Debit needs no card payment', () => {
    const q = B.quote({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2027-03-01', today: '2027-02-10' });
    assert.equal(q.firstCollectionDate, '2027-03-01');
    assert.equal(q.totalPence, 0);
    assert.equal(q.lines.length, 0);
    assert.equal(q.coveredFrom, null);
  });

  test('five-session month is prorated over five', () => {
    const q = B.calculateUpfront({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2027-03-15', firstCollectionDate: '2027-04-01' });
    assert.deepEqual([q.lines[0].sessionsCovered, q.lines[0].sessionsInMonth, q.totalPence], [3, 5, 1800]);
  });

  test('rounds down to the penny using integer maths', () => {
    const q = B.calculateUpfront({ membershipId: 'grassroots-2', startDate: '2026-11-30', firstCollectionDate: '2026-12-01' });
    assert.deepEqual([q.lines[0].sessionsCovered, q.lines[0].sessionsInMonth], [1, 9]);
    assert.equal(q.totalPence, 555, '£50 × 1/9 = £5.555… -> £5.55');
    assert.ok(Number.isInteger(q.totalPence));
  });

  test('waives totals below the card minimum', () => {
    const q = B.calculateUpfront({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-30', firstCollectionDate: '2026-12-01', monthlyPricePence: 100 });
    assert.equal(q.calculatedPence, 20);
    assert.equal(q.waived, true);
    assert.equal(q.totalPence, 0);
  });

  test('a fully closed start month costs nothing for the part month', () => {
    const closures = [{ from: '2027-08-01', to: '2027-08-31' }];
    const q = B.calculateUpfront({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2027-08-16', firstCollectionDate: '2027-09-01', closures });
    assert.equal(q.totalPence, 0);
  });

  test('a changed plan price is used when given (admin-configured prices)', () => {
    const q = B.calculateUpfront({ membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-23', firstCollectionDate: '2026-12-01', monthlyPricePence: 3500 });
    assert.equal(q.totalPence, 1400);
  });
});

describe('no month is charged twice', () => {
  test('card coverage always ends the day before the first Direct Debit, for every start date and lead time', () => {
    const memberships = [['grassroots-1', ['Monday']], ['grassroots-1', ['Friday']], ['grassroots-2', []], ['development-1', ['Thursday']], ['development-2', []]];
    for (let offset = 0; offset < 120; offset++) {
      const today = new Date(Date.UTC(2026, 10, 1 + offset)).toISOString().slice(0, 10);
      for (const [id, days] of memberships) {
        for (const start of B.startDateOptions({ membershipId: id, days, today, closures: XMAS })) {
          const q = B.quote({ membershipId: id, days, startDate: start, today, closures: XMAS });
          assert.ok(q.firstCollectionDate >= start, 'Direct Debit never before start');
          assert.ok(q.firstCollectionDate >= q.earliestChargeDate, 'never an impossible collection date');
          assert.ok(q.firstCollectionDate.endsWith('-01'));
          const months = q.lines.map((l) => l.month);
          assert.equal(new Set(months).size, months.length, 'each month once');
          assert.ok(months.every((m) => m < q.firstCollectionDate.slice(0, 7)), 'card months end before the Direct Debit month');
          assert.ok(q.lines.every((l) => l.coveredSessionDates.every((d) => d >= start && d < q.firstCollectionDate)));
          assert.ok(Number.isInteger(q.totalPence) && q.totalPence >= 0);
        }
      }
    }
  });
});

describe('start dates', () => {
  test('only the chosen weekday, within the window, excluding closures', () => {
    const opts = B.startDateOptions({ membershipId: 'grassroots-1', days: ['Monday'], today: '2026-12-10', closures: XMAS });
    assert.deepEqual(opts, ['2026-12-14', '2027-01-04']);
  });

  test('two-session memberships offer both days', () => {
    const opts = B.startDateOptions({ membershipId: 'development-2', today: '2027-02-01' });
    assert.ok(opts.includes('2027-02-04') && opts.includes('2027-02-05'));
    assert.ok(opts.every((d) => ['Thursday', 'Friday'].includes(new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }))));
  });
});
