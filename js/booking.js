(function () {
  const plansEl = document.getElementById('plans');
  const monthsEl = document.getElementById('months');
  const form = document.getElementById('booking-form');
  if (!plansEl || !form) return;

  const state = { data: null, plan: null, filter: 'both' };
  const money = (p) => '£' + (p / 100).toFixed(p % 100 ? 2 : 0);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const toDate = (iso) => new Date(iso + 'T12:00:00Z');

  async function load() {
    try {
      const res = await fetch('/api/schedule', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state.data = await res.json();
      renderPlans();
      renderPaymentDays();
      renderMonths();
    } catch {
      plansEl.innerHTML = '<p class="booking-loading">Sorry, booking is unavailable right now. Please <a href="contact.html">contact us</a>.</p>';
    }
  }

  function renderPlans() {
    const { plans, slots, time } = state.data;
    plansEl.innerHTML = plans.map((p) => {
      const places = p.slots.map((s) => `<div class="session-detail"><span class="session-detail-icon">👥</span><span>${esc(slots[s].label)}: ${slots[s].remaining} of ${slots[s].capacity} places left</span></div>`).join('');
      const days = p.slots.map((s) => slots[s].label + 's').join(' and ');
      return `<div class="session-card plan-card${p.available ? '' : ' is-full'}" data-plan="${p.code}">
        <div class="session-card-header"><h3>${esc(p.label)}</h3>${p.available ? '' : '<span class="session-badge">Full</span>'}</div>
        <div class="session-card-body">
          <div class="session-detail"><span class="session-detail-icon">📅</span><span>${esc(days)}</span></div>
          <div class="session-detail"><span class="session-detail-icon">🕔</span><span>${esc(time)}</span></div>
          <div class="session-detail"><span class="session-detail-icon">📍</span><span>Ecclesfield School, Chapeltown</span></div>
          ${places}
        </div>
        <div class="session-card-footer">
          <div class="session-price">${money(p.pricePence)} <small>/ month</small></div>
          <button type="button" class="btn ${p.available ? 'btn-primary' : 'btn-outline-dark'} plan-btn" aria-pressed="false" ${p.available ? '' : 'disabled aria-disabled="true"'}
            aria-label="${esc(p.label + ', ' + money(p.pricePence) + ' a month' + (p.available ? '' : ', full'))}">${p.available ? 'Choose' : 'Full'}</button>
        </div>
      </div>`;
    }).join('');
    plansEl.querySelectorAll('.plan-btn:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => selectPlan(btn.closest('.plan-card').dataset.plan));
    });
    if (state.plan && !plans.find((p) => p.code === state.plan)?.available) state.plan = null;
    if (state.plan) selectPlan(state.plan, false);
  }

  function selectPlan(code, scroll = true) {
    state.plan = code;
    const plan = state.data.plans.find((p) => p.code === code);
    plansEl.querySelectorAll('.plan-card').forEach((card) => {
      const on = card.dataset.plan === code;
      card.classList.toggle('is-selected', on);
      const btn = card.querySelector('.plan-btn');
      if (!btn.disabled) { btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? 'Selected ✓' : 'Choose'; }
    });
    document.getElementById('plan-summary').innerHTML =
      `<strong>${esc(plan.label)}</strong>: ${money(plan.pricePence)} a month by Direct Debit. <button type="button" class="link-btn" id="change-plan">Change</button>`;
    document.getElementById('change-plan').addEventListener('click', () => plansEl.querySelector('.plan-btn:not([disabled])').focus());
    document.getElementById('plans-status').textContent = `${plan.label} selected.`;
    clearError('plan');
    if (scroll) document.getElementById('plan-summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderPaymentDays() {
    document.getElementById('payment-days').innerHTML = state.data.paymentDays.map((d) =>
      `<label class="radio-pill"><input type="radio" name="paymentDay" value="${d.code}" required /> <span>${esc(d.label)}</span></label>`).join('');
  }

  function renderMonths() {
    const { sessions, slots } = state.data;
    const shown = sessions.filter((s) => state.filter === 'both' || s.slot === state.filter);
    const groups = new Map();
    for (const s of shown) {
      const key = s.date.slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    if (!groups.size) { monthsEl.innerHTML = '<p>No upcoming sessions.</p>'; return; }
    const nowKey = new Date().toISOString().slice(0, 7);
    const openKey = groups.has(nowKey) ? nowKey : groups.keys().next().value;
    monthsEl.innerHTML = [...groups].map(([key, list]) => {
      const title = toDate(key + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const items = list.map((s) => {
        const d = toDate(s.date);
        return `<li class="date-card"><span class="date-day">${esc(slots[s.slot].label)}</span>
          <span class="date-num">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span>
          <span class="date-time">5:00pm to 6:00pm</span></li>`;
      }).join('');
      return `<details class="month"${key === openKey ? ' open' : ''}><summary>${esc(title)} <span class="month-count">${list.length} session${list.length === 1 ? '' : 's'}</span></summary><ul class="date-list">${items}</ul></details>`;
    }).join('');
  }

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      if (state.data) renderMonths();
    });
  });

  const LABELS = {
    plan: 'Plan', paymentDay: 'Payment day', parentName: 'Parent or guardian name', email: 'Email', phone: 'Phone',
    childName: "Child's full name", childDob: "Child's date of birth", emergencyName: 'Emergency contact name',
    emergencyPhone: 'Emergency contact number', terms: 'Terms',
  };

  function clearError(name) {
    const el = document.getElementById(name + '-error');
    if (el) el.textContent = '';
    const input = form.elements[name];
    if (input && input.setAttribute) input.removeAttribute('aria-invalid');
  }

  function showErrors(errors) {
    const summary = document.getElementById('error-summary');
    Object.keys(LABELS).forEach(clearError);
    const entries = Object.entries(errors);
    if (!entries.length) { summary.hidden = true; return; }
    summary.querySelector('ul').innerHTML = entries.map(([name, msg]) => {
      const target = name === 'plan' ? 'plans' : name === 'paymentDay' ? 'paymentDay-group' : name;
      return `<li><a href="#${target}">${esc(msg)}</a></li>`;
    }).join('');
    for (const [name, msg] of entries) {
      const el = document.getElementById(name + '-error');
      if (el) el.textContent = msg;
      const input = form.elements[name];
      if (input && input.setAttribute) input.setAttribute('aria-invalid', 'true');
    }
    summary.hidden = false;
    summary.focus();
  }

  function collect() {
    const f = form.elements;
    return {
      plan: state.plan || '',
      paymentDay: (form.querySelector('input[name="paymentDay"]:checked') || {}).value || '',
      parentName: f.parentName.value, email: f.email.value, phone: f.phone.value,
      childName: f.childName.value, childDob: f.childDob.value,
      emergencyName: f.emergencyName.value, emergencyPhone: f.emergencyPhone.value,
      medical: f.medical.value, terms: f.terms.checked, photoConsent: f.photoConsent.checked,
    };
  }

  function clientErrors(d) {
    const e = {};
    if (!d.plan) e.plan = 'Choose a plan.';
    if (!d.paymentDay) e.paymentDay = 'Choose when you would like to pay each month.';
    if (d.parentName.trim().length < 2) e.parentName = 'Enter the parent or guardian’s full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = 'Enter a valid email address.';
    if (d.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a valid phone number.';
    if (d.childName.trim().length < 2) e.childName = 'Enter the child’s full name.';
    if (!d.childDob) e.childDob = 'Enter the child’s date of birth.';
    if (d.emergencyName.trim().length < 2) e.emergencyName = 'Enter an emergency contact name.';
    if (d.emergencyPhone.replace(/\D/g, '').length < 10) e.emergencyPhone = 'Enter a valid emergency contact number.';
    if (!d.terms) e.terms = 'You must agree to the terms to continue.';
    return e;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = collect();
    const errs = clientErrors(data);
    showErrors(errs);
    if (Object.keys(errs).length) return;

    const btn = document.getElementById('submit-btn');
    const status = document.getElementById('form-status');
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    status.textContent = 'Reserving your place…';
    try {
      const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.redirectUrl) {
        status.textContent = 'Taking you to GoCardless…';
        window.location.href = body.redirectUrl;
        return;
      }
      if (body.errors) {
        showErrors(body.errors);
        if (res.status === 409) load();
      }
      status.textContent = body.error || '';
    } catch {
      status.textContent = 'Something went wrong. Please check your connection and try again.';
    }
    btn.disabled = false;
    btn.textContent = 'Continue to Direct Debit set-up';
  });

  load();
})();
