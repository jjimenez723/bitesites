import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLeads, useUsers } from './data';
import { deleteTemplate, listTemplates, saveTemplate, sendLeadEmail, sendTemplateEmail } from './email-api';

const blankTemplate = () => ({
  id: '', name: 'New email', description: '', category: 'broadcast',
  subject: '{{headline}}',
  html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#ffffff;color:#222222;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff"><tr><td align="center" style="padding:40px 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px"><tr><td align="center" style="padding:0 0 28px;border-bottom:1px solid #e8e8e8"><a href="{{brand_url}}"><img src="{{logo_url}}" width="74" height="74" alt="BiteSites" style="display:block;width:74px;height:74px;border:0"></a></td></tr><tr><td style="padding:40px 0 36px"><h1 style="margin:0 0 20px;color:#111111;font-size:30px;line-height:37px">{{headline}}</h1><div style="color:#3f3f3f;font-size:16px;line-height:26px"><p style="margin:0 0 16px">Hi {{first_name}},</p><p style="margin:0">{{message}}</p></div><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px"><tr><td style="border-radius:8px;background:#111111"><a href="{{cta_url}}" style="display:inline-block;padding:13px 20px;color:#ffffff;font-size:15px;line-height:20px;font-weight:700;text-decoration:none">{{cta_label}}</a></td></tr></table></td></tr><tr><td style="padding:22px 0 0;border-top:1px solid #e8e8e8"><p style="margin:0;color:#777777;font-size:12px;line-height:19px">You are receiving this because you have a BiteSites account. Questions? Reply to this email.</p></td></tr></table></td></tr></table></body></html>',
  text: '{{headline}}\n\nHi {{first_name}},\n\n{{message}}\n\n{{cta_label}}: {{cta_url}}'
});

const VARIABLE_LIBRARY = {
  brand_url: { label: 'BiteSites website', hint: 'Added automatically and links the logo back to bitesites.org.', automatic: true },
  logo_url: { label: 'BiteSites logo', hint: 'Added automatically and supplies the branded logo image.', automatic: true },
  first_name: { label: 'First name', hint: 'Added for each recipient automatically.', automatic: true },
  email: { label: 'Recipient email', hint: 'Added for each recipient automatically.', automatic: true },
  headline: { label: 'Headline', hint: 'The main title of this email.' },
  message: { label: 'Message', hint: 'The main body copy of this email.' },
  cta_label: { label: 'Button label', hint: 'Text shown on the call-to-action button.' },
  cta_url: { label: 'Button URL', hint: 'Where the call-to-action button links.' },
  verify_url: { label: 'Verification URL', hint: 'A secure account-confirmation link.' },
  pricing_url: { label: 'Pricing URL', hint: 'A link to the pricing page.' },
  reset_url: { label: 'Password reset URL', hint: 'A secure password-reset link.' },
  company: { label: 'Company', hint: 'The recipient’s company name.' },
  admin_url: { label: 'Admin URL', hint: 'A link back to the admin dashboard.' },
  preference_url: { label: 'Email preferences URL', hint: 'A unique recipient link added automatically to broadcasts and feedback requests.', automatic: true },
  agent_name: { label: 'Agent name', hint: 'The agent who handled the completed conversation.', automatic: true },
  source_label: { label: 'Inquiry source', hint: 'The form or agent that created the inquiry.', automatic: true },
  service_names: { label: 'Services', hint: 'A readable list of services from the inquiry.', automatic: true },
  consultation_url: { label: 'Consultation URL', hint: 'The BiteSites consultation booking link.', automatic: true },
  lead_name: { label: 'Lead name', hint: 'The name captured with a new lead.', automatic: true },
  contact: { label: 'Lead contact', hint: 'The best email or phone captured for a lead.', automatic: true },
  lead_url: { label: 'Lead URL', hint: 'A link to the admin Leads view.', automatic: true },
  role_label: { label: 'Access role', hint: 'The access level granted to an account.', automatic: true },
  sign_in_url: { label: 'Sign-in URL', hint: 'The correct sign-in destination for the granted role.', automatic: true },
  support_email: { label: 'Support email', hint: 'The BiteSites support address.', automatic: true },
  feedback_url: { label: 'Feedback URL', hint: 'A secure link for the conversation feedback request.', automatic: true },
  rating_1_url: { label: 'Rating 1 URL', hint: 'Secure rating link generated for the recipient.', automatic: true },
  rating_2_url: { label: 'Rating 2 URL', hint: 'Secure rating link generated for the recipient.', automatic: true },
  rating_3_url: { label: 'Rating 3 URL', hint: 'Secure rating link generated for the recipient.', automatic: true },
  rating_4_url: { label: 'Rating 4 URL', hint: 'Secure rating link generated for the recipient.', automatic: true },
  rating_5_url: { label: 'Rating 5 URL', hint: 'Secure rating link generated for the recipient.', automatic: true }
};

