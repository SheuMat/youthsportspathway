'use strict';
// Minimal GoCardless Pro API client (https://developer.gocardless.com/api-reference).
// Server-side only. The access token never leaves this process.
const crypto = require('node:crypto');

const API_VERSION = '2015-07-06';

class GoCardlessError extends Error {
  constructor(status, body) {
    const e = body && body.error;
    super((e && e.message) || `GoCardless request failed (${status})`);
    this.status = status;
    this.type = e && e.type;
    this.errors = (e && e.errors) || [];
  }
  get conflictingResourceId() {
    const c = this.errors.find((x) => x.reason === 'idempotent_creation_conflict');
    return c && c.links && c.links.conflicting_resource_id;
  }
}

function client({ accessToken, apiBase }, fetchImpl = fetch) {
  async function request(method, path, body, idempotencyKey) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'GoCardless-Version': API_VERSION,
      Accept: 'application/json'
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetchImpl(apiBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoCardlessError(res.status, json);
    return json;
  }

  return {
    request,
    async createBillingRequest({ reference, description }, key) {
      const r = await request('POST', '/billing_requests', {
        billing_requests: {
          mandate_request: { scheme: 'bacs', currency: 'GBP', description: description.slice(0, 100) },
          metadata: { ysp_reference: reference }
        }
      }, key);
      return r.billing_requests;
    },
    async createBillingRequestFlow({ billingRequestId, redirectUri, exitUri, customer }) {
      const r = await request('POST', '/billing_request_flows', {
        billing_request_flows: {
          redirect_uri: redirectUri,
          exit_uri: exitUri,
          lock_currency: true,
          prefilled_customer: customer,
          links: { billing_request: billingRequestId }
        }
      });
      return r.billing_request_flows;
    },
    async getBillingRequest(id) { return (await request('GET', `/billing_requests/${encodeURIComponent(id)}`)).billing_requests; },
    async getMandate(id) { return (await request('GET', `/mandates/${encodeURIComponent(id)}`)).mandates; },
    async getPayment(id) { return (await request('GET', `/payments/${encodeURIComponent(id)}`)).payments; },
    async getSubscription(id) { return (await request('GET', `/subscriptions/${encodeURIComponent(id)}`)).subscriptions; },
    async createSubscription(params, key) {
      try {
        return (await request('POST', '/subscriptions', { subscriptions: params }, key)).subscriptions;
      } catch (err) {
        // Retried with the same idempotency key: return the original subscription, never a second one.
        if (err instanceof GoCardlessError && err.status === 409 && err.conflictingResourceId) {
          return this.getSubscription(err.conflictingResourceId);
        }
        throw err;
      }
    },
    async cancelSubscription(id) {
      return (await request('POST', `/subscriptions/${encodeURIComponent(id)}/actions/cancel`, { data: {} })).subscriptions;
    }
  };
}

/** Verify the Webhook-Signature header (hex HMAC-SHA256 of the raw body). */
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { client, verifySignature, GoCardlessError, API_VERSION };
