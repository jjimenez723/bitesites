# BiteSites AI Sales Platform — System Architecture v1.0

Status: implementation contract for Hybrid AI Dialer V2

This document is the source of truth for the outbound sales system. Existing outbound code that conflicts with this document must be migrated toward this architecture rather than preserved for compatibility. Existing lead/prospect separation, compliance gates, DNC propagation, call history, provider credential isolation, and Firestore security boundaries remain authoritative unless explicitly superseded below.

## 1. Product vision

BiteSites is evolving from an outbound dialer into a human + AI sales orchestration platform.

The operating model is:

- A human rep starts a dialing session.
- The current default concurrency is three outbound PSTN call legs per human session.
- The first verified human answer is offered to the rep when the rep is available.
- Additional verified human answers are not cancelled merely because the rep is busy. They are assigned isolated AI voice sessions.
- Each AI call has a live transcript and can be silently monitored by the rep.
- The rep can request a smooth handoff from AI to human without ending or redialing the prospect.
- A prospect may explicitly request a human. That call becomes the highest-priority handoff candidate. If a rep is available, handoff may proceed immediately. If not, the AI continues the call and informs the prospect that the human is currently assisting someone else.
- AI does not autonomously force a human takeover merely because it considers a lead hot. A takeover occurs because the prospect requested a human or the rep requested the call.
- Manual takeover is the default. Sessions may enable Auto Takeover. Auto Takeover may only act on calls whose takeover has already been authorized by the above rules.
- AI call capacity is architecturally unbounded. Practical limits are provider quota, media infrastructure capacity, model limits, cost controls, and configured safety caps, not a product-level one-call restriction.
- Multiple human reps are supported by architecture and identity attribution. Initially only one rep is expected to operate at a time, with two independent reps supported later. A rep session must never control another rep's calls unless a future supervisor permission explicitly allows it.

## 2. Product decisions locked

The following decisions were explicitly approved and are not open design questions:

1. Hybrid takeover: manual by default, optional Auto Takeover per dialing session.
2. Monitoring: live transcript plus listen-only audio before takeover.
3. Handoff: smooth handoff. AI announces that it is bringing the human into the conversation, then exits or becomes non-speaking.
4. AI behavior is configurable through saved agent profiles, campaign overrides, and temporary session/day overrides.
5. Final runtime prompts are assembled server-side. Browser text must never become an unrestricted system prompt.
6. Human takeover triggers are limited to prospect request or rep request. AI may rank/summarize calls but may not independently force transfer.
7. AI sessions are isolated per active call and support effectively unlimited concurrency.
8. Current default outbound concurrency is three calls per rep session.
9. Architecture supports multiple reps using existing BiteSites identity/RBAC. Every action and call is attributable to a rep.
10. Full analytics/auditing is retained: attempts, answers, AI time, human time, takeover events, transfer requests, transcript, recording metadata when permitted, dispositions, meetings, closes, DNC, prompt/profile version, timestamps, campaign attribution, prospect/lead attribution, and actor identity.

## 3. Non-negotiable invariants

### 3.1 One human call per rep

A rep may own at most one speaking call at a time.

This invariant must be enforced transactionally on the server. UI state is not a correctness boundary.

### 3.2 A connected prospect must always have a controller

A connected human answer may be controlled by:

- `human`
- `ai`
- `transitioning`

A connected call must never remain in an unowned state after routing completes.

### 3.3 AI calls are isolated

Every AI-controlled call receives a distinct AI runtime/session identifier and distinct conversation context. One call's transcript, knowledge retrieval, prompt override, tools, or memory must not bleed into another call.

### 3.4 Prospect locks remain exclusive

A target may not be dialed by two sessions concurrently. Preserve the existing Firestore target-lock mechanism.

### 3.5 DNC is global, not campaign-local

A DNC request suppresses the contact across all campaigns. The existing `markDoNotCall` propagation behavior is preserved and expanded so AI-detected explicit opt-outs can invoke it server-side.

### 3.6 Provider events are untrusted and reorderable

Webhooks can arrive late, duplicated, or out of order. All state transitions must be idempotent and protected by transactions or compare-and-set semantics.

### 3.7 Secrets never enter the browser

