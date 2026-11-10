'use strict';
const YSP = require('../../js/site-data.js');

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const PHONE_RE = /^[0-9+() -]{10,20}$/;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ENQUIRY_TYPES = ['general', 'sessions', 'school', 'partnership', 'coaching', 'newsletter'];

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

class Checker {
  constructor() { this.fields = {}; }
  fail(field, msg) { if (!this.fields[field]) this.fields[field] = msg; }
  required(field, value, label) { if (!value) this.fail(field, `${label} is required.`); return value; }
  email(field, v) { if (v && !EMAIL_RE.test(v)) this.fail(field, 'Please enter a valid email address.'); return v.toLowerCase(); }
  phone(field, v) { if (v && !PHONE_RE.test(v)) this.fail(field, 'Please enter a valid telephone number.'); return v; }
  get ok() { return Object.keys(this.fields).length === 0; }
  get message() { return Object.values(this.fields)[0]; }
}

function parentChild(b, c, programme) {
  const out = {
    parentName: c.required('parentName', str(b.parentName, 120), 'Parent/guardian name'),
    parentEmail: c.email('parentEmail', c.required('parentEmail', str(b.parentEmail, 200), 'Email')),
    parentPhone: c.phone('parentPhone', c.required('parentPhone', str(b.parentPhone, 30), 'Telephone number')),
    childName: c.required('childName', str(b.childName, 120), "Child's name"),
    childAge: Number(b.childAge),
    notes: str(b.notes, 2000),
    emergencyName: c.required('emergencyName', str(b.emergencyName, 120), 'Emergency contact name'),
    emergencyPhone: c.phone('emergencyPhone', c.required('emergencyPhone', str(b.emergencyPhone, 30), 'Emergency contact telephone')),
    medicalInfo: str(b.medicalInfo, 2000),
    participationConsent: b.participationConsent === true,
    medicalConsent: b.medicalConsent === true,
    photoConsent: b.photoConsent === 'yes' ? 'yes' : b.photoConsent === 'no' ? 'no' : '',
    marketingConsent: b.marketingConsent === true
  };
  if (!out.participationConsent) c.fail('participationConsent', 'Parent/guardian permission is needed for your child to take part.');
  if (!out.medicalConsent) c.fail('medicalConsent', 'Please confirm the emergency first aid and medical consent.');
  if (!out.photoConsent) c.fail('photoConsent', 'Please choose yes or no for photo and video consent.');
  if (!Number.isInteger(out.childAge)) c.fail('childAge', "Please enter your child's age.");
  else if (programme && (out.childAge < programme.minAge || out.childAge > programme.maxAge)) {
    c.fail('childAge', `${programme.name} is for ages ${programme.ages}.`);
  }
  if (b.privacyAck !== true) c.fail('privacyAck', 'Please confirm you have read the privacy information.');
  return out;
}

function enquiry(b) {
  const c = new Checker();
  const type = str(b.type, 30);
  if (!ENQUIRY_TYPES.includes(type)) c.fail('type', 'Please choose an enquiry type.');
  const v = {
    type,
    firstName: c.required('firstName', str(b.firstName, 100), 'First name'),
    lastName: str(b.lastName, 100),
    email: c.email('email', c.required('email', str(b.email, 200), 'Email')),
    phone: c.phone('phone', str(b.phone, 30)),
    message: c.required('message', str(b.message, 5000), 'Message'),
    marketingConsent: b.marketingConsent === true
  };
  if (type !== 'newsletter' && !v.lastName) c.fail('lastName', 'Last name is required.');
  if (type === 'newsletter' && !v.marketingConsent) c.fail('marketingConsent', 'Please confirm you want to receive emails.');
  if (b.privacyAck !== true) c.fail('privacyAck', 'Please confirm you have read the privacy information.');
  return { c, v };
}

/** today: 'YYYY-MM-DD' (injectable for tests) */
function taster(b, today = new Date().toISOString().slice(0, 10)) {
  const c = new Checker();
  const programme = YSP.getProgramme(str(b.programmeId, 30));
  if (!programme) c.fail('programmeId', 'Please choose a programme.');
  else if (!programme.tasterAvailable) c.fail('programmeId', 'Tasters are not currently available for this programme.');
  const day = str(b.day, 12);
  if (programme && !YSP.programmeDays(programme.id).includes(day)) {
    c.fail('day', `Please choose ${YSP.programmeDays(programme.id).join(' or ')} for ${programme.name}.`);
  }
  const date = str(b.preferredDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T12:00:00Z'))) c.fail('preferredDate', 'Please choose a preferred taster date.');
  else {
    if (date <= today) c.fail('preferredDate', 'Please choose a future date.');
    const wd = DAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
    if (day && wd !== day) c.fail('preferredDate', `Please choose a date that falls on a ${day}.`);
    const max = new Date(today + 'T12:00:00Z'); max.setUTCDate(max.getUTCDate() + 120);
    if (date > max.toISOString().slice(0, 10)) c.fail('preferredDate', 'Please choose a date within the next four months.');
  }
  const pc = parentChild(b, c, programme);
  return { c, v: { programmeId: programme && programme.id, day, preferredDate: date, ...pc } };
}

function registration(b) {
  const c = new Checker();
  const m = YSP.getMembership(str(b.membershipId, 30));
  const programme = m && YSP.getProgramme(m.programmeId);
  if (!m) c.fail('membershipId', 'Please choose a membership option.');
  if (b.programmeId && m && b.programmeId !== m.programmeId) c.fail('membershipId', 'That membership does not belong to the selected programme.');
  const days = Array.isArray(b.days) ? b.days.map((d) => str(d, 12)).slice(0, 7) : [];
  if (m) { const err = YSP.validateMembershipDays(m.id, days); if (err) c.fail('days', err); }
  if (b.termsAck !== true) c.fail('termsAck', 'Please confirm you have read the membership terms.');
  const pc = parentChild(b, c, programme);
  return {
    c,
    v: {
      membership: m, programme,
      days: m ? (m.sessionsPerWeek === 2 ? YSP.programmeDays(m.programmeId) : days) : [],
      existingDirectDebit: b.existingDirectDebit === true,
      ...pc
    }
  };
}

/** Normalised keys used to spot repeat free-taster bookings. */
function childKey(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function phoneKey(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0044')) d = '0' + d.slice(4);
  else if (d.startsWith('44') && d.length >= 12) d = '0' + d.slice(2);
  return d;
}

module.exports = { enquiry, taster, registration, str, YSP, childKey, phoneKey };
