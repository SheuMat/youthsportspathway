'use strict';
// Stage 3: registration → Direct Debit (GoCardless) → upfront card payment (Stripe) → active membership.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { load } = require('../api/_lib/config');
const { createApp } = require('../api/_lib/app');
const gocardless = require('../api/_lib/gocardless');
const stripeMod = require('../api/_lib/stripe');
const dbMod = require('../api/_lib/db');
const YSP = require('../js/site-data.js');

const GC_SECRET = 'whsec_gc_test';
const STRIPE_SECRET = 'whsec_stripe_test';
const quiet = { info() {}, warn() {}, error() {} };

function mockGoCardless() {
  const calls = [];
  const state = { brStatus: {}, mandateStatus: {}, npcd: {}, defaultNpcd: '2026-11-17', subs: {}, idem: {} };
  let n = 0;
  const ok = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, opts) {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method, path: u.pathname, body, headers: opts.headers });
    const key = opts.headers['Idempotency-Key'];
    const id = u.pathname.split('/')[2];
    if (opts.method === 'POST' && u.pathname === '/billing_requests') return ok({ billing_requests: { id: 'BRQ' + (++n), status: 'pending' } }, 201);
    if (opts.method === 'POST' && u.pathname === '/billing_request_flows') return ok({ billing_request_flows: { authorisation_url: 'https://pay-sandbox.gocardless.com/flow/' + (++n) } }, 201);
    if (opts.method === 'GET' && u.pathname.startsWith('/billing_requests/')) {
      return ok({ billing_requests: { id, status: state.brStatus[id] || 'pending', links: { mandate_request_mandate: 'MD-' + id, customer: 'CU-' + id } } });
    }
    if (opts.method === 'GET' && u.pathname.startsWith('/mandates/')) {
      return ok({ mandates: { id, status: state.mandateStatus[id] || 'pending_submission', next_possible_charge_date: state.npcd[id] || state.defaultNpcd } });
    }
    if (opts.method === 'POST' && u.pathname === '/subscriptions') {
      if (key && state.idem[key]) return ok({ error: { message: 'conflict', errors: [{ reason: 'idempotent_creation_conflict', links: { conflicting_resource_id: state.idem[key] } }] } }, 409);
      const sid = 'SB' + (++n);
      state.subs[sid] = { id: sid, status: 'active', ...body.subscriptions };
      if (key) state.idem[key] = sid;
      return ok({ subscriptions: state.subs[sid] }, 201);
    }
    if (opts.method === 'GET' && u.pathname.startsWith('/subscriptions/')) return ok({ subscriptions: state.subs[id] });
    return ok({ error: { message: 'not mocked ' + u.pathname } }, 404);
  }
  return { calls, state, fetchImpl };
}

function mockStripe() {
  const calls = [];
  const sessions = {};
  const idem = {};
  let n = 0;
  const ok = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, opts) {
    const u = new URL(url);
    const params = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null;
    calls.push({ method: opts.method, path: u.pathname, params, headers: opts.headers });
    assert.match(opts.headers.Authorization, /^Bearer sk_test_/);
    const parts = u.pathname.split('/');
    if (opts.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      const key = opts.headers['Idempotency-Key'];
      if (key && idem[key]) return ok(sessions[idem[key]]);
      const id = 'cs_test_' + (++n);
      sessions[id] = {
        id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/' + id,
        amount_total: Number(params['line_items[0][price_data][unit_amount]']), currency: params['line_items[0][price_data][currency]'],
        client_reference_id: params.client_reference_id, metadata: { ysp_reference: params['metadata[ysp_reference]'] }, customer: null, payment_intent: null
      };
      if (key) idem[key] = id;
      return ok(sessions[id]);
    }
    if (opts.method === 'GET' && parts[3] === 'sessions') return ok(sessions[parts[4]]);
    if (opts.method === 'POST' && parts[5] === 'expire') { sessions[parts[4]].status = 'expired'; return ok(sessions[parts[4]]); }
    return ok({ error: { message: 'not mocked ' + u.pathname } }, 404);
  }
  /** Simulate the parent completing payment on Stripe's page. */
  function pay(id) { Object.assign(sessions[id], { status: 'complete', payment_status: 'paid', customer: 'cus_' + id, payment_intent: 'pi_' + id }); return sessions[id]; }
  return { calls, sessions, fetchImpl, pay };
}

