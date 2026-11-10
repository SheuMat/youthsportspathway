'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { load } = require('../api/_lib/config');
const { createApp } = require('../api/_lib/app');
const gocardless = require('../api/_lib/gocardless');
const dbMod = require('../api/_lib/db');
const YSP = require('../js/site-data.js');

const SECRET = 'whsec_test_secret';
const ADMIN = 'admin-token-for-tests-0123456789';
const quiet = { info() {}, warn() {}, error() {} };

// ── Mock GoCardless API ──
function mockGoCardless() {
  const calls = [];
  const state = { mandates: {}, payments: {}, subs: {}, idem: {} };
  let n = 0;
  async function fetchImpl(url, opts) {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method, path: u.pathname, body, headers: opts.headers });
    assert.equal(opts.headers['GoCardless-Version'], '2015-07-06');
    assert.match(opts.headers.Authorization, /^Bearer sandbox_/);
    const ok = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { 'Content-Type': 'application/json' } });
    const key = opts.headers['Idempotency-Key'];
    if (opts.method === 'POST' && u.pathname === '/billing_requests') return ok({ billing_requests: { id: 'BRQ' + (++n), status: 'pending' } }, 201);
    if (opts.method === 'POST' && u.pathname === '/billing_request_flows') return ok({ billing_request_flows: { id: 'BRF' + (++n), authorisation_url: 'https://pay-sandbox.gocardless.com/flow/BRF' + n } }, 201);
    if (opts.method === 'GET' && u.pathname.startsWith('/billing_requests/')) return ok({ billing_requests: { id: u.pathname.split('/')[2], links: { mandate_request_mandate: 'MD1', customer: 'CU1' } } });
    if (opts.method === 'GET' && u.pathname.startsWith('/mandates/')) return ok({ mandates: { id: u.pathname.split('/')[2], status: state.mandates[u.pathname.split('/')[2]] || 'pending_submission' } });
    if (opts.method === 'GET' && u.pathname.startsWith('/payments/')) return ok({ payments: state.payments[u.pathname.split('/')[2]] });
    if (opts.method === 'GET' && u.pathname.startsWith('/subscriptions/')) return ok({ subscriptions: state.subs[u.pathname.split('/')[2]] });
    if (opts.method === 'POST' && u.pathname === '/subscriptions') {
      if (key && state.idem[key]) {
        return ok({ error: { message: 'conflict', type: 'invalid_state', errors: [{ reason: 'idempotent_creation_conflict', links: { conflicting_resource_id: state.idem[key] } }] } }, 409);
      }
      const id = 'SB' + (++n);
      state.subs[id] = { id, status: 'active', ...body.subscriptions };
      if (key) state.idem[key] = id;
      return ok({ subscriptions: state.subs[id] }, 201);
    }
    if (opts.method === 'POST' && /\/subscriptions\/.+\/actions\/cancel/.test(u.pathname)) {
      const id = u.pathname.split('/')[2]; state.subs[id].status = 'cancelled';
      return ok({ subscriptions: state.subs[id] });
    }
    return ok({ error: { message: 'not mocked ' + u.pathname } }, 404);
  }
  return { calls, state, fetchImpl };
}

// Set TEST_DATABASE_URL=postgres://... to run the suite against Postgres (a fresh database per server).
async function freshDb() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return dbMod.open(':memory:');
  const { Client } = require('pg');
  const name = 'ysp_test_' + crypto.randomBytes(4).toString('hex');
  const c = new Client({ connectionString: base }); await c.connect();
  await c.query(`CREATE DATABASE ${name}`); await c.end();
  const u = new URL(base); u.pathname = '/' + name;
  return dbMod.open(u.toString());
}

async function startServer(envOverrides = {}) {
  const config = load({ GOCARDLESS_ACCESS_TOKEN: 'sandbox_abc', GOCARDLESS_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: ADMIN, PUBLIC_BASE_URL: 'https://example.test', ...envOverrides });
  const mock = mockGoCardless();
  const gc = gocardless.client({ accessToken: config.gocardless.accessToken, apiBase: 'https://api-sandbox.gocardless.com' }, mock.fetchImpl);
  const db = await freshDb();
  const app = createApp({ config, db, gc, log: quiet, now: () => new Date('2026-11-10T10:00:00Z') });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, db, mock, app, config };
}

