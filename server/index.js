'use strict';
const http = require('node:http');
const { load } = require('../api/_lib/config');
const { createApp } = require('../api/_lib/app');

const config = load();
const { handler } = createApp({ config });
const gc = config.gocardless;
console.log(`[ysp] GoCardless: ${gc.enabled ? gc.environment : 'disabled'}${gc.problems.length ? ' — ' + gc.problems.join('; ') : ''}`);
console.log(`[ysp] Auto-create subscriptions: ${config.billing.autoCreateSubscriptions}`);
console.log(`[ysp] Admin: ${config.adminToken ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}`);
http.createServer(handler).listen(config.port, () => console.log(`[ysp] http://localhost:${config.port}`));
