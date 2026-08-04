// Lead Discovery: create a job, watch it run, see what it produced.
//
// The pipeline note is not decoration. The single most common misunderstanding
// about a lead-discovery tool is that "found 400 businesses" means 400 people
// are about to be called; spelling out the gates between discovery and a dial
// is cheaper than explaining it after the fact.

import React from 'react';
import ScrapeJobBuilder from './ScrapeJobBuilder';
import ScrapeJobList from './ScrapeJobList';
import { useScrapeJobs } from './data';

export default function LeadDiscovery({ sources = [] }) {
  const jobs = useScrapeJobs();

  return (
    <div className="admin-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="outbound-compliance-note">
        <strong>Discovery does not create callable contacts.</strong> Every result is normalised,
        deduplicated against existing prospects and leads, compliance-checked, and — where a match is
        uncertain — held for review. A prospect only becomes callable when a campaign explicitly selects it.
      </div>

      <ScrapeJobBuilder sources={sources} onCreated={() => jobs.refresh()} />

      <ScrapeJobList
        jobs={jobs.rows}
        loading={jobs.loading}
        error={jobs.error}
        refresh={jobs.refresh}
      />
    </div>
  );
}
