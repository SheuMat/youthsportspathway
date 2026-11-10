# YSP website: setup and operations

The site is still plain HTML/CSS/JS. A small Node.js server (`server/`) now serves those pages and handles the forms, the free taster requests, membership registration and GoCardless. The site has no build step and no framework.

## Run locally

```bash
cp .env.example .env      # then fill in ADMIN_TOKEN (and GoCardless sandbox keys if testing payments)
npm install               # optional: only needed for email notifications (nodemailer)
npm run dev               # http://localhost:8000
npm test                  # automated tests (uses a mock GoCardless API)
npm run check             # static checks: links, headings, banned claims, secrets
```

Requires Node.js 22.13 or later. Data is stored in SQLite at `DATABASE_PATH` (default `data/ysp.sqlite`). Back this file up.

## Hosting

The forms need this server running. **A static-only host (GitHub Pages, plain Netlify) cannot run it**, and on one the forms show an error asking people to email instead. Use a Node host with a persistent disk (Render, Railway, Fly.io, or a small VPS), set the environment variables there, and point `youthsportspathway.com` at it over HTTPS.

## Where things are configured

| What | Where |
|---|---|
| Programmes, session days and times, venue, prices, membership products | `js/site-data.js`, used by the timetable, programme cards, forms and server |
| Development Basketball paid-registration hold | `paidRegistrationOpen` in `js/site-data.js` |
| Partners / testimonials (currently empty) | `partners` / `testimonials` arrays in `js/site-data.js` |
| WhatsApp invite link (currently none) | `contact.whatsappUrl` in `js/site-data.js` |
| Secrets, GoCardless mode, billing switches | environment variables (`.env.example`) |

## Admin page

Go to `/admin.html` and enter `ADMIN_TOKEN`. From there you can:

- **Taster requests:** confirm (emails the parent), decline, or mark attended.
- **Registrations:** view the registration, mandate, subscription and last-payment status separately. You can create a subscription (one per registration; a repeat click never makes a second one), cancel a subscription, or reject a registration.
- **Payments and enquiries:** view them.

If email isn't configured, nothing is emailed. Check this page for new submissions.

## GoCardless

The integration uses GoCardless Billing Requests with the hosted Billing Request Flow. Parents enter their bank details on GoCardless's own page, so YSP never handles them.

1. In the GoCardless **sandbox** dashboard (manage-sandbox.gocardless.com), go to Developers → Create → Access token (read-write). Put it in `GOCARDLESS_ACCESS_TOKEN`; it starts with `sandbox_`.
2. Go to Developers → Create → Webhook endpoint, with URL `https://<your-domain>/api/webhooks/gocardless`. Copy its secret into `GOCARDLESS_WEBHOOK_SECRET`.
3. Set `PUBLIC_BASE_URL` to the site's public HTTPS URL; it is used for the redirect back to `register-complete.html`.
4. Test using the sandbox's test bank details. Check that the webhooks update the admin page.
5. **Go-live, only with the owner's explicit approval:** create live credentials, then set `GOCARDLESS_ENVIRONMENT=live`, `GOCARDLESS_LIVE_APPROVED=true` and the live token and secret. The server refuses live mode without the approval flag, and refuses a mismatched sandbox or live token.

Keys stay on the server only and never appear in frontend files (`npm run check` scans for this).

### Lifecycle

```
register form → registration saved → billing request + hosted flow → parent authorises on GoCardless
  → webhook billing_requests.fulfilled → mandate linked   (mandate status: pending_submission; NOT a payment)
  → webhook mandates.active           → mandate active
  → subscription created (admin button, or automatically if BILLING_AUTO_CREATE_SUBSCRIPTIONS=true)
  → webhook payments.*                → payment status tracked (confirmed / paid_out / failed / charged_back…)
```

- Webhooks are verified by HMAC signature; an invalid signature gets HTTP 498.
- Each event ID is processed once, so duplicate deliveries are ignored.
- Subscription creation uses an idempotency key per registration.
- Failed payments, failed or cancelled mandates and cancelled subscriptions email YSP when email is configured, and are always shown in admin.
- Parents who tick "I already pay YSP by Direct Debit" are **not** sent to GoCardless. They are flagged for review so no duplicate mandate is created.
- The same parent email, child and programme cannot be registered twice while a registration is active or pending.

## Email (optional)

Set `SMTP_*` and run `npm install`. For Gmail, use an App Password. YSP receives a notification for every enquiry, taster and registration. Parents receive an acknowledgement.
