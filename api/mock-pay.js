import { db } from '../lib/db.js';
import { isMock } from '../lib/gocardless.js';
import { handleEvent } from '../lib/fulfil.js';
import { siteUrl } from '../lib/http.js';

// Local testing only: stands in for the GoCardless hosted page when MOCK_PAYMENTS=1.
export async function GET(request) {
  if (!isMock()) return new Response('Not found', { status: 404 });
  const ref = new URL(request.url).searchParams.get('ref') || '';
  const [m] = await db()`SELECT gc_billing_request FROM members WHERE ref = ${ref}`;
  if (!m?.gc_billing_request) return new Response('Unknown booking', { status: 404 });
  await handleEvent({
    id: `EV_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    resource_type: 'billing_requests', action: 'fulfilled',
    links: { billing_request: m.gc_billing_request },
  });
  return Response.redirect(`${siteUrl(request)}/confirmation.html?ref=${encodeURIComponent(ref)}`, 302);
}
