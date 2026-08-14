import React, { useState } from 'react';
import CallPlanFlow from './CallPlanFlow';
import LiveCallWorkspace from './LiveCallWorkspace';
import './outbound.css';
import './hybrid.css';

const campaign = {
  id: 'training-preview',
  name: 'Local Business Website Growth',
  requireResearchApproval: true,
  counts: { ready: 18, pending: 7, callLater: 3 }
};

const call = {
  id: 'training-call',
  status: 'connected',
  displayName: 'H & S Contracting Of NY Inc',
  companyName: 'H & S Contracting Of NY Inc',
  contactName: 'Sam Rivera',
  phoneE164: '+13476986352',
  website: '',
  businessCategory: 'home_improvement_contractor',
  contactLocation: { city: 'Brooklyn', region: 'NY', timezone: 'America/New_York' },
  attemptNumber: 1,
  startedAt: new Date(Date.now() - 194000),
  answeredAt: new Date(Date.now() - 181000),
  control: { controller: 'human' },
  agent: { profileName: 'Maya — Website Growth Consultant' },
  callPlan: {
    approved: true,
    status: 'approved',
    confidence: .82,
    summary: 'Understand how H & S currently wins local contracting work and whether a measurable website could help turn referrals and search traffic into qualified enquiries.',
    suggestedOpening: 'Hi Sam, this is Jensy with BiteSites. I work with local service businesses on turning their web presence into a more reliable source of enquiries. Did I catch you with thirty seconds for the reason I called?',
    verifiedFacts: [
      { id: '1', text: 'The business is registered as a home improvement contractor in Brooklyn, New York.' },
      { id: '2', text: 'No company website is present in the sourced business record.' },
      { id: '3', text: 'The current phone number is listed as the primary business contact.' }
    ],
    hypotheses: ['The business may rely primarily on referrals and directory listings for new work.'],
    likelyNeeds: ['How do most new customers find you today?', 'When someone searches for your work, what do you want them to see first?', 'How quickly can you respond to a new estimate request?'],
    talkingPoints: ['A focused contractor site can establish trust before the first estimate.', 'Lead capture and follow-up should match the way the team actually works.'],
    likelyObjections: ['Most of our work comes from referrals.', 'We already have enough work.', 'I do not want another monthly platform.']
  }
};

const session = { status: 'active', rep: { state: 'busy', activeCallId: call.id }, takeover: { autoEnabled: false } };
const coachedCall = {
  ...call,
  coaching: { state: 'monitoring', supervisorUid: 'manager-demo', supervisorName: 'Maya Chen' }
};
const turns = [
  { id: '1', speaker: 'human', text: 'Hi Sam, this is Jensy with BiteSites. Did I catch you with thirty seconds for the reason I called?' },
  { id: '2', speaker: 'prospect', text: 'Sure, I have a minute. What is this about?' },
  { id: '3', speaker: 'human', text: 'We help local contractors turn their web presence into a more dependable source of qualified enquiries. How are most new customers finding you right now?' },
  { id: '4', speaker: 'prospect', text: 'Mostly referrals. We stay busy, but people keep asking if we have somewhere they can see our work.' },
  { id: '5', speaker: 'human', text: 'That makes sense. When someone asks, what do you usually send them today?' }
];

export default function OutboundExperiencePreview() {
  const [view, setView] = useState('plan');
  return (
    <div className="bs-admin preview-shell">
      <div className="preview-toolbar">
        <div><strong>BiteSites outbound experience</strong><span>Development preview · no calls can be placed</span></div>
        <div className="admin-segment">
          <button type="button" aria-pressed={view === 'plan'} onClick={() => setView('plan')}>Planning flow</button>
          <button type="button" aria-pressed={view === 'call'} onClick={() => setView('call')}>Live workspace</button>
          <button type="button" aria-pressed={view === 'coach'} onClick={() => setView('coach')}>Coach mode</button>
        </div>
      </div>
      {view === 'plan' ? (
        <div className="preview-stage"><CallPlanFlow campaign={campaign} session={null} interactive={false} /></div>
      ) : view === 'coach' ? (
        <LiveCallWorkspace call={coachedCall} session={session} participationMode="coach" demo demoTurns={turns} onClose={() => setView('plan')} onDisposition={() => false} />
      ) : (
        <LiveCallWorkspace call={call} session={session} target={{ phoneE164: call.phoneE164, timezone: 'America/New_York' }} demo demoTurns={turns} onClose={() => setView('plan')} onDisposition={() => true} />
      )}
    </div>
  );
}
