'use strict';
// Membership registration, GoCardless mandate/subscription lifecycle and webhooks.
const crypto = require('node:crypto');

const PAYMENT_FAILED = new Set(['failed', 'cancelled', 'charged_back', 'customer_approval_denied']);

function newReference(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function create({ db, config, gc, notify, log = console }) {
  const COLS = ['id', 'public_token', 'gc_billing_request_id', 'gc_mandate_id', 'gc_subscription_id'];
  const byId = (id) => db.get('SELECT * FROM registrations WHERE id = ?', id);
  const by = (col, val) => {
    if (!COLS.includes(col)) throw new Error('bad column');
    return val ? db.get(`SELECT * FROM registrations WHERE ${col} = ?`, val) : Promise.resolve(undefined);
  };

  async function update(id, fields, why) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    await db.run(`UPDATE registrations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ...keys.map((k) => fields[k]), id);
    await db.audit('registration', id, why || 'update', JSON.stringify(fields));
  }

  function findDuplicate(v) {
    return db.get(`SELECT reference FROM registrations
      WHERE lower(parent_email) = lower(?) AND lower(child_name) = lower(?) AND programme_id = ?
      AND registration_status IN ('submitted','awaiting_operational_approval','existing_customer_review','awaiting_direct_debit','active')`,
      v.parentEmail, v.childName, v.programme.id);
  }

  /** Create a registration. Returns { status, reference, message, authorisationUrl? } */
  async function register(v) {
    const dup = await findDuplicate(v);
    if (dup) {
      const e = new Error(`We already have a registration for ${v.childName} in ${v.programme.name} (reference ${dup.reference}). Please contact us if you need to change it.`);
      e.status = 409; throw e;
    }
    const reference = newReference('YSPM');
    const token = crypto.randomBytes(18).toString('base64url');
    let status = 'awaiting_direct_debit';
    let message;
    if (!v.programme.paidRegistrationOpen) {
      status = 'awaiting_operational_approval';
      message = `Thanks — we've received your registration for ${v.programme.name}. Places are being finalised, and we'll contact you to confirm before any Direct Debit is set up.`;
    } else if (v.existingDirectDebit) {
      status = 'existing_customer_review';
      message = 'Thanks — as you already pay YSP by Direct Debit, we\'ll review your existing arrangement and contact you rather than setting up a second one.';
    } else if (!gc) {
      status = 'submitted';
      message = 'Thanks — we\'ve received your registration. Online Direct Debit set-up isn\'t available just now, so we\'ll email you a secure link to complete it.';
    }
    const r = await db.run(`INSERT INTO registrations (reference, public_token, membership_id, programme_id, days, amount_pence,
      parent_name, parent_email, parent_phone, child_name, child_age, notes, marketing_consent, existing_direct_debit, registration_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      reference, token, v.membership.id, v.programme.id, v.days.join(','), v.membership.amountPence,
      v.parentName, v.parentEmail, v.parentPhone, v.childName, v.childAge, v.notes, v.marketingConsent ? 1 : 0, v.existingDirectDebit ? 1 : 0, status);
    const id = Number(r.rows[0].id);
    await db.audit('registration', id, 'created', status);

    const summary = `${v.membership.name} (£${v.membership.amountPence / 100}/month) — ${v.days.join(' and ')}`;
    notify.toYsp(`New registration ${reference}: ${v.programme.name}`,
      `Reference: ${reference}\nStatus: ${status}\nMembership: ${summary}\nChild: ${v.childName} (${v.childAge})\nParent: ${v.parentName}, ${v.parentEmail}, ${v.parentPhone}\nNotes: ${v.notes || '-'}\nMarketing consent: ${v.marketingConsent ? 'yes' : 'no'}`);

    if (status !== 'awaiting_direct_debit') {
      notify.toParent(v.parentEmail, `YSP registration received (${reference})`,
        `Hi ${v.parentName},\n\n${message}\n\nMembership: ${summary}\nReference: ${reference}\n\nNo payment has been taken.\n\nYouth Sports Pathway`);
      return { status, reference, message };
    }

    try {
      const desc = `YSP ${v.membership.name}`;
      const br = await gc.createBillingRequest({ reference, description: desc }, `ysp-br-${reference}`);
      const [given, ...rest] = v.parentName.split(/\s+/);
      const flow = await gc.createBillingRequestFlow({
        billingRequestId: br.id,
        redirectUri: `${config.publicBaseUrl}/register-complete.html?ref=${token}`,
        exitUri: `${config.publicBaseUrl}/register.html?programme=${v.programme.id}`,
        customer: { given_name: given, family_name: rest.join(' ') || given, email: v.parentEmail }
      });
      await update(id, { gc_billing_request_id: br.id, mandate_status: 'pending_customer' }, 'billing_request_created');
      return { status, reference, authorisationUrl: flow.authorisation_url };
    } catch (err) {
      log.error(`[billing] GoCardless error for ${reference}: ${err.message}`);
      await update(id, { registration_status: 'submitted' }, 'gocardless_unavailable');
      return { status: 'submitted', reference, message: 'Thanks — we\'ve saved your registration, but couldn\'t open the Direct Debit page just now. We\'ll email you a secure link to complete it.' };
    }
  }

  async function publicStatus(token) {
    if (!token) return null;
    const r = await by('public_token', token);
    if (!r) return null;
    let headline = 'Registration Received';
    let message = 'We\'ve received your registration and will be in touch.';
    if (r.registration_status === 'awaiting_direct_debit' && r.mandate_status === 'pending_customer') {
      message = 'Thanks — your Direct Debit authorisation has been sent to GoCardless and is being processed. No payment has been taken yet. We\'ll email you to confirm your start date and first collection date.';
    } else if (['pending_submission', 'submitted', 'active'].includes(r.mandate_status)) {
      headline = 'Direct Debit Set Up';
      message = 'Your Direct Debit instruction is set up. This is not a payment — we\'ll confirm your start date and first collection date by email before anything is collected.';
    } else if (['failed', 'cancelled', 'expired'].includes(r.mandate_status)) {
      headline = 'Direct Debit Not Completed';
      message = 'Your Direct Debit could not be set up. Please contact us and we\'ll help.';
    }
    if (r.registration_status === 'active' && r.subscription_status === 'active') {
      headline = 'Membership Active';
      message = 'Your membership is active. Monthly payments will be collected by Direct Debit through GoCardless.';
    }
    const YSP = require('../../js/site-data.js');
    const m = YSP.getMembership(r.membership_id);
    return {
      reference: r.reference, headline, message,
      membership: m ? m.name : r.membership_id,
      mandateStatus: r.mandate_status.replace(/_/g, ' '),
      paymentStatus: r.payment_status === 'none' ? 'no payments yet' : r.payment_status.replace(/_/g, ' ')
    };
  }

  /** Create the monthly subscription for a registration with an active mandate. Never creates a second one. */
  async function createSubscription(id) {
    const r = await byId(id);
    if (!r) throw Object.assign(new Error('Registration not found'), { status: 404 });
    if (r.gc_subscription_id) return { already: true, id: r.gc_subscription_id };
    if (!r.gc_mandate_id) throw Object.assign(new Error('No mandate for this registration yet'), { status: 409 });
    if (!['pending_submission', 'submitted', 'active'].includes(r.mandate_status)) {
      throw Object.assign(new Error(`Mandate is ${r.mandate_status}; cannot create subscription`), { status: 409 });
    }
    const YSP = require('../../js/site-data.js');
    const m = YSP.getMembership(r.membership_id);
    const params = {
      amount: r.amount_pence, currency: 'GBP', interval_unit: 'monthly',
      name: `YSP ${m ? m.name : r.membership_id}`.slice(0, 255),
      metadata: { ysp_reference: r.reference },
      links: { mandate: r.gc_mandate_id }
    };
    if (config.billing.dayOfMonth !== null) params.day_of_month = config.billing.dayOfMonth;
    const sub = await gc.createSubscription(params, `ysp-sub-${r.reference}`);
    await update(id, { gc_subscription_id: sub.id, subscription_status: sub.status === 'active' ? 'active' : sub.status, registration_status: 'active' }, 'subscription_created');
    return { id: sub.id };
  }

  async function cancelSubscription(id) {
    const r = await byId(id);
    if (!r || !r.gc_subscription_id) throw Object.assign(new Error('No subscription for this registration'), { status: 404 });
    const sub = await gc.cancelSubscription(r.gc_subscription_id);
    await update(id, { subscription_status: sub.status || 'cancelled', registration_status: 'cancelled' }, 'subscription_cancelled_by_admin');
    return { status: sub.status };
  }

  async function onMandateStatus(r, status, event) {
    const map = { pending_customer_approval: 'pending_customer', pending_submission: 'pending_submission', created: 'pending_submission', customer_approval_granted: 'pending_submission', submitted: 'submitted', active: 'active', reinstated: 'active',
      failed: 'failed', cancelled: 'cancelled', expired: 'expired', consumed: 'cancelled', blocked: 'failed' };
    const s = map[status];
    if (!s) return;
    const fields = { mandate_status: s };
    if (['failed', 'cancelled', 'expired'].includes(s) && r.registration_status === 'awaiting_direct_debit') fields.registration_status = 'submitted';
    await update(r.id, fields, `mandate_${status}`);
    if (['failed', 'cancelled', 'expired'].includes(s)) {
      notify.toYsp(`Direct Debit ${s}: ${r.reference}`, `Mandate for ${r.child_name} (${r.membership_id}) is ${s}. Parent: ${r.parent_name} ${r.parent_email}. Cause: ${(event.details && event.details.cause) || '-'}`);
    }
    if (s === 'active' && config.billing.autoCreateSubscriptions && !r.gc_subscription_id) {
      await createSubscription(r.id);
    }
  }

  async function handleEvent(ev) {
    const links = ev.links || {};
    switch (ev.resource_type) {
      case 'billing_requests': {
        if (ev.action !== 'fulfilled') return;
        const r = await by('gc_billing_request_id', links.billing_request);
        if (!r) return;
        let mandateId = links.mandate_request_mandate;
        let customerId = links.customer;
        if (!mandateId) {
          const br = await gc.getBillingRequest(links.billing_request);
          mandateId = br.links && br.links.mandate_request_mandate;
          customerId = br.links && br.links.customer;
        }
        if (!mandateId) return;
        const fields = { gc_mandate_id: mandateId, gc_customer_id: customerId || r.gc_customer_id };
        if (r.mandate_status === 'pending_customer') fields.mandate_status = 'pending_submission';
        await update(r.id, fields, 'billing_request_fulfilled');
        notify.toParent(r.parent_email, `Direct Debit received (${r.reference})`,
          `Hi ${r.parent_name},\n\nThanks — your Direct Debit instruction for ${r.child_name}'s YSP membership has been received. No payment has been taken yet. We'll confirm your start date and first collection date before anything is collected.\n\nReference: ${r.reference}\n\nYouth Sports Pathway`);
        const mandate = await gc.getMandate(mandateId).catch(() => null);
        if (mandate) await onMandateStatus(await byId(r.id), mandate.status, ev);
        return;
      }
      case 'mandates': {
        const r = await by('gc_mandate_id', links.mandate);
        if (!r) return;
        if (ev.action === 'replaced' && links.new_mandate) { await update(r.id, { gc_mandate_id: links.new_mandate }, 'mandate_replaced'); return; }
        await onMandateStatus(r, ev.action, ev);
        return;
      }
      case 'subscriptions': {
        const r = await by('gc_subscription_id', links.subscription);
        if (!r) return;
        const map = { created: 'active', cancelled: 'cancelled', finished: 'finished', paused: 'paused', resumed: 'active' };
        if (!map[ev.action]) return;
        const fields = { subscription_status: map[ev.action] };
        if (ev.action === 'cancelled') fields.registration_status = 'cancelled';
        await update(r.id, fields, `subscription_${ev.action}`);
        if (ev.action === 'cancelled') notify.toYsp(`Subscription cancelled: ${r.reference}`, `Subscription for ${r.child_name} (${r.membership_id}) was cancelled. Cause: ${(ev.details && ev.details.cause) || '-'}`);
        return;
      }
      case 'payments': {
        const p = await gc.getPayment(links.payment);
        const pl = p.links || {};
        const r = (await by('gc_subscription_id', pl.subscription)) || (await by('gc_mandate_id', pl.mandate));
        await db.run(`INSERT INTO payments (gc_payment_id, registration_id, amount_pence, charge_date, status) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(gc_payment_id) DO UPDATE SET status = excluded.status, charge_date = excluded.charge_date, updated_at = CURRENT_TIMESTAMP`,
          p.id, r ? r.id : null, p.amount ?? null, p.charge_date ?? null, p.status);
        if (!r) return;
        await update(r.id, { payment_status: p.status }, `payment_${ev.action}`);
        if (PAYMENT_FAILED.has(p.status)) {
          notify.toYsp(`Payment ${p.status}: ${r.reference}`, `Payment ${p.id} (£${(p.amount || 0) / 100}, ${p.charge_date}) for ${r.child_name} is ${p.status}. Parent: ${r.parent_name} ${r.parent_email} ${r.parent_phone}. Cause: ${(ev.details && ev.details.cause) || '-'}`);
        }
        return;
      }
      default:
    }
  }

  /** Process a verified webhook body. Each event is processed at most once. */
  async function handleWebhook(payload) {
    const events = Array.isArray(payload && payload.events) ? payload.events : [];
    let processed = 0, duplicates = 0;
    for (const ev of events) {
      if (!ev || typeof ev.id !== 'string') continue;
      const ins = await db.run('INSERT INTO webhook_events (gc_event_id, resource_type, action) VALUES (?, ?, ?) ON CONFLICT (gc_event_id) DO NOTHING', ev.id, ev.resource_type || null, ev.action || null);
      if (ins.changes === 0) { duplicates++; continue; }
      try {
        await handleEvent(ev);
        processed++;
      } catch (err) {
        // Allow GoCardless to retry this event later.
        await db.run('DELETE FROM webhook_events WHERE gc_event_id = ?', ev.id);
        throw err;
      }
    }
    return { processed, duplicates };
  }

  return { register, publicStatus, createSubscription, cancelSubscription, handleWebhook, newReference };
}

module.exports = { create, newReference };
