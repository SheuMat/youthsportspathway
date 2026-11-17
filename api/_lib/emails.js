'use strict';
// Plain-text email bodies. Kept in one place so YSP and parents see consistent details.
const YSP = require('../../js/site-data.js');

const yn = (b) => (b ? 'Yes' : 'No');
const venue = () => `${YSP.venue.name}, ${YSP.venue.address}`;
const pounds = (p) => `£${((p || 0) / 100).toFixed(2)}`;
const longDate = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
function sessionTimes(r) {
  const p = YSP.getProgramme(r.programme_id);
  return String(r.days || '').split(',').filter(Boolean).map((d) => {
    const s = p && p.sessions.find((x) => x.day === d);
    return s ? `${d}s, ${s.time}` : d;
  }).join(' and ');
}

/** Sent once the Direct Debit is set up and an upfront card payment is due. */
function upfrontPaymentRequest(r, m, link, cardReady) {
  return {
    subject: `Complete ${r.child_name}'s YSP membership (${r.reference})`,
    text: [
      `Hi ${r.parent_name},`,
      '',
      `Thanks — ${r.child_name}'s Direct Debit is set up. No money has been taken by Direct Debit yet.`,
      '',
      `To confirm the place, one payment is due for the sessions before your first Direct Debit:`,
      `  ${pounds(r.upfront_pence)} covering ${longDate(r.covered_from)} to ${longDate(r.covered_to)}`,
      '',
      cardReady ? `Pay securely by card here: ${link}` : `We'll contact you shortly to arrange this payment.`,
      '',
      `Membership: ${m ? m.name : r.membership_id} — ${pounds(r.amount_pence)} a month`,
      `First Direct Debit: ${longDate(r.first_collection_date)}, then on the 1st of each month`,
      `Reference: ${r.reference}`,
      '',
      `Questions? Email ${YSP.contact.email}.`,
      '',
      'Youth Sports Pathway'
    ].join('\n')
  };
}

/** Sent when the membership becomes active (Direct Debit set up and any upfront payment confirmed). */
function membershipConfirmed(r, m) {
  const p = YSP.getProgramme(r.programme_id);
  const initial = r.upfront_status === 'paid'
    ? `${pounds(r.upfront_pence)} paid by card, covering ${longDate(r.covered_from)} to ${longDate(r.covered_to)}`
    : 'No upfront payment was needed';
  return {
    subject: `${r.child_name}'s YSP membership is confirmed (${r.reference})`,
    text: [
      `Hi ${r.parent_name},`,
      '',
      `${r.child_name}'s membership is confirmed. We look forward to seeing them!`,
      '',
      `Player: ${r.child_name}`,
      `Programme: ${p ? p.name : r.programme_id}`,
      `Sessions: ${sessionTimes(r)} at ${venue()}`,
      `First session: ${longDate(r.start_date)}`,
      `Membership: ${m ? m.name : r.membership_id} — ${pounds(r.amount_pence)} a month`,
      `Initial payment: ${initial}`,
      `First Direct Debit: ${pounds(r.amount_pence)} on or shortly after ${longDate(r.first_collection_date)}, then on the 1st of each month until you cancel`,
      `Reference: ${r.reference}`,
      '',
      'Your Direct Debit is collected by GoCardless and protected by the Direct Debit Guarantee. GoCardless will email you before each collection.',
      '',
      `To cancel, email ${YSP.contact.email} at least 14 days before the 1st to stop that month's payment.`,
      '',
      `Questions? Email ${YSP.contact.email}.`,
      '',
      'Youth Sports Pathway'
    ].join('\n')
  };
}


function childBlock(v) {
  return [
    `Child: ${v.childName}, age ${v.childAge}`,
    `Parent/guardian: ${v.parentName}`,
    `Email: ${v.parentEmail}`,
    `Telephone: ${v.parentPhone}`,
    `Emergency contact: ${v.emergencyName}, ${v.emergencyPhone}`,
    `Medical / additional needs: ${v.medicalInfo || 'None given'}`,
    `Other notes: ${v.notes || '-'}`,
    '',
    'CONSENT',
    `Parent/guardian permission to take part: ${yn(v.participationConsent)}`,
    `Emergency first aid / medical treatment: ${yn(v.medicalConsent)}`,
    `Photos and video: ${v.photoConsent === 'yes' ? 'Yes' : 'NO — do not use images of this child'}`,
    `Read privacy information: Yes`,
    `Marketing emails: ${yn(v.marketingConsent)}`
  ].join('\n');
}

