import { timingSafeEqual, createHash } from 'node:crypto';
import { db, slotAvailability } from '../lib/db.js';
import { PLANS, PAYMENT_DAYS } from '../lib/config.js';
import { json } from '../lib/http.js';

function authorised(request) {
  const expected = process.env.ADMIN_PASSWORD;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!expected || !given) return false;
  const h = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

const iso = (d) => (d ? d.toISOString().slice(0, 10) : '');
const payDay = (v) => Object.values(PAYMENT_DAYS).find((p) => p.value === v)?.label || '';

// Prefix values that spreadsheet apps would treat as formulas.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request) {
  if (!authorised(request)) return json({ error: 'Unauthorised' }, 401);
  const sql = db();
  const params = new URL(request.url).searchParams;

  const sessionId = params.get('register');
  if (sessionId) {
    const [session] = await sql`SELECT id, slot_code, session_date FROM sessions WHERE id = ${Number(sessionId) || 0}`;
    if (!session) return json({ error: 'Session not found' }, 404);
    const rows = await sql`SELECT m.* FROM members m JOIN member_slots ms ON ms.member_id = m.id
      WHERE ms.slot_code = ${session.slot_code} AND m.status = 'active'
        AND m.confirmed_at::date <= ${session.session_date}
      ORDER BY m.child_name`;
    const header = ['Attended', 'Child name', 'Child DOB', 'Parent / guardian', 'Phone', 'Email', 'Emergency contact', 'Emergency phone', 'Medical / allergies', 'Photo consent', 'Plan', 'Payment status'];
    const lines = [header, ...rows.map((m) => ['', m.child_name, iso(m.child_dob), m.parent_name, m.phone, m.email, m.emergency_name,
      m.emergency_phone, m.medical, m.photo_consent ? 'Yes' : 'No', PLANS[m.plan].label, m.last_payment_status || ''])];
    const date = iso(session.session_date);
    return new Response('﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ysp-register-${session.slot_code}-${date}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const [avail, members, sessions] = await Promise.all([
    slotAvailability(sql),
    sql`SELECT m.*, array_agg(ms.slot_code ORDER BY ms.slot_code) AS slots FROM members m
        JOIN member_slots ms ON ms.member_id = m.id
        WHERE m.status <> 'error' AND NOT (m.status = 'pending' AND m.hold_expires < now() - interval '7 days')
        GROUP BY m.id ORDER BY m.created_at DESC`,
    sql`SELECT id, slot_code, to_char(session_date, 'YYYY-MM-DD') AS date FROM sessions ORDER BY session_date`,
  ]);
  return json({
    slots: avail,
    sessions,
    members: members.map((m) => ({
      ref: m.ref, status: m.status, plan: PLANS[m.plan].label, slots: m.slots,
      parentName: m.parent_name, childName: m.child_name, phone: m.phone, email: m.email,
      paymentDay: payDay(m.payment_day), firstChargeDate: iso(m.first_charge_date),
      paymentStatus: m.last_payment_status || '', holdExpired: m.status === 'pending' && m.hold_expires < new Date(),
      createdAt: m.created_at.toISOString(), notes: m.notes,
    })),
  });
}
