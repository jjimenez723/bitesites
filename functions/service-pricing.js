// The published BiteSites price list. The signed-in pricing page and the rep
// course both read this, so what reps learn cannot drift from what customers see.

export const SERVICE_PRICING = {
  web: [
    ['Starter Site', 'A sharp single-page site for early-stage launches or service businesses that need credibility fast.', 'From $1,000', ['Single-page site', 'Responsive design', 'Basic SEO', 'One revision']],
    ['Growth Site', 'A stronger marketing site built around your offer, content, and lead flow.', 'From $2,500', ['Up to 7 pages', 'Conversion-focused UX', 'Analytics setup', 'Two revisions'], true],
    ['Custom Build', 'A flexible site for businesses with more complex content, integrations, or workflows.', 'Let’s talk', ['Custom architecture', 'Integrations', 'Advanced SEO', 'Ongoing support']]
  ],
  social: [
    ['Visibility Starter', 'Stay active, polished, and top of mind with content that makes your brand worth following.', 'From $600/mo', ['8 on-brand posts each month', 'Strategic content calendar', 'Captions written to drive action', 'Scheduling and performance insights']],
    ['Growth Engine', 'Turn social attention into trust, engagement, and a steady path toward your next customer.', 'From $1,200/mo', ['16 posts across 2 channels', 'Campaign-led content strategy', 'Audience and community engagement', 'Monthly growth recommendations'], true],
    ['Market Leader', 'Build an always-on multi-channel presence designed for bigger campaigns, teams, and ambitions.', 'Let’s talk', ['Custom high-volume cadence', 'Launch and campaign support', 'Executive-ready reporting', 'Creative direction and approvals']]
  ],
  ai: [
    ['Automation Opportunity Audit', 'Find the repetitive work costing your team time—and the fastest opportunities to eliminate it.', 'From $750', ['End-to-end process mapping', 'High-impact opportunity scorecard', 'ROI-focused automation roadmap', 'Clear implementation plan']],
    ['Lead Flow Automation', 'Capture, qualify, and route every opportunity faster so your team can focus on closing.', 'From $2,000', ['Custom workflow architecture', 'CRM, form, and inbox integrations', 'AI-assisted lead handling', 'Testing, training, and handoff'], true],
    ['AI Growth System', 'Build a custom AI-powered operating system around the way your business wins and grows.', 'Let’s talk', ['Purpose-built AI workflows', 'Reliable human review points', 'Team documentation and training', 'Ongoing performance optimization']]
  ]
};
