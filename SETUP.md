# YSP website: setup and operations

The site is still plain HTML/CSS/JS. The forms, free taster requests, membership registration and GoCardless are handled by a small Node.js backend in `api/`. On Vercel it runs as a serverless function (`api/handler.js`, with shared code in `api/_lib/`). Locally, `server/index.js` serves the pages and the same API. The site has no build step and no framework.

## Run locally

```bash
cp .env.example .env      # then fill in ADMIN_TOKEN (and GoCardless sandbox keys if testing payments)
npm install               # optional: only needed for email notifications (nodemailer)
npm run dev               # http://localhost:8000
npm test                  # automated tests (uses a mock GoCardless API)
npm run check             # static checks: links, headings, banned claims, secrets
```

Requires Node.js 22.13 or later. Locally, data is stored in SQLite at `DATABASE_PATH` (default `data/ysp.sqlite`). On Vercel it is stored in Postgres (`DATABASE_URL`); Neon includes point-in-time backups.

## Hosting (Vercel)

The main address is **https://www.youthsportspathway.co.uk**. `youthsportspathway.co.uk`, `youthsportspathway.com` and `www.youthsportspathway.com` all redirect there permanently (308), keeping the page path. Domains are managed in Vercel → Domains; DNS for both domains is at GoDaddy. The `.co.uk` zone also holds the Microsoft 365 email records (MX, autodiscover, DKIM, SPF, DMARC), which must not be changed when editing website records.

The site is deployed by Vercel from `main`. Vercel serves static pages directly and rewrites `/api/*` to `api/handler.js` (see `vercel.json`). Vercel has no persistent disk, so **the live site needs a Postgres database.** Until `DATABASE_URL` is set, the forms show "Online forms are temporarily unavailable — please email…".

One-time setup in the Vercel dashboard (project **youthsportspathway**):

1. **Storage → Create Database → Neon (Postgres)**, free plan, region London (or nearest). Connect it to the project for Production and Preview. This sets `DATABASE_URL`. Tables are created automatically on first use.
2. **Settings → Environment Variables** (Production; Preview too if you want to test there):
   - `ADMIN_TOKEN`: a long random string (`openssl rand -hex 24`).
   - `PUBLIC_BASE_URL`: `https://www.youthsportspathway.co.uk`
   - Optional email: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=youthsportspathway@gmail.com`, `SMTP_PASS=<Gmail App Password>`.
   - GoCardless sandbox (when ready): `GOCARDLESS_ENVIRONMENT=sandbox`, `GOCARDLESS_ACCESS_TOKEN`, `GOCARDLESS_WEBHOOK_SECRET`.
3. **Deployments → Redeploy** the latest production deployment so the variables take effect.
4. Check `https://www.youthsportspathway.co.uk/api/health`. It should show `"database":"postgres"`.

Locally, the same code uses SQLite (`DATABASE_PATH`) unless `DATABASE_URL` is set. To run the tests against Postgres: `TEST_DATABASE_URL=postgres://user@host:port/postgres npm test`.

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
2. Go to Developers → Create → Webhook endpoint, with URL `https://www.youthsportspathway.co.uk/api/webhooks/gocardless`. Copy its secret into `GOCARDLESS_WEBHOOK_SECRET`.
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
