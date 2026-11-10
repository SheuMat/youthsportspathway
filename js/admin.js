(function () {
  'use strict';
  var out = document.getElementById('out');
  var token = '';
  try { token = sessionStorage.getItem('ysp-admin') || ''; } catch (e) {}

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'onclick') n.onclick = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return n;
  }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function act(method, url, body, confirmMsg) {
    return function () {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      api(method, url, body).then(load).catch(function (e) { alert(e.message); });
    };
  }
  function table(title, cols, rows, actions) {
    var head = el('tr', {}, cols.map(function (c) { return el('th', {}, [c[0]]); }).concat(actions ? [el('th', {}, ['Actions'])] : []));
    var body = rows.map(function (r) {
      return el('tr', {}, cols.map(function (c) { var v = r[c[1]]; return el('td', {}, [v == null ? '' : String(v)]); }).concat(actions ? [el('td', {}, actions(r))] : []));
    });
    return [el('h2', {}, [title + ' (' + rows.length + ')']), el('div', { class: 'wrap' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)])])];
  }
  function render(d) {
    out.innerHTML = '';
    var b = [];
    b.push('GoCardless: ' + (d.gocardless.enabled ? d.gocardless.environment.toUpperCase() : 'DISABLED') + (d.gocardless.problems.length ? ' — ' + d.gocardless.problems.join('; ') : ''));
    b.push('Auto-create subscriptions: ' + d.billing.autoCreateSubscriptions + ' · Collection day: ' + (d.billing.dayOfMonth == null ? 'GoCardless default' : d.billing.dayOfMonth));
    b.push('Email notifications: ' + (d.emailConfigured ? 'on' : 'OFF — check this page for new submissions'));
    window.YSP.programmes.forEach(function (p) { if (!p.paidRegistrationOpen) b.push(p.name + ': paid registration ON HOLD pending operational approval (js/site-data.js)'); });
    b.forEach(function (t) { out.appendChild(el('div', { class: 'banner' }, [t])); });

    table('Taster requests', [['Ref', 'reference'], ['Status', 'status'], ['Programme', 'programme_id'], ['Day', 'day'], ['Date', 'preferred_date'], ['Child', 'child_name'], ['Age', 'child_age'], ['Parent', 'parent_name'], ['Email', 'parent_email'], ['Phone', 'parent_phone'], ['Notes', 'notes'], ['Marketing', 'marketing_consent']], d.tasters, function (r) {
      return [
        el('button', { onclick: act('POST', '/api/admin/tasters/' + r.id, { status: 'confirmed', notifyParent: true }, 'Confirm and email the parent?') }, ['Confirm']),
        el('button', { onclick: act('POST', '/api/admin/tasters/' + r.id, { status: 'declined', notifyParent: true }, 'Decline and email the parent?') }, ['Decline']),
        el('button', { onclick: act('POST', '/api/admin/tasters/' + r.id, { status: 'attended' }) }, ['Attended'])
      ];
    }).forEach(function (n) { out.appendChild(n); });

    table('Registrations', [['Ref', 'reference'], ['Registration', 'registration_status'], ['Mandate', 'mandate_status'], ['Subscription', 'subscription_status'], ['Last payment', 'payment_status'], ['Membership', 'membership_id'], ['Days', 'days'], ['Child', 'child_name'], ['Age', 'child_age'], ['Parent', 'parent_name'], ['Email', 'parent_email'], ['Phone', 'parent_phone'], ['Existing DD', 'existing_direct_debit'], ['Created', 'created_at']], d.registrations, function (r) {
      var a = [];
      if (r.gc_mandate_id && !r.gc_subscription_id && ['pending_submission', 'submitted', 'active'].indexOf(r.mandate_status) !== -1) {
        a.push(el('button', { onclick: act('POST', '/api/admin/registrations/' + r.id + '/subscribe', null, 'Create the monthly subscription in GoCardless? Only do this once billing terms are agreed.') }, ['Create subscription']));
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
  function load() {
    if (!token) return;
    api('GET', '/api/admin/overview').then(render).catch(function (e) { out.textContent = 'Error: ' + e.message; });
  }
  document.getElementById('login').addEventListener('submit', function (e) {
    e.preventDefault();
    token = document.getElementById('tok').value.trim();
    try { sessionStorage.setItem('ysp-admin', token); } catch (err) {}
    load();
  });
  load();
})();
