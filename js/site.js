// Renders programme cards, timetable, partners and testimonials from js/site-data.js
(function () {
  'use strict';
  var Y = window.YSP;
  if (!Y) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function priceLine(p) {
    var ms = Y.memberships.filter(function (m) { return m.programmeId === p.id; });
    return ms.map(function (m) {
      return Y.formatPrice(m.amountPence) + '/month — ' + (m.sessionsPerWeek === 1 ? 'one weekly session (' + m.daysLabel + ')' : 'both weekly sessions');
    });
  }

  // Programme cards (basketball.html)
  document.querySelectorAll('[data-ysp="programme-cards"]').forEach(function (el) {
    el.innerHTML = Y.programmes.map(function (p) {
      var days = p.sessions.map(function (s) { return s.day; }).join(' &amp; ');
      var times = p.sessions.map(function (s) { return '<div>' + esc(s.day) + ': ' + esc(s.time) + '</div>'; }).join('');
      var prices = priceLine(p).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
      var regNote = p.paidRegistrationOpen ? '' :
        '<p class="session-note">Online registration is open; places are confirmed once session arrangements are finalised. We\'ll be in touch before any payment is taken.</p>';
      return '' +
        '<article class="session-card" id="' + esc(p.id) + '">' +
          '<div class="session-card-header"><h3>' + esc(p.name) + '</h3><span class="session-badge">Ages ' + esc(p.ages) + '</span></div>' +
          '<div class="session-card-body">' +
            '<p style="margin-bottom:16px;font-size:0.9rem;">' + esc(p.description) + '</p>' +
            (p.note ? '<p style="margin-bottom:16px;font-size:0.9rem;">' + esc(p.note) + '</p>' : '') +
            '<div class="session-detail"><span class="session-detail-icon" aria-hidden="true">📅</span><span>Every ' + days + '</span></div>' +
            '<div class="session-detail"><span class="session-detail-icon" aria-hidden="true">🕔</span><span>' + times + '</span></div>' +
            '<div class="session-detail"><span class="session-detail-icon" aria-hidden="true">📍</span><span>' + esc(Y.venue.name) + ', ' + esc(Y.venue.address) + '</span></div>' +
            '<div class="session-detail"><span class="session-detail-icon" aria-hidden="true">💷</span><span>' + prices + '</span></div>' +
            (p.tasterAvailable ? '<div class="session-detail"><span class="session-detail-icon" aria-hidden="true">✅</span><span>Free taster session available</span></div>' : '') +
            regNote +
          '</div>' +
          '<div class="session-card-footer session-card-actions">' +
            '<a href="taster.html?programme=' + esc(p.id) + '" class="btn btn-outline-dark">Book a Free Taster</a>' +
            '<a href="register.html?programme=' + esc(p.id) + '" class="btn btn-primary">Register</a>' +
          '</div>' +
        '</article>';
    }).join('');
  });

  // Timetable (timetable.html)
  document.querySelectorAll('[data-ysp="timetable"]').forEach(function (el) {
    el.innerHTML = Y.timetable().map(function (r) {
      return '<tr>' +
        '<td data-label="Day"><strong>' + esc(r.session.day) + '</strong></td>' +
        '<td data-label="Time">' + esc(r.session.time) + '</td>' +
        '<td data-label="Programme">' + esc(r.programme.name) + '</td>' +
        '<td data-label="Ages">' + esc(r.programme.ages) + '</td>' +
        '<td data-label="Venue">' + esc(Y.venue.short) + '</td>' +
        '<td data-label="Book"><a href="taster.html?programme=' + esc(r.programme.id) + '&amp;day=' + esc(r.session.day) + '" class="btn btn-primary" style="padding:6px 16px;font-size:0.8rem;">Free Taster</a></td>' +
      '</tr>';
    }).join('');
  });
  document.querySelectorAll('[data-ysp="membership-summary"]').forEach(function (el) {
    var one = Y.memberships.filter(function (m) { return m.sessionsPerWeek === 1; })[0];
    var two = Y.memberships.filter(function (m) { return m.sessionsPerWeek === 2; })[0];
    el.textContent = Y.formatPrice(one.amountPence) + '/month for one session weekly, or ' + Y.formatPrice(two.amountPence) +
      '/month for both sessions within the selected programme. Grassroots and Development are separate memberships.';
  });

  // Partners
  document.querySelectorAll('[data-ysp="partners"]').forEach(function (el) {
    if (!Y.partners.length) {
      el.outerHTML = '<p class="empty-note">' + esc(el.getAttribute('data-empty')) + '</p>';
      return;
    }
    el.innerHTML = Y.partners.map(function (p) {
      var inner = p.logo ? '<img src="' + esc(p.logo) + '" alt="' + esc(p.name) + '" />' : esc(p.name);
      return p.url ? '<a class="partner-logo-placeholder" href="' + esc(p.url) + '" rel="noopener">' + inner + '</a>' : '<div class="partner-logo-placeholder">' + inner + '</div>';
    }).join('');
  });

  // Testimonials
  document.querySelectorAll('[data-ysp="testimonials"]').forEach(function (el) {
    if (!Y.testimonials.length) {
      el.innerHTML = '<p style="max-width:560px;margin:16px auto 0;">' + esc(el.getAttribute('data-empty')) + '</p>';
      return;
    }
    el.className = 'testimonials-grid';
    el.innerHTML = Y.testimonials.map(function (t) {
      return '<div class="testimonial-card"><p>' + esc(t.quote) + '</p><div class="testimonial-author"><div><strong>' + esc(t.author) + '</strong><span>' + esc(t.role) + '</span></div></div></div>';
    }).join('');
  });

  // WhatsApp link, once a verified one is configured
  if (Y.contact.whatsappUrl) {
    document.querySelectorAll('[data-ysp="whatsapp"]').forEach(function (a) {
      a.href = Y.contact.whatsappUrl;
      a.textContent = 'Join WhatsApp Group';
      a.rel = 'noopener';
    });
  }
})();
