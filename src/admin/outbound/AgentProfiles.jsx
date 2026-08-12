import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { outbound, useAction } from './data';

const EMPTY = {
  name: '',
  description: '',
  personality: {
    preset: 'friendly_consultant',
    tone: 'Warm, concise, consultative, and confident.',
    pacing: 'natural',
    formality: 'professional',
    languagePolicy: 'Default to English. Switch languages only when the prospect explicitly asks or clearly speaks another language.',
    energy: 'balanced',
    emotion: 'warm',
    accent: '',
    pauseStyle: 'natural',
    fillerWords: 'minimal',
    responseLength: 'concise',
    pronunciationGuidance: ''
  },
  voiceSettings: { source: 'built_in', builtInVoice: 'marin', customVoiceId: '', playbackSpeed: 1 },
  turnTaking: {
    mode: 'semantic_vad', eagerness: 'medium', allowInterruptions: true,
    noiseReduction: 'far_field', threshold: 0.5, prefixPaddingMs: 300,
    silenceDurationMs: 500, idleTimeoutMs: 10000
  },
  responseSettings: { maxOutputTokens: 512, reasoningEffort: 'low' },
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
  model: 'gpt-realtime-2.1',
  voice: 'marin'
};

const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
const REASONING_MODELS = new Set(['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini']);
const PRESET_SETTINGS = {
  friendly_consultant: { tone: 'Warm, concise, consultative, and confident.', pacing: 'natural', formality: 'professional', energy: 'balanced', emotion: 'warm' },
  appointment_setter: { tone: 'Focused, helpful, clear, and politely persistent.', pacing: 'brisk', formality: 'professional', energy: 'balanced', emotion: 'warm', responseLength: 'concise' },
  confident_closer: { tone: 'Direct, credible, decisive, and respectful. Never pressure or overstate.', pacing: 'brisk', formality: 'professional', energy: 'high', emotion: 'enthusiastic', responseLength: 'concise' },
  warm_followup: { tone: 'Familiar, patient, low-pressure, and attentive to prior context.', pacing: 'natural', formality: 'casual', energy: 'balanced', emotion: 'empathetic' },
  spanish_sales: { tone: 'Cálido, claro, consultivo y seguro.', pacing: 'natural', formality: 'professional', energy: 'balanced', emotion: 'warm', languagePolicy: 'Speak Spanish by default. Switch to English only when the prospect clearly requests it.' }
};

const splitLines = value => String(value || '').split('\n').map(item => item.trim()).filter(Boolean);
const joinLines = value => (Array.isArray(value) ? value : []).join('\n');

