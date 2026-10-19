// End-to-end test against a local dev server running with MOCK_PAYMENTS=1.
// Usage: BASE_URL=http://localhost:3100 DATABASE_URL=... ADMIN_PASSWORD=... GOCARDLESS_WEBHOOK_SECRET=... node scripts/e2e-test.js
import { createHmac } from 'node:crypto';
import { db } from '../lib/db.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const sql = db();
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const person = (i, plan, extra = {}) => ({
  plan, paymentDay: ['1', '15', 'last'][i % 3], parentName: `Parent ${i}`, email: `parent${i}@test.local`,
  phone: '07700 900' + String(100 + i).slice(-3), childName: `Child ${i}`, childDob: '2014-03-0' + ((i % 9) + 1),
  emergencyName: `Contact ${i}`, emergencyPhone: '07700 900999', medical: i % 2 ? '' : 'None', terms: true, photoConsent: i % 2 === 0, ...extra,
});

async function register(body) {
  const res = await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const pay = (ref) => fetch(`${BASE}/api/mock-pay?ref=${encodeURIComponent(ref)}`, { redirect: 'manual' });
const status = async (ref) => (await (await fetch(`${BASE}/api/status?ref=${encodeURIComponent(ref)}`)).json()).status;
const schedule = async () => (await fetch(`${BASE}/api/schedule`)).json();

function webhook(events, secret = process.env.GOCARDLESS_WEBHOOK_SECRET) {
  const raw = JSON.stringify({ events });
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(`${BASE}/api/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Signature': sig }, body: raw });
}

await sql`TRUNCATE members, webhook_events CASCADE`;

// 1. Validation
const bad = await register({ plan: 'mon', terms: false });
check('invalid form rejected with field errors', bad.status === 422 && bad.body.errors.terms && bad.body.errors.email);

// 2. Sign up and confirm one "both" member
const first = await register(person(0, 'both'));
check('registration returns GoCardless redirect', first.status === 200 && first.body.redirectUrl.includes('/api/mock-pay'));
check('booking is pending before payment set-up', (await status(first.body.ref)) === 'pending');
await pay(first.body.ref);
check('booking active after mandate confirmed', (await status(first.body.ref)) === 'active');
let s = await schedule();
check('places drop on both sessions', s.slots.mon.remaining === 24 && s.slots.fri.remaining === 24, JSON.stringify(s.slots));
const [m0] = await sql`SELECT * FROM members WHERE ref = ${first.body.ref}`;
check('subscription created with first charge on/after 1 Nov 2026', !!m0.gc_subscription && m0.first_charge_date.toISOString().slice(0, 10) >= '2026-11-01',
  `${m0.gc_subscription} from ${m0.first_charge_date.toISOString().slice(0, 10)}`);

// 3. Fill Monday to capacity
for (let i = 1; i <= 24; i++) {
  const r = await register(person(i, 'mon'));
  await pay(r.body.ref);
}
s = await schedule();
check('Monday full after 25 members', s.slots.mon.remaining === 0);
check('Monday and Both plans show full, Friday still open',
  !s.plans.find((p) => p.code === 'mon').available && !s.plans.find((p) => p.code === 'both').available && s.plans.find((p) => p.code === 'fri').available);
const blocked = await register(person(99, 'mon'));
check('registration for full session refused', blocked.status === 409, blocked.body.errors?.plan);

// 4. Overbooking race: a hold expires, the session fills, then the late mandate arrives
const late = await register(person(50, 'fri'));
await sql`UPDATE members SET hold_expires = now() - interval '1 minute' WHERE ref = ${late.body.ref}`;
for (let i = 51; i <= 74; i++) { const r = await register(person(i, 'fri')); await pay(r.body.ref); }
s = await schedule();
check('Friday full (24 new + the Both member)', s.slots.fri.remaining === 0);
await pay(late.body.ref);
const [lateRow] = await sql`SELECT status, gc_subscription, notes FROM members WHERE ref = ${late.body.ref}`;
check('late sign-up marked overbooked, no subscription', lateRow.status === 'overbooked' && !lateRow.gc_subscription, lateRow.notes);
check('capacity never exceeded', (await schedule()).slots.fri.remaining === 0);

// 5. Webhooks
const badSig = await webhook([{ id: 'EV_x', resource_type: 'payments', action: 'failed', links: {} }], 'wrong-secret');
check('webhook with bad signature rejected', badSig.status === 498);
const ev = { id: 'EV_pay_failed_1', resource_type: 'payments', action: 'failed', links: { payment: 'PM1', subscription: m0.gc_subscription } };
const ok = await webhook([ev]);
const [afterFail] = await sql`SELECT last_payment_status FROM members WHERE id = ${m0.id}`;
check('signed payment-failed webhook updates status', ok.status === 204 && afterFail.last_payment_status === 'failed');
await sql`UPDATE members SET last_payment_status = 'paid' WHERE id = ${m0.id}`;
await webhook([ev]);
const [afterDup] = await sql`SELECT last_payment_status FROM members WHERE id = ${m0.id}`;
check('duplicate webhook event ignored', afterDup.last_payment_status === 'paid');
await webhook([{ id: 'EV_mandate_cancel_1', resource_type: 'mandates', action: 'cancelled', links: { mandate: m0.gc_mandate } }]);
s = await schedule();
check('cancelled mandate frees a place on both sessions', s.slots.mon.remaining === 1 && s.slots.fri.remaining === 1);

// 6. Admin
const unauth = await fetch(`${BASE}/api/admin`);
check('admin API requires password', unauth.status === 401);
const wrong = await fetch(`${BASE}/api/admin`, { headers: { Authorization: 'Bearer nope' } });
check('admin API rejects wrong password', wrong.status === 401);
const auth = { Authorization: `Bearer ${process.env.ADMIN_PASSWORD}` };
const admin = await (await fetch(`${BASE}/api/admin`, { headers: auth })).json();
check('admin lists members', admin.members.length === 50, `${admin.members.length} rows`);
const monSession = admin.sessions.find((x) => x.slot_code === 'mon');
const csvRes = await fetch(`${BASE}/api/admin?register=${monSession.id}`, { headers: auth });
const csv = await csvRes.text();
const lines = csv.trim().split('\r\n');
check('CSV register downloads for a Monday', csvRes.headers.get('content-type').startsWith('text/csv') && lines.length === 25,
  `${lines.length - 1} children on ${monSession.date}`);

// 7. CSV formula injection is neutralised
const evil = await register(person(200, 'fri', { childName: '=HYPERLINK("http://x")' }));
await pay(evil.body.ref);
const friSession = admin.sessions.find((x) => x.slot_code === 'fri');
const friCsv = await (await fetch(`${BASE}/api/admin?register=${friSession.id}`, { headers: auth })).text();
check('CSV escapes formula-like values', friCsv.includes(`"'=HYPERLINK(""http://x"")"`));

console.log(`\n${passed} passed, ${failed} failed`);
await sql.end();
process.exit(failed ? 1 : 0);
