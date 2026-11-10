'use strict';
// Vercel serverless entry: every /api/* request is rewritten here (vercel.json).
const { load } = require('./_lib/config');
const { createApp } = require('./_lib/app');

let app;
function getApp() {
  if (!app) {
    const config = load();
    const emailReady = Boolean(config.email.resendApiKey || (config.email.smtp.host && config.email.smtp.user && config.email.smtp.pass));
    if (!config.databaseUrl && !emailReady) {
      // No persistent disk on Vercel and no way to email submissions: refuse rather than lose them.
      const err = new Error('Neither DATABASE_URL nor email is configured');
      err.status = 503;
      throw err;
    }
    // With email but no database: email-only mode (nothing stored, no Direct Debit, no admin).
    app = createApp({ config, db: config.databaseUrl ? undefined : null });
  }
  return app;
}

module.exports = async (req, res) => {
  // Restore the original /api/... path from the rewrite.
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('__path');
  if (p !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = '/api/' + p.replace(/^\/+/, '') + (qs ? '?' + qs : '');
  }
  let a;
  try { a = getApp(); } catch (e) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: 'Online forms are temporarily unavailable. Please email youthsportspathway@gmail.com.' }));
  }
  return a.handler(req, res);
};

// Keep the raw body intact (needed for GoCardless webhook signature checks).
module.exports.config = { api: { bodyParser: false } };
