import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { outbound, useAction } from './data';

const EMPTY = {
  name: '',
  description: '',
  personality: { preset: 'friendly_consultant', tone: 'Warm, concise, consultative, and confident.', pacing: 'natural', formality: 'professional', languagePolicy: 'Match the prospect’s language when supported.' },
  objective: { mode: 'sell', primaryGoal: '', successCriteria: [] },
  permissions: {
    mayQuotePricing: false,
    mayOfferDiscount: false,
    maxDiscountPercent: 0,
    mayBookMeeting: true,
    mayCloseSale: false,
    mayCollectPayment: false,
    maySendSms: false,
    maySendEmail: false
  },
  rules: { requiredDisclosures: [], prohibitedClaims: [], escalationRules: [], objectionRules: [] },
  handoffPhrase: 'I’m going to bring a member of our team into the conversation now.',
  advancedInstructions: '',
  knowledgeBaseIds: [],
  model: 'gpt-realtime',
  voice: 'marin'
};

const splitLines = value => String(value || '').split('\n').map(item => item.trim()).filter(Boolean);
const joinLines = value => (Array.isArray(value) ? value : []).join('\n');

function cloneProfile(profile = EMPTY) {
  return JSON.parse(JSON.stringify({ ...EMPTY, ...profile,
    personality: { ...EMPTY.personality, ...(profile.personality || {}) },
    objective: { ...EMPTY.objective, ...(profile.objective || {}) },
    permissions: { ...EMPTY.permissions, ...(profile.permissions || {}) },
    rules: { ...EMPTY.rules, ...(profile.rules || {}) },
    knowledgeBaseIds: profile.knowledgeBaseIds || []
  }));
}

