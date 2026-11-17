'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { load } = require('../api/_lib/config');
const { createApp } = require('../api/_lib/app');
const dbMod = require('../api/_lib/db');
const auth = require('../api/_lib/admin-auth');
const YSP = require('../js/site-data.js');

const TOKEN = 'setup-token-for-tests-0123456789';
const quiet = { info() {}, warn() {}, error() {} };
let clock = new Date('2026-11-17T10:00:00Z').getTime();
let s;

async function start() {
  const config = load({ ADMIN_TOKEN: TOKEN, PUBLIC_BASE_URL: 'https://example.test' });
  let db = dbMod.open(':memory:');
  if (process.env.TEST_DATABASE_URL) {
    const { Client } = require('pg');
    const name = 'ysp_admin_test_' + Date.now();
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect();
    await c.query(`CREATE DATABASE ${name}`); await c.end();
    const u = new URL(process.env.TEST_DATABASE_URL); u.pathname = '/' + name;
    db = dbMod.open(u.toString());
  }
  const app = createApp({ config, db, gc: null, log: quiet, now: () => new Date(clock) });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}
async function call(method, path, body, cookie, extra = {}) {
  const r = await fetch(s.base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => null), text: r.headers.get('content-type'), cookie: setCookie ? setCookie.split(';')[0] : null, raw: setCookie };
}
const tick = (sec = 30) => { clock += sec * 1000; };

before(async () => { s = await start(); });
after(() => { s.server.close(); YSP.applySettings({}); });

describe('TOTP', () => {
  test('matches the RFC 6238 test vector', () => {
    const secret = auth.base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(auth.totpCode(secret, 59 * 1000), '287082');
    assert.equal(auth.checkTotp(secret, '287082', 59 * 1000), 1);
    assert.equal(auth.checkTotp(secret, '000000', 59 * 1000), null);
  });
  test('passwords are salted scrypt hashes', () => {
    const h = auth.hashPassword('correct horse battery');
    assert.match(h, /^scrypt\$/);
    assert.notEqual(h, auth.hashPassword('correct horse battery'));
    assert.ok(auth.verifyPassword('correct horse battery', h));
    assert.ok(!auth.verifyPassword('wrong password!!', h));
  });
});

