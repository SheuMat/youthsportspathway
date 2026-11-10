'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const validate = require('./validate');
const gocardless = require('./gocardless');
const billingMod = require('./billing');
const notifyMod = require('./notify');
const dbMod = require('./db');
const emails = require('./emails');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml'
};
const PUBLIC_DIRS = ['css', 'js', 'assets'];
const MAX_BODY = 32 * 1024;
const MAX_WEBHOOK_BODY = 512 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function createApp({ config, db, gc, notify, log = console, now = () => new Date() }) {
  // db === null means "email-only" mode: submissions are emailed but not stored.
  if (db === undefined) db = dbMod.open(config.databaseUrl || config.databasePath);
  notify = notify || notifyMod.create(config.email, log);
  if (gc === undefined) gc = config.gocardless.enabled && db ? gocardless.client(config.gocardless) : null;
  const billing = db ? billingMod.create({ db, config, gc, notify, log }) : null;
  const emailOnly = !db;
  const UNAVAILABLE = 'We couldn\'t send your form just now. Please try again, or email ' + validate.YSP.contact.email + '.';
  const hits = new Map();

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  }
  function readBody(req, limit) {
    // Some hosts hand over an already-buffered body.
    const pre = req.rawBody;
    if (Buffer.isBuffer(pre) || typeof pre === 'string') {
      const buf = Buffer.isBuffer(pre) ? pre : Buffer.from(pre);
      if (buf.length > limit) return Promise.reject(Object.assign(new Error('Request too large'), { status: 413 }));
      return Promise.resolve(buf);
    }
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
    const raw = await readBody(req, MAX_BODY);
    try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  function rateLimited(req, bucket, max = 10, windowMs = 10 * 60 * 1000) {
    const ip = req.socket.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`; const t = Date.now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    list.push(t); hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length > max;
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host || origin === config.publicBaseUrl; } catch { return false; }
  }
  function isAdmin(req) {
    if (!config.adminToken) return false;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = crypto.createHash('sha256').update(m[1]).digest();
    const b = crypto.createHash('sha256').update(config.adminToken).digest();
    return crypto.timingSafeEqual(a, b);
  }
  function invalid(res, c) { return send(res, 422, { error: c.message, fields: c.fields }); }

  // ── Public API ──
  async function postEnquiry(req, res) {
    const b = await readJson(req);
    if (b.website) return send(res, 200, { ok: true, reference: 'YSPE-OK' }); // honeypot
    const { c, v } = validate.enquiry(b);
    if (!c.ok) return invalid(res, c);
    const reference = billingMod.newReference('YSPE');
    if (db) {
      await db.run('INSERT INTO enquiries (reference, type, first_name, last_name, email, phone, message, marketing_consent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        reference, v.type, v.firstName, v.lastName, v.email, v.phone, v.message, v.marketingConsent ? 1 : 0);
    }
    const m = emails.enquiryToYsp(v, reference);
    const delivered = await notify.toYsp(m.subject, m.text, v.email);
    if (emailOnly && !delivered) return send(res, 503, { error: UNAVAILABLE });
    send(res, 201, { ok: true, reference });
  }

  async function postTaster(req, res) {
    const b = await readJson(req);
    if (b.website) return send(res, 200, { ok: true, reference: 'YSPT-OK' });
    const { c, v } = validate.taster(b, now().toISOString().slice(0, 10));
    if (!c.ok) return invalid(res, c);
    const reference = billingMod.newReference('YSPT');
    if (db) {
      const r = await db.run(`INSERT INTO tasters (reference, programme_id, day, preferred_date, parent_name, parent_email, parent_phone, child_name, child_age, notes, marketing_consent,
        emergency_name, emergency_phone, medical_info, consent_participation, consent_medical, consent_photo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, reference, v.programmeId, v.day, v.preferredDate, v.parentName, v.parentEmail, v.parentPhone, v.childName, v.childAge, v.notes, v.marketingConsent ? 1 : 0,
        v.emergencyName, v.emergencyPhone, v.medicalInfo, 1, 1, v.photoConsent);
      await db.audit('taster', Number(r.rows[0].id), 'created', 'requested');
    }
    const toYsp = emails.tasterToYsp(v, reference);
    const delivered = await notify.toYsp(toYsp.subject, toYsp.text, v.parentEmail);
    if (emailOnly && !delivered) return send(res, 503, { error: UNAVAILABLE });
    const ack = emails.tasterToParent(v, reference);
    await notify.toParent(v.parentEmail, ack.subject, ack.text);
    send(res, 201, { ok: true, reference, status: 'requested' });
  }

  async function postRegistration(req, res) {
    const b = await readJson(req);
    if (b.website) return send(res, 200, { ok: true, reference: 'YSPM-OK', message: 'Thanks.' });
    const { c, v } = validate.registration(b);
    if (!c.ok) return invalid(res, c);
    if (billing) {
      const out = await billing.register(v);
      return send(res, 201, { ok: true, ...out });
    }
    // Email-only: no Direct Debit without a database to track it.
    const reference = billingMod.newReference('YSPM');
    const message = v.existingDirectDebit
      ? "Thanks — we've received your registration. As you already pay YSP by Direct Debit, we'll review your existing arrangement rather than setting up a second one."
      : v.programme.paidRegistrationOpen
        ? "Thanks — we've received your registration. We'll email you a secure GoCardless link to set up your monthly Direct Debit."
        : `Thanks — we've received your registration for ${v.programme.name}. Places are being finalised, and we'll contact you to confirm before any Direct Debit is set up.`;
    const status = v.programme.paidRegistrationOpen ? (v.existingDirectDebit ? 'existing_customer_review' : 'submitted') : 'awaiting_operational_approval';
    const toYsp = emails.registrationToYsp(v, reference, status);
    const delivered = await notify.toYsp(toYsp.subject, toYsp.text, v.parentEmail);
    if (!delivered) return send(res, 503, { error: UNAVAILABLE });
    const ack = emails.registrationToParent(v, reference, message);
    await notify.toParent(v.parentEmail, ack.subject, ack.text);
    send(res, 201, { ok: true, status, reference, message });
  }

  async function postWebhook(req, res) {
    if (!billing) return send(res, 503, { error: 'Database not configured' });
    if (!config.gocardless.webhookSecret) return send(res, 503, { error: 'Webhooks not configured' });
    const raw = await readBody(req, MAX_WEBHOOK_BODY);
    if (!gocardless.verifySignature(raw, req.headers['webhook-signature'], config.gocardless.webhookSecret)) {
      return send(res, 498, { error: 'Invalid signature' });
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    const result = await billing.handleWebhook(payload);
    send(res, 200, result);
  }

  // ── Admin API ──
  async function admin(req, res, url) {
    if (!db) return send(res, 503, { error: 'Admin needs a database (set DATABASE_URL)' });
    if (!config.adminToken) return send(res, 503, { error: 'Admin is not configured (set ADMIN_TOKEN)' });
    if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorised' });
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/admin/overview') {
      return send(res, 200, {
        database: db.kind,
        emailProvider: notify.provider,
        gocardless: { enabled: config.gocardless.enabled, environment: config.gocardless.environment, problems: config.gocardless.problems },
        billing: config.billing,
        emailConfigured: notify.configured,
        enquiries: await db.all('SELECT * FROM enquiries ORDER BY id DESC LIMIT 200'),
        tasters: await db.all('SELECT * FROM tasters ORDER BY id DESC LIMIT 200'),
        registrations: await db.all('SELECT id, reference, membership_id, programme_id, days, amount_pence, parent_name, parent_email, parent_phone, child_name, child_age, notes, marketing_consent, existing_direct_debit, registration_status, mandate_status, subscription_status, payment_status, gc_mandate_id, gc_subscription_id, created_at, updated_at FROM registrations ORDER BY id DESC LIMIT 500'),
        payments: await db.all('SELECT * FROM payments ORDER BY updated_at DESC LIMIT 200')
      });
    }
    let m;
    if (req.method === 'POST' && (m = /^\/api\/admin\/tasters\/(\d+)$/.exec(p))) {
      const b = await readJson(req);
      if (!['requested', 'confirmed', 'declined', 'attended', 'no_show'].includes(b.status)) return send(res, 422, { error: 'Invalid status' });
      const t = await db.get('SELECT * FROM tasters WHERE id = ?', Number(m[1]));
      if (!t) return send(res, 404, { error: 'Not found' });
      await db.run('UPDATE tasters SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', b.status, t.id);
      await db.audit('taster', t.id, `status_${b.status}`);
      if (b.notifyParent && (b.status === 'confirmed' || b.status === 'declined')) {
        const prog = validate.YSP.getProgramme(t.programme_id);
        await notify.toParent(t.parent_email, `Your YSP free taster (${t.reference})`, b.status === 'confirmed'
          ? `Hi ${t.parent_name},\n\n${t.child_name}'s free ${prog.name} taster is confirmed for ${t.day} ${t.preferred_date}, ${prog.sessions.find((s) => s.day === t.day).time}.\n\nVenue: ${validate.YSP.venue.name}, ${validate.YSP.venue.address}\n\nSee you there!\nYouth Sports Pathway`
          : `Hi ${t.parent_name},\n\nUnfortunately we can't offer the taster on ${t.day} ${t.preferred_date}. We'll be in touch about another date.\n\nYouth Sports Pathway`);
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/admin\/registrations\/(\d+)\/(subscribe|cancel|status)$/.exec(p))) {
      const id = Number(m[1]);
      if (m[2] === 'status') {
        const b = await readJson(req);
        if (!['submitted', 'awaiting_operational_approval', 'existing_customer_review', 'rejected', 'cancelled'].includes(b.status)) return send(res, 422, { error: 'Invalid status' });
        await db.run('UPDATE registrations SET registration_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', b.status, id);
        await db.audit('registration', id, `admin_status_${b.status}`);
        return send(res, 200, { ok: true });
      }
      if (!gc) return send(res, 503, { error: 'GoCardless is not configured' });
      const out = m[2] === 'subscribe' ? await billing.createSubscription(id) : await billing.cancelSubscription(id);
      return send(res, 200, { ok: true, ...out });
    }
    send(res, 404, { error: 'Not found' });
  }

  // ── Static files ──
  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
    if (rel === '/') rel = '/index.html';
    const clean = path.posix.normalize(rel).replace(/^\/+/, '');
    const top = clean.split('/')[0];
    const allowed = (!clean.includes('/') && clean.endsWith('.html')) || PUBLIC_DIRS.includes(top);
    if (!allowed || clean.includes('..') || clean.split('/').some((s) => s.startsWith('.'))) return notFound(res);
    const file = path.join(config.root, clean);
    if (!file.startsWith(config.root + path.sep)) return notFound(res);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': /^(text\/html|text\/css|text\/javascript)/.test(type) ? 'no-cache' : 'public, max-age=86400' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }
  function notFound(res) { send(res, 404, '<!doctype html><title>Not found</title><p>Page not found. <a href="/">Return to the homepage</a>.</p>', { 'Content-Type': 'text/html; charset=utf-8' }); }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/webhooks/gocardless' && req.method === 'POST') return await postWebhook(req, res);
        if (url.pathname.startsWith('/api/admin/')) return await admin(req, res, url);
        if (url.pathname === '/api/health') return send(res, 200, { ok: true, database: db ? db.kind : 'none (email-only)', email: notify.provider, gocardless: config.gocardless.enabled ? config.gocardless.environment : 'disabled', admin: Boolean(config.adminToken) });
        if (url.pathname === '/api/registrations/status' && req.method === 'GET') {
          if (!billing) return send(res, 404, { error: 'Not found' });
          const s = await billing.publicStatus(String(url.searchParams.get('ref') || '').slice(0, 64));
          return s ? send(res, 200, s) : send(res, 404, { error: 'Not found' });
        }
        const routes = { '/api/enquiries': postEnquiry, '/api/tasters': postTaster, '/api/registrations': postRegistration };
        const fn = routes[url.pathname];
        if (!fn) return send(res, 404, { error: 'Not found' });
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Forbidden' });
        if (rateLimited(req, url.pathname)) return send(res, 429, { error: 'Too many submissions. Please try again later or email info@youthsportspathway.co.uk.' });
        return await fn(req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
      return serveStatic(req, res, url);
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      if (status === 500) log.error('[server]', err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Please try again or email info@youthsportspathway.co.uk.' : err.message });
    }
  }

  return { handler, db, billing, notify };
}

module.exports = { createApp };
