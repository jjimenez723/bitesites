// Visible answers and structured data share this source. Keep factual claims
// aligned with the public services and the approved Bit/Byte knowledge base.
export const faqGroups = [
  {
    id: 'getting-started', title: 'Getting started', items: [
      { id: 'service-area', question: 'Where is BiteSites based, and do you work nationwide?', answer: 'BiteSites is based in New Jersey and works with businesses across the United States. Most of our current clients are in New Jersey and New York, and we welcome projects nationwide.' },
      { id: 'services', question: 'What does BiteSites do?', answer: 'BiteSites builds revenue systems for local businesses: websites and local visibility, lead capture and recovery, AI receptionists, follow-up automation, booking connections, and tracking. We also offer social media management and custom AI projects. These services connect how customers find you to what happens after they inquire. Choose Custom AI project in the form if your idea needs its own scope.' },
      { id: 'start-project', question: 'How do I start a project with BiteSites?', answer: 'Use the free audit and project form to choose your services, business size, and preferred timeline. Add any project details and your contact information, then send your request. The team will follow up to discuss scope and next steps. You can also book a consultation directly.', link: ['Start your project', '/#start'] },
      { id: 'cost', question: 'How much does a website or AI project cost?', answer: 'Pricing depends on scope, integrations, and how much content needs to be created. You can sign in to view current service pricing on the website. Custom requirements are discussed with the team and confirmed in a proposal; submitting the project form does not make a purchase.', link: ['Explore pricing', '/#pricing'] },
      { id: 'delivery', question: 'How long will my project take?', answer: 'Timing depends on the project scope, content readiness, integrations, and review process. Share your preferred timeline in the project form. The team will confirm a delivery plan after reviewing what you need; choosing a date range in the form is a preference, not a confirmed launch date.' }
    ]
  },
  {
    id: 'revenue-systems', title: 'Revenue systems & lead recovery', items: [
      { id: 'revenue-system', question: 'What is a revenue system?', answer: 'A revenue system connects how a customer discovers your business, contacts you, receives a response, gets follow-up, and books or buys. BiteSites builds the website, response workflows, CRM connections, and tracking around that journey. You can start with one gap rather than replacing every tool.', link: ['See the six steps', '/#system'] },
      { id: 'audit', question: 'What is included in a free revenue leak audit?', answer: 'We review how customers find you, what happens when they call or submit a form, how your team follows up, and what you can track. Share your business and the issue you want to solve in the intake form. The team follows up with practical next steps; this introductory review is free, with no purchase commitment. Detailed automation audits and implementation are scoped separately.', link: ['Request your audit', '/#start'] },
      { id: 'lead-recovery', question: 'Can you help with missed calls and old estimates?', answer: 'Yes. BiteSites can build missed-call response, lead routing, estimate reminders, and CRM follow-up workflows. Reactivation of existing contacts is scoped around appropriate permission or legal basis, opt-outs, and applicable channel rules. Results depend on the opportunity, the connected tools, and your team completing the next step.', link: ['Explore lead recovery', '/services/lead-recovery'] },
      { id: 'revenue-measurement', question: 'Can you measure revenue from leads?', answer: 'We can track inquiries, lead sources, appointments, and CRM stages when the relevant systems are connected. Revenue attribution requires reliable sales or payment data and recorded customer outcomes. When those are unavailable, we report the verified stages we can measure instead of treating every lead as revenue.' }
    ]
  },
  {
    id: 'ai-agents', title: 'AI receptionists & automation', items: [
      { id: 'voice-receptionist', question: 'What can a Voice AI receptionist do?', answer: 'A Voice AI receptionist can answer inbound calls, respond to common questions, qualify leads, book appointments, route callers, and update connected CRM workflows.' },
      { id: 'chat-agent', question: 'What does an AI chat agent handle?', answer: 'An AI chat agent greets website visitors, answers service questions, captures contact details, and routes qualified leads to your team. Bit is BiteSites’ own chat agent, and Byte is our voice agent. You can try both on the homepage.', link: ['Meet Byte & Bit', '/#ai-receptionist'] },
      { id: 'integrations', question: 'Can an AI agent work with my calendar and CRM?', answer: 'Yes. BiteSites can connect a custom AI phone or chat agent with business calendars, qualification rules, and CRM follow-up workflows. The specific tools, access requirements, and integration scope are confirmed during project planning.' },
      { id: 'business-knowledge', question: 'Are the agents configured for my business?', answer: 'Yes. Agents can be configured around your services, common questions, lead qualification criteria, appointment process, and human escalation rules. Business information and connected tools guide the answers and actions the agent can provide.' },
      { id: 'human-handoff', question: 'What happens when the AI cannot answer a question?', answer: 'BiteSites designs agents with fallback and human handoff rules. When an answer is outside the approved business information or an action needs a person, the agent should acknowledge that limit and route the request to your team. The handoff process is agreed during setup.' }
    ]
  },
  {
    id: 'websites', title: 'Websites & ongoing support', items: [
      { id: 'website-features', question: 'Can my website include forms, booking, and CRM integrations?', answer: 'Yes. BiteSites can build responsive websites with lead forms, booking flows, CRM connections, analytics, and conversion tracking. The features and third-party services needed for your project are defined during scoping.', link: ['See our work', '/#portfolio'] },
      { id: 'ownership', question: 'Will I own my finished website?', answer: 'BiteSites’ approach is that the business owns the finished work it pays for and can keep using it if the relationship ends. Exact deliverables, license terms, hosting arrangements, and third-party costs are confirmed in your proposal.' },
      { id: 'search', question: 'Can BiteSites help with SEO and AI search visibility?', answer: 'BiteSites offers technical SEO foundations and search readiness as part of its web services. Clear service information, helpful answers, crawlable pages, internal links, and accurate structured data help search systems understand a website. Search rankings and inclusion in AI-generated answers cannot be guaranteed.' },
      { id: 'support', question: 'Can BiteSites support the website after launch?', answer: 'Ongoing support and maintenance are available. The scope can include website updates, performance improvements, and workflow support. Specific services and responsibilities are agreed with the team.' }
    ]
  }
];

export const faqItems = faqGroups.flatMap(group => group.items);
