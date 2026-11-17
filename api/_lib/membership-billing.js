'use strict';
/*
 * Membership billing calculator (pure functions, no I/O).
 *
 * Rules (all money in integer pence, dates as 'YYYY-MM-DD'):
 *  - The monthly Direct Debit is collected on RULES.collectionDay and covers that calendar month.
 *  - The first Direct Debit is the first collection day that is on/after both the membership start date
 *    and the earliest date GoCardless can collect (estimated, then replaced by the mandate's real
 *    next_possible_charge_date before the parent pays by card).
 *  - Every month from the start date up to the first Direct Debit month is paid upfront by card:
 *      start month  -> price × sessions remaining (from the start date) ÷ sessions in that month
 *      later months -> full monthly price (the same amount the Direct Debit would have taken)
 *    Sessions are the membership's weekly days on the programme calendar, minus closures.
 *  - Amounts are rounded down to the penny. Upfront totals below the card minimum are waived.
 */
const YSP = require('../../js/site-data.js');

const DEFAULT_RULES = Object.freeze({
  collectionDay: 1,
  // Working days from registration to the earliest Direct Debit collection, used only for the estimate
  // shown before the mandate exists. The real date always comes from GoCardless.
  estimateLeadWorkingDays: 7,
  rounding: 'down',
  minimumCardChargePence: 30,
  startWindowDays: 28
});

