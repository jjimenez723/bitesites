import React, { useRef, useState } from 'react';

// Portraits, full bios, and direct social links can be added here without
// changing the orbit or expansion behavior below.
const teamMembers = [
  {
    name: 'Jensy Jimenez',
    initials: 'JJ',
    role: 'BiteSites team',
    image: '',
    bio: 'Jensy brings ideas, craft, and execution together to help shape clear digital experiences for the businesses BiteSites serves.',
    links: [{ label: 'Get in touch', href: '#start' }],
    color: '#b598ff'
  },
  {
    name: 'Jonathan Arroyo',
    initials: 'JA',
    role: 'BiteSites team',
    image: '',
    bio: 'Jonathan helps turn early ideas into thoughtful, polished work that feels focused, useful, and true to each client’s goals.',
    links: [{ label: 'Get in touch', href: '#start' }],
    color: '#7ec9ff'
  },
  {
    name: 'Eidan Jimenez',
    initials: 'EJ',
    role: 'BiteSites team',
    image: '',
    bio: 'Eidan works across projects with a practical eye, connecting details and decisions so each experience feels considered from end to end.',
    links: [{ label: 'Get in touch', href: '#start' }],
    color: '#f1a6ce'
  },
  {
    name: 'Nussein Iounakov',
    initials: 'NI',
    role: 'BiteSites team',
    image: '',
    bio: 'Nussein supports the collaboration behind the work, helping ambitious ideas move forward with clarity, care, and attention to detail.',
    links: [{ label: 'Get in touch', href: '#start' }],
    color: '#80e3cf'
  }
];

function Portrait({ member }) {
  if (member.image) return <img src={member.image} alt={`${member.name} portrait`} />;
  return <span aria-hidden="true">{member.initials}</span>;
}

function matrixAngle(transform) {
  if (!transform || transform === 'none') return 0;
  const values = transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number);
  return values ? Math.atan2(values[1], values[0]) * (180 / Math.PI) : 0;
}

export function TeamSection() {
  const [activeIndex, setActiveIndex] = useState(null);
  const [orbitRotation, setOrbitRotation] = useState(0);
  const orbitRef = useRef(null);

  const activateMember = index => {
    let currentRotation = orbitRotation;
    if (activeIndex === null && orbitRef.current) {
      currentRotation = matrixAngle(window.getComputedStyle(orbitRef.current).transform);
    }

    setActiveIndex(index);
    setOrbitRotation(currentRotation);

    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const selectedAtTop = -index * 90;
      const nearestTurn = selectedAtTop + 360 * Math.round((currentRotation - selectedAtTop) / 360);
      setOrbitRotation(nearestTurn);
    }));
  };

  const activeMember = activeIndex === null ? null : teamMembers[activeIndex];

  return <section className="team-section" id="team">
    <div className="team-backdrop" aria-hidden="true"><i /><i /><i /></div>
    <div className="wrap team-wrap">
      <div className="team-heading reveal">
        <div>
          <div className="eyebrow gradient">The people behind the work</div>
          <h2>Meet the team<br />in our orbit.</h2>
        </div>
        <p>Four perspectives, one shared standard. Choose a team member to bring their story into focus.</p>
      </div>

      <div className={`team-experience reveal ${activeMember ? 'has-selection' : ''}`}>
        <div className="team-orbit-shell">
          <div className="team-orbit-line" aria-hidden="true" />
          <div className="team-orbit-scan" aria-hidden="true" />
          <div
            className="team-orbit-nodes"
            ref={orbitRef}
            style={{ '--orbit-rotation': `${orbitRotation}deg` }}
          >
            {teamMembers.map((member, index) => <div
              className={`team-node ${activeIndex === index ? 'active' : ''}`}
              style={{ '--node-angle': `${-90 + index * 90}deg`, '--member-color': member.color }}
              key={member.name}
            >
              <button
                className="team-node-button"
                type="button"
                onClick={() => activateMember(index)}
                aria-expanded={activeIndex === index}
                aria-controls="team-member-detail"
                aria-label={`View ${member.name}'s bio`}
              >
                <span className="team-node-portrait"><Portrait member={member} /></span>
                <span className="team-node-name">{member.name}</span>
              </button>
            </div>)}
          </div>

          <div className="team-core" aria-hidden={Boolean(activeMember)}>
            <span className="team-core-mark">B</span>
            <span>Choose a person</span>
          </div>

          <article className="team-member-card" id="team-member-detail" aria-live="polite" aria-hidden={!activeMember}>
            {activeMember && <div className="team-member-card-inner" key={activeMember.name}>
              <div className="team-card-topline"><span>Team profile</span><span>0{activeIndex + 1} / 0{teamMembers.length}</span></div>
              <div className="team-card-portrait" style={{ '--member-color': activeMember.color }}><Portrait member={activeMember} /></div>
              <p className="team-card-role">{activeMember.role}</p>
              <h3>{activeMember.name}</h3>
              <p className="team-card-bio">{activeMember.bio}</p>
              <div className="team-card-links">{activeMember.links.map(link => <a href={link.href} key={link.label}>{link.label}<span aria-hidden="true">↗</span></a>)}</div>
            </div>}
          </article>
        </div>

        <div className="team-instructions" aria-hidden="true">
          <span><i /> Orbit active</span>
          <span>Click a portrait to explore</span>
        </div>
      </div>
    </div>
  </section>;
}
