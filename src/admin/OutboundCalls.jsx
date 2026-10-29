// Outbound Calls — lead discovery, sales orchestration, AI agents and dialer.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCampaigns, outbound } from './outbound/data';
import CampaignList from './outbound/CampaignList';
import LeadDiscovery from './outbound/LeadDiscovery';
import ProspectList from './outbound/ProspectList';
import ProspectDetail from './outbound/ProspectDetail';
import ImportReview from './outbound/ImportReview';
import LeadQueue from './outbound/LeadQueue';
import DialerControls from './outbound/DialerControls';
import QuickDial from './outbound/QuickDial';
import CallLaterQueue from './outbound/CallLaterQueue';
import CallHistory from './outbound/CallHistory';
import ProviderStatus from './outbound/ProviderStatus';
import AgentProfiles from './outbound/AgentProfiles';
import AppointmentCalendar from './outbound/AppointmentCalendar';
import TransferInbox from './outbound/TransferInbox';
import TeamCallCoach from './outbound/TeamCallCoach';
import ConsentRegistry from './outbound/ConsentRegistry';
import EligibilityAudit from './outbound/EligibilityAudit';
import RepTraining from './outbound/RepTraining';
import './outbound/outbound.css';
import './outbound/hybrid.css';
import './outbound/agents.css';

const TABS = [
  ['training', 'AI Training'],
  ['campaigns', 'Campaigns'],
  ['discovery', 'Lead Discovery'],
  ['prospects', 'Prospects'],
  ['review', 'Import Review'],
  ['queue', 'Queue'],
  ['dialer', 'Dialer'],
  ['coaching', 'Team Coaching'],
  ['agents', 'AI Agents'],
  ['consent', 'AI Consent'],
  ['eligibility', 'Eligibility Audit'],
  ['calendar', 'Calendar'],
  ['later', 'Call Later'],
  ['history', 'History'],
  ['settings', 'Settings']
];

// Keep the console organized around the work a person is doing, not the
// collections in Firestore.  The key list above remains the single authority
// for permissions and deep links; this only supplies visual hierarchy.
const TAB_GROUPS = [
  { key: 'onboard', label: 'Onboarding', tabs: ['training'] },
  { key: 'operate', label: 'Operate', tabs: ['campaigns', 'queue', 'dialer', 'calendar', 'history'] },
  { key: 'build', label: 'Build', tabs: ['prospects', 'agents'] },
  { key: 'monitor', label: 'Monitor', tabs: ['coaching', 'later', 'settings'] },
  { key: 'admin', label: 'Admin', tabs: ['discovery', 'review', 'consent', 'eligibility'] }
];

const REP_TAB_KEYS = new Set(['training', 'queue', 'dialer', 'calendar', 'later', 'history']);
const MANAGER_TAB_KEYS = new Set([
  'campaigns', 'prospects', 'queue', 'dialer', 'coaching', 'agents',
  'calendar', 'later', 'history', 'settings'
]);

