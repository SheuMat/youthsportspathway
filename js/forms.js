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
          e.fields = j.fields; throw e;
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
      }).catch(function (err) { busy(taster, false); setStatus(taster, failMsg(err), true); });
    });
  }

  // ── Membership registration ──
  var reg = document.getElementById('register-form');
  if (reg) {
    var memBox = reg.querySelector('[data-ysp="membership-choices"]');
    var dayFs = reg.querySelector('[data-ysp="day-fieldset"]');
    var regDayBox = reg.querySelector('[data-ysp="day-choices"]');
    var summary = reg.querySelector('[data-ysp="reg-summary"]');
    var regAge = reg.querySelector('[name=childAge]');

    function selectedMembership() {
      var el = reg.querySelector('[name=membershipId]:checked');
      return el ? Y.getMembership(el.value) : null;
    }
    function updateSummary() {
      var p = selectedProgramme(reg), m = selectedMembership();
      if (!p || !m) { summary.innerHTML = '<h4>Your Membership</h4><p>Choose a programme and membership to see your monthly price.</p>'; return; }
      var days = m.sessionsPerWeek === 2 ? Y.programmeDays(p.id) : Array.prototype.map.call(reg.querySelectorAll('[name=days]:checked'), function (x) { return x.value; });
      summary.innerHTML = '<h4>Your Membership</h4>' +
        '<p><strong>' + esc(m.name) + '</strong> — ' + esc(Y.formatPrice(m.amountPence)) + ' per month</p>' +
        '<p>Session day(s): ' + esc(days.length ? days.join(' and ') : 'not chosen yet') + ' · ' + esc(Y.venue.short) + '</p>' +
        (p.paidRegistrationOpen ? '' : '<p style="margin-top:8px;"><strong>Please note:</strong> places in ' + esc(p.name) + ' are being finalised. We\'ll save your registration and contact you to confirm before any Direct Debit is set up.</p>');
      reg.querySelector('[type=submit]').textContent = p.paidRegistrationOpen ? 'Continue to Secure Direct Debit' : 'Submit Registration';
    }
    function renderMemberships() {
      var p = selectedProgramme(reg);
      if (!p) return;
      regAge.min = p.minAge; regAge.max = p.maxAge;
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
      if (!p || !m || m.sessionsPerWeek === 2) { dayFs.hidden = true; regDayBox.innerHTML = ''; updateSummary(); return; }
      dayFs.hidden = false;
      renderDays(regDayBox, p, 'radio', null);
      updateSummary();
    }
    renderProgrammeChoices(reg, renderMemberships);
    memBox.addEventListener('change', renderDayPicker);
    regDayBox.addEventListener('change', updateSummary);

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
          setStatus(reg, 'Taking you to GoCardless to authorise your Direct Debit…');
          window.location.assign(r.authorisationUrl);
          return;
        }
        replaceWith(reg, 'Registration Received',
          '<p>' + esc(r.message) + '</p><p style="margin-top:12px;">Your reference is <strong>' + esc(r.reference) + '</strong>. No payment has been taken.</p>');
      }).catch(function (err2) { busy(reg, false); setStatus(reg, failMsg(err2), true); });
    });
  }

  // ── Return from GoCardless ──
  var statusBox = document.getElementById('registration-status');
  if (statusBox) {
    var ref = params.get('ref');
    if (!ref) {
      statusBox.innerHTML = '<p>We couldn\'t find a registration reference. If you\'ve just set up a Direct Debit, please check your email or contact ' + esc(EMAIL) + '.</p>';
    } else {
      fetch('/api/registrations/status?ref=' + encodeURIComponent(ref)).then(function (r) {
        if (!r.ok) throw new Error();
        return r.json();
      }).then(function (s) {
        statusBox.innerHTML = '<div style="font-size:3rem;margin-bottom:16px;" aria-hidden="true">✅</div>' +
          '<h3>' + esc(s.headline) + '</h3><p>' + esc(s.message) + '</p>' +
          '<p style="margin-top:16px;font-size:0.9rem;">Membership: <strong>' + esc(s.membership) + '</strong> · Reference: <strong>' + esc(s.reference) + '</strong></p>' +
          '<p style="margin-top:8px;font-size:0.85rem;opacity:0.75;">Direct Debit status: ' + esc(s.mandateStatus) + ' · Payment status: ' + esc(s.paymentStatus) + '</p>';
      }).catch(function () {
        statusBox.innerHTML = '<p>We couldn\'t load your registration status just now. If you completed the Direct Debit form, it has been received — we\'ll email you. Questions? ' + esc(EMAIL) + '</p>';
      });
    }
  }
})();
