// The BiteSites-Leads checkout (the Dialer fork of Watcher-Workflows).
//
// Same corpus, same document shape, one meaningful difference: this fork added
// the Kixie/HighLevel dialer, so its records can already carry a HighLevel
// contact id (`ghl_contact_id`) and a consent record. Preserving those is worth
// a separate adapter — a prospect that already exists as a HighLevel contact
// should reuse that contact rather than create a second one, and a recorded
// consent basis is the only thing that makes a number callable at all.
//
// The Airbnb classification is shared with the Watcher adapter; the fork
// carries the same second ICP.

import { LeadSourceAdapter } from './adapter.js';
import { WatcherWorkflowSource, isAirbnbRecord, classifyWatcherRecord } from './existing-watcher-source.js';
import { clean } from '../../prospect-normalization.js';

export { isAirbnbRecord, classifyWatcherRecord };

export class BiteSitesLeadsSource extends LeadSourceAdapter {
  static id = 'bitesites_leads';
  static label = 'BiteSites-Leads corpus (migrated)';
  static executionMode = 'local_runner';
  static requiredSecrets = [];
  static supportsKeywords = false;

  static sourceSystem = 'bitesites_leads';
  static sourceProjectId = 'watcher-leads-89349';

  async validateConfig() {
    return {
      valid: true,
      errors: [],
      warnings: ['Records arrive through scripts/migrate-watcher-leads.mjs — this source cannot start a job on its own.']
    };
  }

  supports() { return false; }

  async discover() {
    throw new Error('bitesites_leads ingests through the migration script; it cannot run a discovery job.');
  }

  sourceIdentity(raw = {}) {
    return { provider: BiteSitesLeadsSource.id, providerRecordId: clean(raw.__docId || raw.id, 200) };
  }

  normalize(raw = {}) {
    // Field mapping is identical; delegating keeps one copy of it.
    const base = new WatcherWorkflowSource().normalize(raw);
    const providerContactId = clean(raw.ghl_contact_id, 160);
    return {
      ...base,
      // Carried through so promoteProspectToLead and the calling adapters can
      // reuse the existing CRM contact instead of creating a duplicate.
      providerContactId,
      consentBasis: clean(raw.consent_basis, 60),
      consentRecord: clean(raw.consent_record, 500),
      doNotCall: raw.dnc === true || raw.do_not_call === true
    };
  }
}
