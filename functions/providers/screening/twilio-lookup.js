// Twilio Lookup v2 as a screening provider.
//
// The vendor query itself already lived in pre-dial-screening.js and is left
// there: it is pure, injectable and well tested, and moving it would only churn
// the module that owns the evidence contract. This class is the registry entry
// that makes it selectable, declares what it actually checks, and marks it as
// what it is — a paid lookup.
//
// `paidLookup: true` is the whole point of this file. Both fields it requests,
// line_type_intelligence and reassigned_number, are billable packages, so the
// admission gate must refuse this provider until an owner authorises the spend.
// OUTBOUND_LAUNCH_AUTHORIZATION.md §3 has not been granted.

import { ScreeningProviderAdapter } from './adapter.js';
import { queryTwilioLookupScreening } from '../../pre-dial-screening.js';

export class TwilioLookupScreeningProvider extends ScreeningProviderAdapter {
  static id = 'twilio_lookup';
  static label = 'Twilio Lookup v2 (paid: line type + reassigned number)';
  static requiredSecrets = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];

  static capabilities = {
    // Lookup answers the number questions. It is not a DNC service, and saying
    // otherwise here would let a campaign clear a national-DNC requirement it
    // never actually checked.
    nationalDnc: false,
    entityDnc: false,
    reassignedNumber: true,
    phoneValidation: true,
    lineType: true,
    paidLookup: true
  };

  async screen({ phoneE164, consentGrantedAt, fetchImpl, timeoutMs } = {}) {
    return queryTwilioLookupScreening({
      phoneE164,
      consentGrantedAt,
      accountSid: this.config?.TWILIO_ACCOUNT_SID || '',
      authToken: this.config?.TWILIO_AUTH_TOKEN || '',
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(timeoutMs ? { timeoutMs } : {})
    });
  }
}