Twilio Auth Tokens, OpenAI API keys, provider secrets, signing secrets, and service credentials live in Firebase Secret Manager or server environment bindings only.

Browser clients receive only short-lived, scope-limited tokens where required, such as a Twilio Voice SDK access token.

## 4. Existing architecture to preserve

The existing BiteSites application uses:

- React 19
- Vite
- React Router
- Firebase Authentication
- Cloud Firestore
- Firebase Cloud Functions v2
- Firebase Hosting
- GoHighLevel / LeadConnector
- Postmark

Existing reusable outbound concepts remain:

- `prospects`
- `outboundCampaigns`
- `outboundTargets`
- `dialerSessions`
- `calls`
- `calls/{callId}/turns`
- call history
- research briefs
- provider adapters
- compliance gates
- target retries
- prospect-to-lead promotion
- global DNC propagation

Do not create a second dashboard, second auth system, or duplicate call-history database.

## 5. Old behavior being replaced

The current V1 parallel dialer enforces:

`first verified human answer -> winner -> cancel every other leg`

That state machine is obsolete for V2.

V2 behavior is:

`verified human answer -> route based on rep availability -> human OR isolated AI`

No live human answer is cancelled solely because another human answer already connected.

A ringing leg may still be cancelled for explicit operator action, session stop, compliance failure, campaign cancellation, provider failure, duplicate target lock, or other terminal system reason.

## 6. Core data model

### 6.1 `dialerSessions/{sessionId}`

Recommended fields:

```js
{
  campaignId,
  userUid,
  provider,
  mode: "parallel",
  concurrency: 3,
  status: "active" | "ended" | "abandoned" | "cancelled",

  rep: {
    state: "available" | "busy" | "listening" | "transitioning" | "offline",
    activeCallId: "",
    listeningCallId: ""
  },

  takeover: {
    autoEnabled: false,
    pendingCallIds: []
  },

  activeCallIds: [],
  startedAt,
  endedAt,
  lastHeartbeatAt
}
```

`connectedCallId` and `connectedTargetId` are deprecated as the single source of truth. They may be retained temporarily during migration but must not encode the V2 invariant.

### 6.2 `calls/{callId}` V2 outbound additions

```js
{
  direction: "outbound",
  campaignId,
  targetId,
  leadId,
  prospectId,
  sessionId,
  provider,
  providerCallId,

  status: "queued" | "dialing" | "ringing" | "answered" | "connected" | "completed" | "cancelled" | "failed",
  answeredBy: "human" | "machine" | "fax" | "unknown",

  control: {
    controller: "unassigned" | "human" | "ai" | "transitioning" | "none",
    repUid: "",
    aiSessionId: "",
    changedAt,
    revision: 0
  },

  handoff: {
    requestedBy: "" | "prospect" | "rep",
    requestedAt: null,
    state: "none" | "requested" | "queued" | "announcing" | "joining_human" | "completed" | "cancelled" | "failed",
    priority: 0,
    completedAt: null
  },

  media: {
    conferenceSid: "",
    conferenceName: "",
    prospectParticipantSid: "",
    aiParticipantSid: "",
    humanParticipantSid: "",
    streamSid: "",
    recordingSid: ""
  },

  agent: {
    profileId: "",
    profileVersion: 0,
    effectiveConfigHash: "",
    model: "",
    voice: ""
  },

  analytics: {
    humanTalkSec: 0,
    aiTalkSec: 0,
    listenSec: 0,
    takeoverCount: 0,
    prospectRequestedHuman: false
  },

  ringingAt,
  answeredAt,
  connectedAt,
  aiStartedAt,
  humanJoinedAt,
  endedAt,
  durationSec,
  disposition,
  recordingUrl
}
```

### 6.3 `calls/{callId}/turns/{turnId}`

Live transcript turns are append-only and speaker-labelled.

```js
{
  sequence,
  speaker: "prospect" | "ai" | "human" | "system",
  text,
  final: true,
  startedAt,
  endedAt,
  modelEventId,
  createdAt
}
```

Partial transcript events may be kept in memory or a short-lived document; durable history should prefer final turns.

### 6.4 `aiAgentProfiles/{profileId}`