async function startServer(nowIso) {
  const config = load({
    GOCARDLESS_ACCESS_TOKEN: 'sandbox_abc', GOCARDLESS_WEBHOOK_SECRET: GC_SECRET,
    STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, PUBLIC_BASE_URL: 'https://example.test'
  });
  const gcMock = mockGoCardless();
  const stMock = mockStripe();
  const gc = gocardless.client({ accessToken: 'sandbox_abc', apiBase: 'https://api-sandbox.gocardless.com' }, gcMock.fetchImpl);
  const stripe = stripeMod.client({ secretKey: 'sk_test_abc', apiBase: 'https://api.stripe.com/v1' }, stMock.fetchImpl);
  const sent = [];
  const notify = {
    provider: 'test', configured: true, sent,
    toYsp: async (subject, text) => { sent.push({ to: 'ysp', subject, text }); return true; },
    toParent: async (to, subject, text) => { sent.push({ to, subject, text }); return true; }
  };
  const clock = { now: new Date(nowIso) };
  const db = dbMod.open(':memory:');
  const app = createApp({ config, db, gc, stripe, notify, log: quiet, now: () => clock.now });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, db, gcMock, stMock, sent, clock, base: `http://127.0.0.1:${server.address().port}` };
}

const parent = {
  parentName: 'Sam Parent', parentEmail: 'sam@example.com', parentPhone: '07700 900123', privacyAck: true, termsAck: true,
  emergencyName: 'Jo Parent', emergencyPhone: '07700 900999', medicalInfo: '', participationConsent: true, medicalConsent: true, photoConsent: 'no'
};
const post = (s, path, body, headers = {}) => fetch(s.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (s, path) => fetch(s.base + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
function gcWebhook(s, events) {
  const raw = JSON.stringify({ events });
  return fetch(s.base + '/api/webhooks/gocardless', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Signature': crypto.createHmac('sha256', GC_SECRET).update(raw).digest('hex') }, body: raw });
}
function stripeWebhook(s, event, secret = STRIPE_SECRET) {
  const raw = JSON.stringify(event);
  const t = Math.floor(s.clock.now.getTime() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(s.base + '/api/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}
async function register(s, o) {
  const r = await post(s, '/api/registrations', { ...parent, childName: 'Alex Parent', childDob: '2018-03-01', programmeId: 'grassroots', membershipId: 'grassroots-1', days: ['Monday'], ...o });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await s.db.get('SELECT * FROM registrations WHERE reference = ?', r.body.reference);
  return { res: r.body, row };
}
async function authorise(s, row, eventId) {
  await gcWebhook(s, [{ id: eventId, resource_type: 'billing_requests', action: 'fulfilled', links: { billing_request: row.gc_billing_request_id } }]);
  return s.db.get('SELECT * FROM registrations WHERE id = ?', row.id);
}
/** Save settings the way the admin page does (database), and move the clock past the 30-second settings cache. */
async function setSettings(s, overlay) {
  const value = JSON.stringify({ ...YSP.exportSettings(), ...overlay });
  await s.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'site', value);
  s.clock.now = new Date(s.clock.now.getTime() + 31 * 1000);
  await get(s, '/api/health');
}
const status = (s, row) => get(s, '/api/registrations/status?ref=' + row.public_token).then((r) => r.body);
const subCalls = (s) => s.gcMock.calls.filter((c) => c.method === 'POST' && c.path === '/subscriptions');

describe('membership journey (today = Tue 10 Nov 2026)', () => {
  let s;
  before(async () => { s = await startServer('2026-11-10T10:00:00Z'); });
  after(() => { s.server.close(); YSP.applySettings({}); });

  test('start dates and the summary quote are available before registering', async () => {
    const d = await get(s, '/api/registrations/start-dates?membershipId=grassroots-1&days=Monday');
    assert.deepEqual(d.body.dates, ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']);
    const q = await get(s, '/api/registrations/quote?membershipId=grassroots-1&days=Monday&startDate=2026-11-23');
    assert.equal(q.body.upfrontPence, 1200);
    assert.equal(q.body.firstCollectionDate, '2026-12-01');
    assert.equal(q.body.firstCollectionEstimated, true);
    assert.equal(q.body.monthlyPence, 3000);
    assert.equal((await get(s, '/api/registrations/quote?membershipId=grassroots-1&days=Monday&startDate=2026-11-17')).status, 422);
  });

  test('registration rejects a non-session start date and checks age from date of birth', async () => {
    let r = await post(s, '/api/registrations', { ...parent, childName: 'X', childDob: '2018-03-01', programmeId: 'grassroots', membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-17' });
    assert.equal(r.status, 422); assert.ok(r.body.fields.startDate);
    r = await post(s, '/api/registrations', { ...parent, childName: 'X', childDob: '2012-01-01', programmeId: 'grassroots', membershipId: 'grassroots-1', days: ['Monday'], startDate: '2026-11-16' });
    assert.equal(r.status, 422); assert.match(r.body.fields.childDob, /ages 5–10/);
  });

  let paid;
  test('mid-month: Direct Debit set up, then card payment due for the rest of November', async () => {
    const { res, row } = await register(s, { startDate: '2026-11-16' });
    assert.match(res.authorisationUrl, /^https:\/\/pay-sandbox\.gocardless\.com\//);
    assert.equal(row.upfront_pence, 1800, 'estimate stored: 3 of 5 Mondays');
    assert.equal(row.first_collection_estimated, 1);
    const cur = await authorise(s, row, 'GC-1');
    assert.equal(cur.registration_status, 'awaiting_upfront_payment');
    assert.equal(cur.first_collection_date, '2026-12-01');
    assert.equal(cur.first_collection_estimated, 0, 'now based on the real mandate date');
    assert.equal(cur.upfront_status, 'pending');
    assert.equal(subCalls(s).length, 0, 'no subscription before the card payment');
    const mail = s.sent.find((m) => m.to === 'sam@example.com' && /Complete/.test(m.subject));
    assert.match(mail.text, /£18\.00/);
    assert.match(mail.text, /register-complete\.html\?ref=/);
    const st = await status(s, cur);
    assert.equal(st.stage, 'payment_due');
    assert.equal(st.upfrontLines[0].sessionsCovered, 3);
    paid = cur;
  });

  test('checkout charges exactly the upfront amount and is reused, not duplicated', async () => {
    const a = await post(s, '/api/registrations/checkout', { ref: paid.public_token });
    assert.match(a.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const create = s.stMock.calls.find((c) => c.path === '/v1/checkout/sessions');
    assert.equal(create.params['line_items[0][price_data][unit_amount]'], '1800');
    assert.equal(create.params['line_items[0][price_data][currency]'], 'gbp');
    assert.equal(create.params.mode, 'payment');
    assert.match(create.params.success_url, /register-complete\.html\?ref=.*&paid=1$/);
    assert.match(create.headers['Idempotency-Key'], /^ysp-checkout-YSPM-.+-1-1800$/);
    const b = await post(s, '/api/registrations/checkout', { ref: paid.public_token });
    assert.equal(b.body.url, a.body.url);
    assert.equal(s.stMock.calls.filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions').length, 1);
  });

  test('returning from Stripe without payment does not activate anything', async () => {
    const st = await status(s, paid);
    assert.equal(st.stage, 'payment_due');
  });

  test('a declined card is recorded but the membership is not activated', async () => {
    const r = await stripeWebhook(s, { id: 'evt_decl', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_x', metadata: { ysp_reference: paid.reference }, last_payment_error: { message: 'Your card was declined.' } } } });
    assert.equal(r.status, 200);
    const st = await status(s, paid);
    assert.equal(st.stage, 'payment_due');
    assert.equal(st.upfrontError, 'Your card was declined.');
  });

  test('Stripe webhooks with a bad signature are rejected', async () => {
    const r = await stripeWebhook(s, { id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }, 'wrong');
    assert.equal(r.status, 400);
  });

  test('payment confirmed by Stripe webhook → subscription on the 1st → active, confirmation email', async () => {
    const sessionId = (await s.db.get('SELECT stripe_checkout_session_id AS id FROM registrations WHERE id = ?', paid.id)).id;
    const session = s.stMock.pay(sessionId);
    const r = await stripeWebhook(s, { id: 'evt_paid', type: 'checkout.session.completed', data: { object: session } });
    assert.equal(r.status, 200);
    const cur = await s.db.get('SELECT * FROM registrations WHERE id = ?', paid.id);
    assert.equal(cur.upfront_status, 'paid');
    assert.equal(cur.stripe_customer_id, 'cus_' + sessionId);
    assert.equal(cur.stripe_payment_intent_id, 'pi_' + sessionId);
    assert.equal(cur.registration_status, 'active');
    const subs = subCalls(s);
    assert.equal(subs.length, 1);
    assert.deepEqual(
      [subs[0].body.subscriptions.amount, subs[0].body.subscriptions.day_of_month, subs[0].body.subscriptions.start_date, subs[0].body.subscriptions.interval_unit],
      [3000, 1, '2026-12-01', 'monthly']);
    const mail = s.sent.find((m) => m.to === 'sam@example.com' && /confirmed/.test(m.subject));
    for (const want of [/Player: Alex Parent/, /Grassroots Basketball/, /Mondays, 5:00pm/, /£30\.00 a month/, /£18\.00 paid by card/, /Tuesday, 1 December 2026/, /info@youthsportspathway\.co\.uk/]) assert.match(mail.text, want);
    assert.equal((await status(s, cur)).stage, 'active');
  });

  test('duplicate Stripe deliveries are ignored and never create a second subscription', async () => {
    const sessionId = (await s.db.get('SELECT stripe_checkout_session_id AS id FROM registrations WHERE id = ?', paid.id)).id;
    const r = await stripeWebhook(s, { id: 'evt_paid', type: 'checkout.session.completed', data: { object: s.stMock.sessions[sessionId] } });
    assert.deepEqual(r.body, { duplicate: true });
    await stripeWebhook(s, { id: 'evt_paid_again', type: 'checkout.session.completed', data: { object: s.stMock.sessions[sessionId] } });
    assert.equal(subCalls(s).length, 1);
    assert.deepEqual((await post(s, '/api/registrations/checkout', { ref: paid.public_token })).body, { already: true });
  });

  test('a cancelled/expired checkout can be retried with a fresh session', async () => {
    const { row } = await register(s, { childName: 'Bea', startDate: '2026-11-23' });
    const cur = await authorise(s, row, 'GC-2');
    const first = await post(s, '/api/registrations/checkout', { ref: cur.public_token });
    const firstId = first.body.url.split('/').pop();
    await stripeWebhook(s, { id: 'evt_exp', type: 'checkout.session.expired', data: { object: { id: firstId } } });
    assert.equal((await s.db.get('SELECT upfront_status FROM registrations WHERE id = ?', row.id)).upfront_status, 'expired');
    s.stMock.sessions[firstId].status = 'expired';
    const second = await post(s, '/api/registrations/checkout', { ref: cur.public_token });
    assert.notEqual(second.body.url, first.body.url);
    assert.match(s.stMock.calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1).headers['Idempotency-Key'], /-2-1200$/);
  });

  test('paying is confirmed even if the webhook is late (server checks the session with Stripe)', async () => {
    const { row } = await register(s, { childName: 'Cal', startDate: '2026-11-30' });
    const cur = await authorise(s, row, 'GC-3');
    const co = await post(s, '/api/registrations/checkout', { ref: cur.public_token });
    s.stMock.pay(co.body.url.split('/').pop());
    const st = await status(s, cur);
    assert.equal(st.stage, 'active');
    assert.equal(st.upfrontStatus, 'paid');
  });

  test('the amount is recalculated if the first Direct Debit moves before the parent pays', async () => {
    const { row } = await register(s, { childName: 'Dee', startDate: '2026-11-16' });
    let cur = await authorise(s, row, 'GC-4');
    assert.equal(cur.upfront_pence, 1800);
    s.gcMock.state.npcd[cur.gc_mandate_id] = '2026-12-02'; // 1 December no longer possible
    const r = await post(s, '/api/registrations/checkout', { ref: cur.public_token });
    assert.deepEqual(r.body, { changed: true });
    cur = await s.db.get('SELECT * FROM registrations WHERE id = ?', row.id);
    assert.equal(cur.first_collection_date, '2027-01-01');
    assert.equal(cur.upfront_pence, 1800 + 3000, 'December now paid upfront too');
    const again = await post(s, '/api/registrations/checkout', { ref: cur.public_token });
    assert.ok(again.body.url);
    assert.equal(s.stMock.calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1).params['line_items[0][price_data][unit_amount]'], '4800');
  });

  test('a parent who left GoCardless early can resume the same Direct Debit request', async () => {
    const { row } = await register(s, { childName: 'Ola', startDate: '2026-11-23' });
    const r = await post(s, '/api/registrations/resume', { ref: row.public_token });
    assert.match(r.body.url, /^https:\/\/pay-sandbox\.gocardless\.com\//);
    const flows = s.gcMock.calls.filter((c) => c.path === '/billing_request_flows');
    assert.equal(flows.at(-1).body.billing_request_flows.links.billing_request, row.gc_billing_request_id, 'same billing request, no new mandate request');
    assert.equal(s.gcMock.calls.filter((c) => c.path === '/billing_requests' && c.method === 'POST').length,
      (await s.db.get('SELECT COUNT(*) AS n FROM registrations WHERE gc_billing_request_id IS NOT NULL')).n);
    (await authorise(s, row, 'GC-R1'));
    assert.equal((await post(s, '/api/registrations/resume', { ref: row.public_token })).status, 409);
  });

  test('parent returns before GoCardless notifies us: the status check picks up the Direct Debit', async () => {
    const { row } = await register(s, { childName: 'Eli', startDate: '2026-11-23' });
    s.gcMock.state.brStatus[row.gc_billing_request_id] = 'fulfilled';
    const st = await status(s, row);
    assert.equal(st.stage, 'payment_due');
    assert.equal(st.upfrontPence, 1200);
  });

  test('a cancelled Direct Debit stops the journey and no card payment can start', async () => {
    const { row } = await register(s, { childName: 'Fin', startDate: '2026-11-23' });
    const cur = await authorise(s, row, 'GC-5');
    s.gcMock.state.mandateStatus[cur.gc_mandate_id] = 'cancelled';
    await gcWebhook(s, [{ id: 'GC-5c', resource_type: 'mandates', action: 'cancelled', links: { mandate: cur.gc_mandate_id }, details: { cause: 'bank_account_closed' } }]);
    assert.equal((await status(s, cur)).stage, 'direct_debit_failed');
    assert.equal((await post(s, '/api/registrations/checkout', { ref: cur.public_token })).status, 409);
    assert.ok(s.sent.some((m) => m.to === 'ysp' && /Direct Debit cancelled/.test(m.subject)));
  });

  test('no upfront payment needed: subscription is created as soon as the Direct Debit exists', async () => {
    await setSettings(s, { billingRules: { ...YSP.defaults.billingRules, minimumCardChargePence: 1000 } }); // £6 for one session is waived
    try {
      const { row } = await register(s, { childName: 'Gus', startDate: '2026-11-30' });
      const before = subCalls(s).length;
      const cur = await authorise(s, row, 'GC-6');
      assert.equal(cur.upfront_status, 'not_required');
      assert.equal(cur.registration_status, 'active');
      assert.equal(subCalls(s).length, before + 1);
      assert.equal(subCalls(s).at(-1).body.subscriptions.start_date, '2026-12-01');
      assert.ok(s.sent.some((m) => m.to === 'sam@example.com' && /Gus's YSP membership is confirmed/.test(m.subject)));
    } finally { await setSettings(s, YSP.defaults); }
  });

});

describe('capacity', () => {
  let s;
  before(async () => { s = await startServer('2026-11-10T10:00:00Z'); });
  after(() => { s.server.close(); YSP.applySettings({}); });

  test('full sessions refuse new registrations', async () => {
    const programmes = JSON.parse(JSON.stringify(YSP.defaults.programmes));
    programmes[1].sessions[0].capacity = 1; // Development Thursday
    await setSettings(s, { programmes });
    try {
      await register(s, { childName: 'Hal', childDob: '2013-05-01', programmeId: 'development', membershipId: 'development-1', days: ['Thursday'], startDate: '2026-11-12' });
      const r = await post(s, '/api/registrations', { ...parent, childName: 'Ivy', childDob: '2013-05-01', programmeId: 'development', membershipId: 'development-1', days: ['Thursday'], startDate: '2026-11-12' });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /Thursday Development Basketball session is full/);
      const fri = await post(s, '/api/registrations', { ...parent, childName: 'Ivy', childDob: '2013-05-01', programmeId: 'development', membershipId: 'development-1', days: ['Friday'], startDate: '2026-11-13' });
      assert.equal(fri.status, 201);
    } finally { await setSettings(s, YSP.defaults); }
  });
});

describe('registering near the end of the month (today = Thu 26 Nov 2026)', () => {
  let s;
  before(async () => { s = await startServer('2026-11-26T10:00:00Z'); await setSettings(s, { closures: [{ from: '2026-12-19', to: '2027-01-03', reason: 'Christmas' }] }); });
  after(() => { s.server.close(); YSP.applySettings({}); });

  test('1 December is too soon, so the card covers the rest of November and all of December', async () => {
    const q = await get(s, '/api/registrations/quote?membershipId=grassroots-2&startDate=2026-11-27');
    assert.equal(q.body.firstCollectionDate, '2027-01-01');
    assert.equal(q.body.upfrontPence, 6111);
    const { row } = await register(s, { membershipId: 'grassroots-2', days: ['Monday', 'Friday'], startDate: '2026-11-27' });
    s.gcMock.state.defaultNpcd = '2026-12-04';
    const cur = await authorise(s, row, 'GC-N1');
    assert.equal(cur.upfront_pence, 6111);
    assert.equal(cur.covered_to, '2026-12-31');
    const co = await post(s, '/api/registrations/checkout', { ref: cur.public_token });
    const session = s.stMock.pay(co.body.url.split('/').pop());
    await stripeWebhook(s, { id: 'evt_n1', type: 'checkout.session.completed', data: { object: session } });
    const sub = subCalls(s).at(-1).body.subscriptions;
    assert.deepEqual([sub.amount, sub.start_date, sub.day_of_month], [5000, '2027-01-01', 1]);
  });
});