function cloneProfile(profile = EMPTY) {
  return JSON.parse(JSON.stringify({ ...EMPTY, ...profile,
    personality: { ...EMPTY.personality, ...(profile.personality || {}) },
    voiceSettings: {
      ...EMPTY.voiceSettings,
      ...(profile.voiceSettings || {}),
      builtInVoice: profile.voiceSettings?.builtInVoice || (VOICES.includes(profile.voice) ? profile.voice : EMPTY.voiceSettings.builtInVoice)
    },
    turnTaking: { ...EMPTY.turnTaking, ...(profile.turnTaking || {}) },
    responseSettings: { ...EMPTY.responseSettings, ...(profile.responseSettings || {}) },
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
  const customVoiceInvalid = draft.voiceSettings.source === 'custom'
    && !/^voice_[A-Za-z0-9_-]+$/.test(draft.voiceSettings.customVoiceId || '');
  const reasoningCapable = REASONING_MODELS.has(draft.model);

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

  const applyPreset = preset => {
    setDraft(current => {
      const next = cloneProfile(current);
      next.personality = { ...next.personality, preset, ...(PRESET_SETTINGS[preset] || {}) };
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
            <button className="btn-admin primary" type="button" disabled={action.busy || !draft.name.trim() || customVoiceInvalid} onClick={save}>Save</button>
          </div>
        </div>

        <div className="hybrid-agent-form">
          <fieldset className="hybrid-fieldset hybrid-config-section">
            <legend>Agent identity & model</legend>
            <div className="outbound-form-grid">
              <label><span>Name</span><input value={draft.name} maxLength={120} onChange={event => setField(['name'], event.target.value)} placeholder="Friendly Website Consultant" /></label>
              <label><span>Personality preset</span>
                <select className="admin-select" value={draft.personality.preset} onChange={event => applyPreset(event.target.value)}>
                  <option value="friendly_consultant">Friendly consultant</option>
                  <option value="appointment_setter">Appointment setter</option>
                  <option value="confident_closer">Confident closer</option>
                  <option value="warm_followup">Warm follow-up</option>
                  <option value="spanish_sales">Spanish sales</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label><span>Realtime model</span>
                <select className="admin-select" value={draft.model} onChange={event => setField(['model'], event.target.value)}>
                  <option value="gpt-realtime-2.1">GPT Realtime 2.1 · best quality</option>
                  <option value="gpt-realtime-2.1-mini">GPT Realtime 2.1 mini · lower cost</option>
                  <option value="gpt-realtime-2">GPT Realtime 2</option>
                  <option value="gpt-realtime-1.5">GPT Realtime 1.5 · non-reasoning</option>
                </select>
              </label>
              <label><span>Reasoning effort</span>
                <select className="admin-select" value={draft.responseSettings.reasoningEffort} disabled={!reasoningCapable}
                  onChange={event => setField(['responseSettings', 'reasoningEffort'], event.target.value)}>
                  <option value="minimal">Minimal · fastest</option>
                  <option value="low">Low · recommended</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                </select>
                {!reasoningCapable && <small>Not sent to non-reasoning models.</small>}
              </label>
              <label className="full"><span>Description</span><input value={draft.description || ''} maxLength={1000} onChange={event => setField(['description'], event.target.value)} /></label>
            </div>
          </fieldset>

          <fieldset className="hybrid-fieldset hybrid-config-section">
            <legend>Voice identity</legend>
            <div className="outbound-form-grid">
              <label><span>Voice source</span>
                <select className="admin-select" value={draft.voiceSettings.source} onChange={event => setField(['voiceSettings', 'source'], event.target.value)}>
                  <option value="built_in">OpenAI built-in voice</option>
                  <option value="custom">Custom voice ID</option>
                </select>
              </label>
              {draft.voiceSettings.source === 'built_in' ? (
                <label><span>Built-in voice</span>
                  <select className="admin-select" value={draft.voiceSettings.builtInVoice} onChange={event => setField(['voiceSettings', 'builtInVoice'], event.target.value)}>
                    {VOICES.map(voice => <option key={voice} value={voice}>{voice[0].toUpperCase() + voice.slice(1)}{['marin', 'cedar'].includes(voice) ? ' · recommended' : ''}</option>)}
                  </select>
                </label>
              ) : (
                <label><span>Custom voice ID</span><input className={customVoiceInvalid ? 'is-invalid' : ''} value={draft.voiceSettings.customVoiceId}
                  onChange={event => setField(['voiceSettings', 'customVoiceId'], event.target.value)} placeholder="voice_123abc" />
                  {customVoiceInvalid && <small className="field-error">Must begin with voice_.</small>}
                </label>
              )}
              <label className="full hybrid-range-field"><span>Playback speed <strong>{Number(draft.voiceSettings.playbackSpeed).toFixed(2)}×</strong></span>
                <input type="range" min="0.25" max="1.5" step="0.05" value={draft.voiceSettings.playbackSpeed}
                  onChange={event => setField(['voiceSettings', 'playbackSpeed'], Number(event.target.value))} />
                <small>This changes live audio playback rate. Cadence below separately changes how speech is composed.</small>
              </label>
            </div>
          </fieldset>

          <fieldset className="hybrid-fieldset hybrid-config-section">
            <legend>Delivery, cadence & language</legend>
            <div className="outbound-form-grid">
              <label className="full"><span>Tone / personality</span><textarea rows={3} maxLength={500} value={draft.personality.tone || ''} onChange={event => setField(['personality', 'tone'], event.target.value)} /></label>
              <label><span>Composed speaking pace</span>
                <select className="admin-select" value={draft.personality.pacing} onChange={event => setField(['personality', 'pacing'], event.target.value)}>
                  <option value="measured">Measured</option><option value="natural">Natural</option><option value="brisk">Brisk</option><option value="fast">Fast</option>
                </select>
              </label>
              <label><span>Default response length</span>
                <select className="admin-select" value={draft.personality.responseLength} onChange={event => setField(['personality', 'responseLength'], event.target.value)}>
                  <option value="brief">Brief · one sentence</option><option value="concise">Concise · 2–3 sentences</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option>
                </select>
              </label>
              <label><span>Formality</span><select className="admin-select" value={draft.personality.formality} onChange={event => setField(['personality', 'formality'], event.target.value)}>
                <option value="casual">Casual</option><option value="professional">Professional</option><option value="formal">Formal</option>
              </select></label>
              <label><span>Vocal energy</span><select className="admin-select" value={draft.personality.energy} onChange={event => setField(['personality', 'energy'], event.target.value)}>
                <option value="low">Low</option><option value="balanced">Balanced</option><option value="high">High</option>
              </select></label>
              <label><span>Emotional delivery</span><select className="admin-select" value={draft.personality.emotion} onChange={event => setField(['personality', 'emotion'], event.target.value)}>
                <option value="neutral">Neutral</option><option value="warm">Warm</option><option value="enthusiastic">Enthusiastic</option><option value="empathetic">Empathetic</option><option value="calm">Calm</option>
              </select></label>
              <label><span>Pause style</span><select className="admin-select" value={draft.personality.pauseStyle} onChange={event => setField(['personality', 'pauseStyle'], event.target.value)}>
                <option value="minimal">Minimal</option><option value="natural">Natural</option><option value="deliberate">Deliberate</option>
              </select></label>
              <label><span>Filler words</span><select className="admin-select" value={draft.personality.fillerWords} onChange={event => setField(['personality', 'fillerWords'], event.target.value)}>
                <option value="none">None</option><option value="minimal">Minimal</option><option value="natural">Natural</option>
              </select></label>
              <label><span>Maximum response tokens</span><input type="number" min="64" max="4096" step="64" value={draft.responseSettings.maxOutputTokens}
                onChange={event => setField(['responseSettings', 'maxOutputTokens'], Number(event.target.value))} /></label>
              <label className="full"><span>Accent guidance</span><input maxLength={300} value={draft.personality.accent || ''} onChange={event => setField(['personality', 'accent'], event.target.value)} placeholder="Example: Light, stable New York accent; clear and not exaggerated." /></label>
              <label className="full"><span>Language policy</span><textarea rows={2} maxLength={500} value={draft.personality.languagePolicy || ''} onChange={event => setField(['personality', 'languagePolicy'], event.target.value)} /></label>
              <label className="full"><span>Pronunciation guidance</span><textarea rows={2} maxLength={1000} value={draft.personality.pronunciationGuidance || ''} onChange={event => setField(['personality', 'pronunciationGuidance'], event.target.value)} placeholder="Example: BiteSites is pronounced ‘bite sites’. Say URLs letter by letter when clarity matters." /></label>
            </div>
          </fieldset>

          <fieldset className="hybrid-fieldset hybrid-config-section">
            <legend>Turn-taking & caller background noise</legend>
            <div className="outbound-form-grid">
              <label><span>Turn detection</span><select className="admin-select" value={draft.turnTaking.mode} onChange={event => setField(['turnTaking', 'mode'], event.target.value)}>
                <option value="semantic_vad">Semantic · natural conversation</option><option value="server_vad">Server · silence thresholds</option>
              </select></label>
              <label><span>Noise reduction</span><select className="admin-select" value={draft.turnTaking.noiseReduction} onChange={event => setField(['turnTaking', 'noiseReduction'], event.target.value)}>
                <option value="far_field">Far-field · phone / room noise</option><option value="near_field">Near-field · headset mic</option><option value="off">Off</option>
              </select></label>
              <label className="full hybrid-switch-row"><input type="checkbox" checked={draft.turnTaking.allowInterruptions}
                onChange={event => setField(['turnTaking', 'allowInterruptions'], event.target.checked)} />
                <span><strong>Allow prospect barge-in</strong><small>Cancel the agent’s current reply when the prospect starts speaking.</small></span>
              </label>
              {draft.turnTaking.mode === 'semantic_vad' ? (
                <label className="full"><span>Response eagerness</span><select className="admin-select" value={draft.turnTaking.eagerness} onChange={event => setField(['turnTaking', 'eagerness'], event.target.value)}>
                  <option value="low">Patient · waits longer</option><option value="medium">Balanced</option><option value="high">Responsive · answers sooner</option><option value="auto">Automatic</option>
                </select></label>
              ) : (
                <>
                  <label className="hybrid-range-field"><span>Speech threshold <strong>{Number(draft.turnTaking.threshold).toFixed(2)}</strong></span><input type="range" min="0" max="1" step="0.05" value={draft.turnTaking.threshold} onChange={event => setField(['turnTaking', 'threshold'], Number(event.target.value))} /><small>Higher values ignore more quiet background noise.</small></label>
                  <label><span>Silence before response · ms</span><input type="number" min="100" max="5000" step="100" value={draft.turnTaking.silenceDurationMs} onChange={event => setField(['turnTaking', 'silenceDurationMs'], Number(event.target.value))} /></label>
                  <label><span>Speech prefix retained · ms</span><input type="number" min="0" max="2000" step="50" value={draft.turnTaking.prefixPaddingMs} onChange={event => setField(['turnTaking', 'prefixPaddingMs'], Number(event.target.value))} /></label>
                  <label><span>Idle follow-up timeout · ms</span><input type="number" min="0" max="120000" step="1000" value={draft.turnTaking.idleTimeoutMs} onChange={event => setField(['turnTaking', 'idleTimeoutMs'], Number(event.target.value))} /><small>Set 0 to disable.</small></label>
                </>
              )}
            </div>
            <p className="hybrid-config-note">Noise reduction filters the prospect’s incoming audio before turn detection and the model. BiteSites does not add synthetic office or call-center ambience to calls.</p>
          </fieldset>

          <fieldset className="hybrid-fieldset hybrid-config-section">
            <legend>Objective & actions</legend>
            <div className="outbound-form-grid">
              <label className="full"><span>Primary sales objective</span><textarea rows={3} value={draft.objective.primaryGoal || ''} onChange={event => setField(['objective', 'primaryGoal'], event.target.value)} placeholder="Qualify the business, explain the relevant BiteSites offer, and close or book when permitted." /></label>
            </div>

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

          <fieldset className="hybrid-fieldset hybrid-config-section">
            <legend>Guardrails & handoff</legend>
            <div className="outbound-form-grid">
              <label className="full"><span>Required disclosures <small>(one per line)</small></span><textarea rows={3} value={joinLines(draft.rules.requiredDisclosures)} onChange={event => setField(['rules', 'requiredDisclosures'], splitLines(event.target.value))} /></label>
              <label className="full"><span>Prohibited claims <small>(one per line)</small></span><textarea rows={3} value={joinLines(draft.rules.prohibitedClaims)} onChange={event => setField(['rules', 'prohibitedClaims'], splitLines(event.target.value))} /></label>
              <label className="full"><span>Smooth handoff phrase</span><input value={draft.handoffPhrase || ''} maxLength={500} onChange={event => setField(['handoffPhrase'], event.target.value)} /></label>
              <label className="full"><span>Advanced bounded instructions</span><textarea rows={5} maxLength={5000} value={draft.advancedInstructions || ''} onChange={event => setField(['advancedInstructions'], event.target.value)} placeholder="Business-specific behavior. This cannot override system policy or grant unauthorized tools." /></label>
            </div>
          </fieldset>

          <fieldset className="hybrid-fieldset hybrid-config-section">
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
          <button className="btn-admin" type="button" disabled={action.busy || customVoiceInvalid} onClick={runPreview}>Validate live configuration</button>
          {preview && (
            <div className="hybrid-runtime-preview">
              <strong>Ready for the next call</strong>
              <span>{preview.model}</span>
              <span>{typeof preview.sessionConfig?.audio?.output?.voice === 'object' ? 'Custom voice' : preview.sessionConfig?.audio?.output?.voice}</span>
              <span>{preview.sessionConfig?.audio?.output?.speed || 1}× speed</span>
              <span>{preview.sessionConfig?.audio?.input?.turn_detection?.type === 'server_vad' ? 'Server VAD' : 'Semantic VAD'}</span>
              <span>{preview.sessionConfig?.audio?.input?.noise_reduction?.type?.replace('_', ' ') || 'Noise reduction off'}</span>
              <span>{preview.sessionConfig?.max_output_tokens || 512} token cap</span>
              <span>{preview.tools?.length || 0} permitted tools</span>
              <span>config {String(preview.effectiveConfigHash || '').slice(0, 10)}…</span>
            </div>
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