```js
{
  name,
  description,
  status: "active" | "archived",
  version,

  personality: {
    preset,
    tone,
    pacing,
    formality,
    languagePolicy
  },

  objective: {
    mode: "qualify" | "sell" | "book" | "support" | "custom",
    primaryGoal,
    successCriteria: []
  },

  permissions: {
    mayQuotePricing,
    mayOfferDiscount,
    maxDiscountPercent,
    mayBookMeeting,
    mayCloseSale,
    mayCollectPayment,
    maySendSms,
    maySendEmail
  },

  rules: {
    requiredDisclosures: [],
    prohibitedClaims: [],
    escalationRules: [],
    objectionRules: []
  },

  knowledgeBaseIds: [],
  promptTemplateId,
  voice,
  model,

  createdBy,
  updatedBy,
  createdAt,
  updatedAt
}
```

Profiles are versioned. Calls retain the version/hash used at runtime so later edits do not rewrite history.

### 6.5 `aiPromptTemplates/{templateId}`

Templates are server-controlled and should contain trusted system-level structure.

The browser may edit template content only for users with the explicit agent-management permission. Even then, the runtime compiler must surround/administer the editable content with immutable safety/compliance instructions.

### 6.6 `knowledgeBases/{kbId}` and documents

A knowledge base is an approved collection of facts/resources available to agent profiles.

Recommended fields include ownership, status, version, ingestion metadata, and citation/source metadata. Retrieval should return only the bounded chunks needed for a turn rather than dumping an entire knowledge base into every call prompt.

### 6.7 `callAuditEvents/{eventId}`

Append-only audit stream for security and analytics.

Examples:

- `session_started`
- `call_dialed`
- `human_answered`
- `ai_attached`
- `rep_connected`
- `listen_started`
- `listen_stopped`
- `prospect_requested_human`
- `handoff_requested`
- `handoff_announced`
- `handoff_completed`
- `rep_disconnected`
- `ai_disconnected`
- `dnc_marked`
- `call_ended`
- `disposition_recorded`
- `agent_profile_changed`

Every event records actor UID/type, call/session/campaign IDs, timestamps, and a bounded metadata object. Secrets and raw provider credentials are prohibited.

## 7. Routing state machine

### 7.1 Dial

1. Rep starts a parallel session.
2. Server acquires up to the configured number of eligible target locks; current default is three.
3. Compliance and research gates run exactly as today.
4. Provider creates independent outbound legs.
5. Each call doc is created with `control.controller = "unassigned"`.

### 7.2 Machine answer

If AMD classifies machine/fax:

- route according to campaign voicemail policy;
- never assign the rep;
- never start a conversational AI unless the campaign explicitly supports a voicemail agent workflow;
- apply terminal/retry disposition as appropriate.

### 7.3 Human answer

When a human answer arrives:

Run one transaction that loads the call and owning dialer session.

If the call was already routed, return idempotently.

If the session is inactive, safely end/cancel the call according to provider state.

If `session.rep.state == "available"` and no `session.rep.activeCallId` exists:

- assign `call.control.controller = "human"`;
- set `call.control.repUid = session.userUid`;
- set `session.rep.state = "busy"`;
- set `session.rep.activeCallId = callId`;
- bridge the rep into the call.

Otherwise:

- assign `call.control.controller = "ai"`;
- create an isolated AI session;
- attach the AI media participant;
- continue the call.

No sibling call is cancelled merely because this call routed.

### 7.4 Prospect asks for a human

The AI runtime must expose a structured server-side tool such as `request_human_handoff`.

When invoked:

- set `handoff.requestedBy = "prospect"`;
- set `handoff.state = "requested"`;
- set high priority;
- mark analytics flag;
- append an audit event.

If the owning rep is available and Auto Takeover is enabled, begin smooth handoff.

If the rep is busy or Auto Takeover is disabled, queue the call and let AI continue. AI may tell the prospect the rep is currently assisting someone else.

### 7.5 Rep requests takeover

The dashboard exposes `Listen` and `Take Over` for AI-controlled calls in the rep's own session.

`Listen` joins a listen-only participant or monitor path. Rep microphone must not be audible to the prospect or AI.

`Take Over` sets `handoff.requestedBy = "rep"` and begins smooth handoff when the rep is available. If the rep is already speaking on a different call, the system should not silently drop that call; takeover stays queued until the current human call ends or the rep explicitly ends it.

