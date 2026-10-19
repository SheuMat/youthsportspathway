export const VENUE = {
  name: 'Ecclesfield School (EDU @ Ecclesfield School)',
  address: 'Chapeltown Road, Chapeltown, Sheffield S35 9WD',
  url: 'https://bookings.edu-lettings.org/sheffield/edu-ecclesfield-school',
};

export const SESSION_TIME = '5:00pm to 6:00pm';
export const CAPACITY = 25;
export const PROGRAMME_START = '2026-11-01';

export const SLOTS = {
  mon: { label: 'Monday', capacity: CAPACITY },
  fri: { label: 'Friday', capacity: CAPACITY },
};

export const PLANS = {
  mon: { label: 'Monday only', slots: ['mon'], pricePence: 3000 },
  fri: { label: 'Friday only', slots: ['fri'], pricePence: 3000 },
  both: { label: 'Monday and Friday', slots: ['mon', 'fri'], pricePence: 5000 },
};

// GoCardless day_of_month: -1 means the last day of the month.
export const PAYMENT_DAYS = {
  '1': { value: 1, label: '1st of the month' },
  '15': { value: 15, label: '15th of the month' },
  last: { value: -1, label: 'Last day of the month' },
};

export const HOLD_MINUTES = 45;

const m = (y, mo, days) => days.map((d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

export const SESSION_DATES = {
  mon: [
    ...m(2026, 11, [2, 9, 16, 23, 30]), ...m(2026, 12, [7, 14]),
    ...m(2027, 1, [4, 11, 18, 25]), ...m(2027, 2, [1, 8, 15, 22]),
    ...m(2027, 3, [1, 8, 22, 29]), ...m(2027, 4, [5, 12, 19]),
    ...m(2027, 5, [3, 10, 17, 24, 31]), ...m(2027, 6, [7, 14, 21, 28]),
    ...m(2027, 7, [5, 12, 19, 26]), ...m(2027, 8, [2, 9, 16, 23, 30]),
  ],
  fri: [
    ...m(2026, 11, [6, 13, 20, 27]), ...m(2026, 12, [4, 11, 18]),
    ...m(2027, 1, [8, 15, 22, 29]), ...m(2027, 2, [5, 12, 19, 26]),
    ...m(2027, 3, [5, 12, 19, 26]), ...m(2027, 4, [2, 9, 16, 23, 30]),
    ...m(2027, 5, [7, 14, 21, 28]), ...m(2027, 6, [4, 11, 18, 25]),
    ...m(2027, 7, [2, 9, 16, 23, 30]), ...m(2027, 8, [6, 13, 20, 27]),
  ],
};

export const formatPence = (p) => `£${(p / 100).toFixed(p % 100 ? 2 : 0)}`;
