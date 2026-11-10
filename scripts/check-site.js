'use strict';
// Static checks: internal links/assets, one <h1> per page, titles/descriptions, banned claims.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
const BANNED = [/world-class/i, /premier\b/i, /most trusted/i, /fastest[- ]growing/i, /5★/, /#1\b/, /visionaries/i, /\belite\b/i, /\bpremium\b/i, /sheffield's (leading|best)/i,
  /wednesday/i, /concord/i, /firth park/i, /all ages/i, /youthsportspathway@gmail/i, /\bcamps?\b/i, /YSP Games/i, /\bHAF\b/, /hall hire/i, /Coach Name/];
let problems = 0;
const fail = (p, m) => { problems++; console.log(`✖ ${p}: ${m}`); };

for (const p of pages) {
  const html = fs.readFileSync(path.join(root, p), 'utf8');
  const text = html.replace(/<script[\s\S]*?<\/script>/g, '');
  for (const re of BANNED) if (re.test(text)) fail(p, `contains ${re}`);
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (!['index.html', 'admin.html', 'taster.html'].includes(p) && h1 !== 1) fail(p, `${h1} <h1> elements`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail(p, 'missing <title>');
  if (p !== 'admin.html' && !/<meta name="description"/.test(html)) fail(p, 'missing meta description');
  for (const m of html.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:)/.test(u)) continue;
    if (!fs.existsSync(path.join(root, decodeURIComponent(u)))) fail(p, `broken link ${u}`);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) if (!/\balt="/.test(m[0])) fail(p, `img without alt: ${m[0].slice(0, 60)}`);
}
for (const f of ['js/site-data.js', 'js/site.js', 'js/forms.js', 'js/main.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  if (/sandbox_|live_[A-Za-z0-9]{10}|webhook_secret|ACCESS_TOKEN/i.test(src)) fail(f, 'possible secret in frontend code');
}
console.log(problems ? `\n${problems} problem(s)` : `✓ ${pages.length} pages checked, no problems`);
process.exit(problems ? 1 : 0);
