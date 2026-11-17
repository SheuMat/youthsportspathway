'use strict';
// Admin accounts: email + password (scrypt) + authenticator app (TOTP, RFC 6238), with server-side
// sessions held in an HttpOnly cookie. The first account is created with the ADMIN_TOKEN set in Vercel.
const crypto = require('node:crypto');

const COOKIE = 'ysp_admin';
const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const TOTP_STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
const totpStep = (ms) => Math.floor(ms / 1000 / TOTP_STEP);
const totpCode = (secret, ms) => hotp(secret, totpStep(ms));
/** Returns the matching time step (±1 step of clock drift), or null. */
function checkTotp(secret, code, ms) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = totpStep(ms);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(hotp(secret, s), code)) return s;
  return null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function create({ db, config, now = () => new Date() }) {
  const secureCookie = /^https:/.test(config.publicBaseUrl);
  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  async function anyActiveAdmin() {
    return Boolean(await db.get('SELECT id FROM admin_users WHERE totp_enabled = 1 AND active = 1 LIMIT 1'));
  }

  async function state() {
    return { setupRequired: !(await anyActiveAdmin()), setupAllowed: Boolean(config.adminToken) };
  }

  /** Step 1 of first-time setup. Only while no active admin exists, and only with ADMIN_TOKEN. */
  async function beginSetup({ setupToken, email, password, name }) {
    if (await anyActiveAdmin()) return { status: 409, error: 'An admin account already exists. Sign in instead.' };
    if (!config.adminToken || !safeEqual(setupToken || '', config.adminToken)) return { status: 401, error: 'The setup token is incorrect.' };
    email = String(email || '').trim().toLowerCase().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 422, error: 'Enter a valid email address.' };
    if (String(password || '').length < 12) return { status: 422, error: 'Use a password of at least 12 characters.' };
    const secret = base32Encode(crypto.randomBytes(20));
    await db.run('DELETE FROM admin_users WHERE totp_enabled = 0');
    await db.run('INSERT INTO admin_users (email, name, password_hash, totp_secret, totp_enabled, active) VALUES (?, ?, ?, ?, 0, 1)',
      email, String(name || '').trim().slice(0, 100) || null, hashPassword(password), secret);
    await db.audit('admin', null, 'setup_started', email);
    const uri = `otpauth://totp/${encodeURIComponent('YSP Admin:' + email)}?secret=${secret}&issuer=${encodeURIComponent('YSP Admin')}`;
    return { status: 200, secret, uri };
  }

  /** Step 2: confirm the authenticator code, which activates the account and signs in. */
  async function finishSetup({ email, code }) {
    const u = await db.get('SELECT * FROM admin_users WHERE email = ? AND totp_enabled = 0', String(email || '').trim().toLowerCase());
    if (!u) return { status: 404, error: 'Setup not started. Start again.' };
    const step = checkTotp(u.totp_secret, code, now().getTime());
    if (step === null) return { status: 401, error: 'That code is not right. Check the time on your phone and try the newest code.' };
    await db.run('UPDATE admin_users SET totp_enabled = 1, last_totp_step = ? WHERE id = ?', step, u.id);
    await db.audit('admin', u.id, 'setup_completed');
    return { status: 200, ...(await startSession(u.id)) };
  }

  async function login({ email, password, code }, ip) {
    const generic = { status: 401, error: 'Email, password or code is incorrect.' };
    const u = await db.get('SELECT * FROM admin_users WHERE email = ? AND active = 1 AND totp_enabled = 1', String(email || '').trim().toLowerCase());
    const t = now();
    if (!u) { verifyPassword('x'.repeat(12), hashPassword('timing-equaliser')); return generic; }
    if (u.locked_until && new Date(u.locked_until) > t) return { status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
    const passOk = verifyPassword(String(password || ''), u.password_hash);
    const step = passOk ? checkTotp(u.totp_secret, code, t.getTime()) : null;
    const replay = step !== null && u.last_totp_step !== null && step <= Number(u.last_totp_step);
    if (!passOk || step === null || replay) {
      const failures = Number(u.failed_attempts || 0) + 1;
      const lock = failures >= MAX_FAILURES ? new Date(t.getTime() + LOCK_MINUTES * 60000).toISOString() : null;
      await db.run('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?', lock ? 0 : failures, lock, u.id);
      await db.audit('admin', u.id, lock ? 'login_locked' : 'login_failed', ip);
      return generic;
    }
    await db.run('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_totp_step = ?, last_login_at = ? WHERE id = ?', step, t.toISOString(), u.id);
    await db.audit('admin', u.id, 'login', ip);
    return { status: 200, ...(await startSession(u.id)) };
  }

  async function startSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(now().getTime() + SESSION_HOURS * 3600000).toISOString();
    await db.run('INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
    return { setCookie: cookie(token, SESSION_HOURS * 3600) };
  }

  /** Returns the signed-in admin user, or null. */
  async function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = await db.get(`SELECT u.id, u.email, u.name, s.expires_at FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1 AND u.totp_enabled = 1`, sha256(token));
    if (!row || new Date(row.expires_at) <= now()) return null;
    return { id: row.id, email: row.email, name: row.name };
  }

  async function logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.run('DELETE FROM admin_sessions WHERE token_hash = ?', sha256(token));
    await db.run('DELETE FROM admin_sessions WHERE expires_at < ?', now().toISOString());
    return { setCookie: cookie('', 0) };
  }

  return { state, beginSetup, finishSetup, login, authenticate, logout, anyActiveAdmin };
}

module.exports = { create, totpCode, checkTotp, hashPassword, verifyPassword, base32Encode };