const templateVariables = template => Array.from(new Set(
  `${template?.subject || ''} ${template?.html || ''} ${template?.text || ''}`
    .match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)?.map(token => token.replace(/[{}\s]/g, '')) || []
));

const variableLabel = name => VARIABLE_LIBRARY[name]?.label || name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, letter => letter.toUpperCase());

const variableHint = name => VARIABLE_LIBRARY[name]?.hint || 'A custom value you can set before this email is sent.';

const normalizeVariableName = value => value
  .replace(/[{}]/g, '')
  .trim()
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 60);

const tokenLength = name => name.length + 4;

const serializeEditorNodes = nodes => Array.from(nodes).map(node => {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.dataset.variable) return `{{${node.dataset.variable}}}`;
  if (node.tagName === 'BR') return '\n';
  const content = serializeEditorNodes(node.childNodes);
  return /^(DIV|P)$/.test(node.tagName) && node.nextSibling ? `${content}\n` : content;
}).join('');

const renderVariablePills = (editor, value) => {
  const fragment = document.createDocumentFragment();
  const pattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) fragment.append(document.createTextNode(value.slice(cursor, match.index)));
    const pill = document.createElement('span');
    pill.className = 'email-inline-variable-pill';
    pill.contentEditable = 'false';
    pill.dataset.variable = match[1];
    pill.setAttribute('aria-label', `Variable: ${variableLabel(match[1])}`);
    pill.textContent = variableLabel(match[1]);
    fragment.append(pill);
    cursor = pattern.lastIndex;
  }
  if (cursor < value.length || !fragment.childNodes.length) fragment.append(document.createTextNode(value.slice(cursor)));
  editor.replaceChildren(fragment);
};

const editorSelection = editor => {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
    const end = serializeEditorNodes(editor.childNodes).length;
    return { start: end, end };
  }
  const positionAt = (container, offset) => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(container, offset);
    return serializeEditorNodes(range.cloneContents().childNodes).length;
  };
  return { start: positionAt(selection.anchorNode, selection.anchorOffset), end: positionAt(selection.focusNode, selection.focusOffset) };
};

