// A screening provider that contacts nobody and charges nothing.
//
// This is the default, and it is what makes the rest of the screening stack
// testable while every paid lookup stays switched off. It is deliberately
// *not* a way to get a number cleared for a real call: `screeningAdmission`
// only accepts mock evidence outside production, and the deployment gate
// refuses carrier dialing there anyway, so a mock-cleared number still cannot
// be rung.
//
// It answers deterministically from the number itself so a test can ask for a
// specific verdict without a fixture file: a number ending 00 reads as
// reassigned, 11 as an uncallable line type, 22 as invalid.

import { ScreeningProviderAdapter } from './adapter.js';

const digits = value => String(value || '').replace(/\D/g, '');

/** YYYYMMDD, the format Twilio Lookup uses and the evaluator compares against. */
const dateKey = value => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10).replaceAll('-', '');
};

export class MockScreeningProvider extends ScreeningProviderAdapter {
  static id = 'mock';
  static label = 'Mock screening (no network, no spend)';
  static requiredSecrets = [];

  static capabilities = {
    nationalDnc: true,
    entityDnc: true,
    reassignedNumber: true,
    phoneValidation: true,
    lineType: true,
    paidLookup: false
  };

  async screen({ phoneE164, consentGrantedAt } = {}) {
    const number = digits(phoneE164);
    if (!number) throw new Error('A phone number is required');
    const suffix = number.slice(-2);

    const reassigned = suffix === '00' ? 'yes' : 'no';
    const lineType = suffix === '11' ? 'prepaid' : 'mobile';
    const phoneValid = suffix !== '22';

    return {
      provider: 'mock_screening',
      phoneValid,
      lineType,
      lineTypeErrorCode: null,
      reassignedStatus: reassigned,
      reassignedErrorCode: null,
      // YYYYMMDD, matching Twilio Lookup. The reassignment answer is only
      // meaningful relative to the date consent was given, and the evaluator
      // compares the two exactly — so the mock echoes the real grant date in
      // the real format rather than inventing either.
      lastVerifiedDate: dateKey(consentGrantedAt)
    };
  }

  async healthCheck() { return { ok: true, missing: [] }; }
}
