// Pushes every new lead into GoHighLevel so web enquiries land in the same
// pipeline as the calls the voice agent books.
//
// It posts to a GoHighLevel Inbound Webhook — the trigger URL you get from a
// GHL workflow. The workflow decides what to do with the payload (create the
// contact, tag it, start a follow-up sequence, notify the team). That keeps the
// mapping editable in GHL rather than hard-coded here.
//
// Set the URL once, then deploy:
//   firebase functions:secrets:set GHL_WEBHOOK_URL
//   npm run deploy:functions
//
// The outcome is written back onto the lead document under `crm`, so a failed
// sync is visible in the console rather than silently lost.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue } from 'firebase-admin/firestore';

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const GHL_WEBHOOK_URL = defineSecret('GHL_WEBHOOK_URL');

const SERVICE_LABELS = {
  web_development: 'Web Development',
  ai_automation: 'AI Automation',
  social_media_management: 'Social Media Management',
  other: 'Other'
};

const URGENCY_LABELS = {
  asap: 'ASAP',
  '2_4_weeks': '2-4 weeks',
  '1_2_months': '1-2 months',
  flexible: 'Flexible',
  other: 'Other'
};

const SIZE_LABELS = {
  solo: 'Solo / Freelancer',
  small: '2-10 employees',
  growing: '11-50 employees',
  established: '51-200 employees',
  enterprise: '200+ employees',
  other: 'Other'
};

// GHL wants first/last separately; most people type a single string.
function splitName(full = '') {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// A human-readable summary, so whoever picks the lead up has the context the
// structured fields lose.
function buildNotes(lead) {
  const lines = [
    `Source: ${lead.source === 'bit_chat' ? 'Bit chat assistant' : 'Website intake form'}`,
    `Services: ${(lead.services || []).map(s => SERVICE_LABELS[s] || s).join(', ')}`,
    `Business size: ${SIZE_LABELS[lead.businessSize] || lead.businessSize || '—'}`
  ];
  if (lead.urgencyTag) lines.push(`Timeline: ${URGENCY_LABELS[lead.urgencyTag] || lead.urgencyTag}`);
  if (lead.roleInCompany) lines.push(`Role: ${lead.roleInCompany}`);
  if (lead.preferredContactMethod) lines.push(`Prefers: ${lead.preferredContactMethod}`);
  if (lead.projectDetails) lines.push('', 'Project details:', lead.projectDetails);

  // Free-text answers typed into the chat instead of picking an option.
  if (lead.customAnswers && Object.keys(lead.customAnswers).length) {
    lines.push('', 'In their own words:');
    for (const [key, value] of Object.entries(lead.customAnswers)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  if (lead.pagePath) lines.push('', `Submitted from: ${lead.pagePath}`);
  if (lead.referrer) lines.push(`Referrer: ${lead.referrer}`);
  return lines.join('\n');
}

function buildPayload(lead, leadId) {
  const { firstName, lastName } = splitName(lead.name);
  return {
    firstName,
    lastName,
    name: lead.name,
    email: lead.email,
    phone: lead.phone || undefined,
    companyName: lead.businessName || undefined,
    source: lead.source === 'bit_chat' ? 'Website - Bit chat' : 'Website - intake form',
    tags: [
      'website-lead',
      ...(lead.services || []).map(s => `service:${s}`),
      ...(lead.urgencyTag ? [`timeline:${lead.urgencyTag}`] : [])
    ],
    notes: buildNotes(lead),
    leadId,
    // Raw values too, so a workflow can map whatever it needs.
    raw: {
      businessSize: lead.businessSize,
      services: lead.services,
      urgencyTag: lead.urgencyTag || null,
      preferredContactMethod: lead.preferredContactMethod,
      projectDetails: lead.projectDetails || null,
      roleInCompany: lead.roleInCompany || null
    }
  };
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export const syncLeadToGoHighLevel = onDocumentCreated(
  {
    document: 'leads/{leadId}',
    secrets: [GHL_WEBHOOK_URL]
  },
  async event => {
    const snapshot = event.data;
    if (!snapshot) return;

    const lead = snapshot.data();
    const { leadId } = event.params;
    const payload = buildPayload(lead, leadId);

    const webhookUrl = GHL_WEBHOOK_URL.value();

    // The secret has to exist for the function to deploy at all, so it starts
    // life as a placeholder. Anything that is not an http(s) URL means "not
    // configured yet" and is skipped quietly rather than logged as a failure.
    if (!/^https?:\/\//i.test(webhookUrl || '')) {
      console.warn(`[lead ${leadId}] GHL_WEBHOOK_URL not configured — skipping sync`);
      await snapshot.ref.set(
        { crm: { synced: false, reason: 'not-configured', at: FieldValue.serverTimestamp() } },
        { merge: true }
      );
      return;
    }

    try {
      await postJson(webhookUrl, payload);
      console.log(`[lead ${leadId}] synced to GoHighLevel`);
      await snapshot.ref.set(
        { crm: { synced: true, at: FieldValue.serverTimestamp() } },
        { merge: true }
      );
    } catch (error) {
      // Never rethrow: a CRM outage must not lose the lead, which is already
      // safely stored in Firestore. Record why and move on.
      console.error(`[lead ${leadId}] GoHighLevel sync failed:`, error.message);
      await snapshot.ref.set(
        {
          crm: {
            synced: false,
            error: String(error.message).slice(0, 500),
            at: FieldValue.serverTimestamp()
          }
        },
        { merge: true }
      );
    }
  }
);
