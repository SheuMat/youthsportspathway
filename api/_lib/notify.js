'use strict';
// Email notifications.
//  1. Resend (RESEND_API_KEY) — preferred, plain HTTPS, no dependency
//  2. SMTP via nodemailer (SMTP_HOST/USER/PASS) — fallback
//  3. Neither: messages are logged (subject only, no personal data) and kept in `sent` for tests
// send() never throws; it resolves true when the provider accepted the message.

function create(cfg, log = console, fetchImpl = fetch) {
  const sent = [];
  let provider = 'none';
  let smtp = null;

  if (cfg.resendApiKey) {
    provider = 'resend';
  } else if (cfg.smtp && cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass) {
    try {
      const nodemailer = require('nodemailer');
      smtp = nodemailer.createTransport({
        host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465,
        auth: { user: cfg.smtp.user, pass: cfg.smtp.pass }
      });
      provider = 'smtp';
    } catch (e) {
      log.warn('[notify] SMTP configured but nodemailer is not installed — run `npm install`.');
    }
  }

  async function send({ to, subject, text, replyTo }) {
    if (!to) return false;
    if (provider === 'none') {
      sent.push({ to, subject, text, replyTo });
      log.info(`[notify] email not configured — would send "${subject}"`);
      return false;
    }
    try {
      if (provider === 'resend') {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          log.error(`[notify] Resend rejected "${subject}": ${res.status} ${body.slice(0, 300)}`);
          return false;
        }
        sent.push({ to, subject, text, replyTo, provider });
        return true;
      }
      await smtp.sendMail({ from: cfg.from, to, subject, text, replyTo });
      sent.push({ to, subject, text, replyTo, provider });
      return true;
    } catch (e) {
      log.error(`[notify] failed to send "${subject}": ${e.message}`);
      return false;
    }
  }

  return {
    provider,
    configured: provider !== 'none',
    sent,
    /** To YSP's booking inbox. replyTo lets YSP reply straight to the parent. */
    toYsp: (subject, text, replyTo) => send({ to: cfg.to, subject, text, replyTo }),
    /** To a parent. Replies go to YSP's inbox. */
    toParent: (to, subject, text) => send({ to, subject, text, replyTo: cfg.to })
  };
}

module.exports = { create };