describe('admin accounts', () => {
  let secret;
  let cookie;
  const creds = { email: 'owner@example.com', password: 'a-long-test-password' };

  test('before setup, the shared token still works and the page asks for setup', async () => {
    const st = await call('GET', '/api/admin/auth/state');
    assert.equal(st.body.setupRequired, true);
    assert.equal((await call('GET', '/api/admin/overview', null, null, { Authorization: 'Bearer ' + TOKEN })).status, 200);
    assert.equal((await call('GET', '/api/admin/overview')).status, 401);
  });

  test('setup needs the ADMIN_TOKEN and a strong password', async () => {
    assert.equal((await call('POST', '/api/admin/auth/setup', { setupToken: 'wrong', ...creds })).status, 401);
    assert.equal((await call('POST', '/api/admin/auth/setup', { setupToken: TOKEN, email: creds.email, password: 'short' })).status, 422);
    const r = await call('POST', '/api/admin/auth/setup', { setupToken: TOKEN, name: 'Owner', ...creds });
    assert.equal(r.status, 200);
    assert.match(r.body.uri, /^otpauth:\/\/totp\//);
    assert.match(r.body.qrSvg, /<svg/);
    secret = r.body.secret;
  });

  test('a wrong authenticator code does not finish setup', async () => {
    assert.equal((await call('POST', '/api/admin/auth/setup/verify', { email: creds.email, code: '000000' })).status, 401);
  });

  test('the correct code activates the account and signs in with a secure cookie', async () => {
    const r = await call('POST', '/api/admin/auth/setup/verify', { email: creds.email, code: auth.totpCode(secret, clock) });
    assert.equal(r.status, 200);
    assert.match(r.raw, /HttpOnly/);
    assert.match(r.raw, /SameSite=Strict/);
    assert.match(r.raw, /Secure/);
    assert.match(r.raw, /Path=\/api\/admin/);
    cookie = r.cookie;
    const st = await call('GET', '/api/admin/auth/state', null, cookie);
    assert.equal(st.body.signedIn, true);
    assert.equal(st.body.user.email, creds.email);
  });

  test('once an account exists, setup is closed and the shared token stops working', async () => {
    assert.equal((await call('POST', '/api/admin/auth/setup', { setupToken: TOKEN, email: 'x@example.com', password: 'another-long-password' })).status, 409);
    assert.equal((await call('GET', '/api/admin/overview', null, null, { Authorization: 'Bearer ' + TOKEN })).status, 401);
    assert.equal((await call('GET', '/api/admin/overview', null, cookie)).status, 200);
  });

  test('sign-in needs password and code; a used code cannot be replayed', async () => {
    tick();
    const code = auth.totpCode(secret, clock);
    assert.equal((await call('POST', '/api/admin/auth/login', { ...creds, password: 'wrong-password-123', code })).status, 401);
    const ok = await call('POST', '/api/admin/auth/login', { ...creds, code });
    assert.equal(ok.status, 200);
    assert.ok(ok.cookie);
    assert.equal((await call('POST', '/api/admin/auth/login', { ...creds, code })).status, 401, 'same code again is refused');
  });

  test('cross-site requests are refused', async () => {
    const r = await call('PUT', '/api/admin/settings', { settings: YSP.exportSettings() }, cookie, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  test('sign out ends the session', async () => {
    tick();
    const fresh = await call('POST', '/api/admin/auth/login', { ...creds, code: auth.totpCode(secret, clock) });
    const out = await call('POST', '/api/admin/auth/logout', {}, fresh.cookie);
    assert.equal(out.status, 200);
    assert.equal((await call('GET', '/api/admin/overview', null, fresh.cookie)).status, 401);
  });

  test('five wrong attempts lock the account for 15 minutes', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/admin/auth/login', { ...creds, password: 'wrong-password-' + i, code: '123456' });
    tick();
    const locked = await call('POST', '/api/admin/auth/login', { ...creds, code: auth.totpCode(secret, clock) });
    assert.ok([429].includes(locked.status), 'locked even with correct details');
    clock += 16 * 60 * 1000;
    // The per-IP limiter (10 per 10 minutes) has also reset by now.
    const ok = await call('POST', '/api/admin/auth/login', { ...creds, code: auth.totpCode(secret, clock) });
    assert.equal(ok.status, 200);
    cookie = ok.cookie;
  });

  describe('settings', () => {
    test('admin can change prices, times, capacity, closures and rules', async () => {
      const cur = (await call('GET', '/api/admin/settings', null, cookie)).body.settings;
      cur.memberships.find((m) => m.id === 'grassroots-1').amountPence = 3500;
      cur.programmes.find((p) => p.id === 'development').sessions[0] = { day: 'Thursday', start: '18:30', end: '19:30', capacity: 20 };
      cur.closures = [{ from: '2026-12-19', to: '2027-01-03', reason: 'Christmas' }];
      cur.billingRules.estimateLeadWorkingDays = 8;
      const r = await call('PUT', '/api/admin/settings', { settings: cur }, cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(YSP.getMembership('grassroots-1').amountPence, 3500);
      assert.equal(YSP.getProgramme('development').sessions[0].time, '6:30pm – 7:30pm');
      assert.equal(YSP.billingRules.estimateLeadWorkingDays, 8);
    });

    test('the website receives the saved settings', async () => {
      const r = await fetch(s.base + '/api/settings.js');
      assert.match(r.headers.get('content-type'), /javascript/);
      const js = await r.text();
      assert.match(js, /"amountPence":3500/);
      assert.match(js, /Christmas/);
    });

    test('invalid settings are rejected with clear messages and nothing changes', async () => {
      const cur = (await call('GET', '/api/admin/settings', null, cookie)).body.settings;
      cur.memberships[0].amountPence = 5;
      cur.programmes[0].sessions[0].end = '16:00';
      cur.closures.push({ from: '2027-02-10', to: '2027-02-01' });
      const r = await call('PUT', '/api/admin/settings', { settings: cur }, cookie);
      assert.equal(r.status, 422);
      assert.equal(r.body.errors.length, 3);
      assert.equal(YSP.getMembership('grassroots-1').amountPence, 3500, 'unchanged');
    });

    test('settings survive a restart (loaded from the database)', async () => {
      YSP.applySettings({});
      assert.equal(YSP.getMembership('grassroots-1').amountPence, 3000);
      clock += 60 * 1000; // past the 30-second cache
      await fetch(s.base + '/api/health');
      assert.equal(YSP.getMembership('grassroots-1').amountPence, 3500);
    });

    test('saved settings cannot be used to inject script into pages', async () => {
      const cur = (await call('GET', '/api/admin/settings', null, cookie)).body.settings;
      cur.closures = [{ from: '2027-02-01', to: '2027-02-01', reason: '</script><script>alert(1)</script>' }];
      assert.equal((await call('PUT', '/api/admin/settings', { settings: cur }, cookie)).status, 200);
      const js = await (await fetch(s.base + '/api/settings.js')).text();
      assert.ok(!js.includes('</script>'));
    });

    test('changes are recorded in the audit log', async () => {
      const rows = await s.db.all("SELECT event, detail FROM audit_log WHERE entity = 'settings'");
      assert.ok(rows.length >= 2 && rows.every((r) => r.detail === 'owner@example.com'));
    });
  });
});
