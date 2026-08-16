// Every enquiry, whichever way it arrived — the intake form, Bit's chat, or a
// call with Byte — with triage.
//
// Status is the only field this screen writes. firestore.rules holds createdAt
// and email immutable on update, so triage can never quietly rewrite who a lead
// was or when it arrived.

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLeads, setLeadStatus, saveLeadCommercial, loadLeadActivities, toDate } from './data';
import { Panel, DetailRows, Pill } from './Panel';
import Transcript from './Transcript';
import { receivingAgent, receivingAgentLabel } from './voice-attribution';

const STATUSES = ['new', 'contacted', 'qualified', 'booked', 'proposal', 'won', 'lost'];
const firstWord = value => String(value || '').trim().split(/\s+/)[0] || '';

// Byte's leads are written server-side by the recordVoiceCall webhook, so a
// source this screen does not recognise is a real possibility — fall back to
// showing the raw value rather than silently filing it under "Intake form".
// `outbound` is deliberately its own source and not folded into `cold_call`:
// these leads came from a campaign against a cold prospect, so anything that
// measures the website's conversion rate has to be able to exclude them. See
// functions/prospect-conversion.js — nothing reaches `leads` with this source
// until a person actually engaged.
const SOURCE_LABELS = {
  intake_form: 'Intake form',
  bit_chat: 'Bit chat',
  byte_voice: 'Voice AI call',
  cold_call: 'Cold call',
  outbound: 'Outbound campaign'
};

const sourceLabel = lead => SOURCE_LABELS[lead.source] || lead.source || 'Unknown';

const SERVICE_LABELS = {
  web_development: 'Web development',
  ai_automation: 'AI automation',
  social_media_management: 'Social media',
  other: 'Other'
};

const SIZE_LABELS = {
  solo: 'Solo / freelancer', small: '2–10 people', growing: '11–50 people',
  established: '51–200 people', enterprise: '200+ people', other: 'Other'
};

const URGENCY_LABELS = {
  asap: 'ASAP', '2_4_weeks': '2–4 weeks', '1_2_months': '1–2 months',
  flexible: 'Flexible', other: 'Other'
};

const when = (value, withTime = true) => {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {})
  });
};

const services = lead => (lead.services || []).map(s => SERVICE_LABELS[s] || s).join(', ');

// A voice call rarely captures both, so the list shows whichever the caller left.
const contact = lead => lead.email || lead.phone || '';

