import React from 'react';

import { socialProfiles } from '../content/social.js';

const icons = {
  instagram: <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" /></>,
  facebook: <path d="M14 8h3V4h-3a4 4 0 0 0-4 4v2H8v4h2v6h4v-6h3l1-4h-4V8z" />,
  linkedin: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7" /></>,
  tiktok: <path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5M14 3c.5 2.5 2.2 4 5 4.3" />,
};

export default function SocialLinks({ className = '' }) {
  return <nav className={`social-links ${className}`} aria-label="BiteSites on social media">
    {socialProfiles.map(({ key, label, url }) => {
      const live = Boolean(url);
      return <a key={key} href={live ? url : `/coming-soon?from=${key}`} aria-label={live ? `BiteSites on ${label}` : `BiteSites on ${label} (coming soon)`}
        {...(live ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'nofollow' })}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[key]}</svg>
      </a>;
    })}
  </nav>;
}
