// Every enquiry from the intake form and the Bit chat, with triage.
//
// Status is the only field this screen writes. firestore.rules holds createdAt
// and email immutable on update, so triage can never quietly rewrite who a lead
// was or when it arrived.

import React, { useMemo, useState } from 'react';
import { useLeads, setLeadStatus, toDate } from './data';
import { Panel, DetailRows, Pill } from './Panel';

const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];

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

function CrmState({ crm }) {
  if (!crm) return <p className="admin-note">No sync recorded yet.</p>;
  if (crm.synced) return <p className="admin-note">Synced to GoHighLevel · {when(crm.at)}</p>;
  if (crm.reason === 'not-configured') {
    return <p className="admin-note">Not sent — no GoHighLevel webhook is configured.</p>;
  }
  return <p className="admin-error">Sync failed — {crm.error || 'unknown error'}</p>;
}

export default function Leads() {
  const { rows, loading, error, refresh } = useLeads();
  const [openId, setOpenId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const counts = useMemo(() => {
    const map = new Map();
    for (const lead of rows) {
      const status = lead.status || 'new';
      map.set(status, (map.get(status) || 0) + 1);
    }
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(lead => {
      if (filter !== 'all' && (lead.status || 'new') !== filter) return false;
      if (!term) return true;
      return [lead.name, lead.email, lead.businessName, lead.projectDetails]
        .filter(Boolean)
        .some(value => value.toLowerCase().includes(term));
    });
  }, [rows, filter, search]);

  const open = rows.find(lead => lead.id === openId) || null;

  const changeStatus = async (id, status) => {
    setBusy(true);
    setNotice('');
    try {
      await setLeadStatus(id, status);
      await refresh();
    } catch (err) {
      setNotice(err?.code === 'permission-denied'
        ? 'The server rejected that change.'
        : err?.message || 'Could not update the lead.');
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
                      onClick={() => setOpenId(lead.id)}
                    >
                      <td>
                        <div className="cell-strong">{lead.name}</div>
                        <div className="cell-dim">{lead.email}</div>
                      </td>
                      <td className="cell-wrap">{services(lead)}</td>
                      <td className="cell-dim">{lead.source === 'bit_chat' ? 'Bit chat' : 'Intake form'}</td>
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
          subtitle={`${open.source === 'bit_chat' ? 'Bit chat' : 'Intake form'} · ${when(open.createdAt)}`}
          onClose={() => setOpenId(null)}
        >
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
              ['Email', <a href={`mailto:${open.email}`}>{open.email}</a>],
              ['Phone', open.phone ? <a href={`tel:${open.phone}`}>{open.phone}</a> : ''],
              ['Company', open.businessName],
              ['Role', open.roleInCompany],
              ['Business size', SIZE_LABELS[open.businessSize] || open.businessSize],
              ['Timeline', URGENCY_LABELS[open.urgencyTag] || open.urgencyTag],
              ['Services', services(open)],
              ['Prefers', open.preferredContactMethod],
              ['From page', open.pagePath],
              ['Referrer', open.referrer]
            ]}
          />

          {open.projectDetails && (
            <div>
              <div className="panel-section-label">Project details</div>
              <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{open.projectDetails}</p>
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
