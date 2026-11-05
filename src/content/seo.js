import { faqItems } from './faq.js';
import { positioning, revenueServices } from './revenue.js';
import { socialProfiles } from './social.js';

const liveProfiles = socialProfiles.map(profile => profile.url).filter(Boolean);

export const SITE_URL = 'https://bitesites.org';
const organization = { '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: 'BiteSites', url: `${SITE_URL}/`, logo: `${SITE_URL}/apple-touch-icon.png`, description: positioning.about,
  areaServed: 'US', address: { '@type': 'PostalAddress', addressRegion: 'NJ', addressCountry: 'US' },
  knowsAbout: ['AI consulting', 'Voice AI receptionists', 'AI chat agents', 'Missed-call and lead recovery', 'Local SEO', 'Website development', 'Follow-up automation', 'CRM integration', 'Lead tracking and revenue attribution', 'Generative engine optimization'],
  ...(liveProfiles.length ? { sameAs: liveProfiles } : {}) };
export function breadcrumbSchema(items) {
  return { '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE_URL}${path}` })) };
}
export function serviceSchema(service) {
  return { '@type': 'Service', '@id': `${SITE_URL}/services/${service.slug}#service`, name: service.label, serviceType: service.heading, description: service.description, provider: { '@id': organization['@id'] }, url: `${SITE_URL}/services/${service.slug}`, areaServed: 'US' };
}
export const homeSchema = {
  '@context': 'https://schema.org',
  '@graph': [organization,
    { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: 'BiteSites', url: `${SITE_URL}/`, description: positioning.about, publisher: { '@id': organization['@id'] } },
    ...revenueServices.map(serviceSchema)
  ]
};
export const faqSchema = {
  '@context': 'https://schema.org',
  '@graph': [organization, breadcrumbSchema([['Home', '/'], ['FAQ', '/faq']]), {
    '@type': 'FAQPage', '@id': `${SITE_URL}/faq#page`, url: `${SITE_URL}/faq`, name: 'BiteSites frequently asked questions', inLanguage: 'en', publisher: { '@id': organization['@id'] },
    mainEntity: faqItems.map(({ id, question, answer }) => ({ '@type': 'Question', '@id': `${SITE_URL}/faq#${id}`, name: question, acceptedAnswer: { '@type': 'Answer', text: answer } }))
  }]
};

export const homeMeta = {
  title: 'Revenue Systems for Local Businesses | BiteSites',
  description: 'New Jersey-based BiteSites serves businesses nationwide with websites, local SEO, lead recovery, AI receptionists, follow-up automation, and revenue tracking.',
  socialTitle: 'BiteSites | Turn More Inquiries Into Customers.',
  socialDescription: 'Based in New Jersey, serving businesses nationwide. Websites, local visibility, lead recovery, AI receptionists, and follow-up in one connected system.',
  canonical: `${SITE_URL}/`, schema: homeSchema
};
export const faqMeta = {
  title: 'Revenue Systems, Websites & AI: Frequently Asked Questions | BiteSites',
  description: 'Answers about BiteSites revenue systems, lead recovery, websites, local SEO, AI receptionists, follow-up automation, pricing, ownership, and support.',
  canonical: `${SITE_URL}/faq`, schema: faqSchema
};

export function metadataForPath(pathname) {
  const route = pathname.replace(/\/+$/, '') || '/';
  if (route === '/') return homeMeta;
  if (route === '/faq') return faqMeta;
  const service = revenueServices.find(item => route === `/services/${item.slug}`);
  if (service) return {
    title: `${({ ai: 'Voice AI Receptionists & AI Phone Agents', consulting: 'AI Consulting for Local & Small Businesses' })[service.key] || service.heading} | BiteSites`,
    description: service.description, canonical: `${SITE_URL}${route}`,
    schema: { '@context': 'https://schema.org', '@graph': [organization, serviceSchema(service), breadcrumbSchema([['Home', '/'], ['Services', '/services'], [service.label, route]])] }
  };
  if (route === '/services') return {
    title: 'Services: Websites, Local SEO, AI Receptionists & Lead Recovery | BiteSites',
    description: 'See what BiteSites builds for local businesses: websites, local SEO, lead recovery, AI receptionists, follow-up automation, revenue tracking, and AI consulting.',
    canonical: `${SITE_URL}/services`,
    schema: { '@context': 'https://schema.org', '@graph': [organization, breadcrumbSchema([['Home', '/'], ['Services', '/services']]), ...revenueServices.map(serviceSchema)] }
  };
  if (route === '/pricing') return {
    title: 'Website & Revenue System Pricing | BiteSites',
    description: 'Explore BiteSites pricing for websites, AI, automation, and social media. View current packages with a free account or discuss a custom revenue system.',
    canonical: `${SITE_URL}/pricing`,
    schema: { '@context': 'https://schema.org', '@graph': [organization, breadcrumbSchema([['Home', '/'], ['Pricing', '/pricing']])] }
  };
  const pages = {
    '/terms': ['Terms of Service', 'Terms governing BiteSites services and use of the BiteSites website.'],
    '/privacy': ['Privacy Policy', 'How BiteSites handles information provided through our website and services.'],
    '/book': ['Book a Consultation', 'Schedule a consultation with the BiteSites team to review your website, lead response, follow-up, and revenue system.'],
    '/feedback': ['Share Your Feedback', 'Share feedback with the BiteSites team.'],
    '/thank-you': ['Thank You', 'Your next steps with BiteSites.'],
    '/questionnaire': ['Project Questionnaire', 'Share project details with the BiteSites team.'],
    '/email-preferences': ['Email Preferences', 'Manage your BiteSites email preferences.'],
    '/coming-soon': ['Coming Soon', 'This BiteSites page is on the way.']
  };
  const page = pages[route];
  return {
    title: `${page?.[0] || (route.startsWith('/admin') ? 'Team Portal' : 'BiteSites')} | BiteSites`,
    description: page?.[1] || homeMeta.description,
    canonical: `${SITE_URL}${route}`,
    noindex: !['/terms', '/privacy', '/book'].includes(route), schema: null
  };
}

export const serializeSchema = schema => JSON.stringify(schema).replace(/</g, '\\u003c');
