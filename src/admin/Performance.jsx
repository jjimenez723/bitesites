import React, { useMemo, useState } from 'react';
import { useEvents, useLeads, useClientOutcomes, useSearchMetrics, useAnalyticsDaily, addClientOutcome, toDate } from './data';
import { StatTile, Funnel, RankList, compact, share } from './charts';

const RANGES = [[7, '7d'], [30, '30d'], [90, '90d']];
const STAGES = ['new', 'contacted', 'qualified', 'booked', 'proposal', 'won'];
const money = value => Number(value || 0).toLocaleString(undefined, {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0
});
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const inRange = (value, days) => {
  const date = toDate(value);
  return date && Date.now() - date.getTime() <= days * 86400000;
};
const reached = (lead, stage) => {
  if (lead.stageTimestamps?.[stage]) return true;
  if (stage === 'booked' && ['booked', 'rescheduled', 'attended', 'no_show'].includes(lead.appointment?.status)) return true;
  const current = STAGES.indexOf(lead.status || 'new');
  const target = STAGES.indexOf(stage);
  return current >= target && current >= 0 && target >= 0;
};

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function performance(leads) {
  const economics = leads.reduce((total, lead) => {
    const values = lead.economics || {};
    total.contract += numeric(values.contractValue);
    total.collected += numeric(values.cashCollected);
    total.profit += numeric(values.grossProfit);
    total.mrr += numeric(values.recurringMonthlyRevenue);
    return total;
  }, { contract: 0, collected: 0, profit: 0, mrr: 0 });

  const responseHours = leads.map(lead => {
    const created = toDate(lead.createdAt);
    const responded = toDate(lead.firstResponseAt);
    return created && responded ? Math.max(0, (responded - created) / 3600000) : NaN;
  });

  const bySource = new Map();
  const byService = new Map();
  const losses = new Map();
  for (const lead of leads) {
    const touch = lead.attribution?.first;
    const source = touch?.source || (lead.source === 'byte_voice' ? 'phone / Byte' : lead.referrer || 'unattributed');
    const sourceRow = bySource.get(source) || { label: source, leads: 0, qualified: 0, wins: 0, revenue: 0, profit: 0 };
    sourceRow.leads += 1;
    if (reached(lead, 'qualified')) sourceRow.qualified += 1;
    if (lead.status === 'won') sourceRow.wins += 1;
    sourceRow.revenue += numeric(lead.economics?.contractValue);
    sourceRow.profit += numeric(lead.economics?.grossProfit);
    bySource.set(source, sourceRow);

    for (const service of lead.services || ['unknown']) {
      const row = byService.get(service) || { label: service.replaceAll('_', ' '), leads: 0, wins: 0, revenue: 0, profit: 0 };
      row.leads += 1;
      if (lead.status === 'won') row.wins += 1;
      row.revenue += numeric(lead.economics?.contractValue);
      row.profit += numeric(lead.economics?.grossProfit);
      byService.set(service, row);
    }
    const reason = lead.qualification?.lostReason;
    if (reason) losses.set(reason, (losses.get(reason) || 0) + 1);
  }

  return {
    economics,
    responseMedian: median(responseHours),
    stages: STAGES.map(stage => ({ label: stage[0].toUpperCase() + stage.slice(1), count: leads.filter(lead => reached(lead, stage)).length })),
    sources: [...bySource.values()].sort((a, b) => b.profit - a.profit || b.leads - a.leads),
    services: [...byService.values()].sort((a, b) => b.profit - a.profit || b.leads - a.leads),
    losses: [...losses.entries()].map(([label, value]) => ({ label: label.replaceAll('_', ' '), value })).sort((a, b) => b.value - a.value),
    attributed: leads.filter(lead => lead.attribution?.first?.source).length
  };
}

