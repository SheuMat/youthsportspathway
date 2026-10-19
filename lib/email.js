import { appendFileSync } from 'node:fs';
import { VENUE, SESSION_TIME, PLANS, SLOTS, PAYMENT_DAYS, formatPence } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (v) => Object.values(PAYMENT_DAYS).find((p) => p.value === v)?.label || String(v);

async function send({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || 'Youth Sports Pathway <bookings@youthsportspathway.com>';
  if (!process.env.RESEND_API_KEY) {
    const line = `[email] to=${to} subject="${subject}"\n${text}\n---\n`;
    console.log(line);
    if (process.env.EMAIL_LOG_FILE) appendFileSync(process.env.EMAIL_LOG_FILE, line);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text, reply_to: process.env.ADMIN_EMAIL || undefined }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${await res.text()}`);
}

function scheduleLines(sessions) {
  return sessions.map((s) => `${fmtDate(s.session_date)}, ${SESSION_TIME}`);
}

export async function sendConfirmationEmails(member, sessions) {
  const plan = PLANS[member.plan];
  const slotNames = plan.slots.map((c) => SLOTS[c].label).join(' and ');
  const lines = scheduleLines(sessions);
  const summary = [
    `Child: ${member.child_name}`,
    `Plan: ${plan.label} (${slotNames} sessions), ${formatPence(member.amount_pence)} a month`,
    `Direct Debit: ${dayLabel(member.payment_day)}, first payment on ${fmtDate(member.first_charge_date)}`,
    `Time: ${SESSION_TIME}`,
    `Venue: ${VENUE.name}, ${VENUE.address}`,
  ];
  const text = `Hi ${member.parent_name},\n\nThank you for signing up to Youth Sports Pathway. Your place is confirmed.\n\n${summary.join('\n')}\n\nSession dates:\n${lines.join('\n')}\n\nVenue details: ${VENUE.url}\n\nTo make changes or cancel, reply to this email.\n\nYouth Sports Pathway`;
  const html = `<p>Hi ${esc(member.parent_name)},</p><p>Thank you for signing up to Youth Sports Pathway. Your place is confirmed.</p>
<ul>${summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p><strong>Session dates</strong></p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p><a href="${esc(VENUE.url)}">Venue details</a></p><p>To make changes or cancel, reply to this email.</p><p>Youth Sports Pathway</p>`;
  await send({ to: member.email, subject: `Your YSP booking is confirmed: ${plan.label}`, html, text });

  if (process.env.ADMIN_EMAIL) {
    const details = [
      `Ref: ${member.ref}`, ...summary,
      `Child DOB: ${new Date(member.child_dob).toISOString().slice(0, 10)}`,
      `Parent: ${member.parent_name}`, `Email: ${member.email}`, `Phone: ${member.phone}`,
      `Emergency contact: ${member.emergency_name} (${member.emergency_phone})`,
      `Medical / allergies: ${member.medical || 'None given'}`,
      `Photo consent: ${member.photo_consent ? 'Yes' : 'No'}`,
      `GoCardless mandate: ${member.gc_mandate}`, `GoCardless subscription: ${member.gc_subscription}`,
    ];
    await send({
      to: process.env.ADMIN_EMAIL,
      subject: `New YSP sign-up: ${member.child_name} (${plan.label})`,
      text: details.join('\n'),
      html: `<ul>${details.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
    });
  }
}

export async function sendOverbookedEmails(member) {
  const plan = PLANS[member.plan];
  const text = `Hi ${member.parent_name},\n\nSorry, the ${plan.label} sessions filled up while you were setting up your Direct Debit, so we could not confirm a place for ${member.child_name}. We have cancelled the Direct Debit and no payment will be taken.\n\nPlease reply to this email and we will let you know as soon as a place becomes available.\n\nYouth Sports Pathway`;
  await send({ to: member.email, subject: 'Your YSP booking could not be confirmed', text, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>` });
  if (process.env.ADMIN_EMAIL) {
    const t = `Sign-up ${member.ref} for ${member.child_name} (${plan.label}) arrived after the session filled. Mandate ${member.gc_mandate} cancelled; no subscription created. Parent: ${member.parent_name}, ${member.email}, ${member.phone}.`;
    await send({ to: process.env.ADMIN_EMAIL, subject: `YSP sign-up not confirmed (full): ${member.child_name}`, text: t, html: `<p>${esc(t)}</p>` });
  }
}