### 7.6 Smooth handoff

Required sequence:

1. Transaction reserves the rep for the target call and moves call to `transitioning`.
2. AI receives a server-authored instruction to announce the handoff.
3. AI says a concise configured handoff line, for example: "I'm going to bring Jonathan into the conversation now."
4. Human browser participant joins the same live call/conference.
5. Server confirms participant connected.
6. AI is muted/removed or switches to non-speaking monitor mode.
7. Call controller becomes `human`.
8. Session rep becomes `busy` with this call.
9. Audit event records completion.

A failure at any intermediate step must leave the prospect with either AI or human audio; never silence the call because a transfer partially failed.

### 7.7 Human call ends

When the rep's current human-controlled call ends:

- release `session.rep.activeCallId`;
- set rep `available` unless listening/offline;
- if Auto Takeover is enabled, examine queued calls eligible for handoff;
- only calls requested by prospect or rep may auto-transition;
- choose highest priority then oldest request;
- begin smooth handoff.

Otherwise surface the queue in UI and wait for rep action.

## 8. Audio/media architecture

Twilio is the recommended call-control carrier for V2 because the existing adapter already models per-leg call SIDs, AMD, cancellation, recordings, signed webhooks, and browser audio capability.

The preferred media topology is conference-oriented rather than direct winner bridging.

Each answered human call should be represented as a call/conference container with independently manageable participants:

- prospect PSTN participant
- AI media participant
- optional human browser Voice SDK participant
- optional listen-only/monitor participant

Conference participant controls provide the primitives needed to mute/remove AI and join a browser rep without forcing the prospect to redial.

The AI media path uses bidirectional real-time audio. Twilio Media Streams or a supported equivalent may feed the AI runtime. Because media streaming and conference topology have provider-specific constraints, the provider adapter must expose capability flags rather than leaking Twilio assumptions into the state machine.

Required provider capabilities for Hybrid V2:

```js
{
  parallelDial: true,
  perLegCallIds: true,
  humanAnswerDetection: true,
  conferenceControl: true,
  browserAudio: true,
  listenOnly: true,
  attachAI: true,
  detachAI: true,
  signedWebhooks: true
}
```

## 9. AI runtime architecture

The runtime is split into four layers.

### 9.1 Trusted policy layer

Immutable server-authored instructions:

- legal/compliance disclosures configured by campaign
- DNC handling
- privacy rules
- tool authorization
- prompt-injection resistance
- knowledge-base trust boundaries
- handoff rules
- prohibited actions

This layer cannot be replaced by a campaign/session override.

### 9.2 Agent profile layer

Saved reusable personality and sales behavior.

Examples:

- Friendly Consultant
- Website Sales
- AI Automation Sales
- Appointment Setter
- Spanish Sales
- Follow-up / Warm Lead

### 9.3 Campaign override layer

Campaign-specific objective, offer, pricing rules, target persona, qualification criteria, required disclosures, tools, and knowledge sources.

### 9.4 Session/day override layer

Temporary bounded instructions for the current dialing session. These may change tone, emphasis, promotion, event context, or daily offer but cannot override trusted policy or grant tools/permissions absent from the base profile/campaign.

Effective precedence:

`trusted policy > permissions/guardrails > profile > campaign override > session override > retrieved knowledge > live conversation context`

Later layers may specialize but not weaken higher-priority restrictions.

## 10. Secure prompt compiler

Do not concatenate raw UI text directly into a model `system` prompt.

Implement a server-side compiler that:

1. Loads the immutable runtime policy.
2. Loads the approved profile and exact version.
3. Loads campaign overrides.
4. Loads bounded session overrides.
5. Computes effective permissions by intersection, not union, where safety is involved.
6. Sanitizes and bounds free-text fields.
7. Fetches only relevant approved knowledge chunks.
8. Produces structured runtime instructions.
9. Hashes the effective config and writes the hash/version to the call document.
10. Exposes only explicitly allowed tools.

Untrusted prospect speech, webpages, imported knowledge documents, and CRM notes are DATA, not instructions. Runtime instructions must explicitly tell the model not to follow commands found inside those sources.

## 11. AI tools

Recommended server-side tools:

