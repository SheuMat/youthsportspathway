(function () {
  'use strict';
  var out = document.getElementById('out');
  var who = document.getElementById('who');
  var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var tab = 'submissions';

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k.slice(0, 2) === 'on') n[k] = attrs[k];
      else if (k === 'value') n.value = attrs[k];
      else if (k === 'checked') n.checked = Boolean(attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { if (k) n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return n;
  }
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || r.status); e.status = r.status; e.body = j; throw e; } return j; }); });
  }
  function field(label, input, hint) { return el('div', {}, [el('label', {}, [label]), input, hint ? el('div', { class: 'hint' }, [hint]) : null]); }
  function msg(cls, text) { return el('div', { class: cls, role: cls === 'err' ? 'alert' : 'status' }, [text]); }
  var pounds = function (p) { return (p / 100).toFixed(2); };
  function toPence(v) {
    var m = /^\s*£?\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(String(v));
    return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : NaN;
  }

  // ── Sign-in and first-time setup ──
  function showSetup() {
    who.textContent = '';
    out.innerHTML = '';
    var err = el('div');
    var token = el('input', { type: 'password', id: 'setup-token', autocomplete: 'off' });
    var name = el('input', { type: 'text', id: 'setup-name', autocomplete: 'name' });
    var email = el('input', { type: 'email', id: 'setup-email', autocomplete: 'username' });
    var pass = el('input', { type: 'password', id: 'setup-pass', autocomplete: 'new-password', minlength: '12' });
    var form = el('form', { class: 'card' }, [
      el('h2', {}, ['Set up your admin account']),
      el('p', {}, ['This is a one-time step. You need the ADMIN_TOKEN value from Vercel (Settings → Environment Variables).']),
      field('Setup token (ADMIN_TOKEN)', token),
      field('Your name', name),
      field('Email', email),
      field('New password', pass, 'At least 12 characters. Use a password manager.'),
      err,
      el('p', {}, [el('button', { type: 'submit', class: 'primary' }, ['Continue'])])
    ]);
    form.onsubmit = function (e) {
      e.preventDefault();
      err.innerHTML = '';
      api('POST', '/api/admin/auth/setup', { setupToken: token.value, name: name.value, email: email.value, password: pass.value })
        .then(function (r) { showSetupVerify(email.value, r); })
        .catch(function (e2) { err.appendChild(msg('err', e2.message)); });
    };
    out.appendChild(form);
  }

  function showSetupVerify(email, r) {
    out.innerHTML = '';
    var err = el('div');
    var code = el('input', { type: 'text', id: 'setup-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}' });
    var qr = el('div', { class: 'qr' });
    qr.innerHTML = r.qrSvg || '';
    var form = el('form', { class: 'card' }, [
      el('h2', {}, ['Two-step verification']),
      el('p', {}, ['Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator or 1Password), then enter the 6-digit code it shows.']),
      qr,
      el('p', { class: 'hint' }, ["Can't scan? Enter this key: ", el('code', {}, [r.secret])]),
      field('6-digit code', code),
      err,
      el('p', {}, [el('button', { type: 'submit', class: 'primary' }, ['Finish set-up'])])
    ]);
    form.onsubmit = function (e) {
      e.preventDefault();
      err.innerHTML = '';
      api('POST', '/api/admin/auth/setup/verify', { email: email, code: code.value.trim() }).then(start)
        .catch(function (e2) { err.appendChild(msg('err', e2.message)); });
    };
    out.appendChild(form);
    code.focus();
  }

  function showLogin(note) {
    who.textContent = '';
    out.innerHTML = '';
    var err = el('div');
    var email = el('input', { type: 'email', id: 'login-email', autocomplete: 'username' });
    var pass = el('input', { type: 'password', id: 'login-pass', autocomplete: 'current-password' });
    var code = el('input', { type: 'text', id: 'login-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });
    var form = el('form', { class: 'card' }, [
      el('h2', {}, ['Sign in']),
      note ? msg('err', note) : null,
      field('Email', email),
      field('Password', pass),
      field('Authenticator code', code, 'The 6-digit code from your authenticator app.'),
      err,
      el('p', {}, [el('button', { type: 'submit', class: 'primary' }, ['Sign in'])])
    ]);
    form.onsubmit = function (e) {
      e.preventDefault();
      err.innerHTML = '';
      api('POST', '/api/admin/auth/login', { email: email.value, password: pass.value, code: code.value.trim() }).then(start)
        .catch(function (e2) { err.appendChild(msg('err', e2.message)); code.value = ''; });
    };
    out.appendChild(form);
    email.focus();
  }

  function signOut() { api('POST', '/api/admin/auth/logout', {}).then(function () { showLogin(); }); }

  function start() {
    api('GET', '/api/admin/auth/state').then(function (s) {
      if (s.signedIn) {
        who.innerHTML = '';
        who.appendChild(el('span', {}, [(s.user.name || s.user.email) + ' ']));
        who.appendChild(el('button', { type: 'button', onclick: signOut }, ['Sign out']));
        return showDashboard();
      }
      if (s.setupRequired) return s.setupAllowed ? showSetup() : (out.textContent = 'Admin is not configured yet: add ADMIN_TOKEN in Vercel, redeploy, then reload this page.');
      showLogin();
    }).catch(function (e) { out.textContent = 'Error: ' + e.message; });
  }

  // ── Dashboard ──
  function showDashboard() {
    out.innerHTML = '';
    var tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Admin sections' });
    [['submissions', 'Submissions'], ['settings', 'Programmes & prices']].forEach(function (t) {
      tabs.appendChild(el('button', { type: 'button', 'aria-pressed': String(tab === t[0]), onclick: function () { tab = t[0]; showDashboard(); } }, [t[1]]));
    });
    var body = el('div');
    out.appendChild(tabs);
    out.appendChild(body);
    if (tab === 'settings') return loadSettings(body);
    api('GET', '/api/admin/overview').then(function (d) { renderSubmissions(body, d); })
      .catch(function (e) { if (e.status === 401) return showLogin('Your session has ended. Please sign in again.'); body.textContent = 'Error: ' + e.message; });
  }

  function act(method, url, body, confirmMsg) {
    return function () {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      api(method, url, body).then(showDashboard).catch(function (e) { alert(e.message); });
    };
  }
  function table(title, cols, rows, actions) {
    var head = el('tr', {}, cols.map(function (c) { return el('th', {}, [c[0]]); }).concat(actions ? [el('th', {}, ['Actions'])] : []));
    var body = rows.map(function (r) {
      return el('tr', {}, cols.map(function (c) { var v = r[c[1]]; return el('td', {}, [v == null ? '' : String(v)]); }).concat(actions ? [el('td', {}, actions(r))] : []));
    });
    return [el('h2', {}, [title + ' (' + rows.length + ')']), el('div', { class: 'wrap' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)])])];
  }
  function renderSubmissions(out, d) {
    var b = [];
    b.push('GoCardless: ' + (d.gocardless.enabled ? d.gocardless.environment.toUpperCase() : 'DISABLED') + (d.gocardless.problems.length ? ' — ' + d.gocardless.problems.join('; ') : ''));
    b.push('Email notifications: ' + (d.emailConfigured ? 'on' : 'OFF — check this page for new submissions'));
    window.YSP.programmes.forEach(function (p) { if (!p.paidRegistrationOpen) b.push(p.name + ': paid registration is closed (Programmes & prices tab)'); });
    b.forEach(function (t) { out.appendChild(el('div', { class: 'banner' }, [t])); });

    table('Taster requests', [['Ref', 'reference'], ['Status', 'status'], ['Programme', 'programme_id'], ['Day', 'day'], ['Date', 'preferred_date'], ['Child', 'child_name'], ['Age', 'child_age'], ['Parent', 'parent_name'], ['Email', 'parent_email'], ['Phone', 'parent_phone'], ['Repeat check', 'repeat_flag'], ['Photos', 'consent_photo'], ['Emergency', 'emergency_phone'], ['Notes', 'notes'], ['Marketing', 'marketing_consent']], d.tasters, function (r) {
      return [
        el('button', { onclick: act('POST', '/api/admin/tasters/' + r.id, { status: 'confirmed', notifyParent: true }, 'Confirm and email the parent?') }, ['Confirm']),
        el('button', { onclick: act('POST', '/api/admin/tasters/' + r.id, { status: 'declined', notifyParent: true }, 'Decline and email the parent?') }, ['Decline']),
        el('button', { onclick: act('POST', '/api/admin/tasters/' + r.id, { status: 'attended' }) }, ['Attended'])
      ];
    }).forEach(function (n) { out.appendChild(n); });

    table('Registrations', [['Ref', 'reference'], ['Registration', 'registration_status'], ['Mandate', 'mandate_status'], ['Subscription', 'subscription_status'], ['Last payment', 'payment_status'], ['Membership', 'membership_id'], ['Days', 'days'], ['Child', 'child_name'], ['Age', 'child_age'], ['Parent', 'parent_name'], ['Email', 'parent_email'], ['Phone', 'parent_phone'], ['Existing DD', 'existing_direct_debit'], ['Created', 'created_at']], d.registrations, function (r) {
      var a = [];
      if (r.gc_mandate_id && !r.gc_subscription_id && ['pending_submission', 'submitted', 'active'].indexOf(r.mandate_status) !== -1) {
        a.push(el('button', { onclick: act('POST', '/api/admin/registrations/' + r.id + '/subscribe', null, 'Create the monthly subscription in GoCardless?') }, ['Create subscription']));
      }
      if (r.gc_subscription_id && r.subscription_status === 'active') {
        a.push(el('button', { onclick: act('POST', '/api/admin/registrations/' + r.id + '/cancel', null, 'Cancel this subscription in GoCardless? This cannot be undone.') }, ['Cancel subscription']));
      }
      if (!r.gc_mandate_id) {
        a.push(el('button', { onclick: act('POST', '/api/admin/registrations/' + r.id + '/status', { status: 'rejected' }, 'Mark as rejected?') }, ['Reject']));
      }
      return a;
    }).forEach(function (n) { out.appendChild(n); });

    table('Payments', [['Payment', 'gc_payment_id'], ['Registration', 'registration_id'], ['Amount (p)', 'amount_pence'], ['Charge date', 'charge_date'], ['Status', 'status'], ['Updated', 'updated_at']], d.payments).forEach(function (n) { out.appendChild(n); });
    table('Enquiries', [['Ref', 'reference'], ['Type', 'type'], ['Name', 'first_name'], ['Surname', 'last_name'], ['Email', 'email'], ['Phone', 'phone'], ['Message', 'message'], ['Marketing', 'marketing_consent'], ['Received', 'created_at']], d.enquiries).forEach(function (n) { out.appendChild(n); });
  }

  // ── Programmes & prices ──
  function loadSettings(body) {
    api('GET', '/api/admin/settings').then(function (r) { renderSettings(body, r.settings); })
      .catch(function (e) { if (e.status === 401) return showLogin('Your session has ended. Please sign in again.'); body.textContent = 'Error: ' + e.message; });
  }

  function renderSettings(body, s) {
    body.innerHTML = '';
    var status = el('div', { 'aria-live': 'polite' });
    var read = [];

    s.programmes.forEach(function (p) {
      var f = {
        name: el('input', { type: 'text', value: p.name, maxlength: '80' }),
        ages: el('input', { type: 'text', value: p.ages, maxlength: '20' }),
        minAge: el('input', { type: 'number', value: p.minAge, min: '3', max: '18' }),
        maxAge: el('input', { type: 'number', value: p.maxAge, min: '3', max: '18' }),
        description: el('textarea', { maxlength: '1000' }, [p.description || '']),
        note: el('input', { type: 'text', value: p.note || '', maxlength: '300' }),
        taster: el('input', { type: 'checkbox', checked: p.tasterAvailable }),
        open: el('input', { type: 'checkbox', checked: p.paidRegistrationOpen })
      };
      var sessions = p.sessions.map(function (x) {
        return {
          day: el('select', {}, WEEKDAYS.map(function (d) { var o = el('option', { value: d }, [d]); if (d === x.day) o.selected = true; return o; })),
          start: el('input', { type: 'time', value: x.start }),
          end: el('input', { type: 'time', value: x.end }),
          capacity: el('input', { type: 'number', min: '1', max: '200', value: x.capacity == null ? '' : x.capacity, placeholder: 'No limit' })
        };
      });
      body.appendChild(el('div', { class: 'card wide' }, [
        el('h2', { style: 'margin-top:0' }, [p.name]),
        el('div', { class: 'grid' }, [field('Programme name', f.name), field('Ages (as shown)', f.ages), field('Minimum age', f.minAge), field('Maximum age', f.maxAge)]),
        field('Description', f.description),
        field('Note (optional)', f.note),
        el('label', {}, [f.taster, ' Free tasters available']),
        el('label', {}, [f.open, ' Online paid registration open']),
        el('div', { class: 'wrap' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, ['Session', 'Day', 'Start', 'End', 'Capacity'].map(function (h) { return el('th', {}, [h]); }))]),
          el('tbody', {}, sessions.map(function (x, i) {
            return el('tr', {}, [el('td', {}, [String(i + 1)]), el('td', {}, [x.day]), el('td', {}, [x.start]), el('td', {}, [x.end]), el('td', {}, [x.capacity])]);
          }))
        ])]),
        el('div', { class: 'hint' }, ['Leave capacity blank for no limit. Changing days or times updates the website timetable.'])
      ]));
      read.push(function (o) {
        o.programmes.push({
          id: p.id, name: f.name.value, ages: f.ages.value, minAge: Number(f.minAge.value), maxAge: Number(f.maxAge.value),
          description: f.description.value, note: f.note.value, tasterAvailable: f.taster.checked, paidRegistrationOpen: f.open.checked,
          sessions: sessions.map(function (x) { return { day: x.day.value, start: x.start.value, end: x.end.value, capacity: x.capacity.value === '' ? null : Number(x.capacity.value) }; })
        });
      });
    });

    var prices = s.memberships.map(function (m) {
      return { m: m, name: el('input', { type: 'text', value: m.name, maxlength: '80' }), price: el('input', { type: 'text', inputmode: 'decimal', value: pounds(m.amountPence), size: '8' }) };
    });
    body.appendChild(el('div', { class: 'card wide' }, [
      el('h2', { style: 'margin-top:0' }, ['Membership prices']),
      el('div', { class: 'wrap' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, ['Membership', 'Sessions', 'Monthly price (£)'].map(function (h) { return el('th', {}, [h]); }))]),
        el('tbody', {}, prices.map(function (x) { return el('tr', {}, [el('td', {}, [x.name]), el('td', {}, [x.m.daysLabel]), el('td', {}, [x.price])]); }))
      ])]),
      el('div', { class: 'hint' }, ['New prices apply to new registrations. Updating existing members’ Direct Debits comes in a later stage.'])
    ]));
    read.push(function (o) { o.memberships = prices.map(function (x) { return { id: x.m.id, name: x.name.value, amountPence: toPence(x.price.value) }; }); });

    var closureRows = el('tbody');
    var closures = [];
    function addClosure(c) {
      c = c || {};
      var r = {
        from: el('input', { type: 'date', value: c.from || '' }),
        to: el('input', { type: 'date', value: c.to || '' }),
        programme: el('select', {}, [el('option', { value: '' }, ['All programmes'])].concat(s.programmes.map(function (p) { var o = el('option', { value: p.id }, [p.name]); if (p.id === c.programmeId) o.selected = true; return o; }))),
        day: el('select', {}, [el('option', { value: '' }, ['Any day'])].concat(WEEKDAYS.map(function (d) { var o = el('option', { value: d }, [d]); if (d === c.day) o.selected = true; return o; }))),
        reason: el('input', { type: 'text', value: c.reason || '', maxlength: '100', placeholder: 'e.g. Christmas' })
      };
      var tr = el('tr', {}, [el('td', {}, [r.from]), el('td', {}, [r.to]), el('td', {}, [r.programme]), el('td', {}, [r.day]), el('td', {}, [r.reason]),
        el('td', {}, [el('button', { type: 'button', onclick: function () { closures.splice(closures.indexOf(r), 1); tr.remove(); } }, ['Remove'])])]);
      closures.push(r);
      closureRows.appendChild(tr);
    }
    (s.closures || []).forEach(addClosure);
    body.appendChild(el('div', { class: 'card wide' }, [
      el('h2', { style: 'margin-top:0' }, ['Closures']),
      el('p', { class: 'hint' }, ['Dates with no sessions. They are left out of start dates and part-month calculations. For a single day, use the same date in both boxes.']),
      el('div', { class: 'wrap' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, ['From', 'To', 'Programme', 'Day', 'Reason', ''].map(function (h) { return el('th', {}, [h]); }))]),
        closureRows
      ])]),
      el('p', {}, [el('button', { type: 'button', onclick: function () { addClosure(); } }, ['Add closure'])])
    ]));
    read.push(function (o) {
      o.closures = closures.map(function (r) { return { from: r.from.value, to: r.to.value || r.from.value, programmeId: r.programme.value, day: r.day.value, reason: r.reason.value }; });
    });

    var rules = s.billingRules;
    var lead = el('input', { type: 'number', min: '3', max: '15', value: rules.estimateLeadWorkingDays });
    var minCharge = el('input', { type: 'text', inputmode: 'decimal', value: pounds(rules.minimumCardChargePence), size: '8' });
    var windowDays = el('input', { type: 'number', min: '7', max: '60', value: rules.startWindowDays });
    body.appendChild(el('div', { class: 'card wide' }, [
      el('h2', { style: 'margin-top:0' }, ['Billing rules']),
      el('p', {}, ['Monthly Direct Debits are collected on the 1st of each month.']),
      el('div', { class: 'grid' }, [
        field('Direct Debit lead time (working days)', lead, 'Used for the estimate shown before the Direct Debit is set up. The real date always comes from GoCardless.'),
        field('Smallest card payment (£)', minCharge, 'Upfront amounts below this are waived.'),
        field('Start date window (days)', windowDays, 'How far ahead parents can choose a start date.')
      ])
    ]));
    read.push(function (o) {
      o.billingRules = { estimateLeadWorkingDays: Number(lead.value), minimumCardChargePence: toPence(minCharge.value), startWindowDays: Number(windowDays.value) };
    });

    var save = el('button', { type: 'button', class: 'primary' }, ['Save changes']);
    save.onclick = function () {
      var o = { programmes: [] };
      read.forEach(function (fn) { fn(o); });
      status.innerHTML = '';
      save.disabled = true;
      api('PUT', '/api/admin/settings', { settings: o }).then(function (r) {
        window.YSP.applySettings(r.settings);
        renderSettings(body, r.settings);
        body.insertBefore(msg('ok', 'Saved. The website shows the changes within a couple of minutes.'), body.firstChild);
      }).catch(function (e) {
        save.disabled = false;
        var list = (e.body && e.body.errors) || [e.message];
        status.appendChild(el('div', { class: 'err', role: 'alert' }, [el('p', {}, ['Not saved:']), el('ul', {}, list.map(function (t) { return el('li', {}, [t]); }))]));
      });
    };
    body.appendChild(status);
    body.appendChild(el('p', {}, [save]));
  }

  start();
})();
