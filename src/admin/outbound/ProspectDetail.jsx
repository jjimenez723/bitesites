// One prospect, everything we hold about it, and where each fact came from.
//
// The source rows exist because a cold-contact record is only defensible if you
// can say how you got the number. "Watcher · smb_leads · <doc id>" is the answer
// to that question, and it is why the import service preserves source
// attribution rather than flattening records into a name and a phone.

import React, { useEffect, useState } from 'react';
import { Panel, DetailRows } from '../Panel';
import { loadProspect, loadProspectActivities, outbound, useAction } from './data';
import { SourceBadge, StatusPill, formatWhen, formatPhone, localTime } from './SourceBadge';
import LeadResearchPanel from './LeadResearchPanel';

export default function ProspectDetail({ prospectId, onClose, onChanged }) {
  const [prospect, setProspect] = useState(null);
  const [activities, setActivities] = useState([]);
  const [tab, setTab] = useState('details');
  const [loading, setLoading] = useState(true);
  const action = useAction();

  const reload = () => {
    setLoading(true);
    Promise.all([loadProspect(prospectId), loadProspectActivities(prospectId)])
      .then(([record, history]) => { setProspect(record); setActivities(history); })
      .catch(() => setProspect(null))
      .finally(() => setLoading(false));
  };

  useEffect(reload, [prospectId]);

  if (!prospectId) return null;

  const promote = async () => {
    // `manual_qualification` is a real conversion trigger — an admin deciding
    // this business is worth tracking as a lead. An attempted call is not, and
    // the server rejects it if the UI ever tries.
    const result = await action.run(
      () => outbound.promoteProspect(prospectId, 'manual_qualification'),
      'Promoted.'
    );
    if (result) { reload(); onChanged?.(); }
  };

  const resolve = async choice => {
    const result = await action.run(() => outbound.resolveDuplicate(prospectId, choice), 'Resolved.');
    if (result) { reload(); onChanged?.(); }
  };

  const title = prospect?.companyName || prospect?.name || 'Prospect';

  return (
    <Panel
      title={title}
      subtitle={prospect ? `${prospect.business?.category?.replace(/_/g, ' ') || 'Uncategorised'} · ${formatWhen(prospect.createdAt)}` : ''}
      onClose={onClose}
    >
      {loading && <p className="admin-note">Loading…</p>}
      {!loading && !prospect && <p className="admin-error">That prospect no longer exists.</p>}

      {prospect && (
        <>
          <div className="admin-segment" role="group" aria-label="Prospect section" style={{ marginBottom: 14 }}>
            {[['details', 'Details'], ['research', 'Research'], ['activity', `Activity (${activities.length})`]].map(([key, label]) => (
              <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          {action.error && <p className="admin-error">{action.error}</p>}
          {action.message && <p className="admin-note">{action.message}</p>}

          {tab === 'details' && (
            <>
              {prospect.duplicate?.status === 'possible' && (
                <div className="outbound-compliance-note">
                  <strong>Possible duplicate.</strong> Matched a {prospect.duplicate.duplicateOfType} on{' '}
                  {(prospect.duplicate.matchReasons || []).join(', ') || 'an unknown signal'} at{' '}
                  {Math.round((prospect.duplicate.matchConfidence || 0) * 100)}% confidence.
                  <div className="admin-filters" style={{ marginTop: 9 }}>
                    <button className="btn-admin" type="button" disabled={action.busy} onClick={() => resolve('keep')}>
                      Keep as a separate business
                    </button>
                    <button className="btn-admin danger" type="button" disabled={action.busy} onClick={() => resolve('merge')}>
                      It is a duplicate — archive it
                    </button>
                  </div>
                </div>
              )}

              <DetailRows
                rows={[
                  ['Status', <StatusPill status={prospect.lifecycle?.status} />],
                  ['Company', prospect.companyName],
                  ['Contact', [prospect.firstName, prospect.lastName].filter(Boolean).join(' ')],
                  ['Job title', prospect.jobTitle],
                  ['Phone', formatPhone(prospect.phoneE164)],
                  ['Phone as supplied', prospect.phoneE164 !== prospect.phone ? prospect.phone : ''],
                  ['Email', prospect.email],
                  ['Website', prospect.website
                    ? <a href={prospect.website} target="_blank" rel="noreferrer noopener">{prospect.website.replace(/^https:\/\//, '')}</a>
                    : ''],
                  ['Address', [prospect.address?.line1, prospect.address?.city, [prospect.address?.region, prospect.address?.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
                  ['Timezone', prospect.location?.timezone
                    ? `${prospect.location.timezone} — ${localTime(prospect.location.timezone)} there now`
                    : 'Unknown — cannot verify local calling hours'],
                  ['Category', prospect.business?.category?.replace(/_/g, ' ')],
                  ['Rating', prospect.business?.rating ? `${prospect.business.rating} (${prospect.business.reviewCount || 0} reviews)` : ''],
                  ['Contactable', prospect.contactability?.validPhone ? 'Yes' : `No — ${(prospect.contactability?.complianceReasons || []).join(', ')}`],
                  ['Do not call', prospect.contactability?.doNotCall ? 'Yes' : ''],
                  ['Converted lead', prospect.lifecycle?.convertedLeadId],
                  ['Notes', prospect.notes]
                ]}
              />

              <div style={{ marginTop: 16 }}>
                <div className="panel-section-label">Where this record came from</div>
                <div style={{ marginTop: 9 }}><SourceBadge source={prospect.source} /></div>
                <DetailRows
                  rows={[
                    ['Source project', prospect.source?.sourceProjectId],
                    ['Source collection', prospect.source?.sourceCollection],
                    ['Source document', prospect.source?.sourceDocumentId],
                    ['Provider record', prospect.source?.providerRecordId],
                    ['Discovery job', prospect.source?.searchJobId],
                    ['Import run', prospect.importRunId],
                    ['Source URL', prospect.source?.sourceUrl
                      ? <a href={prospect.source.sourceUrl} target="_blank" rel="noreferrer noopener">Open</a>
                      : ''],
                    ['Imported', formatWhen(prospect.source?.importedAt)]
                  ]}
                />
              </div>

              {!prospect.lifecycle?.convertedLeadId && (
                <button className="btn-admin" type="button" style={{ marginTop: 16 }} disabled={action.busy} onClick={promote}>
                  {action.busy ? 'Working…' : 'Qualify as a lead'}
                </button>
              )}
            </>
          )}

          {tab === 'research' && (
            <LeadResearchPanel contactType="prospect" contactId={prospectId} onApproved={reload} />
          )}

          {tab === 'activity' && (
            !activities.length ? (
              <p className="admin-note">Nothing has happened to this prospect yet.</p>
            ) : (
              <div className="lead-activity">
                {activities.map(entry => (
                  <div className="lead-activity-row" key={entry.id} style={{ padding: '10px 12px', background: 'var(--surface-2)' }}>
                    <strong style={{ fontSize: 12.5 }}>{String(entry.type || '').replace(/_/g, ' ')}</strong>
                    <div className="cell-dim" style={{ fontSize: 11, marginTop: 3 }}>
                      {formatWhen(entry.at)}
                      {entry.disposition ? ` · ${entry.disposition}` : ''}
                      {entry.campaignId ? ` · campaign ${entry.campaignId.slice(0, 8)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}
    </Panel>
  );
}
