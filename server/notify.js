'use strict';
// Email notifications. Optional: if SMTP isn't configured, messages are logged
// (without personal data) and the submission is still stored in the database.

function create(smtp, log = console) {
  let transport = null;
  if (smtp.host && smtp.user && smtp.pass) {
    try {
      const nodemailer = require('nodemailer');
      transport = nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.pass }
      });
    } catch (e) {
      log.warn('[notify] SMTP configured but nodemailer is not installed — run `npm install`.');
    }
  }
  const sent = []; // kept for tests/inspection when no transport

  async function send(to, subject, text) {
    if (!transport) {
      sent.push({ to, subject, text });
      log.info(`[notify] email not configured — would send "${subject}"`);
      return false;
    }
    try {
      await transport.sendMail({ from: smtp.from, to, subject, text });
      return true;
    } catch (e) {
      log.error(`[notify] failed to send "${subject}": ${e.message}`);
      return false;
    }
  }
  return {
    configured: Boolean(transport),
    sent,
    toYsp: (subject, text) => send(smtp.to, subject, text),
    toParent: (to, subject, text) => send(to, subject, text)
  };
}

module.exports = { create };