const placeEditorCaret = (editor, position) => {
  let consumed = 0;
  let destination = null;
  const findDestination = parent => {
    for (let index = 0; index < parent.childNodes.length; index += 1) {
      const node = parent.childNodes[index];
      const length = node.nodeType === Node.TEXT_NODE ? (node.nodeValue || '').length
        : node.nodeType === Node.ELEMENT_NODE && node.dataset.variable ? tokenLength(node.dataset.variable)
          : serializeEditorNodes([node]).length;
      if (position <= consumed + length) {
        if (node.nodeType === Node.TEXT_NODE) return { node, offset: Math.max(0, position - consumed) };
        if (node.nodeType === Node.ELEMENT_NODE && node.dataset.variable) return { node: parent, offset: index + (position - consumed > 0 ? 1 : 0) };
        return findDestination(node) || { node: parent, offset: index };
      }
      consumed += length;
    }
    return { node: parent, offset: parent.childNodes.length };
  };
  destination = findDestination(editor);
  const range = document.createRange();
  range.setStart(destination.node, destination.offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

function VariableTokenEditor({ field, id, value, placeholder, multiline = false, inputRef, onChange, onRememberSelection }) {
  const editor = useRef(null);

  useEffect(() => {
    if (editor.current && serializeEditorNodes(editor.current.childNodes) !== value) renderVariablePills(editor.current, value);
  }, [value]);

  const reportSelection = target => onRememberSelection(field, editorSelection(target));
  const reportChange = event => {
    const target = event.currentTarget;
    const selection = editorSelection(target);
    onChange(field, serializeEditorNodes(target.childNodes), { ...selection, inputType: event.nativeEvent?.inputType, data: event.nativeEvent?.data });
  };

  return <div
    id={id}
    ref={node => { editor.current = node; inputRef(node); }}
    className={`email-token-editor${multiline ? ' multiline' : ''}`}
    contentEditable
    suppressContentEditableWarning
    role="textbox"
    aria-multiline={multiline || undefined}
    aria-label={placeholder}
    data-placeholder={placeholder}
    onFocus={event => reportSelection(event.currentTarget)}
    onKeyUp={event => reportSelection(event.currentTarget)}
    onClick={event => reportSelection(event.currentTarget)}
    onKeyDown={event => { if (!multiline && event.key === 'Enter') event.preventDefault(); }}
    onInput={reportChange}
    onPaste={event => {
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    }}
  />;
}

const preview = (template, variables) => {
  const values = {
    brand_url: 'https://bitesites.org', logo_url: 'https://bitesites.org/apple-touch-icon.png',
    first_name: 'Alex', email: 'alex@example.com', headline: 'A brighter digital experience',
    message: 'Here is a preview of your BiteSites email. Every part of this message can be edited in the studio.',
    cta_label: 'Explore what’s new', cta_url: 'https://bitesites.org', verify_url: '#', pricing_url: '#',
    reset_url: '#', company: 'Example Company', admin_url: '#', preference_url: '#', feedback_url: '#',
    rating_1_url: '#', rating_2_url: '#', rating_3_url: '#', rating_4_url: '#', rating_5_url: '#',
    agent_name: 'Bit', source_label: 'Bit', service_names: 'Web Development', consultation_url: '#',
    lead_name: 'Alex Morgan', contact: 'alex@example.com', lead_url: '#', role_label: 'client',
    sign_in_url: '#', support_email: 'jensy@bitesites.org', ...variables
  };
  return String(template?.html || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] || `[${variableLabel(key)}]`);
};

function DeliveryType({ value, onChange }) {
  return (
    <div className="email-delivery-types" role="radiogroup" aria-label="Email type">
      <button
        className={value === 'transactional' ? 'selected' : ''}
        type="button"
        role="radio"
        aria-checked={value === 'transactional'}
        onClick={() => onChange('transactional')}
      >
        <span className="email-type-icon" aria-hidden="true">↗</span>
        <span><strong>Transactional</strong><small>One-to-one account or action email. Use for confirmations, password resets, and other expected updates.</small></span>
      </button>
      <button
        className={value === 'broadcast' ? 'selected' : ''}
        type="button"
        role="radio"
        aria-checked={value === 'broadcast'}
        onClick={() => onChange('broadcast')}
      >
        <span className="email-type-icon" aria-hidden="true">◎</span>
        <span><strong>Broadcast</strong><small>One announcement sent to a selected group. Use for news, launches, and general client updates.</small></span>
      </button>
    </div>
  );
}

const BOOKING_URL = 'https://calendar.app.google/bKKKvGWBSgvV8rodA';

const firstWord = value => String(value || '').trim().split(/\s+/)[0] || '';

const starterCopy = (type, firstName, businessName) => {
  const name = firstName || 'there';
  const business = businessName ? ` for ${businessName}` : '';
  if (type === 'confirmation') return {
    subject: `${name}, you’re all set with BiteSites`,
    message: `It was great speaking with you${business}. I’ve added your information to the BiteSites system so our team has the context from our call.\n\nIf anything changes or you want to add a detail, just reply to this email.`
  };
  if (type === 'follow_up') return {
    subject: `Following up on our conversation${businessName ? ` about ${businessName}` : ''}`,
    message: `Thanks again for taking the time to speak with me${business}. I’m looking forward to continuing the conversation and talking through the next steps.`
  };
  return { subject: '', message: '' };
};

const displayMeetingTime = value => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
};

const googleCalendarUrl = (meetingLocal, subject) => {
  if (!meetingLocal) return 'https://calendar.google.com/calendar/u/0/r/eventedit';
  const start = new Date(meetingLocal);
  if (Number.isNaN(start.getTime())) return 'https://calendar.google.com/calendar/u/0/r/eventedit';
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: subject || 'BiteSites meeting',
    dates: `${stamp(start)}/${stamp(end)}`,
    details: 'BiteSites consultation. Add Google Meet conferencing, save the event, then paste the Meet link into the dashboard email.'
  });
  return `https://calendar.google.com/calendar/render?${params}`;
};