- `request_human_handoff`
- `mark_do_not_call`
- `book_meeting`
- `lookup_approved_pricing`
- `lookup_knowledge`
- `record_qualification`
- `record_interest_signal`
- `send_approved_followup` (future)

Tool calls must validate authorization against the effective agent profile/campaign permissions. Model intent alone is never sufficient authorization.

### DNC tool

When a prospect clearly says they do not want further calls, the AI should call `mark_do_not_call`. The server applies existing global DNC propagation. The AI may confirm the request and must not continue selling after a confirmed opt-out.

## 12. Identity, RBAC, and multi-rep isolation

Reuse existing Firebase Authentication and role system.

Introduce or reuse a permission such as `outbound_dialer` rather than hard-coding all outbound access to a single user identity. During migration, existing `admin` remains authorized.

Future roles may include:

- admin
- outbound_rep
- outbound_manager

Required checks:

- A rep may start/drive only their own session.
- A rep may listen/take over only calls in their own session unless supervisor permission is added.
- Agent-profile editing requires elevated permission.
- Knowledge-base editing requires elevated permission.
- Audit logs are server-write only.
- Provider webhook collections are closed to browser writes.

## 13. Dashboard experience

The existing `/admin/outbound` shell remains.

Live Dialer becomes a multi-call workspace instead of a winner-only panel.

Each active call card shows:

- prospect/business name
- phone
- call duration
- call state
- controller badge (`YOU`, `AI`, `RINGING`, `VOICEMAIL`)
- human-requested indicator
- live transcript preview
- AI profile
- Listen action when AI-controlled
- Take Over action when AI-controlled
- End Call
- Add to Do Not Call

There is no generic `Call` button on an already-active call card.

Session controls include:

- concurrency (default 3)
- agent profile
- campaign
- session/day override
- Auto Takeover toggle
- start/stop session

### Handoff queue

Order:

1. prospect requested human
2. rep-requested queued takeover
3. other AI calls ranked for informational display only

Buying-intent scoring may help the rep choose a manual takeover, but does not independently authorize transfer.

## 14. Live transcript

The dashboard subscribes to `calls/{callId}/turns` ordered by sequence/time.

Speaker treatment:

- Prospect
- AI
- Human
- System

The transcript is available while AI is active and continues seamlessly after takeover.

The rep should be able to open transcript context before pressing Take Over.

## 15. Listen-only mode

Listen mode must not change call ownership.

State rules:

- call remains `control.controller = "ai"`
- session may set `rep.listeningCallId`
- rep microphone remains muted to the conference
- one rep may listen to one call at a time in V1 UI unless future supervisor mode expands it
- stopping listen removes/mutes the monitor participant

Audit start/end and duration.

## 16. Agent profile UI

Add an Agent Profiles area under Outbound Settings or a dedicated sub-tab.

Features:

- create profile
- duplicate profile
- archive profile
- version history
- personality preset
- tone/language
- objective
- allowed actions
- pricing/discount constraints
- handoff phrase
- required disclosures
- prohibited claims
- knowledge bases
- advanced bounded instructions
- test/preview compiled prompt summary without exposing immutable security policy or secrets

Campaign Builder can choose a profile and apply campaign overrides.

Live Dialer can apply a temporary session override.

## 17. Knowledge base architecture

Knowledge sources may include approved text, FAQs, product/service information, pricing tables, scripts, and selected internal documents.

Requirements:

- ingestion is server-side
- every chunk retains source metadata
- archived/unapproved sources are excluded from retrieval
- imported instructions inside documents are not treated as system instructions
- knowledge version used by each call is auditable
- retrieval results are bounded

Do not allow arbitrary public web browsing from the live sales agent unless a future explicit provider/tool design adds it with a separate trust model.

## 18. Analytics and auditing

Track at minimum:

### Per call

- attempt
- ring duration
- answer type
- AI-controlled duration
- human-controlled duration
- listen duration
- number of takeovers
- human-request event
- disposition
- booked meeting
- close/sale flag and value when available
- DNC
- recording metadata
- transcript
- agent profile/version/hash
- timestamps for every major transition

### Per rep

- attempts
- conversations
- connection rate
- human talk time
- AI-assisted conversations
- manual takeovers
- prospect-requested transfers handled
- meetings booked
- closes
- conversion rate
- average talk time
- DNC outcomes

