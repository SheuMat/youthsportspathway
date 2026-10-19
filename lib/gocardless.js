import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const isMock = () => process.env.MOCK_PAYMENTS === '1';

const baseUrl = () =>
  process.env.GOCARDLESS_ENVIRONMENT === 'live' ? 'https://api.gocardless.com' : 'https://api-sandbox.gocardless.com';

async function gc(method, path, body, idempotencyKey) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN is not set');
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GoCardless ${method} ${path} failed: ${res.status} ${json.error?.message || ''}`);
    err.gc = json.error;
    throw err;
  }
  return json;
}

const isoDate = (d) => d.toISOString().slice(0, 10);

export async function createBillingRequestFlow({ member, siteUrl }) {
  if (isMock()) {
    const id = `BRQ_mock_${member.ref.slice(0, 8)}`;
    return { billingRequestId: id, url: `${siteUrl}/api/mock-pay?ref=${encodeURIComponent(member.ref)}` };
  }
  const [givenName, ...rest] = member.parent_name.trim().split(/\s+/);
  const br = await gc('POST', '/billing_requests', {
    billing_requests: {
      mandate_request: { scheme: 'bacs', currency: 'GBP' },
      metadata: { member_ref: member.ref.slice(0, 50) },
    },
  }, `br-${member.id}`);
  const brId = br.billing_requests.id;
  const flow = await gc('POST', '/billing_request_flows', {
    billing_request_flows: {
      redirect_uri: `${siteUrl}/confirmation.html?ref=${encodeURIComponent(member.ref)}`,
      exit_uri: `${siteUrl}/timetable.html`,
      prefilled_customer: { given_name: givenName, family_name: rest.join(' ') || givenName, email: member.email },
      links: { billing_request: brId },
    },
  });
  return { billingRequestId: brId, url: flow.billing_request_flows.authorisation_url };
}

export async function getBillingRequestMandate(billingRequestId) {
  if (isMock()) return `MD_mock_${billingRequestId.replace('BRQ_mock_', '')}`;
  const br = await gc('GET', `/billing_requests/${billingRequestId}`);
  return br.billing_requests.links?.mandate_request_mandate || null;
}

async function nextPossibleChargeDate(mandateId) {
  if (isMock()) return isoDate(new Date(Date.now() + 3 * 864e5));
  const m = await gc('GET', `/mandates/${mandateId}`);
  return m.mandates.next_possible_charge_date;
}

// First chosen collection day that is on/after the programme start, today, and the mandate's earliest charge date.
export function firstChargeDate(paymentDay, notBefore) {
  const floor = new Date(`${notBefore}T00:00:00Z`);
  let y = floor.getUTCFullYear();
  let mo = floor.getUTCMonth();
  for (let i = 0; i < 24; i++) {
    const day = paymentDay === -1 ? new Date(Date.UTC(y, mo + 1, 0)).getUTCDate() : paymentDay;
    const candidate = new Date(Date.UTC(y, mo, day));
    if (candidate >= floor) return isoDate(candidate);
    mo += 1;
  }
  throw new Error('Could not compute first charge date');
}

export async function createSubscription({ member, mandateId, planLabel, programmeStart }) {
  const npcd = await nextPossibleChargeDate(mandateId);
  const today = isoDate(new Date());
  const notBefore = [programmeStart, today, npcd].sort().at(-1);
  const startDate = firstChargeDate(member.payment_day, notBefore);
  if (isMock()) return { id: `SB_mock_${member.ref.slice(0, 8)}`, startDate };
  const sub = await gc('POST', '/subscriptions', {
    subscriptions: {
      amount: member.amount_pence,
      currency: 'GBP',
      name: `YSP ${planLabel}`.slice(0, 255),
      interval_unit: 'monthly',
      day_of_month: member.payment_day,
      start_date: startDate,
      metadata: { member_ref: member.ref.slice(0, 50) },
      links: { mandate: mandateId },
    },
  }, `sub-${member.id}`).catch(async (err) => {
    // Retried webhook: the subscription already exists under this idempotency key.
    const existing = err.gc?.errors?.[0]?.links?.conflicting_resource_id;
    if (!existing) throw err;
    return gc('GET', `/subscriptions/${existing}`);
  });
  return { id: sub.subscriptions.id, startDate: sub.subscriptions.start_date || startDate };
}

export async function cancelMandate(mandateId) {
  if (isMock()) return;
  await gc('POST', `/mandates/${mandateId}/actions/cancel`, {}, `cancel-${mandateId}-${randomUUID()}`);
}

export function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}
