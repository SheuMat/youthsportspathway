import { verifyWebhookSignature } from '../lib/gocardless.js';
import { handleEvent } from '../lib/fulfil.js';

export async function POST(request) {
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get('webhook-signature'))) {
    return new Response('Invalid signature', { status: 498 });
  }
  let events;
  try { ({ events = [] } = JSON.parse(raw)); } catch { return new Response('Bad JSON', { status: 400 }); }
  try {
    for (const event of events) console.log(`[webhook] ${event.id} ${event.resource_type}.${event.action} -> ${await handleEvent(event)}`);
  } catch (err) {
    console.error('[webhook] failed', err);
    return new Response('Processing failed', { status: 500 });
  }
  return new Response(null, { status: 204 });
}
