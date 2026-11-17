// Form handling: enquiries, newsletter, free tasters, membership registration.
// All submissions go to the YSP server (/api/*). Nothing here holds secrets.
(function () {
  'use strict';
  var Y = window.YSP;
  var EMAIL = (Y && Y.contact.email) || 'info@youthsportspathway.co.uk';
  var params = new URLSearchParams(window.location.search);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formData(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.name === 'days') {
        out.days = out.days || [];
        if (el.checked) out.days.push(el.value);
      } else if (el.type === 'checkbox') {
        out[el.name] = el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) out[el.name] = el.value;
      } else out[el.name] = el.value.trim();
    });
    return out;
  }
  function setStatus(form, msg, isError) {
    var el = form.querySelector('.form-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'form-status' + (isError ? ' error' : '');
  }
  function busy(form, on, label) {
    var btn = form.querySelector('[type=submit]');
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Sending…'; }
    else if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = on;
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || 'Something went wrong.');
          e.fields = j.fields; e.code = j.code; throw e;
        }
        return j;
      });
    });
  }
  function failMsg(err) {
    if (err && err.message && err.message !== 'Failed to fetch' && !/NetworkError|Load failed/.test(err.message)) return err.message;
    return 'We couldn\'t send this right now. Please try again, or email us at ' + EMAIL + '.';
  }
  function replaceWith(form, title, html) {
    form.innerHTML = '<div class="result-box"><div style="font-size:3rem;margin-bottom:16px;" aria-hidden="true">✅</div><h3>' + esc(title) + '</h3>' + html + '</div>';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function checkValidity(form) {
    if (form.checkValidity()) return true;
    var bad = form.querySelector(':invalid');
    setStatus(form, 'Please complete the highlighted fields.', true);
    if (bad) { bad.focus(); if (bad.reportValidity) bad.reportValidity(); }
    return false;
  }

  // ── Contact / enquiry form ──
  var contact = document.getElementById('contact-form');
  if (contact) {
    var t = params.get('type');
    var sel = contact.querySelector('[name=type]');
    if (t && sel && sel.querySelector('option[value="' + t.replace(/[^a-z]/g, '') + '"]')) sel.value = t;
    contact.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!checkValidity(contact)) return;
      busy(contact, true); setStatus(contact, '');
      post('/api/enquiries', formData(contact)).then(function () {
        replaceWith(contact, 'Message Sent', '<p>Thanks for getting in touch. We aim to reply within 24 hours on weekdays.</p>');
      }).catch(function (err) { busy(contact, false); setStatus(contact, failMsg(err), true); });
    });
  }

  // ── Newsletter ──
  var news = document.getElementById('email-form');
  if (news) {
    news.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!checkValidity(news)) return;
      var d = formData(news); d.type = 'newsletter'; d.privacyAck = true; d.message = 'Newsletter sign-up' + (d.role ? ' (' + d.role + ')' : '');
      busy(news, true); setStatus(news, '');
      post('/api/enquiries', d).then(function () {
        replaceWith(news, 'You\'re Signed Up', '<p>Thanks — we\'ll keep you posted. You can unsubscribe at any time.</p>');
      }).catch(function (err) { busy(news, false); setStatus(news, failMsg(err), true); });
    });
  }

  if (!Y) return;

  // ── Shared programme/day pickers ──
  function renderProgrammeChoices(form, onChange) {
    var box = form.querySelector('[data-ysp="programme-choices"]');
    box.innerHTML = Y.programmes.map(function (p) {
      return '<label class="choice"><input type="radio" name="programmeId" value="' + esc(p.id) + '" required />' +
        '<strong>' + esc(p.name) + '</strong><span>Ages ' + esc(p.ages) + ' · ' + esc(p.sessions.map(function (s) { return s.day; }).join(' & ')) + '</span></label>';
    }).join('');
    box.addEventListener('change', onChange);
    var pre = params.get('programme');
    var input = pre && box.querySelector('input[value="' + pre.replace(/[^a-z]/g, '') + '"]');
    if (input) { input.checked = true; onChange(); }
  }
  function selectedProgramme(form) {
    var el = form.querySelector('[name=programmeId]:checked');
    return el ? Y.getProgramme(el.value) : null;
  }
  function renderDays(box, p, type, preDay) {
    box.innerHTML = p.sessions.map(function (s) {
      return '<label class="choice"><input type="' + type + '" name="days" value="' + esc(s.day) + '"' + (type === 'radio' ? ' required' : '') +
        (preDay === s.day ? ' checked' : '') + ' /><strong>' + esc(s.day) + '</strong><span>' + esc(s.time) + '</span></label>';
    }).join('');
  }

  // ── Free taster ──
  var taster = document.getElementById('taster-form');
  if (taster) {
    var dayBox = taster.querySelector('[data-ysp="day-choices"]');
    var dateInput = taster.querySelector('[name=preferredDate]');
    var ageInput = taster.querySelector('[name=childAge]');
    var today = new Date(); today.setDate(today.getDate() + 1);
    dateInput.min = today.toISOString().slice(0, 10);
    renderProgrammeChoices(taster, function () {
      var p = selectedProgramme(taster);
      if (!p) return;
      var pre = params.get('day');
      renderDays(dayBox, p, 'radio', p.sessions.some(function (s) { return s.day === pre; }) ? pre : null);
      ageInput.min = p.minAge; ageInput.max = p.maxAge;
      checkDate();
    });
    function checkDate() {
      var dayEl = taster.querySelector('[name=days]:checked');
      dateInput.setCustomValidity('');
      if (!dayEl || !dateInput.value) return;
      var d = new Date(dateInput.value + 'T12:00:00Z');
      var name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
      if (name !== dayEl.value) dateInput.setCustomValidity('Please choose a date that falls on a ' + dayEl.value + '.');
    }
    dateInput.addEventListener('change', checkDate);
    dayBox.addEventListener('change', checkDate);
    taster.addEventListener('submit', function (e) {
      e.preventDefault();
      checkDate();
      if (!selectedProgramme(taster)) { setStatus(taster, 'Please choose a programme.', true); return; }
      if (!taster.querySelector('[name=days]:checked')) { setStatus(taster, 'Please choose a session day.', true); return; }
      if (!checkValidity(taster)) return;
      var d = formData(taster); d.day = d.days && d.days[0]; delete d.days;
      busy(taster, true); setStatus(taster, '');
      post('/api/tasters', d).then(function (r) {
        var p = Y.getProgramme(d.programmeId);
        replaceWith(taster, 'Taster Request Received',
          '<p>Thanks — we\'ve received your request for a free <strong>' + esc(p.name) + '</strong> taster on <strong>' + esc(d.day) + ' ' + esc(d.preferredDate) + '</strong>.</p>' +
          '<p style="margin-top:12px;">This is not yet a confirmed place. We\'ll contact you to confirm the date. Your reference is <strong>' + esc(r.reference) + '</strong>.</p>');
      }).catch(function (err) {
        busy(taster, false);
        setStatus(taster, failMsg(err), true);
        if (err.code === 'taster_already_used') {
          var st = taster.querySelector('.form-status');
          var a = document.createElement('a');
          a.href = 'book.html?mode=join#join'; a.setAttribute('data-mode', 'join');
          a.className = 'btn btn-primary'; a.style.marginTop = '12px'; a.style.display = 'inline-block';
          a.textContent = 'See membership options';
          st.appendChild(document.createElement('br')); st.appendChild(a);
        }
      });
    });
  }

  // ── Membership registration ──
  function money(p) { return '£' + (p / 100).toFixed(2); }
  function niceDate(iso, opts) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign({ weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }, opts || {}));
  }
  function monthName(key) { return new Date(key + '-01T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
  function quoteLines(lines) {
    return lines.map(function (l) {
      return '<li>' + esc(monthName(l.month)) + ': ' + (l.fullMonth ? 'full month' : esc(l.sessionsCovered + ' of ' + l.sessionsInMonth + ' sessions')) + ' — <strong>' + esc(money(l.amountPence)) + '</strong></li>';
    }).join('');
  }

  var reg = document.getElementById('register-form');
  if (reg) {
    var memBox = reg.querySelector('[data-ysp="membership-choices"]');
    var dayFs = reg.querySelector('[data-ysp="day-fieldset"]');
    var regDayBox = reg.querySelector('[data-ysp="day-choices"]');
    var startFs = reg.querySelector('[data-ysp="start-fieldset"]');
    var startSel = reg.querySelector('[data-ysp="start-date"]');
    var summary = reg.querySelector('[data-ysp="reg-summary"]');
    var dob = reg.querySelector('[name=childDob]');
    if (dob) dob.max = new Date().toISOString().slice(0, 10);
    var quoteSeq = 0;

    function selectedMembership() {
      var el = reg.querySelector('[name=membershipId]:checked');
      return el ? Y.getMembership(el.value) : null;
    }
    function chosenDays(p, m) {
      if (!p || !m) return [];
      return m.sessionsPerWeek === 2 ? Y.programmeDays(p.id) : Array.prototype.map.call(reg.querySelectorAll('[name=days]:checked'), function (x) { return x.value; });
    }
    function setSummary(html) { summary.innerHTML = '<h4>Your Membership</h4>' + html; }

    function updateSummary() {
      var p = selectedProgramme(reg), m = selectedMembership();
      if (!p || !m) { setSummary('<p>Choose a programme, membership and start date to see your payments.</p>'); return; }
      var days = chosenDays(p, m);
      var head = '<p><strong>' + esc(m.name) + '</strong> — ' + esc(Y.formatPrice(m.amountPence)) + ' per month</p>' +
        '<p>Session day(s): ' + esc(days.length ? days.join(' and ') : 'not chosen yet') + ' · ' + esc(Y.venue.short) + '</p>';
      if (!p.paidRegistrationOpen) {
        reg.querySelector('[type=submit]').textContent = 'Submit Registration';
        setSummary(head + '<p style="margin-top:8px;"><strong>Please note:</strong> places in ' + esc(p.name) + ' are being finalised. We\'ll save your registration and contact you to confirm before any payment is set up.</p>');
        return;
      }
      reg.querySelector('[type=submit]').textContent = 'Continue to Secure Direct Debit';
      if (!startSel.value) { setSummary(head + '<p>Choose a start date to see your first payments.</p>'); return; }
      var seq = ++quoteSeq;
      setSummary(head + '<p>Working out your payments…</p>');
      fetch('/api/registrations/quote?membershipId=' + encodeURIComponent(m.id) + '&days=' + encodeURIComponent(days.join(',')) + '&startDate=' + encodeURIComponent(startSel.value))
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'quote'); return j; }); })
        .then(function (q) {
          if (seq !== quoteSeq) return;
          var upfront = q.upfrontPence > 0
            ? '<p><strong>To pay by card now: ' + esc(money(q.upfrontPence)) + '</strong> for ' + esc(q.sessionsCovered) + ' session' + (q.sessionsCovered === 1 ? '' : 's') + ' before your first Direct Debit:</p><ul style="margin:6px 0 0 18px;">' + quoteLines(q.lines) + '</ul>'
            : '<p><strong>Nothing to pay by card</strong>' + (q.upfrontWaived ? ' (the small amount for your first sessions is waived)' : '') + '.</p>';
          setSummary(head +
            '<p>First session: <strong>' + esc(niceDate(q.startDate)) + '</strong></p>' + upfront +
            '<p style="margin-top:8px;">First Direct Debit: <strong>' + esc(money(q.monthlyPence)) + ' on ' + esc(niceDate(q.firstCollectionDate, { year: 'numeric' })) + '</strong>' + (q.firstCollectionEstimated ? ' (we\'ll confirm this once your Direct Debit is set up)' : '') + ', then ' + esc(money(q.monthlyPence)) + ' on the 1st of each month.</p>');
        })
        .catch(function () { if (seq === quoteSeq) setSummary(head + '<p>We couldn\'t work out your payments just now. You\'ll see them before you pay anything.</p>'); });
    }

    function loadStartDates() {
      var p = selectedProgramme(reg), m = selectedMembership();
      var days = chosenDays(p, m);
      if (!p || !m || !p.paidRegistrationOpen || (m.sessionsPerWeek === 1 && !days.length)) {
        startFs.hidden = true; startSel.innerHTML = ''; startSel.required = false; updateSummary(); return;
      }
      startFs.hidden = false; startSel.required = true;
      startSel.innerHTML = '<option value="">Loading dates…</option>';
      fetch('/api/registrations/start-dates?membershipId=' + encodeURIComponent(m.id) + '&days=' + encodeURIComponent(days.join(',')))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var dates = (d && d.dates) || [];
          startSel.innerHTML = dates.length
            ? dates.map(function (x) { return '<option value="' + esc(x) + '">' + esc(niceDate(x)) + '</option>'; }).join('')
            : '<option value="">No sessions available in the next few weeks — please contact us</option>';
          updateSummary();
        })
        .catch(function () { startSel.innerHTML = '<option value="">Couldn\'t load dates — please try again</option>'; updateSummary(); });
    }

    function renderMemberships() {
      var p = selectedProgramme(reg);
      if (!p) return;
      memBox.innerHTML = Y.memberships.filter(function (m) { return m.programmeId === p.id; }).map(function (m) {
        return '<label class="choice"><input type="radio" name="membershipId" value="' + esc(m.id) + '" required />' +
          '<strong>' + esc(Y.formatPrice(m.amountPence)) + '/month</strong><span>' + esc(m.sessionsPerWeek === 1 ? 'One weekly session — ' : 'Two weekly sessions — ') + esc(m.daysLabel) + '</span></label>';
      }).join('');
      var pre = params.get('membership');
      var inp = pre && memBox.querySelector('input[value="' + pre.replace(/[^a-z0-9-]/g, '') + '"]');
      if (inp) inp.checked = true;
      renderDayPicker();
    }
    function renderDayPicker() {
      var p = selectedProgramme(reg), m = selectedMembership();
      if (!p || !m || m.sessionsPerWeek === 2) { dayFs.hidden = true; regDayBox.innerHTML = ''; loadStartDates(); return; }
      dayFs.hidden = false;
      renderDays(regDayBox, p, 'radio', null);
      loadStartDates();
    }
    renderProgrammeChoices(reg, renderMemberships);
    memBox.addEventListener('change', renderDayPicker);
    regDayBox.addEventListener('change', loadStartDates);
    startSel.addEventListener('change', updateSummary);

    // Lets the Book Now plan cards preselect a membership in this form.
    window.YSPSelectMembership = function (membershipId) {
      var m = Y.getMembership(membershipId);
      if (!m) return;
      var pInput = reg.querySelector('[name=programmeId][value="' + m.programmeId + '"]');
      if (pInput) pInput.checked = true;
      renderMemberships();
      var mInput = memBox.querySelector('[name=membershipId][value="' + m.id + '"]');
      if (mInput) mInput.checked = true;
      renderDayPicker();
      setStatus(reg, '');
    };

    reg.addEventListener('submit', function (e) {
      e.preventDefault();
      var p = selectedProgramme(reg), m = selectedMembership();
      if (!p) { setStatus(reg, 'Please choose a programme.', true); return; }
      if (!m) { setStatus(reg, 'Please choose a membership.', true); return; }
      if (!checkValidity(reg)) return;
      var d = formData(reg);
      if (m.sessionsPerWeek === 2) d.days = Y.programmeDays(p.id);
      var err = Y.validateMembershipDays(m.id, d.days || []);
      if (err) { setStatus(reg, err, true); return; }
      busy(reg, true, 'Please wait…'); setStatus(reg, '');
      post('/api/registrations', d).then(function (r) {
        if (r.authorisationUrl) {
          setStatus(reg, 'Taking you to GoCardless to set up your Direct Debit…');
          window.location.assign(r.authorisationUrl);
          return;
        }
        replaceWith(reg, 'Registration Received',
          '<p>' + esc(r.message) + '</p><p style="margin-top:12px;">Your reference is <strong>' + esc(r.reference) + '</strong>. No payment has been taken.</p>');
      }).catch(function (err2) { busy(reg, false); setStatus(reg, failMsg(err2), true); });
    });
  }

  // ── Return from GoCardless / Stripe: registration status ──
  var statusBox = document.getElementById('registration-status');
  if (statusBox) {
    var ref = params.get('ref');
    var polls = 0;
    var tick = function (ok) { return ok ? '<span aria-hidden="true">✅</span> ' : '<span aria-hidden="true">⏳</span> '; };
    function details(s) {
      return '<ul class="status-details" style="margin:16px 0 0 18px;font-size:0.92rem;">' +
        '<li>Player: <strong>' + esc(s.childName) + '</strong></li>' +
        '<li>' + esc(s.programme) + ': ' + esc(s.times.join(' and ')) + ', ' + esc(s.venue) + '</li>' +
        '<li>Membership: ' + esc(s.membership) + ' — ' + esc(money(s.monthlyPence)) + ' a month</li>' +
        (s.startDate ? '<li>First session: ' + esc(niceDate(s.startDate)) + '</li>' : '') +
        (s.firstCollectionDate ? '<li>First Direct Debit: ' + esc(money(s.monthlyPence)) + ' on ' + esc(niceDate(s.firstCollectionDate, { year: 'numeric' })) + ', then on the 1st of each month</li>' : '') +
        '<li>Reference: ' + esc(s.reference) + '</li></ul>';
    }
    function button(label, onClick) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-primary'; b.style.marginTop = '20px'; b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }
    function goTo(path, b, wait) {
      b.disabled = true; b.textContent = wait;
      post(path, { ref: ref }).then(function (r) {
        if (r.url) { window.location.assign(r.url); return; }
        load();
      }).catch(function (err) { b.disabled = false; b.textContent = 'Try again'; alert(failMsg(err)); });
    }
    function render(s) {
      var html, action = null;
      if (s.stage === 'active') {
        html = '<div style="font-size:3rem;margin-bottom:12px;" aria-hidden="true">✅</div><h3>Membership Confirmed</h3>' +
          '<p>' + esc(s.childName) + '\'s place is confirmed and a confirmation email is on its way.</p>' +
          '<p style="margin-top:8px;">' + (s.upfrontStatus === 'paid' ? tick(true) + 'First payment of ' + esc(money(s.upfrontPence)) + ' received by card.' : tick(true) + 'No card payment was needed.') + '</p>' +
          '<p>' + tick(true) + 'Direct Debit set up. Your first collection is scheduled, not taken yet; GoCardless will email you before each one.</p>' + details(s);
      } else if (s.stage === 'payment_due') {
        var paidReturn = params.get('paid') === '1' && polls < 10;
        html = '<h3>' + (paidReturn ? 'Confirming Your Payment…' : 'One Last Step: Your First Payment') + '</h3>' +
          '<p>' + tick(true) + 'Direct Debit set up. No money has been taken by Direct Debit yet.</p>' +
          (params.get('cancelled') === '1' ? '<p style="margin-top:8px;"><strong>Your card payment wasn\'t completed.</strong> You can try again below.</p>' : '') +
          (s.upfrontError ? '<p style="margin-top:8px;"><strong>Your last card attempt didn\'t go through:</strong> ' + esc(s.upfrontError) + '</p>' : '') +
          '<p style="margin-top:12px;"><strong>' + esc(money(s.upfrontPence)) + '</strong> covers your sessions before the first Direct Debit:</p>' +
          '<ul style="margin:6px 0 0 18px;">' + quoteLines(s.upfrontLines) + '</ul>' + details(s) +
          (s.cardPaymentAvailable ? '' : '<p style="margin-top:12px;">Online card payment isn\'t available right now. We\'ll contact you to arrange this payment.</p>');
        if (s.cardPaymentAvailable && !paidReturn) action = button('Pay ' + money(s.upfrontPence) + ' securely by card', function () { goTo('/api/registrations/checkout', this, 'Opening secure payment…'); });
        if (paidReturn) { polls++; setTimeout(load, 3000); }
      } else if (s.stage === 'direct_debit_pending') {
        html = '<h3>Your Direct Debit Isn\'t Set Up Yet</h3><p>We saved your registration, but the Direct Debit wasn\'t completed. You can carry on where you left off.</p>' + details(s);
        action = button('Continue to Direct Debit set-up', function () { goTo('/api/registrations/resume', this, 'Opening GoCardless…'); });
        if (params.get('exit') !== '1' && polls < 5) { polls++; setTimeout(load, 3000); }
      } else if (s.stage === 'processing') {
        html = '<h3>Setting Up Your Membership…</h3><p>Your Direct Debit has been received. This usually takes a few seconds.</p>';
        if (polls < 20) { polls++; setTimeout(load, 3000); }
      } else if (s.stage === 'direct_debit_failed') {
        html = '<h3>Direct Debit Not Completed</h3><p>Your Direct Debit couldn\'t be set up, so your membership isn\'t active. Please email ' + esc(s.contact) + ' and we\'ll help.</p>';
      } else {
        html = '<h3>Registration Received</h3><p>We\'ve received your registration and will be in touch. Questions? ' + esc(s.contact) + '</p>';
      }
      statusBox.innerHTML = html;
      if (action) statusBox.appendChild(action);
    }
    function load() {
      fetch('/api/registrations/status?ref=' + encodeURIComponent(ref), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error();
        return r.json();
      }).then(render).catch(function () {
        statusBox.innerHTML = '<p>We couldn\'t load your registration just now. Please refresh this page in a moment. Questions? ' + esc(EMAIL) + '</p>';
      });
    }
    if (!ref) statusBox.innerHTML = '<p>We couldn\'t find a registration reference. Please check your email or contact ' + esc(EMAIL) + '.</p>';
    else load();
  }
})();
