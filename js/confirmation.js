(function () {
  const box = document.getElementById('confirm');
  const ref = new URLSearchParams(location.search).get('ref');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (p) => '£' + (p / 100).toFixed(p % 100 ? 2 : 0);
  const long = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const short = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  let tries = 0;

  function render(d) {
    if (d.status === 'active') {
      box.innerHTML = `<h2>You're booked in!</h2>
        <p>Thank you. A confirmation email is on its way.</p>
        <dl>
          <dt>Child</dt><dd>${esc(d.childName)}</dd>
          <dt>Plan</dt><dd>${esc(d.plan)}, ${money(d.pricePence)} a month</dd>
          <dt>Direct Debit</dt><dd>${esc(d.paymentDay)}${d.firstChargeDate ? `, first payment ${esc(long(d.firstChargeDate))}` : ''}</dd>
          <dt>Time</dt><dd>${esc(d.time)}</dd>
          <dt>Venue</dt><dd>${esc(d.venue.name)}<br>${esc(d.venue.address)}<br><a href="${esc(d.venue.url)}" target="_blank" rel="noopener" style="color:var(--red);font-weight:600;">Venue details</a></dd>
        </dl>
        <details class="month"><summary>Your session dates <span class="month-count">${d.sessions.length} sessions</span></summary>
          <ul class="date-list">${d.sessions.map((s) => `<li class="date-card"><span class="date-num" style="font-size:1rem;">${esc(short(s.date))}</span><span class="date-time">5:00pm to 6:00pm</span></li>`).join('')}</ul>
        </details>
        <p style="margin-top:24px;"><a href="index.html" class="btn btn-primary">Back to home</a></p>`;
      return true;
    }
    if (d.status === 'overbooked') {
      box.innerHTML = `<h2>Sorry, this session is now full</h2>
        <p>The session filled up while you were setting up your Direct Debit, so we couldn't confirm a place for ${esc(d.childName)}. We've cancelled the Direct Debit and <strong>no payment will be taken</strong>. We've emailed you, and we'll be in touch if a place becomes available.</p>
        <p style="margin-top:20px;"><a href="contact.html" class="btn btn-primary">Contact us</a></p>`;
      return true;
    }
    if (d.status === 'pending') {
      if (tries < 20) return false;
      box.innerHTML = `<h2>We're still confirming your booking</h2>
        <p>Your Direct Debit is being set up. You'll receive a confirmation email as soon as it's done. If you don't hear from us within an hour, please <a href="contact.html" style="color:var(--red);font-weight:600;">contact us</a>.</p>`;
      return true;
    }
    box.innerHTML = `<h2>We couldn't confirm this booking</h2><p>Please <a href="timetable.html" style="color:var(--red);font-weight:600;">try again</a> or <a href="contact.html" style="color:var(--red);font-weight:600;">contact us</a>.</p>`;
    return true;
  }

  async function poll() {
    tries += 1;
    try {
      const res = await fetch('/api/status?ref=' + encodeURIComponent(ref || ''), { cache: 'no-store' });
      if (res.status === 404) { render({ status: 'unknown' }); return; }
      if (res.ok && render(await res.json())) return;
    } catch { /* retry */ }
    setTimeout(poll, 3000);
  }

  if (!ref) render({ status: 'unknown' });
  else poll();
})();
