// The interface every lead source implements.
//
// In its own module rather than in index.js on purpose: the registry imports
// each adapter and each adapter extends this class, so keeping both in index.js
// makes a cycle where `class X extends LeadSourceAdapter` evaluates while the
// binding is still in its temporal dead zone. That fails at import time, in the
// deployed function, with a ReferenceError that says nothing useful.

/**
 * `discover(criteria, cursor)` returns `{ records, cursor, done }` — a page at a
 * time, because a provider that returns everything at once cannot be resumed
 * after a timeout, and a Cloud Function will time out.
 *
 * `normalize(raw)` returns the flat field bag `buildProspect` consumes. It must
 * NOT return a full prospect document: the taxonomy lives in one place, and an
 * adapter that builds its own document is an adapter that will drift from it.
 */
export class LeadSourceAdapter {
  /** Stable id stored on every prospect this source produces. */
  static id = 'abstract';
  /** Shown in the Lead Discovery picker. */
  static label = 'Abstract source';
  /** 'cloud_function' | 'local_runner' — where a job for this source runs. */
  static executionMode = 'cloud_function';
  /** Credentials the operator must configure before this source will run. */
  static requiredSecrets = [];
  static supportsRadius = false;
  static supportsKeywords = true;

  constructor(options = {}) { this.options = options; }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async validateConfig(criteria) { return { valid: true, errors: [] }; }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async discover(criteria, cursor) { throw new Error('discover() is not implemented'); }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  normalize(rawRecord) { throw new Error('normalize() is not implemented'); }

  sourceIdentity() { return { provider: this.constructor.id, providerRecordId: '' }; }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  supports(criteria) { return true; }

  // eslint-disable-next-line class-methods-use-this
  canResume(job) { return Boolean(job?.execution?.cursor); }

  // eslint-disable-next-line class-methods-use-this
  async healthCheck() { return { ok: true, detail: '' }; }
}
