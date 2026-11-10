// Book Now page: choose "free taster" or "join & pay monthly", pick a plan, show the right form.
(function () {
  'use strict';
  var Y = window.YSP;
  if (!Y) return;
  var params = new URLSearchParams(location.search);
  var panels = { taster: document.querySelector('[data-panel="taster"]'), join: document.querySelector('[data-panel="join"]') };
  var joinForm = document.querySelector('[data-join-form]');
  var chosen = document.querySelector('[data-ysp="plan-chosen"]');
  var plansBox = document.querySelector('[data-ysp="plans"]');
  if (!panels.taster || !panels.join) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Plan cards, built from the shared programme data ──
  plansBox.innerHTML = Y.programmes.map(function (p) {
    var options = Y.memberships.filter(function (m) { return m.programmeId === p.id; }).map(function (m) {
      var days = m.sessionsPerWeek === 1
        ? p.sessions.map(function (s) { return s.day; }).join(' or ')
        : p.sessions.map(function (s) { return s.day; }).join(' & ');
      return '' +
        '<button type="button" class="plan-option" data-membership="' + esc(m.id) + '" aria-pressed="false">' +
          '<span class="plan-option-sessions">' + (m.sessionsPerWeek === 1 ? '1 session a week' : '2 sessions a week') + '</span>' +
          '<span class="plan-option-price">' + esc(Y.formatPrice(m.amountPence)) + '<small>/month</small></span>' +
          '<span class="plan-option-days">' + esc(days) + '</span>' +
          (m.sessionsPerWeek === 2 ? '<span class="plan-option-badge">Best value</span>' : '') +
          '<span class="plan-option-cta">Choose</span>' +
        '</button>';
    }).join('');
    var times = p.sessions.map(function (s) { return esc(s.day) + ' ' + esc(s.time); }).join(' · ');
    return '' +
      '<article class="plan" id="plan-' + esc(p.id) + '">' +
        '<header class="plan-head">' +
          '<span class="plan-ages">Ages ' + esc(p.ages) + '</span>' +
          '<h3>' + esc(p.name) + '</h3>' +
          '<p>' + times + '<br>' + esc(Y.venue.short) + '</p>' +
        '</header>' +
        '<div class="plan-options">' + options + '</div>' +
        (p.paidRegistrationOpen ? '' : '<p class="plan-note">Places are being finalised — register now and we\'ll confirm before any payment is set up.</p>') +
      '</article>';
  }).join('');

  function scrollTo(el) {
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.pageYOffset - 90;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }
  function setUrl(mode, membership) {
    var q = new URLSearchParams(location.search);
    q.set('mode', mode);
    if (membership) q.set('membership', membership); else q.delete('membership');
    if (mode === 'taster') q.delete('membership');
    history.replaceState(null, '', location.pathname + '?' + q.toString() + '#' + mode);
  }
  function showMode(mode, opts) {
    opts = opts || {};
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== mode; });
    document.querySelectorAll('.book-path').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-mode') === mode);
      a.setAttribute('aria-current', a.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    if (!opts.keepUrl) setUrl(mode, opts.membership);
    if (opts.scroll !== false) scrollTo(opts.target || panels[mode]);
  }
  function choosePlan(id, opts) {
    var m = Y.getMembership(id);
    if (!m) return;
    var p = Y.getProgramme(m.programmeId);
    plansBox.querySelectorAll('.plan-option').forEach(function (b) {
      var on = b.getAttribute('data-membership') === id;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    joinForm.hidden = false;
    if (window.YSPSelectMembership) window.YSPSelectMembership(id);
    chosen.innerHTML = 'You\'ve chosen <strong>' + esc(m.name) + '</strong> — ' + esc(Y.formatPrice(m.amountPence)) + '/month (' + esc(p.name) + ', ages ' + esc(p.ages) + '). <a href="#join" data-change-plan>Change</a>';
    showMode('join', { membership: id, target: joinForm, scroll: opts && opts.scroll === false ? false : true });
  }

  document.addEventListener('click', function (e) {
    var modeLink = e.target.closest('[data-mode]');
    if (modeLink) { e.preventDefault(); showMode(modeLink.getAttribute('data-mode')); return; }
    var plan = e.target.closest('.plan-option');
    if (plan) { choosePlan(plan.getAttribute('data-membership')); return; }
    if (e.target.closest('[data-change-plan]')) { e.preventDefault(); scrollTo(plansBox); }
  });

  // Keep the chosen-plan summary in step if the parent changes it inside the form.
  var reg = document.getElementById('register-form');
  if (reg) reg.addEventListener('change', function (e) {
    if (e.target.name === 'membershipId') choosePlan(e.target.value, { scroll: false });
  });

  // ── Initial state from the URL ──
  var mode = params.get('mode') || (location.hash === '#join' ? 'join' : location.hash === '#taster' ? 'taster' : '');
  var membership = params.get('membership');
  if (membership && Y.getMembership(membership)) {
    choosePlan(membership);
  } else if (mode === 'join') {
    var prog = params.get('programme');
    showMode('join', { keepUrl: true, target: prog ? document.getElementById('plan-' + prog.replace(/[^a-z]/g, '')) : panels.join });
  } else if (mode === 'taster' || params.get('programme') || params.get('day')) {
    showMode('taster', { keepUrl: !!mode });
  }
})();
