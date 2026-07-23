import React, { useEffect, useMemo, useState } from 'react';
import { useUsers } from './data';
import { deleteTemplate, listTemplates, saveTemplate, sendTemplateEmail } from './email-api';

const blankTemplate = () => ({
  id: '', name: 'New email', description: '', category: 'broadcast',
  subject: '{{headline}}',
  html: '<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,sans-serif"><table role="presentation" width="100%" style="padding:40px 18px"><tr><td align="center"><table role="presentation" width="100%" style="max-width:620px;background:#fff;border-radius:20px"><tr><td style="padding:40px"><h1>{{headline}}</h1><p>Hi {{first_name}},</p><p>{{message}}</p><a href="{{cta_url}}">{{cta_label}}</a></td></tr></table></td></tr></table></body></html>',
  text: '{{headline}}\n\nHi {{first_name}},\n\n{{message}}\n\n{{cta_label}}: {{cta_url}}'
});

const templateVariables = template => Array.from(new Set(
  `${template?.subject || ''} ${template?.html || ''} ${template?.text || ''}`
    .match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)?.map(token => token.replace(/[{}\s]/g, '')) || []
));

const preview = (template, variables) => {
  const values = { first_name: 'Alex', email: 'alex@example.com', headline: 'A brighter digital experience', message: 'Here is a preview of your BiteSites email. Every part of this message can be edited in the studio.', cta_label: 'Explore what’s new', cta_url: 'https://bitesites.org', verify_url: '#', pricing_url: '#', reset_url: '#', company: 'Example Company', admin_url: '#' , ...variables };
  return String(template?.html || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] || `[${key}]`);
};

export default function EmailStudio() {
  const { rows: users } = useUsers();
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [variables, setVariables] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState({ kind: '', text: '' });

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

  const choose = id => {
    setSelectedId(id);
    setDraft({ ...templates.find(item => item.id === id) });
    setVariables({});
    setNotice({ kind: '', text: '' });
  };

  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));

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
      setNotice({ kind: 'success', text: `${result.sent} email${result.sent === 1 ? '' : 's'} accepted by Postmark.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Postmark could not send this email.' });
    } finally { setBusy(''); }
  };

  if (loading && !draft) return <div className="admin-body"><div className="admin-card"><div className="admin-empty">Loading email studio…</div></div></div>;

  return (
    <>
      <header className="admin-topbar">
        <div><h1>Email studio</h1><p className="admin-topbar-sub">Edit branded HTML templates and send them through Postmark.</p></div>
        <div className="admin-topbar-spacer" />
        <button className="btn-admin" type="button" onClick={() => { const fresh = blankTemplate(); setSelectedId(''); setDraft(fresh); setVariables({}); }}>New template</button>
        <button className="btn-admin primary" type="button" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save template'}</button>
      </header>

      <div className="admin-body email-studio">
        {notice.text && <p className={`email-notice ${notice.kind}`}>{notice.text}</p>}
        <div className="email-studio-layout">
          <aside className="admin-card email-template-list">
            <div className="card-head"><div><h3>Templates</h3><p>Transactional and broadcast</p></div></div>
            {templates.map(template => <button type="button" key={template.id} className={selectedId === template.id ? 'active' : ''} onClick={() => choose(template.id)}><span>{template.name}</span><small>{template.category}{template.system ? ' · system' : ''}</small></button>)}
          </aside>

          {draft && <main className="email-studio-main">
            <section className="admin-card email-editor-card">
              <div className="card-head"><div><h3>Template editor</h3><p>Use variables such as <code>{'{{first_name}}'}</code>. Recipient values are escaped before send.</p></div>{draft.id && !draft.system && <button className="btn-admin danger" type="button" disabled={Boolean(busy)} onClick={remove}>Delete</button>}</div>
              <div className="email-form-grid">
                <label><span>Name</span><input value={draft.name || ''} onChange={event => update('name', event.target.value)} /></label>
                <label><span>Type</span><select value={draft.category || 'transactional'} onChange={event => update('category', event.target.value)}><option value="transactional">Transactional</option><option value="broadcast">Broadcast</option></select></label>
                <label className="full"><span>Description</span><input value={draft.description || ''} onChange={event => update('description', event.target.value)} /></label>
                <label className="full"><span>Subject</span><input value={draft.subject || ''} onChange={event => update('subject', event.target.value)} /></label>
                <label className="full"><span>HTML</span><textarea className="code" rows="18" value={draft.html || ''} onChange={event => update('html', event.target.value)} spellCheck="false" /></label>
                <label className="full"><span>Plain text fallback</span><textarea rows="7" value={draft.text || ''} onChange={event => update('text', event.target.value)} /></label>
              </div>
            </section>

            <section className="admin-card email-preview-card">
              <div className="card-head"><div><h3>Live preview</h3><p>Preview content uses safe sample values.</p></div></div>
              <iframe title="Email template preview" sandbox="" srcDoc={preview(draft, variables)} />
            </section>

            <section className="admin-card email-send-card">
              <div className="card-head"><div><h3>Send with this template</h3><p>Each recipient gets an individual message; addresses are never exposed to one another.</p></div></div>
              <label><span>Recipients <small>{recipientList.length}/50</small></span><textarea rows="4" value={recipients} onChange={event => setRecipients(event.target.value)} placeholder="alex@example.com, sam@example.com" /></label>
              <div className="email-recipient-actions"><button className="btn-admin" type="button" onClick={() => setRecipients(users.map(user => user.email).filter(Boolean).slice(0, 50).join(', '))}>Use all account emails ({Math.min(users.length, 50)})</button><button className="btn-admin" type="button" onClick={() => setRecipients('')}>Clear</button></div>
              {fields.length > 0 && <div className="email-variable-grid">{fields.map(field => <label key={field}><span>{field}</span><input value={variables[field] || ''} disabled={field === 'first_name' || field === 'email'} placeholder={field === 'first_name' || field === 'email' ? 'Personalized automatically' : `Value for {{${field}}}`} onChange={event => setVariables(current => ({ ...current, [field]: event.target.value }))} /></label>)}</div>}
              <button className="btn-admin primary email-send-button" type="button" disabled={Boolean(busy) || !draft.id || recipientList.length < 1 || recipientList.length > 50} onClick={send}>{busy === 'send' ? 'Sending through Postmark…' : `Send ${recipientList.length || ''} email${recipientList.length === 1 ? '' : 's'}`}</button>
              {!draft.id && <p className="admin-note">Save this new template before sending it.</p>}
            </section>
          </main>}
        </div>
      </div>
    </>
  );
}
