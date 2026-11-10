'use strict';
// Vercel serverless entry: every /api/* request is rewritten here (vercel.json).
const { load } = require('./_lib/config');
const { createApp } = require('./_lib/app');

let app;
function getApp() {
  if (!app) {
    const config = load();
    if (!config.databaseUrl) {
      // No persistent disk on Vercel: refuse to fall back to a throwaway SQLite file.
      const err = new Error('DATABASE_URL is not configured');
      err.status = 503;
      throw err;
    }
    app = createApp({ config });
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