function tasterToYsp(v, reference, warnings = []) {
  const p = YSP.getProgramme(v.programmeId);
  const s = p.sessions.find((x) => x.day === v.day);
  const warn = warnings.length
    ? ['⚠ POSSIBLE REPEAT FREE TASTER — please check before confirming:', ...warnings.map((w) => `  • ${w}`), '']
    : [];
  return {
    subject: `${warnings.length ? '⚠ Possible repeat — ' : ''}Free taster booking ${reference}: ${p.name}, ${v.day} ${v.preferredDate}`,
    text: [
      `New free taster booking — ${reference}`,
      '',
      ...warn,
      `Programme: ${p.name} (ages ${p.ages})`,
      `Session: ${v.day} ${v.preferredDate}, ${s ? s.time : ''}`,
      `Venue: ${venue()}`,
      '',
      childBlock(v),
      '',
      'This is a request. Please reply to the parent to confirm the place (replying to this email goes to them).'
    ].join('\n')
  };
}

function tasterToParent(v, reference) {
  const p = YSP.getProgramme(v.programmeId);
  const s = p.sessions.find((x) => x.day === v.day);
  return {
    subject: `Your free taster request (${reference}) — Youth Sports Pathway`,
    text: [
      `Hi ${v.parentName},`,
      '',
      `Thanks for booking a free ${p.name} taster for ${v.childName}.`,
      '',
      `Requested session: ${v.day} ${v.preferredDate}, ${s ? s.time : ''}`,
      `Venue: ${venue()}`,
      `Reference: ${reference}`,
      '',
      "This is a request, not yet a confirmed place. We'll be in touch to confirm. There's nothing to pay for a taster.",
      'Please note: there is one free taster per child.',
      '',
      'If anything changes, just reply to this email.',
      '',
      'Youth Sports Pathway'
    ].join('\n')
  };
}

function registrationToYsp(v, reference, status) {
  return {
    subject: `New membership registration ${reference}: ${v.membership.name}`,
    text: [
      `New membership registration — ${reference}`,
      `Status: ${status.replace(/_/g, ' ')}`,
      '',
      `Membership: ${v.membership.name} — £${v.membership.amountPence / 100}/month`,
      `Session day(s): ${v.days.join(' and ')}`,
      `Venue: ${venue()}`,
      v.startDate ? `Requested start date: ${longDate(v.startDate)}` : null,
      v.childDob ? `Child's date of birth: ${v.childDob}` : null,
      `Already pays YSP by Direct Debit: ${yn(v.existingDirectDebit)}`,
      '',
      childBlock(v),
      '',
      'No payment has been taken. Reply to this email to contact the parent.'
    ].filter((l) => l !== null).join('\n')
  };
}

function registrationToParent(v, reference, message) {
  return {
    subject: `Your YSP membership registration (${reference})`,
    text: [
      `Hi ${v.parentName},`,
      '',
      message,
      '',
      `Membership: ${v.membership.name} — £${v.membership.amountPence / 100}/month`,
      `Session day(s): ${v.days.join(' and ')}`,
      `Venue: ${venue()}`,
      `Reference: ${reference}`,
      '',
      'No payment has been taken.',
      '',
      'Youth Sports Pathway'
    ].join('\n')
  };
}

function enquiryToYsp(v, reference) {
  return {
    subject: `Website enquiry ${reference}: ${v.type}`,
    text: [
      `New ${v.type} enquiry — ${reference}`,
      '',
      `From: ${v.firstName} ${v.lastName}`.trim(),
      `Email: ${v.email}`,
      `Telephone: ${v.phone || '-'}`,
      `Marketing emails: ${yn(v.marketingConsent)}`,
      '',
      v.message
    ].join('\n')
  };
}

module.exports = { tasterToYsp, tasterToParent, registrationToYsp, registrationToParent, enquiryToYsp, upfrontPaymentRequest, membershipConfirmed };