const callLength = seconds => {
  if (typeof seconds !== 'number' || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};

function CrmState({ crm }) {
  if (!crm) return <p className="admin-note">No sync recorded yet.</p>;
  if (crm.reason === 'origin-gohighlevel') {
    return <p className="admin-note">Came from GoHighLevel — already a contact there.</p>;
  }
  if (crm.synced) return <p className="admin-note">Synced to GoHighLevel · {when(crm.at)}</p>;
  if (crm.reason === 'not-configured') {
    return <p className="admin-note">Not sent — no GoHighLevel webhook is configured.</p>;
  }
  return <p className="admin-error">Sync failed — {crm.error || 'unknown error'}</p>;
}

function OutboundProvenance({ lead }) {
  if (lead.source !== 'outbound') return null;
  const acquisition = lead.acquisition || {};
  const manual = acquisition.trigger === 'manual_qualification';
  const externallyContacted = acquisition.contactStatus === 'external_contact';
  return (
    <section className={`lead-provenance ${manual ? 'is-manual' : 'is-verified'}`} aria-label="Lead origin verification">
      <span className="lead-provenance-icon" aria-hidden="true">{manual ? '!' : '✓'}</span>
      <div>
        <span className="panel-section-label">Lead origin</span>
        <strong>{manual ? 'Added to Leads manually' : 'Verified outbound conversation'}</strong>
        <p>{manual
          ? externallyContacted
            ? 'No BiteSites call is verified. A staff member reported contact outside the platform.'
            : 'No answered BiteSites call or external contact is recorded for this lead.'
          : 'A server-verified human answer is linked to this lead and its notification.'}</p>
        {manual && acquisition.manualReason && <small>Reason: {acquisition.manualReason}</small>}
        {manual && acquisition.manualNotes && <small>Context: {acquisition.manualNotes}</small>}
      </div>
      {acquisition.firstConnectedCallId && (
        <Link className="btn-admin" to={`/admin/outbound?tab=history&call=${encodeURIComponent(acquisition.firstConnectedCallId)}`}>Open verified call</Link>
      )}
    </section>
  );
}

const inputDate = value => {
  const date = toDate(value);
  if (!date) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

const money = value => Number.isFinite(Number(value))
  ? Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : '—';

const numberOrZero = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

function CommercialEditor({ lead, busy, onSave }) {
  const [form, setForm] = useState({});

  useEffect(() => {
    setForm({
      owner: lead.owner || '',
      nextFollowUpAt: inputDate(lead.nextFollowUpAt),
      budgetBand: lead.qualification?.budgetBand || '',
      decisionMaker: lead.qualification?.decisionMaker || '',
      primaryProblem: lead.qualification?.primaryProblem || '',
      lostReason: lead.qualification?.lostReason || '',
      competitor: lead.qualification?.competitor || '',
      appointmentStatus: lead.appointment?.status || 'none',
      scheduledFor: inputDate(lead.appointment?.scheduledFor),
      quotedValue: lead.economics?.quotedValue ?? '',
      contractValue: lead.economics?.contractValue ?? '',
      cashCollected: lead.economics?.cashCollected ?? '',
      recurringMonthlyRevenue: lead.economics?.recurringMonthlyRevenue ?? '',
      estimatedHours: lead.economics?.estimatedHours ?? '',
      actualHours: lead.economics?.actualHours ?? '',
      loadedLaborCost: lead.economics?.loadedLaborCost ?? '',
      contractorCost: lead.economics?.contractorCost ?? '',
      softwareCost: lead.economics?.softwareCost ?? '',
      refunds: lead.economics?.refunds ?? ''
    });
  }, [lead.id, lead.updatedAt]);

  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  const submit = event => {
    event.preventDefault();
    const economics = {
      quotedValue: numberOrZero(form.quotedValue),
      contractValue: numberOrZero(form.contractValue),
      cashCollected: numberOrZero(form.cashCollected),
      recurringMonthlyRevenue: numberOrZero(form.recurringMonthlyRevenue),
      estimatedHours: numberOrZero(form.estimatedHours),
      actualHours: numberOrZero(form.actualHours),
      loadedLaborCost: numberOrZero(form.loadedLaborCost),
      contractorCost: numberOrZero(form.contractorCost),
      softwareCost: numberOrZero(form.softwareCost),
      refunds: numberOrZero(form.refunds)
    };
    const directCosts = economics.loadedLaborCost + economics.contractorCost + economics.softwareCost + economics.refunds;
    economics.grossProfit = economics.contractValue - directCosts;
    economics.grossMargin = economics.contractValue > 0
      ? Math.round((economics.grossProfit / economics.contractValue) * 10000) / 100
      : 0;
    onSave({
      owner: form.owner.trim(),
      nextFollowUpAt: form.nextFollowUpAt ? new Date(form.nextFollowUpAt) : null,
      qualification: {
        budgetBand: form.budgetBand,
        decisionMaker: form.decisionMaker,
        primaryProblem: form.primaryProblem.trim(),
        lostReason: form.lostReason,
        competitor: form.competitor.trim()
      },
      appointment: {
        status: form.appointmentStatus,
        scheduledFor: form.scheduledFor ? new Date(form.scheduledFor) : null
      },
      economics
    });
  };

  const directCosts = ['loadedLaborCost', 'contractorCost', 'softwareCost', 'refunds']
    .reduce((sum, key) => sum + numberOrZero(form[key]), 0);
  const projectedProfit = numberOrZero(form.contractValue) - directCosts;

  return (
    <form className="lead-editor" onSubmit={submit}>
      <div className="panel-section-label">Sales operations</div>
      <div className="lead-form-grid">
        <label><span>Owner</span><input name="owner" value={form.owner || ''} onChange={update} placeholder="Team member" /></label>
        <label><span>Next follow-up</span><input name="nextFollowUpAt" type="datetime-local" value={form.nextFollowUpAt || ''} onChange={update} /></label>
        <label><span>Budget</span><select name="budgetBand" value={form.budgetBand || ''} onChange={update}><option value="">Unknown</option><option value="under_2k">Under $2k</option><option value="2k_5k">$2k–$5k</option><option value="5k_10k">$5k–$10k</option><option value="10k_25k">$10k–$25k</option><option value="25k_plus">$25k+</option></select></label>
        <label><span>Decision maker</span><select name="decisionMaker" value={form.decisionMaker || ''} onChange={update}><option value="">Unknown</option><option value="yes">Yes</option><option value="influencer">Influencer</option><option value="no">No</option></select></label>
        <label className="full"><span>Primary problem</span><textarea name="primaryProblem" value={form.primaryProblem || ''} onChange={update} rows="2" /></label>
        <label><span>Lost reason</span><select name="lostReason" value={form.lostReason || ''} onChange={update}><option value="">Not lost / unknown</option><option value="price">Price</option><option value="timing">Timing</option><option value="no_response">No response</option><option value="competitor">Competitor</option><option value="poor_fit">Poor fit</option><option value="internal_solution">Internal solution</option><option value="other">Other</option></select></label>
        <label><span>Competitor</span><input name="competitor" value={form.competitor || ''} onChange={update} /></label>
      </div>

      <div className="panel-section-label">Appointment</div>
      <div className="lead-form-grid">
        <label><span>Outcome</span><select name="appointmentStatus" value={form.appointmentStatus || 'none'} onChange={update}><option value="none">Not booked</option><option value="booked">Booked</option><option value="rescheduled">Rescheduled</option><option value="cancelled">Cancelled</option><option value="attended">Attended</option><option value="no_show">No-show</option></select></label>
        <label><span>Scheduled for</span><input name="scheduledFor" type="datetime-local" value={form.scheduledFor || ''} onChange={update} /></label>
      </div>

      <div className="panel-section-label">Economics</div>
      <div className="lead-form-grid money-grid">
        {[['quotedValue', 'Quoted value'], ['contractValue', 'Contract value'], ['cashCollected', 'Cash collected'], ['recurringMonthlyRevenue', 'Monthly recurring'], ['estimatedHours', 'Estimated hours'], ['actualHours', 'Actual hours'], ['loadedLaborCost', 'Loaded labor cost'], ['contractorCost', 'Contractor cost'], ['softwareCost', 'Software cost'], ['refunds', 'Refunds']].map(([name, label]) => (
          <label key={name}><span>{label}</span><input name={name} type="number" min="0" step={name.includes('Hours') || name.endsWith('Hours') ? '0.25' : '0.01'} value={form[name] ?? ''} onChange={update} /></label>
        ))}
      </div>
      <div className="lead-profit-preview"><span>Projected gross profit</span><strong>{money(projectedProfit)}</strong><small>Contract value less labor, contractor, software and refunds</small></div>
      <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save commercial details'}</button>
    </form>
  );
}

function ActivityHistory({ leadId, refreshKey }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let active = true;
    loadLeadActivities(leadId).then(data => active && setRows(data)).catch(() => active && setRows([]));
    return () => { active = false; };
  }, [leadId, refreshKey]);
  if (!rows.length) return null;
  return <div><div className="panel-section-label">Activity</div><div className="lead-activity">{rows.map(row => <div key={row.id}><span>{row.type === 'stage_change' ? `${row.fromStatus} → ${row.toStatus}` : row.type === 'email_sent' ? `Email sent · ${row.subject || 'Follow-up'}` : 'Commercial details updated'}</span><time>{when(row.at)}</time></div>)}</div></div>;
}