export default function OutboundCalls({ role = 'admin', currentUid = '' }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const canManage = role !== 'outbound_rep';
  const [repTraining, setRepTraining] = useState({ accounts: [], loading: role === 'outbound_rep', error: null });
  const trainingExempt = role === 'outbound_rep' && repTraining.accounts.length > 0
    && repTraining.accounts.every(account => account.trainingExempt);
  const needsRepOnboarding = repTraining.accounts.some(account =>
    !account.trainingExempt && (!account.passed || !account.campaignAssigned));
  const visibleTabs = useMemo(
    () => canManage
      ? TABS.filter(([key]) => key !== 'training' && (role === 'admin' || MANAGER_TAB_KEYS.has(key)))
      : TABS.filter(([key]) => REP_TAB_KEYS.has(key) && !(trainingExempt && key === 'training')),
    [canManage, role, trainingExempt]
  );
  const orderedTabs = useMemo(() => TAB_GROUPS.flatMap(group => group.tabs
    .map(key => visibleTabs.find(([tabKey]) => tabKey === key))
    .filter(Boolean)), [visibleTabs]);
  const requestedTab = searchParams.get('tab');
  const initialTab = role === 'outbound_rep'
    ? 'training'
    : visibleTabs.some(([key]) => key === requestedTab)
      ? requestedTab
      : 'campaigns';
  const [tab, setTabState] = useState(initialTab);
  const [campaignId, setCampaignId] = useState('');
  const [prospectId, setProspectId] = useState(null);
  const [queueEntry, setQueueEntry] = useState({ group: 'workable', key: 0 });
  // The dialer opens on the one-button human flow. The guided AI setup is a
  // deliberate detour, not the thing you have to get past to make a call.
  const [dialerAdvanced, setDialerAdvanced] = useState(false);
  const [config, setConfig] = useState({ data: null, loading: true, error: null });
  const tabRefs = useRef([]);
  const repTrainingInitialized = useRef(false);

  const accountIds = config.data?.accountIds || [];
  const allAccounts = config.data?.allAccounts === true || role === 'admin';
  const assignedTrainingAccountIds = useMemo(
    // Exempt reps use explicit campaign assignments; a global onboarding
    // default is not needed. The query and rules still enforce those assignments.
    () => repTraining.accounts.filter(account => account.trainingExempt || (account.passed && account.campaignAssigned)).map(account => account.accountId),
    [repTraining.accounts]
  );
  const campaignAccountIds = role === 'outbound_rep' ? assignedTrainingAccountIds : accountIds;
  const campaigns = useCampaigns(campaignAccountIds, role === 'outbound_rep' ? false : allAccounts, role, currentUid);

  const setTab = useCallback(next => {
    if (!visibleTabs.some(([key]) => key === next)) return;
    setTabState(next);
    const updated = new URLSearchParams(searchParams);
    updated.set('tab', next);
    setSearchParams(updated, { replace: true });
  }, [searchParams, setSearchParams, visibleTabs]);

  const openQueue = useCallback(group => {
    setQueueEntry(current => ({ group, key: current.key + 1 }));
    setTab('queue');
  }, [setTab]);

  useEffect(() => {
    const repBlocked = role === 'outbound_rep'
      && (repTraining.loading || repTraining.error || needsRepOnboarding);
    if (requestedTab && visibleTabs.some(([key]) => key === requestedTab) && requestedTab !== tab) {
      if (repBlocked && requestedTab !== 'training') return;
      setTabState(requestedTab);
    }
  }, [requestedTab, tab, visibleTabs, role, repTraining, needsRepOnboarding]);

  const loadConfig = useCallback(() => {
    setConfig(current => ({ ...current, loading: true }));
    outbound.config()
      .then(data => setConfig({ data, loading: false, error: null }))
      .catch(error => setConfig({
        data: null,
        loading: false,
        error: error?.code === 'functions/permission-denied'
          ? 'This account does not have access to outbound calling.'
          : `Could not load provider status: ${error?.message || 'the outbound functions may not be deployed yet.'}`
      }));
  }, []);

  useEffect(loadConfig, [loadConfig]);

  const loadRepTraining = useCallback(() => {
    if (role !== 'outbound_rep') return Promise.resolve();
    setRepTraining(current => ({ ...current, loading: true, error: null }));
    return outbound.repTrainingStatus()
      .then(result => setRepTraining({ accounts: result?.accounts || [], loading: false, error: null }))
      .catch(error => setRepTraining({
        accounts: [], loading: false,
        error: error?.code === 'functions/not-found' || error?.code === 'functions/internal'
          ? 'The required sales training service is unavailable in this environment. Try again later or ask a manager to check the release.'
          : error?.message || 'Could not load required sales training.'
      }));
  }, [role]);

  useEffect(() => { void loadRepTraining(); }, [loadRepTraining]);

  useEffect(() => {
    if (role !== 'outbound_rep' || repTraining.loading) return;
    if (repTraining.error) return;
    const needsTrainingOrAssignment = needsRepOnboarding;
    if (!repTrainingInitialized.current) {
      repTrainingInitialized.current = true;
      if (needsTrainingOrAssignment && tab !== 'training') setTab('training');
      else if (!needsTrainingOrAssignment && repTraining.accounts.length && tab === 'training') setTab('dialer');
      return;
    }
    if (needsTrainingOrAssignment && tab !== 'training') setTab('training');
    else if (trainingExempt && tab === 'training') setTab('dialer');
  }, [role, repTraining, tab, setTab, needsRepOnboarding, trainingExempt]);

  useEffect(() => {
    if (!campaignId && campaigns.rows.length) setCampaignId(campaigns.rows[0].id);
  }, [campaigns.rows, campaignId]);

  const onTabKeyDown = event => {
    const index = orderedTabs.findIndex(([key]) => key === tab);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = event.key === 'ArrowRight'
      ? (index + 1) % orderedTabs.length
      : (index - 1 + orderedTabs.length) % orderedTabs.length;
    setTab(orderedTabs[next][0]);
    tabRefs.current[next]?.focus();
  };

  const sources = config.data?.leadSources || [];
  const providers = config.data?.callingProviders || [];
  const activeCampaign = campaigns.rows.find(entry => entry.id === campaignId) || null;
  const groupedTabs = useMemo(() => TAB_GROUPS.map(group => ({
    ...group,
    tabs: group.tabs
      .map(key => visibleTabs.find(([tabKey]) => tabKey === key))
      .filter(Boolean)
  })).filter(group => group.tabs.length), [visibleTabs]);
  const campaignStatus = activeCampaign?.status || 'not selected';
  const campaignCounts = activeCampaign?.counts || {};

  if (role === 'outbound_rep' && (repTraining.loading || repTraining.error)) {
    return <>
      <header className="admin-topbar"><h1>Outbound Sales</h1></header>
      <div className="admin-body">
        {repTraining.error ? <>
          <p className="admin-error" role="alert">Could not check your calling access. Please try again.</p>
          <button className="btn-admin" type="button" onClick={loadRepTraining}>Try again</button>
        </> : <p role="status">Checking your calling access…</p>}
      </div>
    </>;
  }

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Outbound Sales</h1>
          <p className="admin-topbar-sub">
            {role === 'outbound_rep'
              ? 'Call your assigned prospects, save notes, and follow up after each conversation.'
              : 'Discover prospects, configure AI agents, run human + AI calls, and audit every outcome in one workspace.'}
          </p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          {activeCampaign?.status === 'running' && (
            <span className="pill running"><i />{activeCampaign.name} is running</span>
          )}
          <button className="btn-admin" type="button" onClick={() => { campaigns.refresh(); loadConfig(); void loadRepTraining(); }}>
            Refresh
          </button>
        </div>
      </header>

      <div className="admin-body">
        {!(role === 'outbound_rep' && needsRepOnboarding) && <section className="outbound-workspace-bar" aria-label="Current outbound workspace">
          <div className="outbound-workspace-copy">
            <span className="outbound-eyebrow">Current workspace</span>
            <h2>{activeCampaign?.name || 'Choose a campaign'}</h2>
            <p>
              {activeCampaign
                ? 'Open Dialer to start calling this list yourself. Starting a campaign only arms its queue; it never places a call by itself.'
                : 'Select a campaign to see its readiness, queue, dialer, and appointment context in one place.'}
            </p>
          </div>
          <dl className="outbound-workspace-stats">
            <div>
              <dt>Status</dt>
              <dd><span className={`pill ${campaignStatus}`}>{campaignStatus.replace(/_/g, ' ')}</span></dd>
            </div>
            <div>
              <dt>Ready</dt>
              <dd>{activeCampaign ? Number(campaignCounts.ready) || 0 : '—'}</dd>
            </div>
            <div>
              <dt>Awaiting review</dt>
              <dd>{activeCampaign ? Number(campaignCounts.pending) || 0 : '—'}</dd>
            </div>
          </dl>
          <div className="outbound-workspace-actions">
            {activeCampaign && (
              <button
                className="btn-admin"
                type="button"
                onClick={() => openQueue(Number(campaignCounts.pending) > 0 ? 'pending' : 'workable')}
              >
                Review queue
              </button>
            )}
            <button className="btn-admin" type="button" onClick={() => setTab('campaigns')}>Campaigns</button>
          </div>
        </section>}

        <div className="outbound-subnav" role="tablist" aria-label="Outbound sections" onKeyDown={onTabKeyDown}>
          {groupedTabs.map(group => (
            <div className="outbound-subnav-group" key={group.key} role="presentation">
              <span className="outbound-subnav-label">{group.label}</span>
              <div className="outbound-subnav-buttons" role="presentation">
                {group.tabs.map(([key, label]) => {
                  const index = orderedTabs.findIndex(([tabKey]) => tabKey === key);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      id={`outbound-tab-${key}`}
                      aria-selected={tab === key}
                      aria-current={tab === key ? 'page' : undefined}
                      aria-controls="outbound-panel"
                      tabIndex={tab === key ? 0 : -1}
                      ref={element => { tabRefs.current[index] = element; }}
                      onClick={() => key === 'queue' ? openQueue('workable') : setTab(key)}
                    >
                      {label}
                      {key === 'campaigns' && campaigns.rows.length > 0 && (
                        <span className="outbound-subnav-count">{campaigns.rows.length}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {config.error && <p className="admin-error" style={{ marginBottom: 14 }}>{config.error}</p>}

        <div id="outbound-panel" role="tabpanel" aria-labelledby={`outbound-tab-${tab}`}>
          {tab === 'training' && !trainingExempt && <RepTraining
            accounts={repTraining.accounts}
            loading={repTraining.loading}
            error={repTraining.error}
            onRefresh={loadRepTraining}
          />}
          {tab === 'campaigns' && (
            <CampaignList
              campaigns={campaigns.rows}
              loading={campaigns.loading}
              error={campaigns.error}
              refresh={campaigns.refresh}
              providers={providers}
              selectedId={campaignId}
              onSelect={setCampaignId}
            />
          )}
          {tab === 'discovery' && <LeadDiscovery sources={sources} />}
          {tab === 'prospects' && (
            <ProspectList
              campaigns={campaigns.rows}
              accountIds={accountIds}
              allAccounts={allAccounts}
              onOpen={setProspectId}
              onTargetsAdded={id => {
                setCampaignId(id);
                campaigns.refresh();
              }}
            />
          )}
          {tab === 'review' && <ImportReview onOpen={setProspectId} />}
          {tab === 'queue' && (
            <LeadQueue key={`${campaignId}:${queueEntry.key}`} campaignId={campaignId} campaigns={campaigns.rows}
              initialGroup={queueEntry.group}
              canManage={canManage}
              onSelectCampaign={setCampaignId} onOpenProspect={canManage ? setProspectId : null} />
          )}
          {tab === 'dialer' && (canManage && dialerAdvanced ? (
            <>
              <div className="outbound-dialer-mode-switch">
                <button className="btn-admin" type="button" onClick={() => setDialerAdvanced(false)}>
                  ← Back to simple dialing
                </button>
                <p className="admin-note">
                  Advanced setup: AI-assisted modes, call plans, agent profiles and preflight.
                </p>
              </div>
              <DialerControls
                campaignId={campaignId}
                campaigns={campaigns.rows}
                onSelectCampaign={setCampaignId}
                onOpenQueue={() => openQueue('workable')}
                role={role}
              />
            </>
          ) : (
            <QuickDial
              campaignId={campaignId}
              campaigns={campaigns.rows}
              campaignsLoading={campaigns.loading}
              role={role}
              onSelectCampaign={setCampaignId}
              onOpenAdvanced={canManage ? () => setDialerAdvanced(true) : undefined}
            />
          ))}
          {tab === 'coaching' && <TeamCallCoach accountIds={accountIds} allAccounts={allAccounts} />}
          {tab === 'agents' && <AgentProfiles />}
          {tab === 'consent' && <ConsentRegistry />}
          {tab === 'eligibility' && (
            <EligibilityAudit campaigns={campaigns.rows} role={role} accountIds={accountIds} />
          )}
          {tab === 'calendar' && <AppointmentCalendar canManage={canManage} accountIds={accountIds} allAccounts={allAccounts} role={role} campaigns={campaigns.rows} />}
          {tab === 'later' && (
            <CallLaterQueue campaignId={campaignId} campaigns={campaigns.rows} onSelectCampaign={setCampaignId} />
          )}
          {tab === 'history' && (
            <CallHistory campaignId={campaignId} campaigns={campaigns.rows} role={role} onSelectCampaign={setCampaignId} />
          )}
          {tab === 'settings' && (
            <ProviderStatus config={config.data} loading={config.loading} error={config.error} onRefresh={loadConfig} />
          )}
        </div>
      </div>

      {prospectId && (
        <ProspectDetail prospectId={prospectId} onClose={() => setProspectId(null)} onChanged={campaigns.refresh} />
      )}
      <TransferInbox
        currentUid={currentUid}
        accountIds={accountIds}
        allAccounts={allAccounts}
        role={role}
        campaignIds={campaigns.rows.map(campaign => campaign.id)}
      />
    </>
  );
}
