'use strict';
// Minimal Stripe API client for hosted Checkout (https://docs.stripe.com/api/checkout/sessions).
// Server-side only: the secret key never leaves this process and card details never reach YSP.
const crypto = require('node:crypto');

const API = 'https://api.stripe.com/v1';

class StripeError extends Error {
  constructor(status, body) {
    const e = body && body.error;
    super((e && e.message) || `Stripe request failed (${status})`);
    this.status = status;
    this.code = e && e.code;
    this.type = e && e.type;
  }
}

/** Stripe expects application/x-www-form-urlencoded with bracketed nested keys. */
function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formEncode(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

function client({ secretKey, apiBase = API }, fetchImpl = fetch) {
  async function request(method, path, params, idempotencyKey) {
    const headers = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' };
    if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetchImpl(apiBase + path, { method, headers, body: params ? formEncode(params) : undefined, signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError(res.status, json);
    return json;
  }
  return {
    request,
    createCheckoutSession(params, idempotencyKey) { return request('POST', '/checkout/sessions', params, idempotencyKey); },
    getCheckoutSession(id) { return request('GET', `/checkout/sessions/${encodeURIComponent(id)}`); },
    expireCheckoutSession(id) { return request('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, {}); }
  };
}

/**
 * Verify a Stripe-Signature header: t=timestamp,v1=hex HMAC-SHA256 of `${t}.${rawBody}`.
 * Rejects signatures older than `toleranceSec` to stop replays.
 */
function verifySignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) (parts[kv.slice(0, i).trim()] = parts[kv.slice(0, i).trim()] || []).push(kv.slice(i + 1).trim());
  }
  const t = Number(parts.t && parts.t[0]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return (parts.v1 || []).some((sig) => {
    const a = Buffer.from(expected); const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = { client, verifySignature, formEncode, StripeError };
