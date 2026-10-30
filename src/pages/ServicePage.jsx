import React, { useEffect } from 'react';
import { revenueServices } from '../content/revenue';
import { startAnalytics } from '../lib/analytics';

export function MarketingShell({ children }) {
  useEffect(() => startAnalytics(), []);
  return <div className="service-page"><header className="faq-header"><div className="wrap faq-header-inner"><a href="/" className="faq-brand"><img src="/favicon.svg" width="42" height="42" alt="" /><span>BiteSites</span></a><nav aria-label="Page navigation"><a href="/#services">Services</a><a href="/faq">FAQ</a><a href="/#start" className="btn btn-ai">Get a free audit ↗</a></nav></div></header>{children}<footer className="faq-footer wrap"><a className="faq-brand" href="/">BiteSites</a><span>Revenue systems for local businesses.</span><nav aria-label="Footer"><a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav></footer></div>;
}

export default function ServicePage({ service }) {
  return <MarketingShell><main className="wrap service-page-main"><nav className="revenue-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/#services">Services</a><span aria-hidden="true">/</span><span>{service.label}</span></nav>
    <div className="service-page-hero"><p className="eyebrow gradient">{service.label}</p><h1>{service.heading}</h1><p className="lead">{service.description}</p><div className="hero-actions"><a className="btn btn-ai" href="/#start">Find my revenue leaks ↗</a><a className="btn btn-ghost" href={service.key === 'ai' ? '/#ai-receptionist' : '/book'}>{service.key === 'ai' ? 'Try Byte & Bit' : 'Talk to BiteSites'}</a></div></div>
    <div className="service-editorial"><section><h2>Where the opportunity gets lost</h2><p>{service.problem}</p></section><section><h2>How we connect the next step</h2><p>{service.approach}</p><ul>{service.bullets.map(item => <li key={item}>{item}</li>)}</ul></section><section><h2>What this looks like in practice</h2><p>{service.example}</p><a className="text-link" href="/#portfolio">Explore our work →</a></section><section><h2>What we scope together</h2><p>{service.scope}</p><a className="text-link" href="/pricing">See how pricing works →</a></section></div>
    <section className="service-related"><h2>The other pieces of your system</h2><div>{service.related.map(slug => { const item = revenueServices.find(s => s.slug === slug); return <a key={slug} href={`/services/${slug}`}><strong>{item.label} ↗</strong><span>{item.description}</span></a>; })}</div></section>
    <section className="faq-cta"><div><p className="eyebrow gradient">Start with a clear next step</p><h2>Find the gap worth fixing first.</h2><p>Tell us how customers reach you today. We’ll review the path from inquiry to follow-up.</p></div><a className="btn btn-ai" href="/#start">Get a free revenue leak audit ↗</a></section>
  </main></MarketingShell>;
}
