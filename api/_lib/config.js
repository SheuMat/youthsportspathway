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
  const dom = env.BILLING_DAY_OF_MONTH ? Number(env.BILLING_DAY_OF_MONTH) : null;
  if (dom !== null && !(dom === -1 || (Number.isInteger(dom) && dom >= 1 && dom <= 28))) problems.push('BILLING_DAY_OF_MONTH must be 1-28 or -1');

  const gocardlessEnabled = Boolean(token && env.GOCARDLESS_WEBHOOK_SECRET && problems.length === 0);
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
    billing: {
      autoCreateSubscriptions: env.BILLING_AUTO_CREATE_SUBSCRIPTIONS === 'true',
      dayOfMonth: dom
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
