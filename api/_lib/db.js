'use strict';
// Async database layer with two backends:
//  - Postgres when DATABASE_URL is set (Vercel + Neon/Vercel Postgres)
//  - SQLite file otherwise (local development and tests)
// SQL is written once using `?` placeholders and syntax both engines accept.
const fs = require('node:fs');
const path = require('node:path');

const TABLES = (idType, ts) => `
CREATE TABLE IF NOT EXISTS enquiries (
  id ${idType},
  reference TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  first_name TEXT, last_name TEXT, email TEXT NOT NULL, phone TEXT,
  message TEXT, marketing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  created_at ${ts}
);
CREATE TABLE IF NOT EXISTS tasters (
  id ${idType},
  reference TEXT UNIQUE NOT NULL,
  programme_id TEXT NOT NULL, day TEXT NOT NULL, preferred_date TEXT NOT NULL,
  parent_name TEXT NOT NULL, parent_email TEXT NOT NULL, parent_phone TEXT NOT NULL,
  child_name TEXT NOT NULL, child_age INTEGER NOT NULL, notes TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested',
  created_at ${ts},
  updated_at ${ts}
);
CREATE TABLE IF NOT EXISTS registrations (
  id ${idType},
  reference TEXT UNIQUE NOT NULL,
  public_token TEXT UNIQUE NOT NULL,
  membership_id TEXT NOT NULL, programme_id TEXT NOT NULL, days TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  parent_name TEXT NOT NULL, parent_email TEXT NOT NULL, parent_phone TEXT NOT NULL,
  child_name TEXT NOT NULL, child_age INTEGER NOT NULL, notes TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  existing_direct_debit INTEGER NOT NULL DEFAULT 0,
  registration_status TEXT NOT NULL,
  mandate_status TEXT NOT NULL DEFAULT 'none',
  subscription_status TEXT NOT NULL DEFAULT 'none',
  payment_status TEXT NOT NULL DEFAULT 'none',
  gc_billing_request_id TEXT UNIQUE, gc_customer_id TEXT, gc_mandate_id TEXT UNIQUE, gc_subscription_id TEXT UNIQUE,
  created_at ${ts},
  updated_at ${ts}
);
CREATE TABLE IF NOT EXISTS payments (
  gc_payment_id TEXT PRIMARY KEY,
  registration_id INTEGER REFERENCES registrations(id),
  amount_pence INTEGER, charge_date TEXT, status TEXT NOT NULL,
  updated_at ${ts}
);
CREATE TABLE IF NOT EXISTS webhook_events (
  gc_event_id TEXT PRIMARY KEY,
  resource_type TEXT, action TEXT,
  received_at ${ts}
);
CREATE TABLE IF NOT EXISTS audit_log (
  id ${idType},
  entity TEXT NOT NULL, entity_id INTEGER, event TEXT NOT NULL, detail TEXT,
  at ${ts}
);
`;

function withAudit(db) {
  db.audit = (entity, id, event, detail) =>
    db.run('INSERT INTO audit_log (entity, entity_id, event, detail) VALUES (?, ?, ?, ?)',
      entity, id ?? null, event, detail ? String(detail).slice(0, 2000) : null);
  return db;
}

function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const s = new DatabaseSync(file);
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  s.exec(TABLES('INTEGER PRIMARY KEY AUTOINCREMENT', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'));
  const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  return withAudit({
    kind: 'sqlite',
    async get(sql, ...p) { return s.prepare(sql).get(...norm(p)) || undefined; },
    async all(sql, ...p) { return s.prepare(sql).all(...norm(p)); },
    async run(sql, ...p) {
      const st = s.prepare(sql);
      if (/\bRETURNING\b/i.test(sql)) { const rows = st.all(...norm(p)); return { rows, changes: rows.length }; }
      const r = st.run(...norm(p));
      return { rows: [], changes: Number(r.changes) };
    },
    async close() { s.close(); }
  });
}

function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10000,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true }
  });
  let ready = null;
  const migrate = () => (ready = ready || pool.query(TABLES('SERIAL PRIMARY KEY', 'TIMESTAMPTZ NOT NULL DEFAULT now()')).catch((e) => { ready = null; throw e; }));
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  async function q(sql, p) { await migrate(); return pool.query(toPg(sql), norm(p)); }
  return withAudit({
    kind: 'postgres',
    async get(sql, ...p) { return (await q(sql, p)).rows[0]; },
    async all(sql, ...p) { return (await q(sql, p)).rows; },
    async run(sql, ...p) { const r = await q(sql, p); return { rows: r.rows, changes: r.rowCount }; },
    async close() { await pool.end(); }
  });
}

function open(target) {
  if (/^postgres(ql)?:\/\//.test(target)) return openPostgres(target);
  return openSqlite(target);
}

module.exports = { open };