export default function Leads() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { rows, loading, error, refresh } = useLeads();
  const [openId, setOpenId] = useState(() => searchParams.get('lead'));
  const [filter, setFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [activityRefresh, setActivityRefresh] = useState(0);

  const openLead = id => {
    setOpenId(id);
    const updated = new URLSearchParams(searchParams);
    updated.set('lead', id);
    setSearchParams(updated, { replace: true });
  };

  const closeLead = () => {
    setOpenId(null);
    const updated = new URLSearchParams(searchParams);
    updated.delete('lead');
    setSearchParams(updated, { replace: true });
  };

  const counts = useMemo(() => {
    const map = new Map();
    for (const lead of rows) {
      const status = lead.status || 'new';
      map.set(status, (map.get(status) || 0) + 1);
    }
    return map;
  }, [rows]);

  const sourceCounts = useMemo(() => {
    const map = new Map();
    for (const lead of rows) map.set(lead.source, (map.get(lead.source) || 0) + 1);
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(lead => {
      if (filter !== 'all' && (lead.status || 'new') !== filter) return false;
      if (sourceFilter !== 'all' && lead.source !== sourceFilter) return false;
      if (!term) return true;
      return [lead.name, lead.email, lead.phone, lead.businessName, lead.projectDetails, lead.voice?.summary]
        .filter(Boolean)
        .some(value => value.toLowerCase().includes(term));
    });
  }, [rows, filter, sourceFilter, search]);

  const open = rows.find(lead => lead.id === openId) || null;

  const changeStatus = async (id, status) => {
    setBusy(true);
    setNotice('');
    try {
      await setLeadStatus(id, status, open || {});
      await refresh();
      setActivityRefresh(value => value + 1);
    } catch (err) {
      setNotice(err?.code === 'permission-denied'
        ? 'The server rejected that change.'
        : err?.message || 'Could not update the lead.');
    } finally {
      setBusy(false);
    }
  };

  const saveCommercial = async fields => {
    if (!open) return;
    setBusy(true);
    setNotice('');
    try {
      await saveLeadCommercial(open.id, fields);
      await refresh();
      setActivityRefresh(value => value + 1);
    } catch (err) {
      setNotice(err?.code === 'permission-denied' ? 'The server rejected that change.' : err?.message || 'Could not save commercial details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Leads</h1>
          <p className="admin-topbar-sub">
            {rows.length} most recent {rows.length === 1 ? 'enquiry' : 'enquiries'}
          </p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          <input
            className="admin-search"
            type="search"
            placeholder="Search name, email, company…"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <select className="admin-select" value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">All statuses</option>
            {STATUSES.map(status => (
              <option key={status} value={status}>
                {status} {counts.get(status) ? `(${counts.get(status)})` : ''}
              </option>
            ))}
          </select>
          <select
            className="admin-select"
            value={sourceFilter}
            onChange={event => setSourceFilter(event.target.value)}
            aria-label="Source"
          >
            <option value="all">All sources</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label} {sourceCounts.get(value) ? `(${sourceCounts.get(value)})` : ''}
              </option>
            ))}
          </select>
          <button className="btn-admin" type="button" onClick={refresh}>Refresh</button>
        </div>
      </header>

      <div className={`admin-body ${loading ? 'is-refreshing' : ''}`}>
        {error && <p className="admin-error">{error}</p>}
        {notice && <p className="admin-error">{notice}</p>}

        <div className="admin-card">
          {!visible.length ? (
            <div className="admin-empty">
              <strong>{rows.length ? 'Nothing matches that filter' : 'No leads yet'}</strong>
              {rows.length
                ? 'Try a different status or clear the search.'
                : 'They appear here the moment someone submits a form.'}
            </div>
          ) : (
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Services</th>
                    <th>Source</th>
                    <th>Received by</th>
                    <th>Status</th>
                    <th>CRM</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(lead => (
                    <tr
                      key={lead.id}
                      className={`clickable ${openId === lead.id ? 'selected' : ''}`}
                      onClick={() => openLead(lead.id)}
                    >
                      <td>
                        <div className="cell-strong">{lead.name}</div>
                        <div className="cell-dim">{contact(lead)}</div>
                      </td>
                      <td className="cell-wrap">{services(lead) || '—'}</td>
                      <td className="cell-dim">
                        {sourceLabel(lead)}
                        {/* A website-demo caller is still a lead, but worth
                            telling apart from someone who dialled the number. */}
                        {lead.voice?.demo && <span className="chip" style={{ marginLeft: 6 }}>demo</span>}
                        {lead.source === 'outbound' && (
                          <span className={`chip ${lead.acquisition?.trigger === 'manual_qualification' ? 'warning' : 'success'}`} style={{ marginLeft: 6 }}>
                            {lead.acquisition?.trigger === 'manual_qualification' ? 'manual · no verified call' : 'verified call'}
                          </span>
                        )}
                      </td>
                      <td className="cell-dim cell-wrap">
                        {lead.source === 'byte_voice' ? receivingAgentLabel(lead) : '—'}
                      </td>
                      <td><Pill kind={lead.status || 'new'}>{lead.status || 'new'}</Pill></td>
                      <td className="cell-dim">
                        {lead.crm?.synced ? 'Synced' : lead.crm?.error ? 'Failed' : '—'}
                      </td>
                      <td className="cell-dim">{when(lead.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {open && (
        <Panel
          title={open.name}
          subtitle={`${sourceLabel(open)} · ${when(open.createdAt)}`}
          onClose={closeLead}
        >
          {open.email && <div className="lead-primary-action"><div><strong>Follow up with {firstWord(open.name) || 'this lead'}</strong><span>Send a confirmation, Meet link, or booking page.</span></div><Link className="btn-admin primary" to={`/admin/email?lead=${encodeURIComponent(open.id)}`}>Email lead</Link></div>}
          <OutboundProvenance lead={open} />
          <div>
            <div className="panel-section-label">Status</div>
            <div className="chip-row" style={{ marginTop: 10 }}>
              {STATUSES.map(status => (
                <button
                  key={status}
                  type="button"
                  disabled={busy}
                  className={`btn-admin ${(open.status || 'new') === status ? 'primary' : ''}`}
                  onClick={() => changeStatus(open.id, status)}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <DetailRows
            rows={[
              ['Email', open.email ? <a href={`mailto:${open.email}`}>{open.email}</a> : ''],
              ['Phone', open.phone ? <a href={`tel:${open.phone}`}>{open.phone}</a> : ''],
              ['Company', open.businessName],
              ...(open.source === 'byte_voice' ? [
                ['Received by', receivingAgent(open).agentName],
                ['Client', receivingAgent(open).clientName]
              ] : []),
              ['Role', open.roleInCompany],
              ['Business size', SIZE_LABELS[open.businessSize] || open.businessSize],
              ['Timeline', URGENCY_LABELS[open.urgencyTag] || open.urgencyTag],
              ['Services', services(open)],
              ['Prefers', open.preferredContactMethod],
              ['From page', open.pagePath],
              ['Referrer', open.referrer],
              ['First-touch source', open.attribution?.first?.source],
              ['First-touch medium', open.attribution?.first?.medium],
              ['Campaign', open.attribution?.first?.campaign],
              ['Converting CTA', open.attribution?.conversion?.cta],
              ['Plan interest', open.attribution?.conversion?.plan],
              ['First response', open.firstResponseAt ? when(open.firstResponseAt) : ''],
              ['Next follow-up', open.nextFollowUpAt ? when(open.nextFollowUpAt) : '']
            ]}
          />

          <CommercialEditor lead={open} busy={busy} onSave={saveCommercial} />

          <ActivityHistory leadId={open.id} refreshKey={activityRefresh} />

          {open.projectDetails && (
            <div>
              <div className="panel-section-label">Project details</div>
              <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{open.projectDetails}</p>
            </div>
          )}

          {open.voice?.appointment && (
            <div>
              <div className="panel-section-label">Booked meeting</div>
              <DetailRows
                rows={[
                  ['Meeting time', open.voice.appointment.spoken
                    || (open.voice.appointment.startIso ? when(open.voice.appointment.startIso) : '')],
                  ['Confirmation', open.voice.appointment.confirmationRef],
                  ['Appointment', open.voice.appointment.id]
                ]}
              />
            </div>
          )}

          {open.voice && (
            <div>
              <div className="panel-section-label">The call</div>
              <DetailRows
                rows={[
                  // Only meaningful once someone has rung more than once.
                  ['Calls', open.voice.callCount > 1 ? `${open.voice.callCount} calls` : ''],
                  ['Received by', receivingAgent(open).agentName],
                  ['Client', receivingAgent(open).clientName],
                  ['Last call', open.voice.lastCallAt ? when(open.voice.lastCallAt) : ''],
                  ['Length', callLength(open.voice.durationSec)],
                  ['Placed from', open.voice.demo ? 'Website demo' : open.phone ? 'Phone' : ''],
                  ['Recording', open.voice.recordingUrl
                    ? <a href={open.voice.recordingUrl} target="_blank" rel="noreferrer">Listen</a>
                    : ''],
                  ['GoHighLevel call', open.voice.providerCallId]
                ]}
              />
              {open.voice.summary && (
                <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{open.voice.summary}</p>
              )}
              {open.voice.callId && (
                <div style={{ marginTop: 12 }}>
                  <Transcript collection="calls" sub="turns" agent={receivingAgent(open).agentName} id={open.voice.callId} />
                </div>
              )}
            </div>
          )}

          {open.customAnswers && Object.keys(open.customAnswers).length > 0 && (
            <div>
              <div className="panel-section-label">In their own words</div>
              <div className="chip-row" style={{ marginTop: 10 }}>
                {Object.entries(open.customAnswers).map(([key, value]) => (
                  <span className="chip" key={key}><b>{key}</b> {value}</span>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="panel-section-label">CRM</div>
            <div style={{ marginTop: 8 }}><CrmState crm={open.crm} /></div>
          </div>
        </Panel>
      )}
    </>
  );
}
