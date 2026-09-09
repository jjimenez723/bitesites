// Explicit customer-email semantics for lead creation.
//
// A Firestore `source` says where a record came from; it does not prove who
// initiated contact. Customer lifecycle mail must be driven by this separate,
// server-verifiable classification so imports and outbound activity cannot be
// mistaken for inquiries merely because they created a lead document.

export const CONTACT_TYPES = Object.freeze({
  INBOUND_INQUIRY: 'inbound_inquiry',
  OUTBOUND_PROSPECT: 'outbound_prospect',
  BOOKING: 'booking'
});

const INBOUND_CHANNELS = Object.freeze({
  intake_form: new Set(['intake_form']),
  bit_chat: new Set(['bit_chat']),
  byte_voice: new Set(['byte_web', 'byte_inbound'])
});

export function inboundInquiryEmailLifecycle(channel) {
  return {
    contactType: CONTACT_TYPES.INBOUND_INQUIRY,
    initiatedBy: 'recipient',
    channel
  };
}

export function outboundProspectEmailLifecycle(channel = 'outbound') {
  return {
    contactType: CONTACT_TYPES.OUTBOUND_PROSPECT,
    initiatedBy: 'bitesites',
    channel
  };
}

export function bookingEmailLifecycle(channel = 'booking_page') {
  return {
    contactType: CONTACT_TYPES.BOOKING,
    initiatedBy: 'recipient',
    channel
  };
}

export function shouldSendInquiryReceipt(lead = {}) {
  const lifecycle = lead.emailLifecycle;
  if (!lifecycle || lifecycle.contactType !== CONTACT_TYPES.INBOUND_INQUIRY) return false;
  if (lifecycle.initiatedBy !== 'recipient') return false;
  const allowed = INBOUND_CHANNELS[lead.source];
  return Boolean(allowed && allowed.has(lifecycle.channel));
}

export function leadCrmClassification(lead = {}) {
  if (shouldSendInquiryReceipt(lead)) return 'inbound-inquiry';
  if (lead.emailLifecycle?.contactType === CONTACT_TYPES.BOOKING) return 'booking';
  return 'outbound-prospect';
}