function OutcomeForm({ onSaved }) {
  const [form, setForm] = useState({ periodStart: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const data = {
        clientName: String(form.clientName || '').trim(),
        projectName: String(form.projectName || '').trim(),
        periodStart: new Date(`${form.periodStart}T12:00:00`)
      };
      for (const key of ['websiteLeads', 'qualifiedLeads', 'callsAnswered', 'callsMissed', 'appointmentsBooked', 'appointmentsAttended', 'revenue', 'escalations', 'failedIntents', 'satisfaction']) {
        data[key] = Math.max(0, numeric(form[key]));
      }
      await addClientOutcome(data);
      setNotice('Client outcome recorded.');
      setForm({ periodStart: new Date().toISOString().slice(0, 10) });
      await onSaved();
    } catch (error) {
      setNotice(error?.message || 'Could not record the outcome.');
    } finally { setBusy(false); }
  };
  return <form className="outcome-form" onSubmit={submit}>
    <div className="outcome-form-grid">
      <label><span>Client</span><input name="clientName" value={form.clientName || ''} onChange={update} required /></label>
      <label><span>Project / system</span><input name="projectName" value={form.projectName || ''} onChange={update} /></label>
      <label><span>Period starting</span><input type="date" name="periodStart" value={form.periodStart || ''} onChange={update} required /></label>
      {[['websiteLeads', 'Website leads'], ['qualifiedLeads', 'Qualified leads'], ['callsAnswered', 'Calls answered'], ['callsMissed', 'Calls missed'], ['appointmentsBooked', 'Appointments booked'], ['appointmentsAttended', 'Appointments attended'], ['revenue', 'Attributed revenue'], ['escalations', 'AI escalations'], ['failedIntents', 'Failed intents'], ['satisfaction', 'Satisfaction (1–5)']].map(([name, label]) => <label key={name}><span>{label}</span><input name={name} type="number" min="0" step={name === 'satisfaction' ? '0.1' : '1'} max={name === 'satisfaction' ? '5' : undefined} value={form[name] || ''} onChange={update} /></label>)}
    </div>
    <button className="btn-admin primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record outcome'}</button>
    {notice && <p className="admin-note">{notice}</p>}
  </form>;
}

