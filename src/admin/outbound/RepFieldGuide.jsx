import React, { useEffect, useRef, useState } from 'react';

/**
 * Print only the sheet. It is copied into a hidden frame with the page's own
 * stylesheets, so the console around it never reaches the paper and the guide
 * lays out on a clean letter page.
 */
function printSheet(sheet) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map(node => node.outerHTML).join('');
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>BiteSites rep field guide</title>${styles}<style>@page { size: letter; margin: .35in; }</style></head><body class="bs-admin rep-guide-print">${sheet.outerHTML}</body></html>`);
  doc.close();
  const sheetsReady = [...doc.querySelectorAll('link[rel="stylesheet"]')].map(link => new Promise(resolve => {
    if (link.sheet) resolve();
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
  }));
  const fontsReady = doc.fonts?.ready || Promise.resolve();
  const timeout = new Promise(resolve => setTimeout(resolve, 2500));
  Promise.race([Promise.all([...sheetsReady, fontsReady]), timeout]).then(() => {
    const cleanUp = () => setTimeout(() => frame.remove(), 500);
    frame.contentWindow.addEventListener('afterprint', cleanUp, { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(cleanUp, 60000);
  });
}

/**
 * The rep's one-page sheet: what we sell, the call in five steps, a short
 * script and answers to the usual pushback. It stays open beside practice
 * calls and prints on a single letter page.
 */
export default function RepFieldGuide({ guide, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const sheetRef = useRef(null);
  const [printWhenOpen, setPrintWhenOpen] = useState(false);

  useEffect(() => {
    if (!printWhenOpen || !sheetRef.current) return;
    setPrintWhenOpen(false);
    printSheet(sheetRef.current);
  }, [printWhenOpen, open]);

  if (!guide) return null;

  const print = () => {
    if (sheetRef.current) printSheet(sheetRef.current);
    else { setOpen(true); setPrintWhenOpen(true); }
  };

  return <section className={`rep-guide-shell ${open ? 'is-open' : ''}`} aria-label="Field guide">
    <div className="rep-guide-bar">
      <div>
        <strong>Your field guide</strong>
        <span>Keep it open while you practice. Everything you need on one page.</span>
      </div>
      <div className="rep-guide-bar-actions">
        <button className="btn-admin" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? 'Hide guide' : 'Show guide'}
        </button>
        <button className="btn-admin" type="button" onClick={print}>Print</button>
      </div>
    </div>

    {open && <article className="rep-guide" ref={sheetRef}>
      <header className="rep-guide-head">
        <span>{guide.title}</span>
        <h3>{guide.promise}</h3>
      </header>

      <section aria-label="What we sell">
        <h4>What we sell</h4>
        <div className="rep-guide-services">
          {guide.services.map(service => <div key={service.name}>
            <strong>{service.name}</strong>
            <p>{service.does}</p>
            <ul>{service.prices.map(price => <li key={price}>{price}</li>)}</ul>
          </div>)}
        </div>
        <p className="rep-guide-note">{guide.priceNote}</p>
      </section>

      <section aria-label="The call in five steps">
        <h4>The call in five steps</h4>
        <ol className="rep-guide-steps">
          {guide.steps.map(step => <li key={step.label}><strong>{step.label}</strong><span>{step.line}</span></li>)}
        </ol>
      </section>

      <div className="rep-guide-columns">
        <section aria-label="Your script">
          <h4>Your script</h4>
          <dl className="rep-guide-script">
            {guide.script.map(line => <div key={line.label}><dt>{line.label}</dt><dd>“{line.say}”</dd></div>)}
          </dl>
          <h5>Good questions to ask</h5>
          <ul className="rep-guide-list">{guide.questions.map(question => <li key={question}>{question}</li>)}</ul>
        </section>

        <section aria-label="When they say">
          <h4>When they say…</h4>
          <dl className="rep-guide-objections">
            {guide.objections.map(item => <div key={item.they}>
              <dt>“{item.they}”</dt>
              <dd>“{item.you}”{item.action && <em>{item.action}</em>}</dd>
            </div>)}
          </dl>
        </section>
      </div>

      <div className="rep-guide-columns">
        <section aria-label="Never">
          <h4>Never</h4>
          <ul className="rep-guide-list is-never">{guide.never.map(rule => <li key={rule}>{rule}</li>)}</ul>
        </section>
        <section aria-label="After every call">
          <h4>After every call, pick one</h4>
          <ul className="rep-guide-outcomes">{guide.outcomes.map(outcome => <li key={outcome}>{outcome}</li>)}</ul>
          <p className="rep-guide-remember">{guide.remember}</p>
        </section>
      </div>
    </article>}
  </section>;
}