// England & Wales bank holidays (Bacs does not process on these). Source: gov.uk/bank-holidays.
// Extend each year, or pass `bankHolidays` explicitly.
const BANK_HOLIDAYS = Object.freeze([
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26'
]);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDate(iso) {
  if (!DATE_RE.test(iso)) throw new Error(`Invalid date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Invalid date: ${iso}`);
  return d;
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => { const d = toDate(isoDate); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const weekday = (isoDate) => WEEKDAYS[toDate(isoDate).getUTCDay()];
const monthKey = (isoDate) => isoDate.slice(0, 7);
const firstOfMonth = (key) => `${key}-01`;
function nextMonthKey(key) {
  let [y, m] = key.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addWorkingDays(isoDate, n, bankHolidays = BANK_HOLIDAYS) {
  const hol = new Set(bankHolidays);
  let d = isoDate;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    const wd = toDate(d).getUTCDay();
    if (wd !== 0 && wd !== 6 && !hol.has(d)) left -= 1;
  }
  return d;
}

/**
 * Closures: [{ date: 'YYYY-MM-DD' } | { from, to }, optional programmeId, optional day ('Monday'), optional reason].
 * A closure without programmeId applies to every programme.
 */
function isClosed(dateIso, programmeId, closures = []) {
  const day = weekday(dateIso);
  return closures.some((c) => {
    if (c.programmeId && c.programmeId !== programmeId) return false;
    if (c.day && c.day !== day) return false;
    if (c.date) return c.date === dateIso;
    return c.from <= dateIso && dateIso <= c.to;
  });
}

function membershipDays(membership, chosenDays) {
  const all = YSP.programmeDays(membership.programmeId);
  if (membership.sessionsPerWeek >= all.length) return all;
  return chosenDays;
}

/** Scheduled session dates for the given weekdays in a month, excluding closures. */
function sessionsInMonth(programmeId, days, key, closures = []) {
  const out = [];
  for (let day = 1; day <= daysInMonth(key); day++) {
    const d = `${key}-${String(day).padStart(2, '0')}`;
    if (days.includes(weekday(d)) && !isClosed(d, programmeId, closures)) out.push(d);
  }
  return out;
}

/** First collection day that is on/after `notBefore` (YYYY-MM-DD). */
function nextCollectionDate(notBefore, rules = DEFAULT_RULES) {
  let key = monthKey(notBefore);
  for (let i = 0; i < 36; i++) {
    const day = Math.min(rules.collectionDay, daysInMonth(key));
    const d = `${key}-${String(day).padStart(2, '0')}`;
    if (d >= notBefore) return d;
    key = nextMonthKey(key);
  }
  throw new Error('No collection date found');
}

/**
 * First Direct Debit date for a membership starting on `startDate`.
 * `earliestChargeDate` is GoCardless's next_possible_charge_date for the mandate, or the estimate.
 */
function firstCollectionDate({ startDate, earliestChargeDate }, rules = DEFAULT_RULES) {
  return nextCollectionDate(startDate > earliestChargeDate ? startDate : earliestChargeDate, rules);
}

function estimateEarliestChargeDate(today, rules = DEFAULT_RULES, bankHolidays = BANK_HOLIDAYS) {
  return addWorkingDays(today, rules.estimateLeadWorkingDays, bankHolidays);
}

function roundPence(numerator, denominator, rounding) {
  // Integer-only: numerator and denominator are integers.
  if (rounding === 'nearest') return Math.floor((2 * numerator + denominator) / (2 * denominator));
  return Math.floor(numerator / denominator);
}

/**
 * Upfront card payment for the period before the first Direct Debit.
 * Returns { lines, totalPence, calculatedPence, waived, coveredFrom, coveredTo, firstCollectionDate }.
 */
function calculateUpfront({ membershipId, days = [], startDate, firstCollectionDate: firstDd, closures = [], monthlyPricePence }, rules = DEFAULT_RULES) {
  const membership = YSP.getMembership(membershipId);
  if (!membership) throw new Error(`Unknown membership: ${membershipId}`);
  const price = Number.isInteger(monthlyPricePence) ? monthlyPricePence : membership.amountPence;
  const weekdays = membershipDays(membership, days);
  toDate(startDate);
  toDate(firstDd);

  const lines = [];
  const firstDdMonth = monthKey(firstDd);
  let key = monthKey(startDate);
  while (key < firstDdMonth) {
    const all = sessionsInMonth(membership.programmeId, weekdays, key, closures);
    const covered = all.filter((d) => d >= startDate);
    const fullMonth = startDate <= firstOfMonth(key);
    let amountPence;
    if (fullMonth) amountPence = price;
    else if (all.length === 0) amountPence = 0;
    else amountPence = roundPence(price * covered.length, all.length, rules.rounding);
    lines.push({
      month: key,
      fullMonth,
      sessionsInMonth: all.length,
      sessionsCovered: covered.length,
      coveredSessionDates: covered,
      amountPence
    });
    key = nextMonthKey(key);
  }

  const calculatedPence = lines.reduce((s, l) => s + l.amountPence, 0);
  const waived = calculatedPence > 0 && calculatedPence < rules.minimumCardChargePence;
  return {
    membershipId,
    monthlyPricePence: price,
    days: weekdays,
    startDate,
    firstCollectionDate: firstDd,
    lines,
    calculatedPence,
    waived,
    totalPence: waived ? 0 : calculatedPence,
    coveredFrom: lines.length ? startDate : null,
    coveredTo: lines.length ? addDays(firstDd, -1) : null
  };
}

/** Bookable start dates: the membership's session dates within the start window, excluding closures. */
function startDateOptions({ membershipId, days = [], today, closures = [] }, rules = DEFAULT_RULES) {
  const membership = YSP.getMembership(membershipId);
  if (!membership) throw new Error(`Unknown membership: ${membershipId}`);
  const weekdays = membershipDays(membership, days);
  const out = [];
  for (let i = 1; i <= rules.startWindowDays; i++) {
    const d = addDays(today, i);
    if (weekdays.includes(weekday(d)) && !isClosed(d, membership.programmeId, closures)) out.push(d);
  }
  return out;
}

/** Full quote used for the summary step (estimate) and again after the mandate exists (real date). */
function quote({ membershipId, days, startDate, today, earliestChargeDate, closures = [], monthlyPricePence }, rules = DEFAULT_RULES, bankHolidays = BANK_HOLIDAYS) {
  const estimated = !earliestChargeDate;
  const earliest = earliestChargeDate || estimateEarliestChargeDate(today, rules, bankHolidays);
  const firstDd = firstCollectionDate({ startDate, earliestChargeDate: earliest }, rules);
  const membership = YSP.getMembership(membershipId);
  return {
    ...calculateUpfront({ membershipId, days, startDate, firstCollectionDate: firstDd, closures, monthlyPricePence }, rules),
    earliestChargeDate: earliest,
    firstCollectionEstimated: estimated,
    ongoingMonthlyPence: Number.isInteger(monthlyPricePence) ? monthlyPricePence : membership.amountPence
  };
}

module.exports = {
  DEFAULT_RULES,
  BANK_HOLIDAYS,
  addWorkingDays,
  isClosed,
  sessionsInMonth,
  nextCollectionDate,
  firstCollectionDate,
  estimateEarliestChargeDate,
  calculateUpfront,
  startDateOptions,
  quote
};
