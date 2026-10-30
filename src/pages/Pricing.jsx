import React, { useState } from 'react';
import { MarketingShell } from './ServicePage';
import ProtectedPricing from '../components/ProtectedPricing';
import { MoreThanAWebsite } from '../components/RevenueSections';

export default function Pricing() {
  const [tab, setTab] = useState('web');
  return <MarketingShell><main className="wrap service-page-main"><nav className="revenue-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span>Pricing</span></nav><div className="service-page-hero"><p className="eyebrow gradient">Pricing & project scope</p><h1>Invest where your business is losing opportunities.</h1><p className="lead">Start with the most urgent issue: visibility, a weak website, missed inquiries, or slow follow-up. Expand the system as your business needs it.</p><p>Sign in or create a free account to view current packages. Custom systems and ongoing services are quoted after we review the scope, integrations, and content needed.</p></div><ProtectedPricing tab={tab} setTab={setTab} /><MoreThanAWebsite /><section className="service-editorial"><div><h2>A scope you can review before committing.</h2><p>We confirm deliverables, responsibilities, recurring costs, and timing in your proposal. The free revenue leak audit is an introductory review. Detailed automation audits and implementation have their own scope and pricing. Requesting a review or creating a pricing account does not purchase a service.</p><a className="text-link" href="/faq#cost">Read pricing questions →</a></div></section></main></MarketingShell>;
}
