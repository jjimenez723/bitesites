// Lead capture — writes straight to Firestore from the browser.
//
// There is no API server in front of this on purpose: the site is a static
// build, and firestore.rules already whitelists every field, type and length on
// the `leads` collection. This module's job is to normalise input so a valid
// submission never trips those rules, and to give the visitor a readable error
// when something is genuinely wrong.

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

const BUSINESS_SIZES = ['solo', 'small', 'growing', 'established', 'enterprise'];
const URGENCY_TAGS = ['asap', '2_4_weeks', '1_2_months', 'flexible'];
const SERVICES = ['web_development', 'ai_automation', 'social_media_management'];
const CONTACT_METHODS = ['email', 'phone'];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const clean = (value, maxLen) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

// The Bit chat lets people type a free-text answer to a multiple-choice
// question. Anything we don't recognise becomes 'other' and the original text
// is preserved in customAnswers rather than silently dropped.
const normaliseChoice = (value, allowed) => {
  const candidate = clean(value, 500);
  if (!candidate) return { value: '', raw: '' };
  if (allowed.includes(candidate)) return { value: candidate, raw: '' };
  return { value: 'other', raw: candidate };
};

export function buildLead(input, source) {
  const customAnswers = {};

  const businessSize = normaliseChoice(input.businessSize, BUSINESS_SIZES);
  if (businessSize.raw) customAnswers.businessSize = businessSize.raw;

  const urgency = normaliseChoice(input.urgencyTag, URGENCY_TAGS);
  if (urgency.raw) customAnswers.urgencyTag = urgency.raw;

  const rawServices = Array.isArray(input.services)
    ? input.services
    : [input.services];
  const services = [];
  for (const entry of rawServices) {
    const mapped = normaliseChoice(entry, SERVICES);
    if (!mapped.value) continue;
    if (mapped.raw && !customAnswers.services) customAnswers.services = mapped.raw;
    if (!services.includes(mapped.value)) services.push(mapped.value);
  }

  const preferredContactMethod = CONTACT_METHODS.includes(input.preferredContactMethod)
    ? input.preferredContactMethod
    : 'email';

  const lead = {
    name: clean(input.name, 120),
    email: clean(input.email, 200).toLowerCase(),
    businessSize: businessSize.value,
    services,
    preferredContactMethod,
    source,
    status: 'new',
    createdAt: serverTimestamp()
  };

  // Optional fields are omitted entirely rather than sent as empty strings, so
  // an admin querying leads can distinguish "not asked" from "left blank".
  const optional = {
    phone: clean(input.phone, 40),
    businessName: clean(input.businessName, 160),
    roleInCompany: clean(input.roleInCompany, 160),
    projectDetails: clean(input.projectDetails, 5000),
    urgencyTag: urgency.value
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) lead[key] = value;
  }

  if (Object.keys(customAnswers).length) lead.customAnswers = customAnswers;

  if (typeof window !== 'undefined') {
    lead.pagePath = clean(window.location?.pathname, 300) || '/';
    const referrer = clean(document?.referrer, 400);
    if (referrer) lead.referrer = referrer;
    const userAgent = clean(navigator?.userAgent, 400);
    if (userAgent) lead.userAgent = userAgent;
  }

  return lead;
}

// Mirrors firestore.rules so the visitor gets a useful message instead of a
// generic permission error.
export function validateLead(lead) {
  if (!lead.name) return 'Please enter your name.';
  if (!lead.email) return 'Please enter your email address.';
  if (!EMAIL_PATTERN.test(lead.email)) return 'Please enter a valid email address.';
  if (!lead.businessSize) return 'Please select your business size.';
  if (!lead.services.length) return 'Please select at least one service.';
  if (lead.preferredContactMethod === 'phone' && !lead.phone) {
    return 'Please provide a phone number for a phone consultation.';
  }
  return null;
}

export async function submitLead(input, source = 'intake_form') {
  const lead = buildLead(input, source);

  const problem = validateLead(lead);
  if (problem) throw new Error(problem);

  try {
    const ref = await addDoc(collection(db, 'leads'), lead);
    return ref.id;
  } catch (error) {
    console.error('[leads] submission failed', error);
    if (error?.code === 'permission-denied') {
      throw new Error('We could not verify this submission. Please refresh the page and try again.');
    }
    if (error?.code === 'unavailable') {
      throw new Error('Network unavailable. Please check your connection and try again.');
    }
    throw new Error('Something went wrong sending your request. Please try again or email us directly.');
  }
}
