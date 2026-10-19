import { randomBytes } from 'node:crypto';
import { db, slotAvailability } from '../lib/db.js';
import { PLANS, PAYMENT_DAYS, HOLD_MINUTES } from '../lib/config.js';
import { createBillingRequestFlow } from '../lib/gocardless.js';
import { json, siteUrl } from '../lib/http.js';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validate(body) {
  const errors = {};
  const d = {
    plan: str(body.plan, 10),
    paymentDay: str(body.paymentDay, 10),
    parentName: str(body.parentName, 120),
    email: str(body.email, 200).toLowerCase(),
    phone: str(body.phone, 30),
    childName: str(body.childName, 120),
    childDob: str(body.childDob, 10),
    emergencyName: str(body.emergencyName, 120),
    emergencyPhone: str(body.emergencyPhone, 30),
    medical: str(body.medical, 2000),
    terms: body.terms === true,
    photoConsent: body.photoConsent === true,
  };
  const phoneOk = (p) => /^[+()\d\s-]{10,20}$/.test(p) && p.replace(/\D/g, '').length >= 10;
  if (!PLANS[d.plan]) errors.plan = 'Choose a plan.';
  if (!PAYMENT_DAYS[d.paymentDay]) errors.paymentDay = 'Choose when you would like to pay each month.';
  if (d.parentName.length < 2) errors.parentName = 'Enter the parent or guardian’s full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) errors.email = 'Enter a valid email address.';
  if (!phoneOk(d.phone)) errors.phone = 'Enter a valid phone number.';
  if (d.childName.length < 2) errors.childName = 'Enter the child’s full name.';
  const dob = new Date(`${d.childDob}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.childDob) || isNaN(dob) || dob >= new Date() || dob.getUTCFullYear() < 1990) {
    errors.childDob = 'Enter the child’s date of birth.';
  }
  if (d.emergencyName.length < 2) errors.emergencyName = 'Enter an emergency contact name.';
  if (!phoneOk(d.emergencyPhone)) errors.emergencyPhone = 'Enter a valid emergency contact number.';
  if (!d.terms) errors.terms = 'You must agree to the terms to continue.';
  return { d, errors };
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const { d, errors } = validate(body || {});
  if (Object.keys(errors).length) return json({ errors }, 422);

  const sql = db();
  const plan = PLANS[d.plan];
  const ref = randomBytes(18).toString('base64url');

  // Hold the place(s) while the parent sets up the Direct Debit.
  const member = await sql.begin(async (tx) => {
    await tx`SELECT code FROM slots ORDER BY code FOR UPDATE`;
    const avail = await slotAvailability(tx);
    const fullSlot = plan.slots.find((s) => avail[s].remaining <= 0);
    if (fullSlot) return null;
    const [m] = await tx`INSERT INTO members (ref, plan, amount_pence, payment_day, parent_name, email, phone, child_name,
        child_dob, emergency_name, emergency_phone, medical, terms_agreed, photo_consent, hold_expires)
      VALUES (${ref}, ${d.plan}, ${plan.pricePence}, ${PAYMENT_DAYS[d.paymentDay].value}, ${d.parentName}, ${d.email},
        ${d.phone}, ${d.childName}, ${d.childDob}, ${d.emergencyName}, ${d.emergencyPhone}, ${d.medical}, ${d.terms},
        ${d.photoConsent}, now() + ${`${HOLD_MINUTES} minutes`}::interval)
      RETURNING *`;
    for (const s of plan.slots) await tx`INSERT INTO member_slots (member_id, slot_code) VALUES (${m.id}, ${s})`;
    return m;
  });
  if (!member) return json({ errors: { plan: 'Sorry, this plan is now full. Please choose another.' } }, 409);

  try {
    const flow = await createBillingRequestFlow({ member, siteUrl: siteUrl(request) });
    await sql`UPDATE members SET gc_billing_request = ${flow.billingRequestId} WHERE id = ${member.id}`;
    return json({ redirectUrl: flow.url, ref });
  } catch (err) {
    console.error(err);
    await sql`UPDATE members SET status = 'error', notes = ${String(err.message).slice(0, 500)} WHERE id = ${member.id}`;
    return json({ error: 'We could not start the Direct Debit set-up. Please try again or contact us.' }, 502);
  }
}
