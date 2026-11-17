'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function load(env = process.env) {
  const gcEnv = (env.GOCARDLESS_ENVIRONMENT || 'sandbox').toLowerCase();
  const token = env.GOCARDLESS_ACCESS_TOKEN || '';
  const problems = [];
  if (gcEnv !== 'sandbox' && gcEnv !== 'live') problems.push('GOCARDLESS_ENVIRONMENT must be sandbox or live');
  if (gcEnv === 'live' && env.GOCARDLESS_LIVE_APPROVED !== 'true') problems.push('Live GoCardless is not approved (set GOCARDLESS_LIVE_APPROVED=true only after owner sign-off)');
  if (token && gcEnv === 'sandbox' && !token.startsWith('sandbox_')) problems.push('GOCARDLESS_ACCESS_TOKEN is not a sandbox token');
  if (token && gcEnv === 'live' && !token.startsWith('live_')) problems.push('GOCARDLESS_ACCESS_TOKEN is not a live token');

  const gocardlessEnabled = Boolean(token && env.GOCARDLESS_WEBHOOK_SECRET && problems.length === 0);
  const stripeKey = env.STRIPE_SECRET_KEY || '';
  const stripeProblems = [];
  if (stripeKey && !/^(sk|rk)_(test|live)_/.test(stripeKey)) stripeProblems.push('STRIPE_SECRET_KEY is not a Stripe secret key');
  if (/^(sk|rk)_live_/.test(stripeKey) && env.STRIPE_LIVE_APPROVED !== 'true') stripeProblems.push('Live Stripe is not approved (set STRIPE_LIVE_APPROVED=true only after owner sign-off)');
  return {
    root: ROOT,
    port: Number(env.PORT) || 8000,
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:8000').replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
    databasePath: env.DATABASE_PATH || path.join(ROOT, 'data', 'ysp.sqlite'),
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 ? env.ADMIN_TOKEN : '',
    gocardless: {
      enabled: gocardlessEnabled,
      environment: gcEnv,
      accessToken: token,
      webhookSecret: env.GOCARDLESS_WEBHOOK_SECRET || '',
      // Test hook only: lets the test suite point at a local mock API.
      apiBase: env.GOCARDLESS_API_BASE_OVERRIDE || (gcEnv === 'live' ? 'https://api.gocardless.com' : 'https://api-sandbox.gocardless.com'),
      problems
    },
    stripe: {
      enabled: Boolean(stripeKey && stripeProblems.length === 0),
      // Card payments need the webhook secret to confirm payment; without it Checkout is not offered.
      webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
      mode: /_live_/.test(stripeKey) ? 'live' : 'test',
      secretKey: stripeKey,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      // Test hook only: lets the test suite point at a local mock API.
      apiBase: env.STRIPE_API_BASE_OVERRIDE || 'https://api.stripe.com/v1',
      problems: stripeProblems
    },
    email: {
      resendApiKey: env.RESEND_API_KEY || '',
      from: env.EMAIL_FROM || 'Youth Sports Pathway <bookings@youthsportspathway.co.uk>',
      to: env.NOTIFY_TO || 'info@youthsportspathway.co.uk',
      smtp: {
        host: env.SMTP_HOST || '',
        port: Number(env.SMTP_PORT) || 465,
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || ''
      }
    }
  };
}

module.exports = { load, ROOT };
