import { readFileSync } from 'node:fs';
import { db } from '../lib/db.js';
import { SLOTS, SESSION_DATES } from '../lib/config.js';

const WEEKDAY = { mon: 1, fri: 5 };
const sql = db();

await sql.unsafe(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));

for (const [code, slot] of Object.entries(SLOTS)) {
  await sql`INSERT INTO slots (code, label, capacity) VALUES (${code}, ${slot.label}, ${slot.capacity})
            ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, capacity = EXCLUDED.capacity`;
  for (const d of SESSION_DATES[code]) {
    const day = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (day !== WEEKDAY[code]) throw new Error(`${d} is not a ${slot.label}`);
    await sql`INSERT INTO sessions (slot_code, session_date) VALUES (${code}, ${d}) ON CONFLICT DO NOTHING`;
  }
}

const counts = await sql`SELECT slot_code, COUNT(*)::int AS n, MIN(session_date) AS first, MAX(session_date) AS last
                         FROM sessions GROUP BY slot_code ORDER BY slot_code`;
for (const c of counts) console.log(`${c.slot_code}: ${c.n} sessions, ${c.first.toISOString().slice(0, 10)} to ${c.last.toISOString().slice(0, 10)}`);
await sql.end();
