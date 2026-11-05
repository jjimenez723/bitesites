import React, { useEffect } from 'react';
import { positioning, revenueServices } from '../content/revenue';
import { RevenueSystem, WhoWeHelp } from '../components/RevenueSections';
import HoloCard from '../components/HoloCard';
import { CustomIcon } from '../components/CustomIcons';
import { MeshFieldBackdrop } from '../components/MeshFieldBackdrop';
import { MarketingShell } from './ServicePage';

const cardTones = ['blue', 'violet', 'teal', 'rose', 'blue', 'violet'];
const cardIcons = ['recovery', 'website', 'receptionist', 'automation', 'attribution', 'consulting'];
const formValue = key => `/?service=${key}#start`;

// Everything about what BiteSites sells lives here, so the homepage can stay short.
export default function ServicesOverview() {
  useEffect(() => {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
    }), { threshold: .12 });
    document.querySelectorAll('.services-overview .reveal').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return <MarketingShell><main className="services-overview">
    <div className="wrap services-overview-intro">
      <nav className="revenue-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span>Services</span></nav>
      <p className="eyebrow gradient">Services</p>
      <h1>What we build.</h1>
      <p className="lead">{positioning.description}</p>
      <div className="hero-actions"><a className="btn btn-ai" href="/#start">Find my revenue leaks</a><a className="btn btn-ghost" href="/book">Talk to BiteSites</a></div>
    </div>
    <RevenueSystem />
    <section className="pad services-section" id="services"><MeshFieldBackdrop /><div className="wrap">
      <div className="section-head reveal"><div className="eyebrow">What we build</div><h2>Fix the gap. Connect the system.</h2><p>Start with the place your business loses opportunities. We connect the right tools around it.</p></div>
      <div className="services-grid revenue-services">{revenueServices.map((service, index) => <HoloCard as="article" className={`service-card ${service.key}`} key={service.key} tone={cardTones[index]} tiltMax={3} hoverScale={1.015}>
        <div className="holo-card-top"><div className="service-icon" aria-hidden="true">0{index + 1}</div><span className="holo-icon"><CustomIcon name={cardIcons[index]} /></span></div>
        <p className="revenue-service-label">{service.label}</p><h3>{service.title}</h3><p className="desc">{service.description}</p>
        <div className="revenue-card-actions"><a className="text-link" href={`/services/${service.slug}`}>Explore {service.label} →</a><a href={formValue(service.key)} aria-label={`Discuss ${service.label}`}>Discuss your project</a></div>
      </HoloCard>)}</div>
      <div className="revenue-other-services"><p>Something more specific? We also build custom AI tools and manage social media.</p><a href={formValue('custom')}>Custom AI projects</a><a href={formValue('social')}>Social media management</a></div>
    </div></section>
    <WhoWeHelp />
  </main></MarketingShell>;
}
