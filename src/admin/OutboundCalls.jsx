// Outbound Calls — lead discovery, sales orchestration, AI agents and dialer.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCampaigns, outbound } from './outbound/data';
import CampaignList from './outbound/CampaignList';
import LeadDiscovery from './outbound/LeadDiscovery';
import ProspectList from './outbound/ProspectList';
import ProspectDetail from './outbound/ProspectDetail';
import ImportReview from './outbound/ImportReview';
import LeadQueue from './outbound/LeadQueue';
import DialerControls from './outbound/DialerControls';
import CallLaterQueue from './outbound/CallLaterQueue';
import CallHistory from './outbound/CallHistory';
import ProviderStatus from './outbound/ProviderStatus';
import AgentProfiles from './outbound/AgentProfiles';
import './outbound/outbound.css';
import './outbound/hybrid.css';

const TABS = [
  ['campaigns', 'Campaigns'],
  ['discovery', 'Lead Discovery'],
  ['prospects', 'Prospects'],
  ['review', 'Import Review'],
  ['queue', 'Queue'],
  ['dialer', 'Live Dialer'],
  ['agents', 'AI Agents'],
  ['later', 'Call Later'],
  ['history', 'History'],
  ['settings', 'Settings']
];

export default function OutboundCalls() {
  const [tab, setTab] = useState('campaigns');
  const [campaignId, setCampaignId] = useState('');
  const [prospectId, setProspectId] = useState(null);
  const [config, setConfig] = useState({ data: null, loading: true, error: null });
  const tabRefs = useRef([]);

  const campaigns = useCampaigns();

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

  useEffect(() => {
    if (!campaignId && campaigns.rows.length) setCampaignId(campaigns.rows[0].id);
  }, [campaigns.rows, campaignId]);

  const onTabKeyDown = event => {
    const index = TABS.findIndex(([key]) => key === tab);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = event.key === 'ArrowRight'
      ? (index + 1) % TABS.length
      : (index - 1 + TABS.length) % TABS.length;
    setTab(TABS[next][0]);
    tabRefs.current[next]?.focus();
  };

  const sources = config.data?.leadSources || [];
  const providers = config.data?.callingProviders || [];
  const activeCampaign = campaigns.rows.find(entry => entry.id === campaignId) || null;

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Outbound Sales</h1>
          <p className="admin-topbar-sub">
            Discover prospects, configure AI agents, run human + AI calls, and audit every outcome in one workspace.
          </p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          {activeCampaign?.status === 'running' && (
            <span className="pill running"><i />{activeCampaign.name} is running</span>
          )}
          <button className="btn-admin" type="button" onClick={() => { campaigns.refresh(); loadConfig(); }}>
            Refresh
          </button>
        </div>
      </header>

      <div className="admin-body">
        <div className="outbound-subnav" role="tablist" aria-label="Outbound sections" onKeyDown={onTabKeyDown}>
          {TABS.map(([key, label], index) => (
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
              onClick={() => setTab(key)}
            >
              {label}
              {key === 'campaigns' && campaigns.rows.length > 0 && (
                <span className="outbound-subnav-count">{campaigns.rows.length}</span>
              )}
            </button>
          ))}
        </div>

        {config.error && <p className="admin-error" style={{ marginBottom: 14 }}>{config.error}</p>}

        <div id="outbound-panel" role="tabpanel" aria-labelledby={`outbound-tab-${tab}`}>
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
          {tab === 'prospects' && <ProspectList campaigns={campaigns.rows} onOpen={setProspectId} />}
          {tab === 'review' && <ImportReview onOpen={setProspectId} />}
          {tab === 'queue' && (
            <LeadQueue campaignId={campaignId} campaigns={campaigns.rows}
              onSelectCampaign={setCampaignId} onOpenProspect={setProspectId} />
          )}
          {tab === 'dialer' && (
            <DialerControls campaignId={campaignId} campaigns={campaigns.rows} onSelectCampaign={setCampaignId} />
          )}
          {tab === 'agents' && <AgentProfiles />}
          {tab === 'later' && (
            <CallLaterQueue campaignId={campaignId} campaigns={campaigns.rows} onSelectCampaign={setCampaignId} />
          )}
          {tab === 'history' && (
            <CallHistory campaignId={campaignId} campaigns={campaigns.rows} onSelectCampaign={setCampaignId} />
          )}
          {tab === 'settings' && (
            <ProviderStatus config={config.data} loading={config.loading} error={config.error} onRefresh={loadConfig} />
          )}
        </div>
      </div>

      {prospectId && (
        <ProspectDetail prospectId={prospectId} onClose={() => setProspectId(null)} onChanged={campaigns.refresh} />
      )}
    </>
  );
}