function LeadEmailComposer({ initialLeadId, onOpenAutomations }) {
  const { rows: leads, loading, refresh } = useLeads();
  const [selectedLeadId, setSelectedLeadId] = useState(initialLeadId || '');
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [starter, setStarter] = useState('confirmation');
  const initialCopy = starterCopy('confirmation', '', '');
  const [subject, setSubject] = useState(initialCopy.subject);
  const [message, setMessage] = useState(initialCopy.message);
  const [actionType, setActionType] = useState('none');
  const [meetingLocal, setMeetingLocal] = useState('');
  const [meetUrl, setMeetUrl] = useState('');
  const [bookingUrl, setBookingUrl] = useState(BOOKING_URL);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const initializedLead = useRef(false);

  const chooseLead = id => {
    setSelectedLeadId(id);
    const lead = leads.find(item => item.id === id);
    if (!lead) return;
    const nextFirstName = firstWord(lead.name);
    setFirstName(nextFirstName);
    setEmail(lead.email || '');
    setBusinessName(lead.businessName || '');
    const copy = starterCopy(starter, nextFirstName, lead.businessName || '');
    setSubject(copy.subject);
    setMessage(copy.message);
    setNotice({ kind: '', text: '' });
  };

  useEffect(() => {
    if (!initializedLead.current && initialLeadId && leads.some(lead => lead.id === initialLeadId)) {
      initializedLead.current = true;
      chooseLead(initialLeadId);
    }
  }, [initialLeadId, leads]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseStarter = value => {
    setStarter(value);
    const copy = starterCopy(value, firstName, businessName);
    setSubject(copy.subject);
    setMessage(copy.message);
    setNotice({ kind: '', text: '' });
  };

  const updateRecipientDetail = (key, value) => {
    const previous = starterCopy(starter, firstName, businessName);
    const nextFirstName = key === 'firstName' ? value : firstName;
    const nextBusinessName = key === 'businessName' ? value : businessName;
    const next = starterCopy(starter, nextFirstName, nextBusinessName);
    // Keep untouched starter copy personalized as the contact is entered, but
    // stop auto-writing as soon as the admin edits either field themselves.
    if (subject === previous.subject) setSubject(next.subject);
    if (message === previous.message) setMessage(next.message);
    if (key === 'firstName') setFirstName(value);
    else setBusinessName(value);
  };

  const meetingTime = displayMeetingTime(meetingLocal);
  const actionUrl = actionType === 'confirmed' ? meetUrl : actionType === 'self_schedule' ? bookingUrl : '';
  const canSend = email && subject.trim() && message.trim()
    && (actionType === 'none' || actionUrl.startsWith('https://'))
    && (actionType !== 'confirmed' || meetingTime);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setNotice({ kind: '', text: '' });
    try {
      await sendLeadEmail({
        leadId: selectedLeadId, email, firstName: firstName || firstWord(email.split('@')[0]),
        businessName, subject: subject.trim(), headline: subject.trim(), message: message.trim(),
        actionType, actionUrl, meetingTime,
        meetingAt: actionType === 'confirmed' && meetingLocal ? new Date(meetingLocal).toISOString() : ''
      });
      await refresh();
      setNotice({ kind: 'success', text: `Sent to ${email}. The contact and follow-up are now recorded in Leads.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'The email could not be sent.' });
    } finally {
      setBusy(false);
    }
  };

  return <>
    <header className="admin-topbar">
      <div><h1>Lead email</h1><p className="admin-topbar-sub">Send a personal follow-up, meeting confirmation, or booking link.</p></div>
      <div className="admin-topbar-spacer" />
      <button className="btn-admin" type="button" onClick={onOpenAutomations}>Automated emails</button>
      <button className="btn-admin primary" type="button" disabled={busy || !canSend} onClick={send}>{busy ? 'Sending…' : 'Send email'}</button>
    </header>

    <div className="admin-body lead-email-page">
      {notice.text && <p className={`email-notice ${notice.kind}`} aria-live="polite">{notice.text}</p>}
      <div className="lead-email-layout">
        <main className="admin-card lead-email-composer">
          <section className="lead-email-section">
            <div className="lead-email-section-head"><span>1</span><div><h3>Who is this for?</h3><p>Choose a lead to fill their details, or enter someone new.</p></div></div>
            <div className="lead-email-fields">
              <label className="full"><span>Lead</span><select value={selectedLeadId} onChange={event => chooseLead(event.target.value)}><option value="">New or unlisted contact</option>{leads.map(lead => <option key={lead.id} value={lead.id}>{lead.name || lead.email || lead.phone || 'Unnamed lead'}{lead.businessName ? ` — ${lead.businessName}` : ''}</option>)}</select>{loading && <small>Loading leads…</small>}</label>
              <label><span>First name</span><input value={firstName} onChange={event => updateRecipientDetail('firstName', event.target.value)} placeholder="Alex" /></label>
              <label><span>Business</span><input value={businessName} onChange={event => updateRecipientDetail('businessName', event.target.value)} placeholder="Acme Studio" /></label>
              <label className="full"><span>Email</span><input type="email" value={email} onChange={event => { setEmail(event.target.value); if (selectedLeadId) setSelectedLeadId(''); }} placeholder="alex@business.com" /></label>
            </div>
          </section>

          <section className="lead-email-section">
            <div className="lead-email-section-head"><span>2</span><div><h3>Start with</h3><p>Use a practical starting point, then edit every word below.</p></div></div>
            <div className="lead-email-starters">
              {[
                ['confirmation', 'Added to our system', 'Confirm that their details and call context are saved.'],
                ['follow_up', 'Conversation follow-up', 'Continue a promising conversation and outline next steps.'],
                ['custom', 'Write from scratch', 'Start with a blank subject and message.']
              ].map(([value, label, description]) => <button key={value} type="button" className={starter === value ? 'selected' : ''} onClick={() => chooseStarter(value)}><strong>{label}</strong><small>{description}</small></button>)}
            </div>
            <div className="lead-email-fields message-fields">
              <label className="full"><span>Subject</span><input value={subject} onChange={event => setSubject(event.target.value)} placeholder="A clear subject line" /></label>
              <label className="full"><span>Message</span><textarea rows="8" value={message} onChange={event => setMessage(event.target.value)} placeholder="Write your note here…" /></label>
            </div>
          </section>

          <section className="lead-email-section">
            <div className="lead-email-section-head"><span>3</span><div><h3>Add a meeting action</h3><p>Confirm the time you agreed on, let them choose, or send only the note.</p></div></div>
            <div className="lead-email-actions">
              {[
                ['none', 'No meeting link', 'Send the message as-is.'],
                ['confirmed', 'Time already agreed', 'Include the exact time and Google Meet link.'],
                ['self_schedule', 'Let them choose', 'Send your Google booking page.']
              ].map(([value, label, description]) => <button key={value} type="button" className={actionType === value ? 'selected' : ''} onClick={() => setActionType(value)}><strong>{label}</strong><small>{description}</small></button>)}
            </div>

            {actionType === 'confirmed' && <div className="lead-email-fields meeting-fields">
              <label><span>Agreed date and time</span><input type="datetime-local" value={meetingLocal} onChange={event => setMeetingLocal(event.target.value)} /></label>
              <label><span>Google Meet link</span><input type="url" value={meetUrl} onChange={event => setMeetUrl(event.target.value)} placeholder="https://meet.google.com/…" /></label>
              <div className="full meeting-helper"><div><strong>{meetingTime || 'Choose the agreed time above'}</strong><small>The recipient will see the time in your current timezone.</small></div><a className="btn-admin" href={googleCalendarUrl(meetingLocal, subject)} target="_blank" rel="noreferrer">Open Google Calendar ↗</a></div>
            </div>}
            {actionType === 'self_schedule' && <div className="lead-email-fields meeting-fields"><label className="full"><span>Booking page</span><input type="url" value={bookingUrl} onChange={event => setBookingUrl(event.target.value)} /></label></div>}
          </section>
        </main>

        <aside className="admin-card lead-email-preview">
          <div className="lead-email-preview-head"><span className="email-eyebrow">Recipient view</span><h3>Ready to review</h3><p>This is the content that will be sent through Postmark.</p></div>
          <div className="lead-email-paper">
            <img src="https://bitesites.org/apple-touch-icon.png" width="60" height="60" alt="BiteSites" />
            <div className="lead-email-paper-content">
              <small>Subject</small><strong className="preview-subject">{subject || 'Your subject will appear here'}</strong>
              <h2>{subject || 'Your email'}</h2>
              <p>Hi {firstName || 'there'},</p>
              <p className="preview-message">{message || 'Your message will appear here.'}</p>
              {actionType === 'confirmed' && meetingTime && <div className="preview-meeting"><small>Meeting time</small><strong>{meetingTime}</strong></div>}
              {actionType !== 'none' && <span className="preview-button">{actionType === 'confirmed' ? 'Join Google Meet' : 'Choose a meeting time'}</span>}
            </div>
            <p className="preview-footer">This is a personal follow-up from your BiteSites conversation. Reply to this email if you have any questions.</p>
          </div>
        </aside>
      </div>
    </div>
  </>;
}

function TemplateLibrary({ onOpenComposer }) {
  const { rows: users } = useUsers();
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [variables, setVariables] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [activeContentField, setActiveContentField] = useState('text');
  const [variableMaker, setVariableMaker] = useState(null);
  const editorRefs = useRef({});
  const editorSelections = useRef({});

  const reload = async preferred => {
    setLoading(true);
    try {
      const rows = await listTemplates();
      setTemplates(rows);
      const id = preferred || selectedId || rows[0]?.id;
      const found = rows.find(item => item.id === id) || rows[0];
      setSelectedId(found?.id || '');
      setDraft(found ? { ...found } : blankTemplate());
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Could not load email templates.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useMemo(() => templateVariables(draft), [draft]);
  const recipientList = useMemo(() => Array.from(new Set(recipients.split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean))), [recipients]);
  const suggestedVariables = useMemo(() => Object.keys(VARIABLE_LIBRARY).filter(name => !fields.includes(name)), [fields]);

  const clearVariableEditor = () => {
    setVariables({});
    setVariableMaker(null);
    setActiveContentField('text');
    editorSelections.current = {};
  };

  const choose = id => {
    setSelectedId(id);
    setDraft({ ...templates.find(item => item.id === id) });
    clearVariableEditor();
    setNotice({ kind: '', text: '' });
  };

  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));

  const rememberSelection = (field, selection) => {
    setActiveContentField(field);
    editorSelections.current[field] = selection;
  };

  const openVariableMaker = field => {
    const target = field || activeContentField || 'text';
    const fallbackPosition = String(draft?.[target] || '').length;
    const selection = editorSelections.current[target] || { start: fallbackPosition, end: fallbackPosition };
    setActiveContentField(target);
    setVariableMaker({ field: target, start: selection.start, end: selection.end, name: '' });
  };

  const changeContent = (field, value, selection) => {
    const cursor = selection.start ?? value.length;
    const insertedSlash = selection.inputType === 'insertText' && selection.data === '/';
    const commandPosition = cursor === 1 || /\s/.test(value.charAt(cursor - 2));
    update(field, value);
    setActiveContentField(field);
    editorSelections.current[field] = { start: cursor, end: selection.end ?? cursor };

    // A slash at the beginning of a word is a quick variable command. Keeping
    // the slash in the field makes closing the menu harmless; choosing a value
    // replaces it with the variable token.
    if (field !== 'html' && insertedSlash && commandPosition) {
      setVariableMaker({ field, start: cursor - 1, end: cursor, name: '' });
    }
  };

  const nativeEditorSelection = target => ({
    start: target.selectionStart ?? String(target.value || '').length,
    end: target.selectionEnd ?? String(target.value || '').length
  });

  const changeNativeContent = (field, event) => changeContent(field, event.target.value, {
    ...nativeEditorSelection(event.target), inputType: event.nativeEvent?.inputType, data: event.nativeEvent?.data
  });

  const insertVariable = rawName => {
    const name = normalizeVariableName(rawName);
    if (!name || !variableMaker) return;
    const { field, start, end } = variableMaker;
    const token = `{{${name}}}`;
    const source = String(draft?.[field] || '');
    const position = Math.max(0, Math.min(start, source.length));
    const finish = Math.max(position, Math.min(end, source.length));
    const next = `${source.slice(0, position)}${token}${source.slice(finish)}`;
    update(field, next);
    setVariableMaker(null);

    window.setTimeout(() => {
      const editor = editorRefs.current[field];
      if (!editor) return;
      const nextPosition = position + token.length;
      editor.focus();
      if (editor.setSelectionRange) editor.setSelectionRange(nextPosition, nextPosition);
      else placeEditorCaret(editor, nextPosition);
      editorSelections.current[field] = { start: nextPosition, end: nextPosition };
    }, 0);
  };

  const save = async () => {
    setBusy('save'); setNotice({ kind: '', text: '' });
    try {
      const payload = { ...draft, id: draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') };
      const result = await saveTemplate(payload);
      await reload(result.id);
      setNotice({ kind: 'success', text: 'Template saved. New sends will use this version immediately.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Could not save the template.' });
    } finally { setBusy(''); }
  };

  const remove = async () => {
    if (!draft?.id || draft.system || !window.confirm(`Delete “${draft.name}”?`)) return;
    setBusy('delete');
    try {
      await deleteTemplate(draft.id);
      setSelectedId('');
      await reload();
      setNotice({ kind: 'success', text: 'Template deleted.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Could not delete the template.' });
    } finally { setBusy(''); }
  };

  const send = async () => {
    setBusy('send'); setNotice({ kind: '', text: '' });
    try {
      const result = await sendTemplateEmail({ templateId: draft.id, recipients: recipientList, variables });
      const skipped = result.skipped ? ` ${result.skipped} opted-out or suppressed recipient${result.skipped === 1 ? ' was' : 's were'} skipped.` : '';
      setNotice({ kind: 'success', text: `${result.sent} email${result.sent === 1 ? '' : 's'} accepted by Postmark.${skipped}` });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Postmark could not send this email.' });
    } finally { setBusy(''); }
  };

  if (loading && !draft) return <div className="admin-body"><div className="admin-card"><div className="admin-empty">Loading email studio…</div></div></div>;

  return (
    <>
      <header className="admin-topbar">
        <div><h1>Automated emails</h1><p className="admin-topbar-sub">Review lifecycle templates used by the website and account system.</p></div>
        <div className="admin-topbar-spacer" />
        <button className="btn-admin" type="button" onClick={onOpenComposer}>Compose lead email</button>
        <button className="btn-admin" type="button" onClick={() => { const fresh = blankTemplate(); setSelectedId(''); setDraft(fresh); clearVariableEditor(); }}>New template</button>
        <button className="btn-admin primary" type="button" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save template'}</button>
      </header>

      <div className="admin-body email-studio">
        {notice.text && <p className={`email-notice ${notice.kind}`}>{notice.text}</p>}
        <div className="email-studio-layout">
          <aside className="admin-card email-template-list">
            <div className="card-head"><div><h3>Templates</h3><p>Choose a message to edit</p></div></div>
            {templates.map(template => <button type="button" key={template.id} className={selectedId === template.id ? 'active' : ''} onClick={() => choose(template.id)}><span>{template.name}</span><small>{template.category === 'broadcast' ? 'Broadcast' : 'Transactional'}{template.system ? ' · system' : ''}</small></button>)}
          </aside>

          {draft && <main className="email-studio-main">
            <div className="email-workspace">
              <section className="admin-card email-preview-card">
                <div className="card-head email-preview-head">
                  <div><span className="email-eyebrow">Recipient view</span><h3>Your email, as it will arrive</h3><p>Preview values update as you edit the template.</p></div>
                  <span className={`email-category-badge ${draft.category || 'transactional'}`}>{draft.category === 'broadcast' ? 'Broadcast' : 'Transactional'}</span>
                </div>
                <iframe title="Email template preview" sandbox="" srcDoc={preview(draft, variables)} />
              </section>

              <section className="admin-card email-editor-card">
                <div className="card-head">
                  <div><h3>Message setup</h3><p>Set the purpose, details, and personalization behind the preview.</p></div>
                  {draft.id && !draft.system && <button className="btn-admin danger" type="button" disabled={Boolean(busy)} onClick={remove}>Delete</button>}
                </div>

                <div className="email-form-grid">
                  <label><span>Name</span><input value={draft.name || ''} onChange={event => update('name', event.target.value)} /></label>
                  <label><span>Internal description</span><input value={draft.description || ''} placeholder="What is this email for?" onChange={event => update('description', event.target.value)} /></label>
                  <div className="full email-type-field"><span>Email type</span><DeliveryType value={draft.category || 'transactional'} onChange={category => update('category', category)} /></div>
                  <div className="full email-content-field">
                    <div className="email-field-label"><label htmlFor="email-template-subject">Subject</label><button className="email-insert-token" type="button" title="Insert a variable in the subject" onClick={() => openVariableMaker('subject')}>{'{{}}'}</button></div>
                    <VariableTokenEditor
                      id="email-template-subject"
                      value={draft.subject || ''}
                      placeholder="A clear, useful subject line"
                      field="subject"
                      inputRef={node => { editorRefs.current.subject = node; }}
                      onRememberSelection={rememberSelection}
                      onChange={changeContent}
                    />
                  </div>
                </div>

                <section className="email-variable-panel" aria-label="Email variables">
                  <div className="email-variable-panel-head">
                    <div><span className="email-eyebrow">Personalization</span><h4>Variables</h4><p>Type <kbd>/</kbd> in the subject or plain-text field, or insert one here. Each variable appears as a named tag—not a JSON field.</p></div>
                    <button className="btn-admin email-variable-add" type="button" onClick={() => openVariableMaker()}>{'{{}}'} Add variable</button>
                  </div>

                  {variableMaker && <div className="email-variable-maker" role="dialog" aria-label="Create or insert a variable">
                    <div><strong>Insert a variable</strong><p>It will be added to the active text field and appear below as a named tag.</p></div>
                    {suggestedVariables.length > 0 && <div className="email-variable-suggestions">{suggestedVariables.slice(0, 6).map(name => <button type="button" key={name} onClick={() => insertVariable(name)}><span>{variableLabel(name)}</span><small>{variableHint(name)}</small></button>)}</div>}
                    <form className="email-variable-custom" onSubmit={event => { event.preventDefault(); insertVariable(variableMaker.name); }}>
                      <label><span>Custom variable name</span><input autoFocus value={variableMaker.name} onChange={event => setVariableMaker(current => ({ ...current, name: event.target.value }))} placeholder="e.g. event date" /></label>
                      <button className="btn-admin primary" type="submit" disabled={!normalizeVariableName(variableMaker.name)}>Add</button>
                      <button className="email-text-button" type="button" onClick={() => setVariableMaker(null)}>Cancel</button>
                    </form>
                  </div>}

                  {fields.length > 0 ? <div className="email-variable-list">
                    {fields.map(field => {
                      const automatic = VARIABLE_LIBRARY[field]?.automatic;
                      return <div className="email-variable-row" key={field}>
                        <div className="email-variable-name"><span className="email-variable-pill">{variableLabel(field)}</span><p>{variableHint(field)}</p></div>
                        {automatic ? <span className="email-variable-auto">Personalized automatically</span> : <label><span>Preview & send value</span><input value={variables[field] || ''} placeholder={`Set ${variableLabel(field).toLowerCase()}`} onChange={event => setVariables(current => ({ ...current, [field]: event.target.value }))} /></label>}
                      </div>;
                    })}
                  </div> : <div className="email-variable-empty"><strong>No variables yet</strong><span>Add one with <kbd>/</kbd> in a text field or use the button above.</span></div>}
                </section>

                <div className="email-plain-text-field email-content-field">
                  <div className="email-field-label"><label htmlFor="email-template-text">Plain-text fallback</label><button className="email-insert-token" type="button" title="Insert a variable in the plain-text fallback" onClick={() => openVariableMaker('text')}>{'{{}}'}</button></div>
                  <VariableTokenEditor
                    id="email-template-text"
                    value={draft.text || ''}
                    placeholder="A readable version for email clients that do not show HTML"
                    multiline
                    field="text"
                    inputRef={node => { editorRefs.current.text = node; }}
                    onRememberSelection={rememberSelection}
                    onChange={changeContent}
                  />
                </div>

                <details className="email-html-disclosure">
                  <summary>Show HTML?</summary>
                  <div className="email-html-disclosure-content">
                    <p>Use this only when you need to adjust the email source. The recipient preview is the primary editing reference.</p>
                    <div className="email-content-field"><div className="email-field-label"><label htmlFor="email-template-html">HTML source</label><button className="email-insert-token" type="button" title="Insert a variable in the HTML source" onClick={() => openVariableMaker('html')}>{'{{}}'}</button></div>
                      <textarea
                        id="email-template-html"
                        className="code"
                        ref={node => { editorRefs.current.html = node; }}
                        rows="18"
                        value={draft.html || ''}
                        onFocus={event => rememberSelection('html', nativeEditorSelection(event.target))}
                        onSelect={event => rememberSelection('html', nativeEditorSelection(event.target))}
                        onChange={event => changeNativeContent('html', event)}
                        spellCheck="false"
                      />
                    </div>
                  </div>
                </details>
              </section>
            </div>

            <section className="admin-card email-send-card">
              <div className="card-head"><div><span className="email-eyebrow">Delivery</span><h3>Send this email</h3><p>{draft.category === 'broadcast' ? 'A selected group will receive this announcement individually through the broadcast stream.' : 'Each selected recipient will receive their own account or action email through the transactional stream.'}</p></div></div>
              <label><span>Recipients <small>{recipientList.length}/50</small></span><textarea rows="4" value={recipients} onChange={event => setRecipients(event.target.value)} placeholder="alex@example.com, sam@example.com" /></label>
              <div className="email-recipient-actions"><button className="btn-admin" type="button" onClick={() => setRecipients(users.map(user => user.email).filter(Boolean).slice(0, 50).join(', '))}>Use all account emails ({Math.min(users.length, 50)})</button><button className="btn-admin" type="button" onClick={() => setRecipients('')}>Clear</button></div>
              <button className="btn-admin primary email-send-button" type="button" disabled={Boolean(busy) || !draft.id || recipientList.length < 1 || recipientList.length > 50} onClick={send}>{busy === 'send' ? 'Sending through Postmark…' : `Send ${recipientList.length || ''} email${recipientList.length === 1 ? '' : 's'}`}</button>
              {!draft.id && <p className="admin-note">Save this new template before sending it.</p>}
            </section>
          </main>}
        </div>
      </div>
    </>
  );
}

export default function EmailStudio() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'automations' ? 'automations' : 'compose';
  const switchView = next => {
    const nextParams = new URLSearchParams(params);
    if (next === 'automations') nextParams.set('view', 'automations');
    else nextParams.delete('view');
    setParams(nextParams);
  };
  return view === 'automations'
    ? <TemplateLibrary onOpenComposer={() => switchView('compose')} />
    : <LeadEmailComposer initialLeadId={params.get('lead') || ''} onOpenAutomations={() => switchView('automations')} />;
}
