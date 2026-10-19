import { db } from '../lib/db.js';
import { PLANS, PAYMENT_DAYS, VENUE, SESSION_TIME } from '../lib/config.js';
import { memberSessions } from '../lib/fulfil.js';
import { json } from '../lib/http.js';

export async function GET(request) {
  const ref = new URL(request.url).searchParams.get('ref') || '';
  if (!/^[\w-]{20,40}$/.test(ref)) return json({ error: 'Not found' }, 404);
  const sql = db();
  const [m] = await sql`SELECT * FROM members WHERE ref = ${ref}`;
  if (!m) return json({ error: 'Not found' }, 404);
  const sessions = m.status === 'active' ? await memberSessions(sql, m) : [];
  return json({
    status: m.status,
    childName: m.child_name,
    plan: PLANS[m.plan].label,
    pricePence: m.amount_pence,
    paymentDay: Object.values(PAYMENT_DAYS).find((p) => p.value === m.payment_day)?.label,
    firstChargeDate: m.first_charge_date ? m.first_charge_date.toISOString().slice(0, 10) : null,
    venue: VENUE, time: SESSION_TIME,
    sessions: sessions.map((s) => ({ slot: s.slot_code, date: s.session_date.toISOString().slice(0, 10) })),
  });
}