### Per agent profile

- conversations
- average AI duration
- human-request rate
- takeover rate
- meeting/close outcomes
- DNC rate
- tool usage

### Per campaign

Retain existing metrics and add AI/handoff/controller breakdowns.

## 19. Compliance controls

Technical implementation is not legal approval.

Preserve and expand:

- internal DNC
- configured calling windows/timezones
- consent basis
- recording disclosure settings
- AI disclosure settings
- retry/attempt limits
- global opt-out propagation

The call runtime must be able to immediately stop sales behavior and persist DNC after an explicit opt-out.

Live-call recording/transcription behavior must follow configured policy and applicable jurisdictional requirements.

## 20. Provider abstraction changes

The existing calling provider interface must evolve from "start/cancel leg" to media/controller primitives.

Recommended new methods:

```js
createOutboundLeg()
routeProspectToConference()
attachAIController()
detachAIController()
createBrowserToken()
joinHumanController()
joinListenOnly()
leaveListenOnly()
muteParticipant()
removeParticipant()
playAnnouncement()
endCall()
getCallStatus()
normalizeWebhookEvent()
verifyWebhook()
```

Provider-neutral orchestration code owns state transitions. The Twilio adapter owns Twilio REST/TwiML details.

## 21. Firebase Functions surface

Recommended callable/request endpoints:

- `startParallelDialerSession`
- `dialNextTargets`
- `stopDialerSessionCall`
- `getVoiceAccessToken`
- `beginListenToCall`
- `stopListeningToCall`
- `requestCallTakeover`
- `completeCallHandoff` (provider/server callback)
- `endOutboundCall`
- `markTargetDoNotCall`
- `createAgentProfile`
- `updateAgentProfile`
- `archiveAgentProfile`
- `compileAgentRuntimeConfig` (server/internal; optional preview callable returns safe summary only)
- `recordOutboundCallEvent`
- `twilioVoiceTwiml`
- `twilioConferenceEvent`
- `aiMediaSession` infrastructure endpoint/service

A traditional Firebase HTTPS Function is suitable for authenticated control-plane APIs and webhook/TwiML endpoints. Long-lived bidirectional WebSocket media should run on infrastructure that supports durable WebSocket connections. If Cloud Functions cannot satisfy the media-session lifetime/stream requirements cleanly, use Cloud Run for the media bridge while keeping Firebase Functions as the control plane. Do not fake a durable WebSocket inside a function runtime that is not designed for it.

## 22. OpenAI realtime integration boundary

If OpenAI Realtime is used for the live AI voice runtime:

- API key stays server-side.
- One Realtime session per AI-controlled call.
- Audio bridge performs explicit format conversion only where required.
- Transcript events are normalized into `calls/{callId}/turns`.
- Tool calls are validated server-side.
- Prospect speech is treated as untrusted input.
- Session instructions come from the secure prompt compiler.
- Handoff terminates or mutes AI output before human control is finalized.

The model/provider name must remain configurable at the agent profile or platform-config level so the orchestration architecture is not permanently coupled to one realtime model.

## 23. Failure handling

### AI fails to attach

If rep is free, route to human.

If rep is busy and AI cannot attach, play a configured apology/hold message and either queue briefly or end safely. Never leave silence indefinitely.

### Human browser disconnects

Attempt to keep the prospect with AI when policy permits. If AI is unavailable, end safely and disposition the call for retry/follow-up.

### Handoff fails after announcement

Keep/re-enable AI immediately and tell the prospect the human could not join yet. Record a failed handoff event.

### Webhook duplication

Use deterministic event IDs and revision-aware state transitions.

### Session heartbeat expires

Stop recruiting new targets. AI-controlled calls already in progress should be allowed to complete or be transferred to a recovery process rather than blindly terminated solely because the browser tab disappeared.

This changes the V1 assumption that an abandoned rep session must cancel every active call.

## 24. Testing contract

Tests must cover at minimum:

