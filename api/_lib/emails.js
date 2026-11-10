'use strict';
// Plain-text email bodies. Kept in one place so YSP and parents see consistent details.
const YSP = require('../../js/site-data.js');

const yn = (b) => (b ? 'Yes' : 'No');
const venue = () => `${YSP.venue.name}, ${YSP.venue.address}`;

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
      `Already pays YSP by Direct Debit: ${yn(v.existingDirectDebit)}`,
      '',
      childBlock(v),
      '',
      'No payment has been taken. Reply to this email to contact the parent.'
    ].join('\n')
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

module.exports = { tasterToYsp, tasterToParent, registrationToYsp, registrationToParent, enquiryToYsp };
