import { db, slotAvailability } from './db.js';
import { PLANS, PROGRAMME_START } from './config.js';
import { getBillingRequestMandate, createSubscription, cancelMandate } from './gocardless.js';
import { sendConfirmationEmails, sendOverbookedEmails } from './email.js';

export async function memberSessions(sql, member) {
  return sql`SELECT s.slot_code, s.session_date FROM sessions s
             JOIN member_slots ms ON ms.slot_code = s.slot_code AND ms.member_id = ${member.id}
             WHERE s.session_date >= CURRENT_DATE ORDER BY s.session_date`;
}

// Called when GoCardless reports the Direct Debit mandate is set up (billing request fulfilled).
export async function confirmBillingRequest(billingRequestId) {
  const sql = db();
  const mandateId = await getBillingRequestMandate(billingRequestId);
  if (!mandateId) throw new Error(`No mandate on billing request ${billingRequestId}`);

  const outcome = await sql.begin(async (tx) => {
    await tx`SELECT code FROM slots ORDER BY code FOR UPDATE`;
    const [member] = await tx`SELECT * FROM members WHERE gc_billing_request = ${billingRequestId} FOR UPDATE`;
    if (!member) throw new Error(`Unknown billing request ${billingRequestId}`);
    // An earlier attempt confirmed the place but failed before the subscription was created.
    if (member.status === 'active' && !member.gc_subscription) return { member, result: 'active' };
    if (member.status !== 'pending') return { member, result: 'already-processed' };

    // Re-check capacity now, ignoring this member's own hold.
    const avail = await slotAvailability(tx, member.id);
    const full = PLANS[member.plan].slots.some((code) => avail[code].remaining <= 0);
    const status = full ? 'overbooked' : 'active';
    const [updated] = await tx`UPDATE members SET status = ${status}, gc_mandate = ${mandateId},
                                confirmed_at = CASE WHEN ${status} = 'active' THEN now() ELSE confirmed_at END
                               WHERE id = ${member.id} RETURNING *`;
    return { member: updated, result: status };
  });

  let { member } = outcome;
  if (outcome.result === 'overbooked') {
    await cancelMandate(mandateId);
    await sql`UPDATE members SET notes = 'Session full at confirmation; mandate cancelled' WHERE id = ${member.id}`;
    await sendOverbookedEmails(member);
    return 'overbooked';
  }
  if (outcome.result !== 'active') return outcome.result;

  const sub = await createSubscription({ member, mandateId, planLabel: PLANS[member.plan].label, programmeStart: PROGRAMME_START });
  [member] = await sql`UPDATE members SET gc_subscription = ${sub.id}, first_charge_date = ${sub.startDate},
                         last_payment_status = 'scheduled'
                       WHERE id = ${member.id} RETURNING *`;
  await sendConfirmationEmails(member, await memberSessions(sql, member));
  return 'active';
}

const MANDATE_ENDED = new Set(['cancelled', 'failed', 'expired', 'blocked']);
const PAYMENT_STATUS = { confirmed: 'paid', paid_out: 'paid', failed: 'failed', charged_back: 'charged back', cancelled: 'cancelled', late_failure_settled: 'failed' };

export async function handleEvent(event) {
  const sql = db();
  const inserted = await sql`INSERT INTO webhook_events (id) VALUES (${event.id}) ON CONFLICT DO NOTHING RETURNING id`;
  if (!inserted.length) return 'duplicate';
  try {
    return await processEvent(sql, event);
  } catch (err) {
    // Forget the event so GoCardless's retry gets processed.
    await sql`DELETE FROM webhook_events WHERE id = ${event.id}`;
    throw err;
  }
}

async function processEvent(sql, event) {
  const { resource_type: type, action, links = {} } = event;
  if (type === 'billing_requests' && action === 'fulfilled') {
    return confirmBillingRequest(links.billing_request);
  }
  if (type === 'mandates' && MANDATE_ENDED.has(action)) {
    await sql`UPDATE members SET status = 'cancelled', notes = ${`Mandate ${action}`}
              WHERE gc_mandate = ${links.mandate} AND status = 'active'`;
    return `mandate-${action}`;
  }
  if (type === 'subscriptions' && (action === 'cancelled' || action === 'finished')) {
    await sql`UPDATE members SET status = 'cancelled', notes = ${`Subscription ${action}`}
              WHERE gc_subscription = ${links.subscription} AND status = 'active'`;
    return `subscription-${action}`;
  }
  if (type === 'payments' && PAYMENT_STATUS[action] && links.subscription) {
    await sql`UPDATE members SET last_payment_status = ${PAYMENT_STATUS[action]} WHERE gc_subscription = ${links.subscription}`;
    return `payment-${action}`;
  }
  return 'ignored';
}
