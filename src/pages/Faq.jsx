import React, { useEffect } from 'react';
import { faqGroups } from '../content/faq.js';

// Plain links and native details keep the pre-rendered page fully usable
// before JavaScript loads. The build renders this exact component to HTML.
export default function Faq() {
  useEffect(() => {
    const revealHash = () => {
      const target = document.getElementById(window.location.hash.slice(1));
      if (target?.tagName === 'DETAILS') target.open = true;
      if (target) target.scrollIntoView();
      else if (!window.location.hash) window.scrollTo(0, 0);
    };
    revealHash();
    window.addEventListener('hashchange', revealHash);
    return () => window.removeEventListener('hashchange', revealHash);
  }, []);
  return <div className="faq-page">
    <header className="faq-header"><div className="wrap faq-header-inner"><a href="/" className="faq-brand" aria-label="BiteSites home"><img src="/favicon.svg" width="42" height="42" alt="" /><span>BiteSites</span></a><nav aria-label="FAQ navigation"><a href="/">Back to home</a><a href="/#start" className="btn ai">Start a project <span aria-hidden="true">↗</span></a></nav></div></header>
    <main className="wrap faq-main">
      <div className="faq-intro"><p className="eyebrow gradient">A little clarity goes a long way</p><h1>Good questions.<br /><span>Straight answers.</span></h1><p>From your first idea to the way it all works. Here’s what to know about building with BiteSites.</p></div>
      <div className="faq-layout">
        <nav className="faq-topics" aria-label="Question topics"><p>Find your answer</p>{faqGroups.map(group => <a href={`#${group.id}`} key={group.id}>{group.title}<span aria-hidden="true">↗</span></a>)}<a className="faq-talk" href="/book">Let’s talk about your project →</a></nav>
        <div className="faq-groups">{faqGroups.map(group => <section className="faq-group" id={group.id} key={group.id} aria-labelledby={`${group.id}-heading`}><h2 id={`${group.id}-heading`}>{group.title}</h2>{group.items.map(item => <details className="faq-item" id={item.id} key={item.id}><summary>{item.question}<span aria-hidden="true">+</span></summary><div className="faq-answer"><p>{item.answer}</p>{item.link && <a href={item.link[1]}>{item.link[0]} <span aria-hidden="true">↗</span></a>}</div></details>)}</section>)}</div>
      </div>
      <section className="faq-cta"><div><p className="eyebrow gradient">Let’s make it happen</p><h2>Have something in mind?</h2><p>Tell us a little about it. We’ll figure out the next step together.</p></div><a className="btn ai" href="/#start">Start your project <span aria-hidden="true">↗</span></a></section>
    </main>
    <footer className="faq-footer wrap"><a className="faq-brand" href="/"><img src="/favicon.svg" width="30" height="30" alt="" /><span>BiteSites</span></a><span>© 2026 BiteSites.</span><nav aria-label="Footer"><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav></footer>
  </div>;
}
