// The interface every pre-dial screening provider implements.
//
// Own module for the same reason as the calling and lead-source base classes:
// the registry imports the adapters and the adapters extend this, so
// co-locating them makes an import cycle that fails at deploy time.
//
// Everything above this layer deals in one *normalised* evidence bag:
//
//   { provider, phoneValid, lineType, lineTypeErrorCode,
//     reassignedStatus, reassignedErrorCode, lastVerifiedDate }
//
// which is exactly what `composePreDialScreening` already consumes. That shape
// is not invented here — `queryTwilioLookupScreening` has returned it since the
// screening gate was written, so it is already the de facto vendor-neutral
// contract and this class only makes it explicit.
//
// `lastVerifiedDate` is YYYYMMDD and must equal the date consent was granted.
// A reassignment answer means nothing except relative to that date, and the
// evaluator compares the two exactly.
//
// Every capability defaults to false. An unverified capability must never read
// as supported: the whole screening gate exists to refuse a call when evidence
// is missing, and a provider that claims a check it does not perform turns that
// refusal into a rubber stamp.

export const REASSIGNED_STATUSES = ['no', 'yes', 'unknown'];

export const CALLABLE_LINE_TYPES = [
  'mobile', 'landline', 'fixedvoip', 'nonfixedvoip', 'tollfree', 'uan'
];

export class ScreeningProviderAdapter {
  static id = 'abstract';
  static label = 'Abstract screening provider';
  static requiredSecrets = [];

  /**
   * Which checks this provider genuinely performs.
   *
   * `paidLookup` is separate from the rest and is the flag the admission gate
   * reads: a provider may be perfectly capable and still be refused because
   * nobody has authorised the spend.
   *
   * `verifiesExternally` is the second admission flag and answers a different
   * question: does this provider ask an outside authority, or does it compute
   * an answer locally?  The other capability flags describe *which* questions a
   * provider answers; this one describes whether the answers are real.  A
   * simulated `reassignedNumber: true` and a Twilio-verified one produce byte
   * -identical ledger evidence, so without this flag the only thing separating
   * fabricated compliance evidence from genuine evidence in production is which
   * string an operator picked in a dropdown.  Defaults to false, so a provider
   * added later is refused in production until it says otherwise.
   */
  static capabilities = {
    nationalDnc: false,
    entityDnc: false,
    reassignedNumber: false,
    phoneValidation: false,
    lineType: false,
    paidLookup: false,
    verifiesExternally: false
  };

  constructor(config = {}) {
    this.config = config || {};
  }

  get id() { return this.constructor.id; }
  get label() { return this.constructor.label; }
  get capabilities() { return this.constructor.capabilities; }

  /**
   * Read-only vendor query. Never writes, never decides eligibility — it
   * returns evidence, and `evaluatePreDialScreening` decides what it means.
   */
  async screen() {
    throw new Error(`${this.constructor.id} cannot screen a number`);
  }

  /**
   * Never throws, so a settings screen can render a badge for a provider whose
   * credentials are absent.
   */
  async healthCheck() {
    const missing = (this.constructor.requiredSecrets || [])
      .filter(name => !this.config?.[name]);
    return { ok: missing.length === 0, missing };
  }
}
