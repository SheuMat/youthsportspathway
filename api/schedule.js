import { db, slotAvailability } from '../lib/db.js';
import { PLANS, PAYMENT_DAYS, VENUE, SESSION_TIME } from '../lib/config.js';
import { json } from '../lib/http.js';

export async function GET() {
  const sql = db();
  const [avail, sessions] = await Promise.all([
    slotAvailability(sql),
    sql`SELECT slot_code, to_char(session_date, 'YYYY-MM-DD') AS date FROM sessions
        WHERE session_date >= CURRENT_DATE ORDER BY session_date, slot_code`,
  ]);
  const slots = Object.fromEntries(Object.entries(avail).map(([k, v]) => [k, { label: v.label, capacity: v.capacity, remaining: v.remaining }]));
  const plans = Object.entries(PLANS).map(([code, p]) => ({
    code, label: p.label, slots: p.slots, pricePence: p.pricePence,
    available: p.slots.every((s) => slots[s].remaining > 0),
  }));
  return json({
    venue: VENUE, time: SESSION_TIME, slots, plans,
    paymentDays: Object.entries(PAYMENT_DAYS).map(([code, d]) => ({ code, label: d.label })),
    sessions: sessions.map((s) => ({ slot: s.slot_code, date: s.date })),
  });
}
