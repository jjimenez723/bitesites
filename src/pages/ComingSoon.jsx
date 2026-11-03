import React from 'react';
import { MarketingShell } from './ServicePage';
import { socialProfiles } from '../content/social.js';

// Destination for social profiles that are not live yet. Not indexed.
export default function ComingSoon() {
  const from = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('from');
  const network = socialProfiles.find(profile => profile.key === from)?.label;
  return <MarketingShell><main className="wrap coming-soon">
    <p className="eyebrow gradient">Coming soon</p>
    <h1>{network ? `Our ${network} is almost ready.` : 'We’re working on it.'}</h1>
    <p className="lead">We’re setting this up now. It will be ready soon.</p>
    <p>In the meantime, get a free audit of how your business wins and loses leads.</p>
    <div className="hero-actions"><a className="btn btn-ai" href="/#start">Get a free audit</a><a className="btn btn-ghost" href="/">Back to BiteSites</a></div>
  </main></MarketingShell>;
}
