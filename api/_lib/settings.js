'use strict';
// Admin-managed settings (programmes, prices, capacities, closures, billing rules), stored as one JSON
// document in the `settings` table and overlaid on the defaults in js/site-data.js.
const YSP = require('../../js/site-data.js');

const KEY = 'site';
const CACHE_MS = 30 * 1000;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Returns { errors: string[], value } where value is the cleaned settings document. */
function validateSettings(input) {
  const errors = [];
  const d = YSP.defaults;
  const src = input && typeof input === 'object' ? input : {};

  const programmes = d.programmes.map((def) => {
    const p = (src.programmes || []).find((x) => x && x.id === def.id) || def;
    const label = def.name;
    const out = {
      id: def.id,
      name: text(p.name, 80) || def.name,
      ages: text(p.ages, 20) || def.ages,
      minAge: Number(p.minAge),
      maxAge: Number(p.maxAge),
      description: text(p.description, 1000),
      note: text(p.note, 300),
      tasterAvailable: p.tasterAvailable === true,
      paidRegistrationOpen: p.paidRegistrationOpen === true
    };
    if (!isInt(out.minAge, 3, 18) || !isInt(out.maxAge, 3, 18) || out.minAge > out.maxAge) errors.push(`${label}: ages must be whole numbers from 3 to 18, minimum no higher than maximum.`);
    if (!out.description) errors.push(`${label}: description is required.`);
    const sessions = Array.isArray(p.sessions) ? p.sessions : [];
    if (sessions.length !== def.sessions.length) errors.push(`${label}: must have exactly ${def.sessions.length} weekly sessions.`);
    out.sessions = def.sessions.map((ds, i) => {
      const s = sessions[i] || ds;
      const cap = s.capacity === null || s.capacity === '' || s.capacity === undefined ? null : Number(s.capacity);
      const v = { day: s.day, start: s.start, end: s.end, capacity: cap };
      if (!WEEKDAYS.includes(v.day)) errors.push(`${label}: session ${i + 1} has an invalid day.`);
      if (!TIME_RE.test(v.start || '') || !TIME_RE.test(v.end || '') || v.end <= v.start) errors.push(`${label}: session ${i + 1} needs a start and end time (24-hour HH:MM), ending after it starts.`);
      if (cap !== null && !isInt(cap, 1, 200)) errors.push(`${label}: session ${i + 1} capacity must be 1–200, or blank for no limit.`);
      return v;
    });
    if (new Set(out.sessions.map((s) => s.day)).size !== out.sessions.length) errors.push(`${label}: each session must be on a different day.`);
    return out;
  });

  const memberships = d.memberships.map((def) => {
    const m = (src.memberships || []).find((x) => x && x.id === def.id) || def;
    const amountPence = Number(m.amountPence);
    if (!isInt(amountPence, 100, 50000)) errors.push(`${def.name}: monthly price must be between £1 and £500.`);
    return { id: def.id, name: text(m.name, 80) || def.name, amountPence };
  });

  const ids = d.programmes.map((p) => p.id);
  const closuresIn = Array.isArray(src.closures) ? src.closures : [];
  if (closuresIn.length > 300) errors.push('Too many closures (maximum 300).');
  const closures = closuresIn.slice(0, 300).map((c, i) => {
    const from = text(c && c.from, 10);
    const to = text(c && c.to, 10) || from;
    const v = { from, to };
    const programmeId = text(c && c.programmeId, 30);
    const day = text(c && c.day, 12);
    const reason = text(c && c.reason, 100);
    if (programmeId) v.programmeId = programmeId;
    if (day) v.day = day;
    if (reason) v.reason = reason;
    if (!validDate(from) || !validDate(to) || to < from) errors.push(`Closure ${i + 1}: needs valid from/to dates, with "to" on or after "from".`);
    if (programmeId && !ids.includes(programmeId)) errors.push(`Closure ${i + 1}: unknown programme.`);
    if (day && !WEEKDAYS.includes(day)) errors.push(`Closure ${i + 1}: invalid day.`);
    return v;
  }).sort((a, b) => a.from.localeCompare(b.from));

  const r = src.billingRules || d.billingRules;
  const billingRules = {
    collectionDay: 1,
    estimateLeadWorkingDays: Number(r.estimateLeadWorkingDays),
    minimumCardChargePence: Number(r.minimumCardChargePence),
    startWindowDays: Number(r.startWindowDays)
  };
  if (!isInt(billingRules.estimateLeadWorkingDays, 3, 15)) errors.push('Direct Debit lead time must be 3–15 working days.');
  if (!isInt(billingRules.minimumCardChargePence, 30, 1000)) errors.push('Minimum card charge must be 30p–£10.');
  if (!isInt(billingRules.startWindowDays, 7, 60)) errors.push('Start date window must be 7–60 days.');

  return { errors, value: { programmes, memberships, closures, billingRules } };
}

function create(db, { now = () => Date.now() } = {}) {
  let loadedAt = 0;
  let current = null;

  async function load(force = false) {
    if (!db) return null;
    if (!force && current !== null && now() - loadedAt < CACHE_MS) return current;
    try {
      const row = await db.get('SELECT value FROM settings WHERE key = ?', KEY);
      current = row ? JSON.parse(row.value) : {};
      YSP.applySettings(current);
      loadedAt = now();
    } catch (err) {
      // Keep the last good settings (or the defaults) if the database is unavailable.
      if (current === null) YSP.applySettings({});
      throw err;
    }
    return current;
  }

  async function save(input, actor) {
    const { errors, value } = validateSettings(input);
    if (errors.length) return { errors };
    const json = JSON.stringify(value);
    await db.run(`INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`, KEY, json, actor || null);
    current = value;
    loadedAt = now();
    YSP.applySettings(value);
    return { value };
  }

  /** Browser script that applies the saved settings on top of js/site-data.js. */
  function publicScript() {
    const json = JSON.stringify(current || {}).replace(/</g, '\\u003c');
    return `/* YSP settings */\nif (window.YSP && window.YSP.applySettings) window.YSP.applySettings(${json});\n`;
  }

  return { load, save, publicScript, current: () => current };
}

module.exports = { create, validateSettings };