1. first human answer with free rep -> human
2. second human answer while rep busy -> AI, not cancelled
3. third human answer while rep busy -> independent AI
4. two simultaneous answers -> exactly one human controller and one AI controller
5. duplicate human-answer webhook -> idempotent
6. prospect requests human while rep busy -> queued, AI continues
7. prospect requests human while rep free + auto enabled -> smooth handoff starts
8. prospect requests human while rep free + auto disabled -> queued for manual action
9. rep clicks takeover while busy -> queued, current call not dropped
10. rep becomes available with auto enabled -> highest-priority authorized request selected
11. AI never forces takeover absent prospect/rep request
12. Listen mode -> rep mic not audible, controller remains AI
13. takeover -> AI announcement -> human participant confirmed -> AI removed/muted -> controller human
14. handoff failure -> AI remains/restores controller
15. explicit DNC from AI tool -> global DNC propagation
16. End Call does not imply DNC
17. manual DNC ends/suppresses according to UI action
18. calls remain isolated across two different rep sessions
19. rep cannot operate another rep's session
20. prompt compiler cannot weaken trusted policy through session override
21. knowledge-base prompt injection is treated as data
22. agent profile version/hash retained on call
23. analytics counters and audit events reflect controller durations and takeover
24. stale session does not orphan AI-controlled calls
25. machine answer follows voicemail policy and does not start normal conversational AI

## 25. Migration strategy

### Phase A — contract and pure state machine

- Add V2 data structures and pure routing functions.
- Add tests without live providers.
- Keep production calls inert.

### Phase B — Firestore integration

- Migrate session/call writes to V2 controller model.
- Replace `claimWinningCall`/`cancelLosingLegs` behavior for hybrid sessions.
- Preserve V1 mode behind an explicit compatibility flag only if needed for rollout.

### Phase C — Twilio conference/browser audio

- Configure TwiML App.
- Add short-lived Voice SDK token endpoint.
- Route answered calls into conference topology.
- Implement browser join and listen-only controls.

### Phase D — AI realtime bridge

- Add AI profile storage and prompt compiler.
- Add live media bridge.
- Persist transcript turns.
- Add DNC and handoff tools.

### Phase E — UI

- Multi-call cards.
- transcript pane.
- Listen / Take Over / End / DNC.
- Auto Takeover.
- Agent Profiles.
- session overrides.

### Phase F — analytics and QA

- audit stream
- rep analytics
- AI profile analytics
- campaign breakdowns
- playback/transcript review where permitted

### Phase G — live verification

- only consented test numbers controlled by the project owner
- one call first, then three-line test
- simulate simultaneous answers
- verify listen and takeover
- verify DNC
- verify two distinct rep accounts

## 26. Deployment and secret setup

Expected secrets/settings include at least:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_API_KEY_SID` (recommended for token signing)
- `TWILIO_API_KEY_SECRET`
- `TWILIO_TWIML_APP_SID`
- `OPENAI_API_KEY` when OpenAI realtime is enabled
- existing outbound webhook/discovery secrets

Never commit secret values.

Provider account setup must include callback URLs, signing validation, caller IDs/numbers, TwiML application, and any required account-level registration/verification.

## 27. Definition of done

Hybrid Dialer V2 is complete when all of the following are true:

- A rep can launch three calls.
- First answered human can reach the free rep.
- Additional answered humans are handled by independent AI sessions instead of being cancelled.
- Rep can read each AI call transcript live.
- Rep can listen silently to an AI call.
- Prospect can request human.
- Rep can request takeover.
- Smooth same-call handoff works without redial.
- Optional Auto Takeover works only on already-authorized handoff requests.
- AI profiles, campaign overrides, and session overrides compile securely.
- Knowledge base is selectable by profile.
- AI can mark explicit DNC through a validated server tool.
- End Call and DNC remain separate actions.
- Every call/action is attributed to the rep and agent profile version.
- Two rep accounts can operate isolated sessions concurrently.
- Existing prospect, compliance, DNC, research, history, and lead-promotion behavior remains intact.
- Emulator/unit tests cover the state machine and security rules.
- A live test with controlled/consented numbers validates carrier media, transcript, listen, takeover, and DNC.

## 28. Current implementation note

At the time this architecture was authored, the repository already contained a substantial V1 outbound system, including a provider registry, Twilio adapter, parallel dialing, DNC propagation, campaign/target/session models, tests, and `/admin/outbound` UI. The principal incompatible behavior is the server-enforced first-answer-wins/cancel-losing-legs model. V2 must change that state machine before the UI is allowed to imply that multiple answered calls are supported.
