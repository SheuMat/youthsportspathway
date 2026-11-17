/*
 * YSP shared site data — the single source of truth for programmes, sessions,
 * membership products, partners and testimonials.
 *
 * Used by the browser (timetable, programme cards, booking forms) AND by the
 * server (validation, GoCardless amounts). Edit here, not in the HTML.
 */
(function (root) {
  'use strict';

  var VENUE = {
    name: 'Ecclesfield School',
    address: 'Chapeltown Road, Sheffield S35 9WD',
    short: 'Ecclesfield School, Sheffield S35 9WD'
  };

  var programmes = [
    {
      id: 'grassroots',
      name: 'Grassroots Basketball',
      ages: '5–10',
      minAge: 5,
      maxAge: 10,
      description: 'Our grassroots basketball sessions introduce young players to the game while developing their basketball skills, confidence and understanding in a positive, supportive environment. Sessions are suitable for beginners and developing players aged 5–10.',
      sessions: [
        { day: 'Monday', start: '17:00', end: '18:00', time: '5:00pm – 6:00pm', capacity: 25 },
        { day: 'Friday', start: '17:00', end: '18:00', time: '5:00pm – 6:00pm', capacity: 25 }
      ],
      tasterAvailable: true,
      // true = parents can set up Direct Debit online straight away.
      paidRegistrationOpen: true
    },
    {
      id: 'development',
      name: 'Development Basketball',
      ages: '11–15',
      minAge: 11,
      maxAge: 15,
      description: 'Our Development Basketball sessions are designed for young people aged 11–15 who want to improve their basketball skills, understanding and confidence. Sessions focus on individual development, decision-making, game situations and applying skills in competitive play.',
      note: 'Players with different levels of experience are welcome — you do not need to play for a club.',
      sessions: [
        // Capacity not yet confirmed by YSP (null = no limit enforced).
        { day: 'Thursday', start: '18:00', end: '19:00', time: '6:00pm – 7:00pm', capacity: null },
        { day: 'Friday', start: '18:00', end: '19:00', time: '6:00pm – 7:00pm', capacity: null }
      ],
      tasterAvailable: true,
      // Sessions confirmed by YSP (venue, coaching and capacity arrangements agreed).
      paidRegistrationOpen: true
    }
  ];

  // Four distinct membership products. A membership never spans programmes.
  var memberships = [
    { id: 'grassroots-1', programmeId: 'grassroots', sessionsPerWeek: 1, amountPence: 3000, name: 'Grassroots: One Weekly Session', daysLabel: 'Monday OR Friday' },
    { id: 'grassroots-2', programmeId: 'grassroots', sessionsPerWeek: 2, amountPence: 5000, name: 'Grassroots: Two Weekly Sessions', daysLabel: 'Monday AND Friday' },
    { id: 'development-1', programmeId: 'development', sessionsPerWeek: 1, amountPence: 3000, name: 'Development: One Weekly Session', daysLabel: 'Thursday OR Friday' },
    { id: 'development-2', programmeId: 'development', sessionsPerWeek: 2, amountPence: 5000, name: 'Development: Two Weekly Sessions', daysLabel: 'Thursday AND Friday' }
  ];

  // Leave empty until the owner provides approved content.
  // partner shape:     { name: '', logo: 'assets/partners/x.png', url: '' }
  // testimonial shape: { quote: '', author: '', role: 'Parent' }
  var partners = [];
  var testimonials = [];

  // Dates with no sessions: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', programmeId?: 'grassroots', day?: 'Monday', reason?: '' }.
  // Managed from the admin page; these are only the defaults.
  var closures = [];

  // Membership billing rules (see api/_lib/membership-billing.js). Managed from the admin page.
  var billingRules = {
    collectionDay: 1,
    estimateLeadWorkingDays: 7,
    minimumCardChargePence: 30,
    startWindowDays: 28
  };

  var contact = {
    email: 'info@youthsportspathway.co.uk',
    // Set to the verified WhatsApp community/group invite link when available.
    whatsappUrl: ''
  };

  function getProgramme(id) {
    for (var i = 0; i < programmes.length; i++) if (programmes[i].id === id) return programmes[i];
    return null;
  }
  function getMembership(id) {
    for (var i = 0; i < memberships.length; i++) if (memberships[i].id === id) return memberships[i];
    return null;
  }
  function programmeDays(programmeId) {
    var p = getProgramme(programmeId);
    return p ? p.sessions.map(function (s) { return s.day; }) : [];
  }
  function formatPrice(pence) {
    return '£' + (pence / 100).toFixed(pence % 100 ? 2 : 0);
  }
  /** Returns an error string, or null if the day selection is valid for the membership. */
  function validateMembershipDays(membershipId, days) {
    var m = getMembership(membershipId);
    if (!m) return 'Please choose a membership option.';
    if (!Array.isArray(days)) return 'Please choose your session day(s).';
    var allowed = programmeDays(m.programmeId);
    var unique = days.filter(function (d, i) { return days.indexOf(d) === i; });
    for (var i = 0; i < unique.length; i++) {
      if (allowed.indexOf(unique[i]) === -1) return unique[i] + ' is not a session day for this programme.';
    }
    if (unique.length !== m.sessionsPerWeek) {
      return m.sessionsPerWeek === 1 ? 'Please choose one session day.' : 'This membership includes both session days.';
    }
    return null;
  }
  /** Timetable rows sorted by weekday then time. */
  function timetable() {
    var order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    var rows = [];
    programmes.forEach(function (p) {
      p.sessions.forEach(function (s) { rows.push({ programme: p, session: s }); });
    });
    rows.sort(function (a, b) {
      return (order.indexOf(a.session.day) - order.indexOf(b.session.day)) || a.session.start.localeCompare(b.session.start);
    });
    return rows;
  }

  // ── Admin-managed settings ──
  // Settings saved in the admin page overlay these built-in defaults, in place, so every page and
  // server module that already holds a reference to YSP sees the same values.
  var DEFAULTS = JSON.parse(JSON.stringify({ programmes: programmes, memberships: memberships, closures: closures, billingRules: billingRules }));

  function timeLabel(start, end) {
    function one(t) {
      var h = Number(t.slice(0, 2)), m = t.slice(3);
      return (h % 12 || 12) + ':' + m + (h < 12 ? 'am' : 'pm');
    }
    return one(start) + ' – ' + one(end);
  }
  function replaceArray(target, items) { target.length = 0; items.forEach(function (x) { target.push(x); }); }

  /** Reset to defaults, then apply saved settings ({ programmes, memberships, closures, billingRules }). */
  function applySettings(saved) {
    var base = JSON.parse(JSON.stringify(DEFAULTS));
    saved = saved || {};
    replaceArray(programmes, base.programmes.map(function (p) {
      var o = (saved.programmes || []).filter(function (x) { return x.id === p.id; })[0];
      if (!o) return p;
      ['name', 'ages', 'minAge', 'maxAge', 'description', 'note', 'tasterAvailable', 'paidRegistrationOpen'].forEach(function (k) {
        if (o[k] !== undefined) p[k] = o[k];
      });
      if (Array.isArray(o.sessions) && o.sessions.length === p.sessions.length) {
        p.sessions = o.sessions.map(function (s) {
          return { day: s.day, start: s.start, end: s.end, time: timeLabel(s.start, s.end), capacity: s.capacity == null ? null : s.capacity };
        });
      }
      return p;
    }));
    replaceArray(memberships, base.memberships.map(function (m) {
      var o = (saved.memberships || []).filter(function (x) { return x.id === m.id; })[0];
      if (o && o.amountPence !== undefined) m.amountPence = o.amountPence;
      if (o && o.name) m.name = o.name;
      var days = programmeDays(m.programmeId);
      m.daysLabel = days.join(m.sessionsPerWeek >= days.length ? ' AND ' : ' OR ');
      return m;
    }));
    replaceArray(closures, Array.isArray(saved.closures) ? saved.closures : base.closures);
    Object.keys(billingRules).forEach(function (k) { delete billingRules[k]; });
    Object.assign(billingRules, base.billingRules, saved.billingRules || {}, { collectionDay: 1 });
    return YSP;
  }
  /** Current settings in the shape applySettings accepts. */
  function exportSettings() {
    return JSON.parse(JSON.stringify({ programmes: programmes, memberships: memberships, closures: closures, billingRules: billingRules }));
  }

  var YSP = {
    venue: VENUE,
    programmes: programmes,
    memberships: memberships,
    closures: closures,
    billingRules: billingRules,
    defaults: DEFAULTS,
    applySettings: applySettings,
    exportSettings: exportSettings,
    timeLabel: timeLabel,
    partners: partners,
    testimonials: testimonials,
    contact: contact,
    getProgramme: getProgramme,
    getMembership: getMembership,
    programmeDays: programmeDays,
    formatPrice: formatPrice,
    validateMembershipDays: validateMembershipDays,
    timetable: timetable
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = YSP;
  else root.YSP = YSP;
})(this);
