'use strict';
// Membership registration and payments.
//
// Journey (see SETUP.md "Membership billing rules"):
//   1. register()          -> estimated quote stored; parent sent to GoCardless to authorise a Direct Debit
//   2. mandate exists      -> finalise(): re-quote with GoCardless's real next_possible_charge_date
//   3. upfront > £0        -> startCheckout(): Stripe-hosted card payment for the months before the first Direct Debit
//   4. card payment paid   -> (Stripe webhook, or a server-side check of the session) activate()
//      upfront = £0        -> activate() straight away
//   5. activate()          -> GoCardless subscription on the 1st, starting at the first collection date; confirmation email
// A registration is only 'active' once the mandate exists AND the upfront payment is paid or not required.
const crypto = require('node:crypto');
const emails = require('./emails');
const calc = require('./membership-billing');
const YSP = require('../../js/site-data.js');

const PAYMENT_FAILED = new Set(['failed', 'cancelled', 'charged_back', 'customer_approval_denied']);
const MANDATE_USABLE = ['pending_submission', 'submitted', 'active'];
const HOLDS_PLACE = ['awaiting_direct_debit', 'awaiting_upfront_payment', 'active'];

function newReference(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function create({ db, config, gc, stripe = null, notify, log = console, now = () => new Date() }) {
  const COLS = ['id', 'public_token', 'gc_billing_request_id', 'gc_mandate_id', 'gc_subscription_id', 'stripe_checkout_session_id', 'reference'];
  const byId = (id) => db.get('SELECT * FROM registrations WHERE id = ?', id);
  const by = (col, val) => {
    if (!COLS.includes(col)) throw new Error('bad column');
    return val ? db.get(`SELECT * FROM registrations WHERE ${col} = ?`, val) : Promise.resolve(undefined);
  };
  const today = () => now().toISOString().slice(0, 10);
  const rules = () => ({ ...calc.DEFAULT_RULES, ...YSP.billingRules });
  const daysOf = (r) => String(r.days || '').split(',').filter(Boolean);
  const cardPaymentsReady = () => Boolean(stripe && config.stripe && config.stripe.webhookConfigured);

  async function update(id, fields, why) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    await db.run(`UPDATE registrations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ...keys.map((k) => fields[k]), id);
    await db.audit('registration', id, why || 'update', JSON.stringify(fields));
  }

  function quoteFor({ membershipId, days, startDate, monthlyPricePence, earliestChargeDate }) {
    return calc.quote({ membershipId, days, startDate, today: today(), earliestChargeDate, closures: YSP.closures, monthlyPricePence }, rules());
  }
  function quoteFields(q) {
    return {
      first_collection_date: q.firstCollectionDate,
      first_collection_estimated: q.firstCollectionEstimated ? 1 : 0,
      earliest_charge_date: q.earliestChargeDate,
      upfront_pence: q.totalPence,
      upfront_detail: JSON.stringify({ lines: q.lines, calculatedPence: q.calculatedPence, waived: q.waived }),
      covered_from: q.coveredFrom,
      covered_to: q.coveredTo
    };
  }

  function findDuplicate(v) {
    return db.get(`SELECT reference FROM registrations
      WHERE lower(parent_email) = lower(?) AND lower(child_name) = lower(?) AND programme_id = ?
      AND registration_status IN ('submitted','awaiting_operational_approval','existing_customer_review','awaiting_direct_debit','awaiting_upfront_payment','active')`,
      v.parentEmail, v.childName, v.programme.id);
  }

  /** Days (of those requested) whose session is already at capacity. */
  async function fullDays(programme, days) {
    const full = [];
    for (const day of days) {
      const s = programme.sessions.find((x) => x.day === day);
      if (!s || s.capacity == null) continue;
      const row = await db.get(`SELECT COUNT(*) AS n FROM registrations WHERE programme_id = ? AND (',' || days || ',') LIKE ?
        AND registration_status IN ('awaiting_direct_debit','awaiting_upfront_payment','active')`, programme.id, `%,${day},%`);
      if (Number(row.n) >= s.capacity) full.push(day);
    }
    return full;
  }

  /** Public quote for the summary step (nothing stored). */
  function previewQuote({ membershipId, days, startDate }) {
    const m = YSP.getMembership(membershipId);
    if (!m) throw Object.assign(new Error('Please choose a membership option.'), { status: 422 });
    const memberDays = m.sessionsPerWeek === 2 ? YSP.programmeDays(m.programmeId) : days;
    const err = YSP.validateMembershipDays(m.id, memberDays);
    if (err) throw Object.assign(new Error(err), { status: 422 });
    const options = calc.startDateOptions({ membershipId: m.id, days: memberDays, today: today(), closures: YSP.closures }, rules());
    if (!options.includes(startDate)) throw Object.assign(new Error('Please choose a start date from the list.'), { status: 422 });
    return summarise(quoteFor({ membershipId: m.id, days: memberDays, startDate, monthlyPricePence: m.amountPence }), m);
  }

  function startDates({ membershipId, days }) {
    const m = YSP.getMembership(membershipId);
    if (!m) throw Object.assign(new Error('Please choose a membership option.'), { status: 422 });
    const memberDays = m.sessionsPerWeek === 2 ? YSP.programmeDays(m.programmeId) : days;
    const err = YSP.validateMembershipDays(m.id, memberDays);
    if (err) throw Object.assign(new Error(err), { status: 422 });
    return calc.startDateOptions({ membershipId: m.id, days: memberDays, today: today(), closures: YSP.closures }, rules());
  }

  function summarise(q, m) {
    return {
      membership: m.name,
      days: q.days,
      monthlyPence: q.ongoingMonthlyPence,
      startDate: q.startDate,
      firstCollectionDate: q.firstCollectionDate,
      firstCollectionEstimated: q.firstCollectionEstimated,
      upfrontPence: q.totalPence,
      upfrontWaived: q.waived,
      sessionsCovered: q.lines.reduce((n, l) => n + l.sessionsCovered, 0),
      lines: q.lines.map((l) => ({ month: l.month, fullMonth: l.fullMonth, sessionsCovered: l.sessionsCovered, sessionsInMonth: l.sessionsInMonth, amountPence: l.amountPence }))
    };
  }

  /** Create a registration. Returns { status, reference, message?, authorisationUrl? } */
  async function register(v) {
    const dup = await findDuplicate(v);
    if (dup) {
      const e = new Error(`We already have a registration for ${v.childName} in ${v.programme.name} (reference ${dup.reference}). Please contact us if you need to change it.`);
      e.status = 409; throw e;
    }
    const full = await fullDays(v.programme, v.days);
    if (full.length) {
      const e = new Error(`Sorry, the ${full.join(' and ')} ${v.programme.name} session is full. Please choose another day or contact us to join the waiting list.`);
      e.status = 409; throw e;
    }
    const reference = newReference('YSPM');
    const token = crypto.randomBytes(18).toString('base64url');
    const q = quoteFor({ membershipId: v.membership.id, days: v.days, startDate: v.startDate, monthlyPricePence: v.membership.amountPence });
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
    const qf = quoteFields(q);
    const r = await db.run(`INSERT INTO registrations (reference, public_token, membership_id, programme_id, days, amount_pence,
      parent_name, parent_email, parent_phone, child_name, child_age, notes, marketing_consent, existing_direct_debit, registration_status,
      emergency_name, emergency_phone, medical_info, consent_participation, consent_medical, consent_photo,
      child_dob, start_date, first_collection_date, first_collection_estimated, earliest_charge_date, upfront_pence, upfront_detail, covered_from, covered_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      reference, token, v.membership.id, v.programme.id, v.days.join(','), v.membership.amountPence,
      v.parentName, v.parentEmail, v.parentPhone, v.childName, v.childAge, v.notes, v.marketingConsent ? 1 : 0, v.existingDirectDebit ? 1 : 0, status,
      v.emergencyName, v.emergencyPhone, v.medicalInfo, 1, 1, v.photoConsent,
      v.childDob, v.startDate, qf.first_collection_date, qf.first_collection_estimated, qf.earliest_charge_date, qf.upfront_pence, qf.upfront_detail, qf.covered_from, qf.covered_to);
    const id = Number(r.rows[0].id);
    await db.audit('registration', id, 'created', status);

    const toYsp = emails.registrationToYsp(v, reference, status);
    await notify.toYsp(toYsp.subject, toYsp.text, v.parentEmail);

    if (status !== 'awaiting_direct_debit') {
      const ack = emails.registrationToParent(v, reference, message);
      await notify.toParent(v.parentEmail, ack.subject, ack.text);
      return { status, reference, message };
    }

    try {
      const desc = `YSP ${v.membership.name}`;
      const br = await gc.createBillingRequest({ reference, description: desc }, `ysp-br-${reference}`);
      const [given, ...rest] = v.parentName.split(/\s+/);
      const flow = await gc.createBillingRequestFlow({
        billingRequestId: br.id,
        redirectUri: `${config.publicBaseUrl}/register-complete.html?ref=${token}`,
        exitUri: `${config.publicBaseUrl}/register-complete.html?ref=${token}&exit=1`,
        customer: { given_name: given, family_name: rest.join(' ') || given, email: v.parentEmail }
      });
      await update(id, { gc_billing_request_id: br.id, mandate_status: 'pending_customer' }, 'billing_request_created');
      return { status, reference, authorisationUrl: flow.authorisation_url, resumeUrl: `${config.publicBaseUrl}/register-complete.html?ref=${token}` };
    } catch (err) {
      log.error(`[billing] GoCardless error for ${reference}: ${err.message}`);
      await update(id, { registration_status: 'submitted' }, 'gocardless_unavailable');
      return { status: 'submitted', reference, message: 'Thanks — we\'ve saved your registration, but couldn\'t open the Direct Debit page just now. We\'ll email you a secure link to complete it.' };
    }
  }

  // ── After the Direct Debit is authorised ──

  /** Re-quote using the mandate's real earliest charge date, then ask for the card payment or activate. */
  async function finalise(id) {
    let r = await byId(id);
    if (!r || !r.gc_mandate_id || r.gc_subscription_id) return;
    if (!['awaiting_direct_debit', 'awaiting_upfront_payment'].includes(r.registration_status)) return;
    if (!MANDATE_USABLE.includes(r.mandate_status)) return;
    if (!r.start_date) return; // registrations made before start dates existed are handled by YSP manually
    const mandate = await gc.getMandate(r.gc_mandate_id);
    if (r.upfront_status === 'paid') return activate(r.id);
    const q = quoteFor({ membershipId: r.membership_id, days: daysOf(r), startDate: r.start_date, monthlyPricePence: r.amount_pence, earliestChargeDate: mandate.next_possible_charge_date || undefined });
    const fields = quoteFields(q);
    if (q.totalPence === 0) {
      await update(r.id, { ...fields, upfront_status: 'not_required' }, 'quote_final_no_upfront');
      return activate(r.id);
    }
    const firstRequest = r.registration_status !== 'awaiting_upfront_payment';
    await update(r.id, { ...fields, registration_status: 'awaiting_upfront_payment', upfront_status: ['failed', 'expired'].includes(r.upfront_status) ? r.upfront_status : 'pending' }, 'quote_final_upfront_due');
    r = await byId(r.id);
    if (firstRequest) {
      const m = YSP.getMembership(r.membership_id);
      const mail = emails.upfrontPaymentRequest(r, m, `${config.publicBaseUrl}/register-complete.html?ref=${r.public_token}`, cardPaymentsReady());
      await notify.toParent(r.parent_email, mail.subject, mail.text);
      if (!cardPaymentsReady()) await notify.toYsp(`Card payment needed: ${r.reference}`, `${r.child_name}'s membership needs an upfront payment of £${(r.upfront_pence / 100).toFixed(2)}, but online card payments aren't configured. Please arrange payment with the parent (${r.parent_email}).`);
    }
  }

  /** Create the monthly subscription (once) and mark the membership active. */
  async function activate(id) {
    const r = await byId(id);
    if (!r) throw Object.assign(new Error('Registration not found'), { status: 404 });
    if (r.gc_subscription_id) return { already: true, id: r.gc_subscription_id };
    if (!r.gc_mandate_id) throw Object.assign(new Error('No mandate for this registration yet'), { status: 409 });
    if (!MANDATE_USABLE.includes(r.mandate_status)) throw Object.assign(new Error(`Mandate is ${r.mandate_status}; cannot create subscription`), { status: 409 });
    const m = YSP.getMembership(r.membership_id);
    let start = r.first_collection_date;
    const mandate = await gc.getMandate(r.gc_mandate_id);
    const earliest = mandate.next_possible_charge_date;
    if (!start || (earliest && start < earliest)) {
      // The planned date is no longer possible (for example the card payment came in very late). Use the next
      // feasible 1st and tell YSP, because one month between the card payment and the first Direct Debit is unpaid.
      const next = calc.nextCollectionDate(earliest || today(), rules());
      if (start) await notify.toYsp(`Coverage gap: ${r.reference}`, `${r.child_name}'s first Direct Debit had to move from ${start} to ${next}. The month(s) in between are not covered by the card payment: please collect them separately.`);
      start = next;
    }
    const params = {
      amount: r.amount_pence, currency: 'GBP', interval_unit: 'monthly', day_of_month: 1, start_date: start,
      name: `YSP ${m ? m.name : r.membership_id}`.slice(0, 255),
      metadata: { ysp_reference: r.reference },
      links: { mandate: r.gc_mandate_id }
    };
    const sub = await gc.createSubscription(params, `ysp-sub-${r.reference}`);
    await update(r.id, {
      gc_subscription_id: sub.id, subscription_status: sub.status === 'active' ? 'active' : sub.status,
      registration_status: 'active', first_collection_date: start, first_collection_estimated: 0, activated_at: now().toISOString()
    }, 'activated');
    const done = await byId(r.id);
    const mail = emails.membershipConfirmed(done, m);
    await notify.toParent(done.parent_email, mail.subject, mail.text);
    await notify.toYsp(`Membership active: ${done.reference}`, `${done.child_name} — ${m ? m.name : done.membership_id}, starting ${done.start_date}. Upfront: ${done.upfront_status === 'paid' ? '£' + ((done.upfront_pence || 0) / 100).toFixed(2) + ' paid by card' : 'none'}. First Direct Debit ${start}.`, done.parent_email);
    return { id: sub.id };
  }

  /** Admin fallback: create the subscription for a registration with a usable mandate. */
  async function createSubscription(id) { return activate(id); }

  async function cancelSubscription(id) {
    const r = await byId(id);
    if (!r || !r.gc_subscription_id) throw Object.assign(new Error('No subscription for this registration'), { status: 404 });
    const sub = await gc.cancelSubscription(r.gc_subscription_id);
    await update(id, { subscription_status: sub.status || 'cancelled', registration_status: 'cancelled' }, 'subscription_cancelled_by_admin');
    return { status: sub.status };
  }

  /** Parent left GoCardless before finishing: open a new hosted flow for the same billing request (never a second mandate). */
  async function resumeDirectDebit(token) {
    const r = await by('public_token', token);
    if (!r) throw Object.assign(new Error('Registration not found'), { status: 404 });
    if (r.registration_status !== 'awaiting_direct_debit' || r.gc_mandate_id || !r.gc_billing_request_id) {
      throw Object.assign(new Error('The Direct Debit for this registration is already set up or no longer needed.'), { status: 409 });
    }
    const br = await gc.getBillingRequest(r.gc_billing_request_id);
    if (br.status === 'fulfilled') { await sync(token); return { done: true }; }
    if (!['pending', 'ready_to_fulfil'].includes(br.status)) throw Object.assign(new Error('This Direct Debit request has expired. Please contact us and we\'ll send a new link.'), { status: 409 });
    const [given, ...rest] = r.parent_name.split(/\s+/);
    const flow = await gc.createBillingRequestFlow({
      billingRequestId: r.gc_billing_request_id,
      redirectUri: `${config.publicBaseUrl}/register-complete.html?ref=${r.public_token}`,
      exitUri: `${config.publicBaseUrl}/register-complete.html?ref=${r.public_token}&exit=1`,
      customer: { given_name: given, family_name: rest.join(' ') || given, email: r.parent_email }
    });
    await db.audit('registration', r.id, 'direct_debit_resumed');
    return { url: flow.authorisation_url };
  }

  // ── Card payment (Stripe Checkout) ──

  /** Returns { url } for the hosted checkout, { changed: true } if the amount had to be recalculated, or { already: true }. */
  async function startCheckout(token) {
    let r = await by('public_token', token);
    if (!r) throw Object.assign(new Error('Registration not found'), { status: 404 });
    if (r.registration_status === 'active' || ['paid', 'not_required'].includes(r.upfront_status)) return { already: true };
    if (r.registration_status !== 'awaiting_upfront_payment') throw Object.assign(new Error('This registration is not ready for payment yet.'), { status: 409 });
    if (!cardPaymentsReady()) throw Object.assign(new Error('Online card payment is not available just now. We will contact you to arrange payment.'), { status: 503 });

    // Recheck the amount: the first Direct Debit date may have moved since the quote.
    const mandate = await gc.getMandate(r.gc_mandate_id);
    const q = quoteFor({ membershipId: r.membership_id, days: daysOf(r), startDate: r.start_date, monthlyPricePence: r.amount_pence, earliestChargeDate: mandate.next_possible_charge_date || undefined });
    if (q.firstCollectionDate !== r.first_collection_date || q.totalPence !== r.upfront_pence) {
      if (r.stripe_checkout_session_id) await stripe.expireCheckoutSession(r.stripe_checkout_session_id).catch(() => null);
      await update(r.id, { ...quoteFields(q), stripe_checkout_session_id: null }, 'quote_changed_before_payment');
      if (q.totalPence === 0) { await update(r.id, { upfront_status: 'not_required' }, 'upfront_no_longer_needed'); await activate(r.id); return { already: true }; }
      return { changed: true };
    }

    if (r.stripe_checkout_session_id) {
      const existing = await stripe.getCheckoutSession(r.stripe_checkout_session_id);
      if (existing.status === 'complete' && existing.payment_status === 'paid') { await markPaid(existing); return { already: true }; }
      if (existing.status === 'open' && existing.amount_total === r.upfront_pence) return { url: existing.url };
    }

    const attempt = Number(r.checkout_attempts || 0) + 1;
    const m = YSP.getMembership(r.membership_id);
    const back = `${config.publicBaseUrl}/register-complete.html?ref=${r.public_token}`;
    const session = await stripe.createCheckoutSession({
      mode: 'payment',
      'payment_method_types': ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: r.upfront_pence,
          product_data: { name: `${m ? m.name : 'YSP membership'}: first payment`, description: `Sessions from ${r.covered_from} to ${r.covered_to}` }
        }
      }],
      customer_email: r.parent_email,
      customer_creation: 'always',
      client_reference_id: r.reference,
      metadata: { ysp_reference: r.reference },
      payment_intent_data: { metadata: { ysp_reference: r.reference }, description: `YSP ${r.reference} first payment` },
      success_url: `${back}&paid=1`,
      cancel_url: `${back}&cancelled=1`,
      expires_at: Math.floor(now().getTime() / 1000) + 31 * 60
    }, `ysp-checkout-${r.reference}-${attempt}-${r.upfront_pence}`);
    await update(r.id, { stripe_checkout_session_id: session.id, checkout_attempts: attempt, upfront_status: 'pending', upfront_error: null }, 'checkout_started');
    return { url: session.url };
  }

  /** Record a paid Checkout Session (from the webhook or a server-side check), then activate. Safe to call repeatedly. */
  async function markPaid(session) {
    const ref = session.client_reference_id || (session.metadata && session.metadata.ysp_reference);
    const r = (await by('stripe_checkout_session_id', session.id)) || (await by('reference', ref));
    if (!r) return;
    if (r.upfront_status === 'paid') return;
    if (session.payment_status !== 'paid') return;
    const mismatch = session.amount_total !== r.upfront_pence || String(session.currency).toLowerCase() !== 'gbp';
    await update(r.id, {
      upfront_status: 'paid', upfront_paid_at: now().toISOString(), upfront_error: null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null,
      stripe_customer_id: typeof session.customer === 'string' ? session.customer : (session.customer && session.customer.id) || null
    }, 'upfront_paid');
    if (mismatch) await notify.toYsp(`Check card payment: ${r.reference}`, `Stripe reported ${session.amount_total}p ${session.currency} for ${r.reference}, but the registration expected ${r.upfront_pence}p GBP. Please check before the first Direct Debit.`);
    if (MANDATE_USABLE.includes(r.mandate_status)) await activate(r.id);
  }

  async function handleStripeEvent(ev) {
    const obj = (ev.data && ev.data.object) || {};
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return markPaid(obj);
      case 'checkout.session.async_payment_failed': {
        const r = await by('stripe_checkout_session_id', obj.id);
        if (r && r.upfront_status !== 'paid') await update(r.id, { upfront_status: 'failed', upfront_error: 'Card payment failed' }, 'upfront_failed');
        return;
      }
      case 'checkout.session.expired': {
        const r = await by('stripe_checkout_session_id', obj.id);
        if (r && r.upfront_status === 'pending') await update(r.id, { upfront_status: 'expired' }, 'checkout_expired');
        return;
      }
      case 'payment_intent.payment_failed': {
        const ref = obj.metadata && obj.metadata.ysp_reference;
        const r = ref && (await by('reference', ref));
        const reason = (obj.last_payment_error && obj.last_payment_error.message) || 'Card payment declined';
        if (r && r.upfront_status !== 'paid') await update(r.id, { upfront_error: String(reason).slice(0, 300) }, 'upfront_attempt_declined');
        return;
      }
      default:
    }
  }

  /** Process a verified Stripe webhook event at most once. */
  async function handleStripeWebhook(ev) {
    if (!ev || typeof ev.id !== 'string') return { processed: 0 };
    const ins = await db.run('INSERT INTO stripe_events (stripe_event_id, type) VALUES (?, ?) ON CONFLICT (stripe_event_id) DO NOTHING', ev.id, ev.type || null);
    if (ins.changes === 0) return { duplicate: true };
    try {
      await handleStripeEvent(ev);
    } catch (err) {
      await db.run('DELETE FROM stripe_events WHERE stripe_event_id = ?', ev.id);
      throw err;
    }
    return { processed: 1 };
  }

  // ── Status page (and safe resume) ──

  /** Bring a registration up to date without waiting for webhooks: check GoCardless and Stripe server-side. */
  async function sync(token) {
    const r = await by('public_token', token);
    if (!r || !gc) return;
    if (r.registration_status === 'awaiting_direct_debit' && r.gc_billing_request_id && !r.gc_mandate_id) {
      const br = await gc.getBillingRequest(r.gc_billing_request_id);
      if (br.status === 'fulfilled' && br.links && br.links.mandate_request_mandate) await onFulfilled(r, br.links.mandate_request_mandate, br.links.customer);
    } else if (r.gc_mandate_id && !r.gc_subscription_id) {
      const mandate = await gc.getMandate(r.gc_mandate_id).catch(() => null);
      if (mandate) await onMandateStatus(r, mandate.status, {});
    }
    const fresh = await by('public_token', token);
    if (fresh && fresh.registration_status === 'awaiting_upfront_payment' && fresh.stripe_checkout_session_id && stripe) {
      const s = await stripe.getCheckoutSession(fresh.stripe_checkout_session_id).catch(() => null);
      if (s && s.status === 'complete' && s.payment_status === 'paid') await markPaid(s);
    }
  }

  async function publicStatus(token) {
    if (!token) return null;
    const r = await by('public_token', token);
    if (!r) return null;
    const m = YSP.getMembership(r.membership_id);
    const p = YSP.getProgramme(r.programme_id);
    let stage = 'received';
    if (r.registration_status === 'active') stage = 'active';
    else if (r.registration_status === 'awaiting_upfront_payment') stage = 'payment_due';
    else if (r.registration_status === 'awaiting_direct_debit') stage = r.gc_mandate_id ? 'processing' : 'direct_debit_pending';
    else if (['failed', 'cancelled', 'expired'].includes(r.mandate_status)) stage = 'direct_debit_failed';
    let detail = {};
    try { detail = JSON.parse(r.upfront_detail || '{}'); } catch { detail = {}; }
    return {
      reference: r.reference,
      stage,
      childName: r.child_name,
      membership: m ? m.name : r.membership_id,
      programme: p ? p.name : r.programme_id,
      days: daysOf(r),
      times: p ? daysOf(r).map((d) => { const s = p.sessions.find((x) => x.day === d); return s ? `${d} ${s.time}` : d; }) : daysOf(r),
      venue: YSP.venue.short,
      monthlyPence: r.amount_pence,
      startDate: r.start_date,
      upfrontPence: r.upfront_pence,
      upfrontStatus: r.upfront_status,
      upfrontError: r.upfront_status !== 'paid' ? r.upfront_error : null,
      upfrontLines: detail.lines || [],
      coveredFrom: r.covered_from,
      coveredTo: r.covered_to,
      firstCollectionDate: r.first_collection_date,
      firstCollectionEstimated: Boolean(r.first_collection_estimated),
      mandateStatus: r.mandate_status,
      cardPaymentAvailable: cardPaymentsReady(),
      contact: YSP.contact.email
    };
  }

  // ── GoCardless webhooks ──

  async function onFulfilled(r, mandateId, customerId) {
    if (!mandateId || r.gc_mandate_id === mandateId) return;
    const fields = { gc_mandate_id: mandateId, gc_customer_id: customerId || r.gc_customer_id };
    if (r.mandate_status === 'pending_customer') fields.mandate_status = 'pending_submission';
    await update(r.id, fields, 'billing_request_fulfilled');
    const mandate = await gc.getMandate(mandateId).catch(() => null);
    if (mandate) await onMandateStatus(await byId(r.id), mandate.status, {});
  }

  async function onMandateStatus(r, status, event) {
    const map = { pending_customer_approval: 'pending_customer', pending_submission: 'pending_submission', created: 'pending_submission', customer_approval_granted: 'pending_submission', submitted: 'submitted', active: 'active', reinstated: 'active',
      failed: 'failed', cancelled: 'cancelled', expired: 'expired', consumed: 'cancelled', blocked: 'failed' };
    const s = map[status];
    if (!s) return;
    const fields = { mandate_status: s };
    const ended = ['failed', 'cancelled', 'expired'].includes(s);
    if (ended && ['awaiting_direct_debit', 'awaiting_upfront_payment'].includes(r.registration_status)) fields.registration_status = 'submitted';
    if (s !== r.mandate_status || fields.registration_status) await update(r.id, fields, `mandate_${status}`);
    if (ended) {
      const paid = r.upfront_status === 'paid' ? ` The parent has already paid £${((r.upfront_pence || 0) / 100).toFixed(2)} by card: decide whether to refund.` : '';
      await notify.toYsp(`Direct Debit ${s}: ${r.reference}`, `Mandate for ${r.child_name} (${r.membership_id}) is ${s}.${paid} Parent: ${r.parent_name} ${r.parent_email}. Cause: ${(event.details && event.details.cause) || '-'}`);
      return;
    }
    if (MANDATE_USABLE.includes(s)) await finalise(r.id);
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
        return onFulfilled(r, mandateId, customerId);
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
        if (ev.action === 'cancelled') await notify.toYsp(`Subscription cancelled: ${r.reference}`, `Subscription for ${r.child_name} (${r.membership_id}) was cancelled. Cause: ${(ev.details && ev.details.cause) || '-'}`);
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
          await notify.toYsp(`Payment ${p.status}: ${r.reference}`, `Payment ${p.id} (£${(p.amount || 0) / 100}, ${p.charge_date}) for ${r.child_name} is ${p.status}. Parent: ${r.parent_name} ${r.parent_email} ${r.parent_phone}. Cause: ${(ev.details && ev.details.cause) || '-'}`);
        }
        return;
      }
      default:
    }
  }

  /** Process a verified GoCardless webhook body. Each event is processed at most once. */
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

  return {
    register, previewQuote, startDates, publicStatus, sync, resumeDirectDebit, startCheckout, handleStripeWebhook, markPaid,
    createSubscription, cancelSubscription, activate, finalise, handleWebhook, newReference, HOLDS_PLACE
  };
}

module.exports = { create, newReference };