function postJson(base, path, body, headers = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}
function webhook(base, events, secret = SECRET) {
  const raw = JSON.stringify({ events });
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(base + '/api/webhooks/gocardless', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Signature': sig }, body: raw })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

const parent = { parentName: 'Sam Parent', parentEmail: 'sam@example.com', parentPhone: '07700 900123', privacyAck: true };
const reg = (o) => ({ ...parent, childName: 'Alex Parent', childAge: 8, termsAck: true, programmeId: 'grassroots', membershipId: 'grassroots-1', days: ['Monday'], ...o });

describe('shared programme data', () => {
  test('four distinct membership products with correct prices', () => {
    assert.deepEqual(YSP.memberships.map((m) => [m.id, m.amountPence]), [['grassroots-1', 3000], ['grassroots-2', 5000], ['development-1', 3000], ['development-2', 5000]]);
  });
  test('timetable has the four sessions in order', () => {
    assert.deepEqual(YSP.timetable().map((r) => `${r.session.day} ${r.session.start} ${r.programme.id}`),
      ['Monday 17:00 grassroots', 'Thursday 18:00 development', 'Friday 17:00 grassroots', 'Friday 18:00 development']);
  });
  test('day validation', () => {
    assert.equal(YSP.validateMembershipDays('grassroots-1', ['Monday']), null);
    assert.equal(YSP.validateMembershipDays('grassroots-1', ['Friday']), null);
    assert.ok(YSP.validateMembershipDays('grassroots-1', ['Thursday']));
    assert.ok(YSP.validateMembershipDays('grassroots-1', ['Monday', 'Friday']));
    assert.equal(YSP.validateMembershipDays('grassroots-2', ['Monday', 'Friday']), null);
    assert.ok(YSP.validateMembershipDays('grassroots-2', ['Monday', 'Thursday']));
    assert.ok(YSP.validateMembershipDays('development-2', ['Monday', 'Friday']));
    assert.equal(YSP.validateMembershipDays('development-1', ['Thursday']), null);
    assert.ok(YSP.validateMembershipDays('development-1', ['Wednesday']));
  });
});

describe('config safety', () => {
  test('live mode refused without approval', () => {
    const c = load({ GOCARDLESS_ENVIRONMENT: 'live', GOCARDLESS_ACCESS_TOKEN: 'live_x', GOCARDLESS_WEBHOOK_SECRET: 's' });
    assert.equal(c.gocardless.enabled, false);
    assert.match(c.gocardless.problems.join(), /not approved/);
  });
  test('sandbox refuses a live token', () => {
    const c = load({ GOCARDLESS_ACCESS_TOKEN: 'live_x', GOCARDLESS_WEBHOOK_SECRET: 's' });
    assert.equal(c.gocardless.enabled, false);
  });
  test('subscriptions are not auto-created by default', () => {
    assert.equal(load({}).billing.autoCreateSubscriptions, false);
  });
});

describe('server', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { s.server.close(); await s.db.close(); });

  test('serves pages but not server code, secrets or dotfiles', async () => {
    assert.equal((await fetch(s.base + '/')).status, 200);
    assert.equal((await fetch(s.base + '/taster.html')).status, 200);
    assert.equal((await fetch(s.base + '/js/site-data.js')).status, 200);
    for (const p of ['/server/app.js', '/package.json', '/.env', '/data/ysp.sqlite', '/tests/server.test.js', '/js/../server/config.js', '/%2e%2e/etc/passwd', '/.git/config']) {
      assert.equal((await fetch(s.base + p)).status, 404, p);
    }
    const r = await fetch(s.base + '/');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  test('enquiry: valid, invalid, wrong content type, honeypot', async () => {
    const ok = await postJson(s.base, '/api/enquiries', { type: 'school', firstName: 'A', lastName: 'B', email: 'a@b.co.uk', message: 'Hello', privacyAck: true });
    assert.equal(ok.status, 201);
    assert.equal((await s.db.get('SELECT CAST(count(*) AS INTEGER) n FROM enquiries')).n, 1);
    const bad = await postJson(s.base, '/api/enquiries', { type: 'school', firstName: 'A', lastName: 'B', email: 'nope', message: 'x', privacyAck: true });
    assert.equal(bad.status, 422); assert.ok(bad.body.fields.email);
    const noPrivacy = await postJson(s.base, '/api/enquiries', { type: 'general', firstName: 'A', lastName: 'B', email: 'a@b.com', message: 'x' });
    assert.equal(noPrivacy.status, 422);
    const txt = await fetch(s.base + '/api/enquiries', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(txt.status, 415);
    const bot = await postJson(s.base, '/api/enquiries', { website: 'spam' });
    assert.equal(bot.status, 200);
    assert.equal((await s.db.get('SELECT CAST(count(*) AS INTEGER) n FROM enquiries')).n, 1);
    const xorigin = await postJson(s.base, '/api/enquiries', { type: 'general', firstName: 'A', lastName: 'B', email: 'a@b.com', message: 'x', privacyAck: true }, { Origin: 'https://evil.example' });
    assert.equal(xorigin.status, 403);
  });

  test('newsletter requires marketing consent', async () => {
    const r = await postJson(s.base, '/api/enquiries', { type: 'newsletter', firstName: 'A', email: 'n@b.com', message: 'Newsletter sign-up', privacyAck: true });
    assert.equal(r.status, 422);
    const ok = await postJson(s.base, '/api/enquiries', { type: 'newsletter', firstName: 'A', email: 'n@b.com', message: 'Newsletter sign-up', privacyAck: true, marketingConsent: true });
    assert.equal(ok.status, 201);
  });

  test('taster: valid request is stored and acknowledged, never charged', async () => {
    const before = s.mock.calls.length;
    const r = await postJson(s.base, '/api/tasters', { ...parent, programmeId: 'development', day: 'Thursday', preferredDate: '2026-11-12', childName: 'Jo', childAge: 12 });
    assert.equal(r.status, 201); assert.equal(r.body.status, 'requested'); assert.match(r.body.reference, /^YSPT-/);
    assert.equal(s.mock.calls.length, before, 'no GoCardless calls for tasters');
    const sent = s.app.notify.sent.map((m) => m.to);
    assert.ok(sent.includes('youthsportspathway@gmail.com') && sent.includes('sam@example.com'));
  });

  test('taster: day must belong to programme, date must match day, age in range, future date', async () => {
    const base = { ...parent, childName: 'Jo', childAge: 8 };
    let r = await postJson(s.base, '/api/tasters', { ...base, programmeId: 'grassroots', day: 'Thursday', preferredDate: '2026-11-12' });
    assert.equal(r.status, 422); assert.ok(r.body.fields.day);
    r = await postJson(s.base, '/api/tasters', { ...base, programmeId: 'grassroots', day: 'Monday', preferredDate: '2026-11-13' });
    assert.equal(r.status, 422); assert.ok(r.body.fields.preferredDate);
    r = await postJson(s.base, '/api/tasters', { ...base, programmeId: 'grassroots', day: 'Monday', preferredDate: '2026-11-09' });
    assert.equal(r.status, 422);
    r = await postJson(s.base, '/api/tasters', { ...base, childAge: 13, programmeId: 'grassroots', day: 'Monday', preferredDate: '2026-11-16' });
    assert.equal(r.status, 422); assert.ok(r.body.fields.childAge);
    r = await postJson(s.base, '/api/tasters', { ...base, programmeId: 'grassroots', day: 'Wednesday', preferredDate: '2026-11-11' });
    assert.equal(r.status, 422);
  });

  test('registration: rejects cross-programme or arbitrary day combinations', async () => {
    let r = await postJson(s.base, '/api/registrations', reg({ membershipId: 'grassroots-2', days: ['Monday', 'Thursday'] }));
    assert.equal(r.status, 422);
    r = await postJson(s.base, '/api/registrations', reg({ membershipId: 'development-1', days: ['Thursday'] }));
    assert.equal(r.status, 422, 'membership belongs to a different programme than selected');
    r = await postJson(s.base, '/api/registrations', reg({ days: ['Monday', 'Friday'] }));
    assert.equal(r.status, 422);
    r = await postJson(s.base, '/api/registrations', reg({ termsAck: false }));
    assert.equal(r.status, 422);
  });

  test('registration: Development is held for operational approval with no Direct Debit', async () => {
    const before = s.mock.calls.length;
    const r = await postJson(s.base, '/api/registrations', reg({ programmeId: 'development', membershipId: 'development-2', days: ['Thursday', 'Friday'], childAge: 13, childName: 'Dev Kid' }));
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'awaiting_operational_approval');
    assert.equal(r.body.authorisationUrl, undefined);
    assert.equal(s.mock.calls.length, before);
  });

  test('registration: existing Direct Debit customers are not sent to GoCardless', async () => {
    const before = s.mock.calls.length;
    const r = await postJson(s.base, '/api/registrations', reg({ childName: 'Existing', existingDirectDebit: true }));
    assert.equal(r.body.status, 'existing_customer_review');
    assert.equal(s.mock.calls.length, before);
  });

  test('full Direct Debit lifecycle with verified, de-duplicated webhooks', async () => {
    const r = await postJson(s.base, '/api/registrations', reg());
    assert.equal(r.status, 201);
    assert.match(r.body.authorisationUrl, /^https:\/\/pay-sandbox\.gocardless\.com\//);
    const brCall = s.mock.calls.find((c) => c.path === '/billing_requests');
    assert.deepEqual(brCall.body.billing_requests.mandate_request, { scheme: 'bacs', currency: 'GBP', description: 'YSP Grassroots: One Weekly Session' });
    const flow = s.mock.calls.find((c) => c.path === '/billing_request_flows');
    assert.match(flow.body.billing_request_flows.redirect_uri, /^https:\/\/example\.test\/register-complete\.html\?ref=/);

    const row = (await s.db.get("SELECT * FROM registrations WHERE child_name = 'Alex Parent'"));
    assert.equal(row.mandate_status, 'pending_customer');
    assert.equal(row.payment_status, 'none');

    // duplicate registration blocked
    const dup = await postJson(s.base, '/api/registrations', reg());
    assert.equal(dup.status, 409);

    // bad signature
    const bad = await webhook(s.base, [{ id: 'EV0', resource_type: 'mandates', action: 'active', links: { mandate: 'MD1' } }], 'wrong');
    assert.equal(bad.status, 498);

    // billing request fulfilled → mandate linked, NOT a payment
    let w = await webhook(s.base, [{ id: 'EV1', resource_type: 'billing_requests', action: 'fulfilled', links: { billing_request: row.gc_billing_request_id } }]);
    assert.equal(w.status, 200);
    let cur = (await s.db.get('SELECT * FROM registrations WHERE id = ?', row.id));
    assert.equal(cur.gc_mandate_id, 'MD1');
    assert.equal(cur.mandate_status, 'pending_submission');
    assert.equal(cur.payment_status, 'none');
    assert.equal(cur.subscription_status, 'none');

    const status = await (await fetch(s.base + '/api/registrations/status?ref=' + row.public_token)).json();
    assert.match(status.message, /not a payment/);

    // mandate active; auto-create is off so no subscription
    w = await webhook(s.base, [{ id: 'EV2', resource_type: 'mandates', action: 'active', links: { mandate: 'MD1' } }]);
    cur = (await s.db.get('SELECT * FROM registrations WHERE id = ?', row.id));
    assert.equal(cur.mandate_status, 'active');
    assert.equal(cur.gc_subscription_id, null);

    // duplicate delivery is ignored
    w = await webhook(s.base, [{ id: 'EV2', resource_type: 'mandates', action: 'active', links: { mandate: 'MD1' } }]);
    assert.deepEqual(w.body, { processed: 0, duplicates: 1 });

    // admin requires auth
    assert.equal((await postJson(s.base, `/api/admin/registrations/${row.id}/subscribe`, {})).status, 401);
    const auth = { Authorization: 'Bearer ' + ADMIN };
    let a = await postJson(s.base, `/api/admin/registrations/${row.id}/subscribe`, {}, auth);
    assert.equal(a.status, 200);
    const subCall = s.mock.calls.filter((c) => c.path === '/subscriptions');
    assert.equal(subCall.length, 1);
    assert.equal(subCall[0].body.subscriptions.amount, 3000);
    assert.equal(subCall[0].body.subscriptions.interval_unit, 'monthly');
    assert.equal(subCall[0].body.subscriptions.links.mandate, 'MD1');
    assert.match(subCall[0].headers['Idempotency-Key'], /^ysp-sub-YSPM-/);
    a = await postJson(s.base, `/api/admin/registrations/${row.id}/subscribe`, {}, auth);
    assert.equal(a.body.already, true);
    assert.equal(s.mock.calls.filter((c) => c.path === '/subscriptions').length, 1, 'no duplicate subscription');
    cur = (await s.db.get('SELECT * FROM registrations WHERE id = ?', row.id));
    assert.equal(cur.registration_status, 'active');

    // payment confirmed then a failure
    s.mock.state.payments.PM1 = { id: 'PM1', status: 'confirmed', amount: 3000, charge_date: '2026-12-01', links: { mandate: 'MD1', subscription: cur.gc_subscription_id } };
    await webhook(s.base, [{ id: 'EV3', resource_type: 'payments', action: 'confirmed', links: { payment: 'PM1' } }]);
    assert.equal((await s.db.get('SELECT payment_status FROM registrations WHERE id = ?', row.id)).payment_status, 'confirmed');
    s.mock.state.payments.PM2 = { id: 'PM2', status: 'failed', amount: 3000, charge_date: '2027-01-01', links: { mandate: 'MD1', subscription: cur.gc_subscription_id } };
    await webhook(s.base, [{ id: 'EV4', resource_type: 'payments', action: 'failed', links: { payment: 'PM2' }, details: { cause: 'insufficient_funds' } }]);
    assert.equal((await s.db.get('SELECT payment_status FROM registrations WHERE id = ?', row.id)).payment_status, 'failed');
    assert.ok(s.app.notify.sent.some((m) => /Payment failed/.test(m.subject)));
    assert.equal((await s.db.get('SELECT CAST(count(*) AS INTEGER) n FROM payments')).n, 2);

    // admin cancels
    a = await postJson(s.base, `/api/admin/registrations/${row.id}/cancel`, {}, auth);
    assert.equal(a.status, 200);
    cur = (await s.db.get('SELECT * FROM registrations WHERE id = ?', row.id));
    assert.equal(cur.subscription_status, 'cancelled');
    assert.equal(cur.registration_status, 'cancelled');
  });

  test('admin overview requires the token', async () => {
    assert.equal((await fetch(s.base + '/api/admin/overview')).status, 401);
    const r = await fetch(s.base + '/api/admin/overview', { headers: { Authorization: 'Bearer ' + ADMIN } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.gocardless.environment, 'sandbox');
  });
});

describe('auto-create subscriptions (when owner enables it)', () => {
  let s;
  before(async () => { s = await startServer({ BILLING_AUTO_CREATE_SUBSCRIPTIONS: 'true', BILLING_DAY_OF_MONTH: '1' }); });
  after(async () => { s.server.close(); await s.db.close(); });

  test('creates exactly one subscription even if mandate events repeat', async () => {
    const r = await postJson(s.base, '/api/registrations', reg({ membershipId: 'grassroots-2', days: ['Monday', 'Friday'] }));
    const row = (await s.db.get('SELECT * FROM registrations WHERE reference = ?', r.body.reference));
    s.mock.state.mandates.MD1 = 'active';
    await webhook(s.base, [{ id: 'A1', resource_type: 'billing_requests', action: 'fulfilled', links: { billing_request: row.gc_billing_request_id, mandate_request_mandate: 'MD1', customer: 'CU1' } }]);
    await webhook(s.base, [{ id: 'A2', resource_type: 'mandates', action: 'active', links: { mandate: 'MD1' } }]);
    await webhook(s.base, [{ id: 'A3', resource_type: 'mandates', action: 'reinstated', links: { mandate: 'MD1' } }]);
    const subs = s.mock.calls.filter((c) => c.path === '/subscriptions');
    assert.equal(subs.length, 1);
    assert.equal(subs[0].body.subscriptions.amount, 5000);
    assert.equal(subs[0].body.subscriptions.day_of_month, 1);
  });
});

describe('no GoCardless configured', () => {
  test('registration is saved and parent told no payment was taken', async () => {
    const config = load({});
    const app = createApp({ config, db: await freshDb(), gc: null, log: quiet });
    const server = http.createServer(app.handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await postJson(base, '/api/registrations', reg());
    server.close();
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'submitted');
    assert.equal(r.body.authorisationUrl, undefined);
  });
});