export default function Performance() {
  const [days, setDays] = useState(30);
  const { rows: allLeads, loading: leadsLoading, error: leadsError, capped: leadsCapped, refresh: refreshLeads } = useLeads();
  const { rows: events, loading: eventsLoading, error: eventsError, capped: eventsCapped } = useEvents(days);
  const { rows: outcomes, refresh: refreshOutcomes } = useClientOutcomes();
  const { rows: searchRows, error: searchError, capped: searchCapped } = useSearchMetrics(days);
  const { rows: dailyRows } = useAnalyticsDaily(days);
  const leads = useMemo(() => allLeads.filter(lead => inRange(lead.createdAt, days)), [allLeads, days]);
  const summary = useMemo(() => performance(leads), [leads]);

  const webFunnel = useMemo(() => {
    if (dailyRows.length) {
      const sessionCount = type => dailyRows.reduce((sum, row) => sum + numeric(row.sessionCounts?.[type]), 0);
      const visits = dailyRows.reduce((sum, row) => sum + numeric(row.sessions), 0);
      return {
        visits,
        durable: true,
        steps: [
          { label: 'Visited', count: visits },
          { label: 'Pricing viewed', count: sessionCount('pricing_view') },
          { label: 'Form started', count: sessionCount('form_start') },
          { label: 'Lead created', count: sessionCount('lead_created') },
          { label: 'Calendar opened', count: sessionCount('booking_click') }
        ]
      };
    }
    const byType = type => new Set(events.filter(event => event.type === type).map(event => event.sid).filter(Boolean)).size;
    const visits = byType('page_view');
    return {
      visits,
      steps: [
        { label: 'Visited', count: visits },
        { label: 'Pricing viewed', count: byType('pricing_view') },
        { label: 'Form started', count: byType('form_start') },
        { label: 'Lead created', count: byType('lead_created') },
        { label: 'Calendar opened', count: byType('booking_click') }
      ]
    };
  }, [events, dailyRows]);

  const clientSummary = useMemo(() => {
    const map = new Map();
    for (const row of outcomes.filter(item => inRange(item.periodStart, days))) {
      const current = map.get(row.clientName) || { label: row.clientName, leads: 0, qualified: 0, appointments: 0, attended: 0, revenue: 0, calls: 0, missed: 0, escalations: 0, failed: 0, satisfactionTotal: 0, satisfactionCount: 0 };
      current.leads += numeric(row.websiteLeads);
      current.qualified += numeric(row.qualifiedLeads);
      current.appointments += numeric(row.appointmentsBooked);
      current.attended += numeric(row.appointmentsAttended);
      current.revenue += numeric(row.revenue);
      current.calls += numeric(row.callsAnswered);
      current.missed += numeric(row.callsMissed);
      current.escalations += numeric(row.escalations);
      current.failed += numeric(row.failedIntents);
      if (numeric(row.satisfaction) > 0) {
        current.satisfactionTotal += numeric(row.satisfaction);
        current.satisfactionCount += 1;
      }
      map.set(row.clientName, current);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [outcomes, days]);

  const searchSummary = useMemo(() => {
    const queries = new Map();
    const pages = new Map();
    let clicks = 0;
    let impressions = 0;
    for (const row of searchRows) {
      clicks += numeric(row.clicks);
      impressions += numeric(row.impressions);
      const query = queries.get(row.query) || { label: row.query, clicks: 0, impressions: 0, weightedPosition: 0 };
      query.clicks += numeric(row.clicks);
      query.impressions += numeric(row.impressions);
      query.weightedPosition += numeric(row.position) * Math.max(1, numeric(row.impressions));
      queries.set(row.query, query);
      const pageLabel = String(row.page || '').replace(/^https?:\/\/[^/]+/, '') || '/';
      const page = pages.get(pageLabel) || { label: pageLabel, value: 0, impressions: 0 };
      page.value += numeric(row.clicks);
      page.impressions += numeric(row.impressions);
      pages.set(pageLabel, page);
    }
    const opportunities = [...queries.values()].map(row => ({
      ...row,
      position: row.impressions ? row.weightedPosition / row.impressions : 0,
      value: Math.max(0, row.impressions - row.clicks)
    })).filter(row => row.impressions >= 5 && row.position <= 20)
      .sort((a, b) => b.value - a.value).slice(0, 10)
      .map(row => ({ label: row.label, value: row.value, note: `${compact(row.clicks)} clicks · pos ${row.position.toFixed(1)}` }));
    return {
      clicks, impressions, ctr: impressions ? (clicks / impressions) * 100 : 0,
      opportunities,
      pages: [...pages.values()].sort((a, b) => b.value - a.value).slice(0, 10)
        .map(row => ({ ...row, note: `${compact(row.impressions)} impressions` }))
    };
  }, [searchRows]);

  const qualified = summary.stages.find(stage => stage.label === 'Qualified')?.count || 0;
  const booked = summary.stages.find(stage => stage.label === 'Booked')?.count || 0;
  const won = summary.stages.find(stage => stage.label === 'Won')?.count || 0;

  return <>
    <header className="admin-topbar"><div><h1>Performance</h1><p className="admin-topbar-sub">Acquisition, sales, profit and client outcomes.</p></div><div className="admin-topbar-spacer" /><div className="admin-filters"><div className="admin-segment" role="group" aria-label="Date range">{RANGES.map(([value, label]) => <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>{label}</button>)}</div><button className="btn-admin" type="button" onClick={refreshLeads}>Refresh</button></div></header>
    <div className={`admin-body ${leadsLoading || eventsLoading ? 'is-refreshing' : ''}`}>
      {(leadsError || eventsError) && <p className="admin-error">{leadsError || eventsError}</p>}
      {(leadsCapped || (!dailyRows.length && eventsCapped) || searchCapped) && <p className="admin-note">Some results reached their safety read limit. Totals shown for the affected section are a lower bound; shorten the date range for an exact comparison.</p>}
      <div className="admin-grid cols-4">
        <StatTile label="Qualified rate" value={`${share(qualified, leads.length)}%`} foot={`${qualified} of ${leads.length} leads`} />
        <StatTile label="Booking rate" value={`${share(booked, leads.length)}%`} foot={`${booked} leads reached booked`} />
        <StatTile label="Win rate" value={`${share(won, qualified)}%`} foot={`${won} of ${qualified} qualified`} />
        <StatTile label="Median first response" value={summary.responseMedian == null ? '—' : `${summary.responseMedian.toFixed(summary.responseMedian < 1 ? 1 : 0)}h`} foot="from lead creation" />
      </div>
      <div className="admin-grid cols-4">
        <StatTile label="Contracted revenue" value={money(summary.economics.contract)} />
        <StatTile label="Cash collected" value={money(summary.economics.collected)} />
        <StatTile label="Gross profit" value={money(summary.economics.profit)} foot={summary.economics.contract ? `${share(summary.economics.profit, summary.economics.contract)}% margin` : undefined} />
        <StatTile label="New monthly recurring" value={money(summary.economics.mrr)} />
      </div>

      <div className="admin-grid cols-2">
        <div className="admin-card"><div className="card-head"><div><h3>Website conversion path</h3><p>Unique sessions at each measurable step{webFunnel.durable ? ', from durable daily totals' : ''}.</p></div></div><Funnel steps={webFunnel.steps} total={webFunnel.visits} empty="No website conversion events in this range." /></div>
        <div className="admin-card"><div className="card-head"><div><h3>Sales pipeline</h3><p>Lead cohorts reaching each stage.</p></div></div><Funnel steps={summary.stages} total={leads.length} empty="No leads in this range." /></div>
      </div>

      <div className="admin-grid cols-2">
        <div className="admin-card"><div className="card-head"><div><h3>Organic search opportunities</h3><p>High-impression queries ranking on page one or two with clicks still available.</p></div></div>{searchError ? <p className="admin-error">{searchError}</p> : <RankList rows={searchSummary.opportunities} empty="No Search Console data yet. Grant the function service account property access to begin the daily sync." />}</div>
        <div className="admin-card"><div className="card-head"><div><h3>Organic landing pages</h3><p>{searchSummary.impressions ? `${compact(searchSummary.clicks)} clicks from ${compact(searchSummary.impressions)} impressions · ${searchSummary.ctr.toFixed(1)}% CTR` : 'Clicks and impressions by landing page.'}</p></div></div><RankList rows={searchSummary.pages} empty="No Search Console page data in this range." /></div>
      </div>

      <div className="admin-card"><div className="card-head"><div><h3>Acquisition quality and profit</h3><p>First-touch source, joined directly to the resulting lead.</p></div></div><div className="admin-table-scroll"><table className="admin-table performance-table"><thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Qualified</th><th className="num">Won</th><th className="num">Revenue</th><th className="num">Gross profit</th></tr></thead><tbody>{summary.sources.map(row => <tr key={row.label}><td className="cell-strong">{row.label}</td><td className="num">{row.leads}</td><td className="num">{row.qualified}</td><td className="num">{row.wins}</td><td className="num">{money(row.revenue)}</td><td className="num">{money(row.profit)}</td></tr>)}</tbody></table></div>{!summary.sources.length && <div className="admin-empty">No leads in this range.</div>}<p className="admin-note attribution-note">Attribution coverage: {summary.attributed}/{leads.length} leads ({share(summary.attributed, leads.length)}%). Legacy leads remain unattributed.</p></div>

      <div className="admin-grid cols-2">
        <div className="admin-card"><div className="card-head"><div><h3>Services by gross profit</h3><p>Use this to focus sales effort and refine packaging.</p></div></div><div className="admin-table-scroll"><table className="admin-table performance-table"><thead><tr><th>Service</th><th className="num">Leads</th><th className="num">Won</th><th className="num">Revenue</th><th className="num">Profit</th></tr></thead><tbody>{summary.services.map(row => <tr key={row.label}><td>{row.label}</td><td className="num">{row.leads}</td><td className="num">{row.wins}</td><td className="num">{money(row.revenue)}</td><td className="num">{money(row.profit)}</td></tr>)}</tbody></table></div></div>
        <div className="admin-card"><div className="card-head"><div><h3>Why opportunities are lost</h3><p>Structured reasons entered during lead review.</p></div></div><RankList rows={summary.losses} empty="No loss reasons recorded in this range." /></div>
      </div>

      <div className="admin-card"><div className="card-head"><div><h3>Client outcomes</h3><p>Standardised results prove ROI and reveal service issues.</p></div></div>{clientSummary.length ? <div className="admin-table-scroll"><table className="admin-table performance-table"><thead><tr><th>Client</th><th className="num">Leads</th><th className="num">Qualified</th><th className="num">Calls answered</th><th className="num">Appointments</th><th className="num">Show rate</th><th className="num">Failed intents</th><th className="num">Escalations</th><th className="num">Satisfaction</th><th className="num">Revenue</th></tr></thead><tbody>{clientSummary.map(row => <tr key={row.label}><td className="cell-strong">{row.label}</td><td className="num">{compact(row.leads)}</td><td className="num">{compact(row.qualified)}</td><td className="num">{compact(row.calls)}</td><td className="num">{compact(row.appointments)}</td><td className="num">{share(row.attended, row.appointments)}%</td><td className="num">{compact(row.failed)}</td><td className="num">{compact(row.escalations)}</td><td className="num">{row.satisfactionCount ? `${(row.satisfactionTotal / row.satisfactionCount).toFixed(1)}/5` : '—'}</td><td className="num">{money(row.revenue)}</td></tr>)}</tbody></table></div> : <div className="admin-empty">No client outcome snapshots in this range.</div>}<details className="outcome-entry"><summary>Record a client outcome</summary><OutcomeForm onSaved={refreshOutcomes} /></details></div>
    </div>
  </>;
}
