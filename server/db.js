'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  first_name TEXT, last_name TEXT, email TEXT NOT NULL, phone TEXT,
  message TEXT, marketing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  programme_id TEXT NOT NULL, day TEXT NOT NULL, preferred_date TEXT NOT NULL,
  parent_name TEXT NOT NULL, parent_email TEXT NOT NULL, parent_phone TEXT NOT NULL,
  child_name TEXT NOT NULL, child_age INTEGER NOT NULL, notes TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested',   -- requested | confirmed | declined | attended | no_show
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  public_token TEXT UNIQUE NOT NULL,
  membership_id TEXT NOT NULL, programme_id TEXT NOT NULL, days TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  parent_name TEXT NOT NULL, parent_email TEXT NOT NULL, parent_phone TEXT NOT NULL,
  child_name TEXT NOT NULL, child_age INTEGER NOT NULL, notes TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  existing_direct_debit INTEGER NOT NULL DEFAULT 0,
  -- registration: submitted | awaiting_operational_approval | existing_customer_review |
  --               awaiting_direct_debit | active | cancelled | rejected
  registration_status TEXT NOT NULL,
  -- mandate: none | pending_customer | pending_submission | submitted | active | failed | cancelled | expired
  mandate_status TEXT NOT NULL DEFAULT 'none',
  -- subscription: none | active | cancelled | finished | paused
  subscription_status TEXT NOT NULL DEFAULT 'none',
  -- payment: latest payment's status: none | pending_submission | submitted | confirmed | paid_out | failed | cancelled | charged_back
  payment_status TEXT NOT NULL DEFAULT 'none',
  gc_billing_request_id TEXT UNIQUE, gc_customer_id TEXT, gc_mandate_id TEXT UNIQUE, gc_subscription_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  gc_payment_id TEXT PRIMARY KEY,
  registration_id INTEGER REFERENCES registrations(id),
  amount_pence INTEGER, charge_date TEXT, status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_events (
  gc_event_id TEXT PRIMARY KEY,
  resource_type TEXT, action TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL, entity_id INTEGER, event TEXT NOT NULL, detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  db.audit = (entity, id, event, detail) =>
    db.prepare('INSERT INTO audit_log (entity, entity_id, event, detail) VALUES (?, ?, ?, ?)').run(entity, id ?? null, event, detail ? String(detail).slice(0, 2000) : null);
  return db;
}

module.exports = { open };
