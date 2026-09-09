import test from 'node:test';
import assert from 'node:assert/strict';
import { inboundInquiryEmailLifecycle, outboundProspectEmailLifecycle, bookingEmailLifecycle, shouldSendInquiryReceipt } from './lead-email-intent.js';

test('only explicitly recipient-initiated inbound inquiries receive a receipt', () => {
  assert.equal(shouldSendInquiryReceipt({ source: 'intake_form', emailLifecycle: inboundInquiryEmailLifecycle('intake_form') }), true);
  assert.equal(shouldSendInquiryReceipt({ source: 'bit_chat', emailLifecycle: inboundInquiryEmailLifecycle('bit_chat') }), true);
  assert.equal(shouldSendInquiryReceipt({ source: 'byte_voice', emailLifecycle: inboundInquiryEmailLifecycle('byte_web') }), true);
  assert.equal(shouldSendInquiryReceipt({ source: 'byte_voice', emailLifecycle: inboundInquiryEmailLifecycle('byte_inbound') }), true);
});

test('outbound, manual, imported, GHL, follow-up-created, booking, and questionnaire records never receive inquiry receipts', () => {
  const negative = [
    { source: 'outbound', emailLifecycle: outboundProspectEmailLifecycle('prospect_promotion') },
    { source: 'outbound', acquisition: { trigger: 'manual_qualification' }, emailLifecycle: outboundProspectEmailLifecycle('manual_qualification') },
    { source: 'outbound', acquisition: { originalSystem: 'gohighlevel_contacts' }, emailLifecycle: outboundProspectEmailLifecycle('ghl_import') },
    { source: 'byte_voice', crm: { reason: 'origin-gohighlevel' } },
    { source: 'outbound', emailLifecycle: outboundProspectEmailLifecycle('admin_followup') },
    { source: 'booking_page', emailLifecycle: bookingEmailLifecycle() },
    { source: 'prospect_questionnaire' },
    { source: 'intake_form' },
    { source: 'outbound', emailLifecycle: inboundInquiryEmailLifecycle('intake_form') }
  ];
  negative.forEach(lead => assert.equal(shouldSendInquiryReceipt(lead), false));
});