export default function AgentProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [knowledgeBases, setKnowledgeBases] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(cloneProfile());
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [kbName, setKbName] = useState('');
  const [kbDoc, setKbDoc] = useState({ knowledgeBaseId: '', title: '', text: '' });
  const action = useAction();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [agents, kbs] = await Promise.all([outbound.listAgentProfiles(), outbound.listKnowledgeBases()]);
      setProfiles(agents?.profiles || []);
      setKnowledgeBases(kbs?.knowledgeBases || []);
      if (!selectedId && agents?.profiles?.length) {
        setSelectedId(agents.profiles[0].id);
        setDraft(cloneProfile(agents.profiles[0]));
      }
    } finally { setLoading(false); }
  }, [selectedId]);

  useEffect(() => { refresh().catch(() => setLoading(false)); }, [refresh]);

  const selected = useMemo(() => profiles.find(profile => profile.id === selectedId) || null, [profiles, selectedId]);

  const selectProfile = id => {
    const profile = profiles.find(item => item.id === id);
    setSelectedId(id);
    setDraft(cloneProfile(profile || EMPTY));
    setPreview(null);
  };

  const setField = (path, value) => {
    setDraft(current => {
      const next = cloneProfile(current);
      if (path.length === 1) next[path[0]] = value;
      else next[path[0]][path[1]] = value;
      return next;
    });
  };

  const save = async () => {
    const result = selected
      ? await action.run(() => outbound.updateAgentProfile(selected.id, draft), 'Agent profile updated.')
      : await action.run(() => outbound.createAgentProfile(draft), 'Agent profile created.');
    if (!result) return;
    if (result.profileId) setSelectedId(result.profileId);
    await refresh();
  };

  const createNew = () => {
    setSelectedId('');
    setDraft(cloneProfile());
    setPreview(null);
  };

  const duplicate = () => {
    const copy = cloneProfile(draft);
    copy.name = `${copy.name || 'Agent'} copy`;
    setSelectedId('');
    setDraft(copy);
    setPreview(null);
  };

  const archive = async () => {
    if (!selected) return;
    const result = await action.run(() => outbound.archiveAgentProfile(selected.id), 'Agent archived.');
    if (result) { setSelectedId(''); setDraft(cloneProfile()); await refresh(); }
  };

  const runPreview = async () => {
    const result = await action.run(() => outbound.previewAgentRuntime({ profile: { id: selectedId || 'preview', version: selected?.version || 1, ...draft } }), 'Runtime validated.');
    if (result) setPreview(result);
  };

  const toggleKnowledge = kbId => {
    setDraft(current => {
      const next = cloneProfile(current);
      next.knowledgeBaseIds = next.knowledgeBaseIds.includes(kbId)
        ? next.knowledgeBaseIds.filter(id => id !== kbId)
        : [...next.knowledgeBaseIds, kbId];
      return next;
    });
  };

  const createKb = async () => {
    const result = await action.run(() => outbound.createKnowledgeBase({ name: kbName }), 'Knowledge base created.');
    if (!result) return;
    setKbName('');
    setKbDoc(current => ({ ...current, knowledgeBaseId: result.knowledgeBaseId }));
    await refresh();
  };

  const saveKbDocument = async () => {
    const result = await action.run(() => outbound.upsertKnowledgeDocument(kbDoc), 'Knowledge document saved.');
    if (result) setKbDoc(current => ({ ...current, title: '', text: '' }));
  };

  const permission = (key, label) => (
    <label className="hybrid-permission" key={key}>
      <input type="checkbox" checked={draft.permissions[key] === true}
        onChange={event => setField(['permissions', key], event.target.checked)} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="hybrid-agent-layout">
      <div className="admin-card hybrid-agent-sidebar">
        <div className="card-head">
          <div><h3>AI Agents</h3><p>Saved, versioned sales personalities.</p></div>
          <button className="btn-admin primary" type="button" onClick={createNew}>New</button>
        </div>
        {loading && <p className="admin-note">Loading agents…</p>}
        <div className="hybrid-agent-list">
          {profiles.filter(profile => profile.status !== 'archived').map(profile => (
            <button type="button" key={profile.id} className={selectedId === profile.id ? 'is-selected' : ''}
              onClick={() => selectProfile(profile.id)}>
              <strong>{profile.name}</strong>
              <span>v{profile.version || 1} · {profile.personality?.preset || 'custom'}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="admin-card hybrid-agent-editor">
        <div className="card-head">
          <div>
            <h3>{selected ? `Edit ${selected.name}` : 'Create AI agent'}</h3>
            <p>The runtime compiler combines this profile with campaign and session overrides without allowing lower layers to weaken system policy.</p>
          </div>
          <div className="card-head-actions">
            {selected && <button className="btn-admin" type="button" onClick={duplicate}>Duplicate</button>}
            {selected && <button className="btn-admin danger" type="button" onClick={archive}>Archive</button>}
            <button className="btn-admin primary" type="button" disabled={action.busy || !draft.name.trim()} onClick={save}>Save</button>
          </div>
        </div>

        <div className="outbound-form-grid hybrid-agent-form">
          <label><span>Name</span><input value={draft.name} maxLength={120} onChange={event => setField(['name'], event.target.value)} placeholder="Friendly Website Consultant" /></label>
          <label><span>Preset</span>
            <select className="admin-select" value={draft.personality.preset} onChange={event => setField(['personality', 'preset'], event.target.value)}>
              <option value="friendly_consultant">Friendly consultant</option>
              <option value="appointment_setter">Appointment setter</option>
              <option value="confident_closer">Confident closer</option>
              <option value="warm_followup">Warm follow-up</option>
              <option value="spanish_sales">Spanish sales</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="full"><span>Description</span><input value={draft.description || ''} maxLength={1000} onChange={event => setField(['description'], event.target.value)} /></label>
          <label className="full"><span>Tone / personality</span><textarea rows={3} value={draft.personality.tone || ''} onChange={event => setField(['personality', 'tone'], event.target.value)} /></label>
          <label><span>Language policy</span><input value={draft.personality.languagePolicy || ''} onChange={event => setField(['personality', 'languagePolicy'], event.target.value)} /></label>
          <label><span>Voice</span><input value={draft.voice || ''} onChange={event => setField(['voice'], event.target.value)} /></label>
          <label className="full"><span>Primary sales objective</span><textarea rows={3} value={draft.objective.primaryGoal || ''} onChange={event => setField(['objective', 'primaryGoal'], event.target.value)} placeholder="Qualify the business, explain the relevant BiteSites offer, and close or book when permitted." /></label>

          <fieldset className="full hybrid-fieldset">
            <legend>Allowed actions</legend>
            <div className="hybrid-permissions-grid">
              {permission('mayQuotePricing', 'Quote approved pricing')}
              {permission('mayOfferDiscount', 'Offer discounts')}
              {permission('mayBookMeeting', 'Book meetings')}
              {permission('mayCloseSale', 'Close the sale')}
              {permission('mayCollectPayment', 'Collect payment')}
              {permission('maySendSms', 'Send approved SMS follow-up')}
              {permission('maySendEmail', 'Send approved email follow-up')}
            </div>
            {draft.permissions.mayOfferDiscount && (
              <label className="hybrid-inline-number">Max discount %
                <input type="number" min="0" max="100" value={draft.permissions.maxDiscountPercent || 0}
                  onChange={event => setField(['permissions', 'maxDiscountPercent'], Number(event.target.value))} />
              </label>
            )}
          </fieldset>

          <label className="full"><span>Required disclosures <small>(one per line)</small></span><textarea rows={3} value={joinLines(draft.rules.requiredDisclosures)} onChange={event => setField(['rules', 'requiredDisclosures'], splitLines(event.target.value))} /></label>
          <label className="full"><span>Prohibited claims <small>(one per line)</small></span><textarea rows={3} value={joinLines(draft.rules.prohibitedClaims)} onChange={event => setField(['rules', 'prohibitedClaims'], splitLines(event.target.value))} /></label>
          <label className="full"><span>Smooth handoff phrase</span><input value={draft.handoffPhrase || ''} maxLength={500} onChange={event => setField(['handoffPhrase'], event.target.value)} /></label>
          <label className="full"><span>Advanced bounded instructions</span><textarea rows={5} maxLength={5000} value={draft.advancedInstructions || ''} onChange={event => setField(['advancedInstructions'], event.target.value)} placeholder="Business-specific behavior. This cannot override system policy or grant unauthorized tools." /></label>

          <fieldset className="full hybrid-fieldset">
            <legend>Knowledge bases</legend>
            {!knowledgeBases.length && <p className="admin-note">No knowledge bases yet.</p>}
            <div className="hybrid-kb-choices">
              {knowledgeBases.filter(kb => kb.status !== 'archived').map(kb => (
                <label key={kb.id}>
                  <input type="checkbox" checked={draft.knowledgeBaseIds.includes(kb.id)} onChange={() => toggleKnowledge(kb.id)} />
                  <span>{kb.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="hybrid-agent-actions">
          <button className="btn-admin" type="button" disabled={action.busy} onClick={runPreview}>Validate runtime</button>
          {preview && (
            <span className="admin-note">{preview.model} · {preview.tools?.length || 0} tools · config {String(preview.effectiveConfigHash || '').slice(0, 10)}…</span>
          )}
        </div>
        {action.error && <p className="admin-error" style={{ marginTop: 10 }}>{action.error}</p>}
        {action.message && <p className="admin-note" style={{ marginTop: 10 }}>{action.message}</p>}
      </div>

      <div className="admin-card hybrid-kb-editor">
        <div className="card-head"><div><h3>Knowledge Base</h3><p>Add approved facts the live AI is allowed to retrieve.</p></div></div>
        <div className="outbound-form-grid">
          <label><span>New knowledge base name</span><input value={kbName} onChange={event => setKbName(event.target.value)} placeholder="BiteSites Services & Pricing" /></label>
          <div className="hybrid-field-button"><button className="btn-admin" type="button" disabled={!kbName.trim() || action.busy} onClick={createKb}>Create knowledge base</button></div>
          <label><span>Knowledge base</span>
            <select className="admin-select" value={kbDoc.knowledgeBaseId} onChange={event => setKbDoc(current => ({ ...current, knowledgeBaseId: event.target.value }))}>
              <option value="">Select…</option>
              {knowledgeBases.filter(kb => kb.status !== 'archived').map(kb => <option key={kb.id} value={kb.id}>{kb.name}</option>)}
            </select>
          </label>
          <label><span>Document title</span><input value={kbDoc.title} onChange={event => setKbDoc(current => ({ ...current, title: event.target.value }))} /></label>
          <label className="full"><span>Approved knowledge</span><textarea rows={8} maxLength={20000} value={kbDoc.text} onChange={event => setKbDoc(current => ({ ...current, text: event.target.value }))} placeholder="Products, services, pricing, FAQs, objection answers, process details…" /></label>
        </div>
        <button className="btn-admin primary" type="button" disabled={action.busy || !kbDoc.knowledgeBaseId || !kbDoc.text.trim()} onClick={saveKbDocument}>Save knowledge document</button>
      </div>
    </div>
  );
}
