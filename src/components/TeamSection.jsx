import React, { useEffect, useRef, useState } from 'react';
import eidanPoster from '../assets/team/eidan-jimenez.webp';
import eidanVideo from '../assets/team/eidan-jimenez.mp4';
import jensyPoster from '../assets/team/jensy-jimenez.webp';
import jensyVideo from '../assets/team/jensy-jimenez.mp4';
import jonathanPoster from '../assets/team/jonathan-arroyo.webp';
import jonathanVideo from '../assets/team/jonathan-arroyo.mp4';
import nusseinPoster from '../assets/team/nussein-iounakov.webp';
import nusseinVideo from '../assets/team/nussein-iounakov.mp4';

const teamMembers = [
  {
    name: 'Jensy Jimenez',
    initials: 'JJ',
    role: 'CEO & Founder',
    bio: 'The head, hands, and heart behind BiteSites—leading the vision while staying close to every part of the operation.',
    poster: jensyPoster,
    video: jensyVideo,
    color: '#b598ff'
  },
  {
    name: 'Jonathan Arroyo',
    initials: 'JA',
    role: 'Co-Founder & AI Architect',
    bio: 'Designs and builds custom AI workflows for BiteSites and our partners. Hands-on across the business—except social media.',
    poster: jonathanPoster,
    video: jonathanVideo,
    color: '#7ec9ff'
  },
  {
    name: 'Nussein Iounakov',
    initials: 'NI',
    role: 'Head of Sales',
    bio: 'Turns conversations into relationships and makes complex ideas easy to understand. Simply put: the guy can talk.',
    poster: nusseinPoster,
    video: nusseinVideo,
    mediaPosition: 'center 24%',
    color: '#80e3cf'
  },
  {
    name: 'Eidan Jimenez',
    initials: 'EJ',
    role: 'Lead Database Engineer',
    bio: 'Data science–trained and focused on the systems that keep our data structured, reliable, and ready to scale.',
    poster: eidanPoster,
    video: eidanVideo,
    color: '#f1a6ce'
  }
];

function Portrait({ member }) {
  if (member.poster) return <img src={member.poster} alt="" style={{ objectPosition: member.mediaPosition || 'center' }} />;
  return <span aria-hidden="true">{member.initials}</span>;
}

function TeamVideo({ member }) {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let isVisible = false;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const updatePlayback = () => {
      if (isVisible && !document.hidden && !reduceMotion) {
        video.play().catch(() => setIsPlaying(false));
      } else {
        video.pause();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      isVisible = entry.isIntersecting && entry.intersectionRatio >= 0.35;
      updatePlayback();
    }, { threshold: [0, 0.35] });
    const handleVisibility = () => updatePlayback();

    observer.observe(video);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      video.pause();
    };
  }, [member.video]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => setIsPlaying(false));
    else video.pause();
  };

  return <div className="team-card-media">
    <video
      ref={videoRef}
      src={member.video}
      poster={member.poster}
      style={{ objectPosition: member.mediaPosition || 'center' }}
      muted
      loop
      playsInline
      preload="metadata"
      onPlay={() => setIsPlaying(true)}
      onPause={() => setIsPlaying(false)}
      aria-label={`${member.name} profile video`}
    />
    <div className="team-video-vignette" aria-hidden="true" />
    <button className="team-video-control" type="button" onClick={togglePlayback} aria-label={`${isPlaying ? 'Pause' : 'Play'} ${member.name}'s profile video`}>
      <span aria-hidden="true">{isPlaying ? 'Ⅱ' : '▶'}</span>
    </button>
  </div>;
}

// The global reveal observer adds `in` straight to the DOM, so React wipes it the
// first time it rewrites this element's className. Track it in state instead.
function useReveal() {
  const ref = useRef(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || node.classList.contains('in')) {
      setRevealed(Boolean(node));
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setRevealed(true);
      observer.disconnect();
    }, { threshold: .12 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, revealed];
}

function matrixAngle(transform) {
  if (!transform || transform === 'none') return 0;
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return Math.atan2(matrix.b, matrix.a) * (180 / Math.PI);
  } catch {
    const values = transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number);
    return values ? Math.atan2(values[1], values[0]) * (180 / Math.PI) : 0;
  }
}

export function TeamSection() {
  const [activeIndex, setActiveIndex] = useState(null);
  const [orbitRotation, setOrbitRotation] = useState(0);
  const orbitRef = useRef(null);
  const [experienceRef, experienceRevealed] = useReveal();

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

      <div
        className={`team-experience reveal ${experienceRevealed ? 'in' : ''} ${activeMember ? 'has-selection' : ''}`}
        ref={experienceRef}
      >
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
                aria-label={`View ${member.name}'s profile`}
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

          {activeMember && <article className="team-member-card" id="team-member-detail" aria-live="polite" key={activeMember.name}>
            <div className="team-card-topline"><span>Team profile</span><span>0{activeIndex + 1} / 0{teamMembers.length}</span></div>
            <button className="team-card-close" type="button" onClick={() => setActiveIndex(null)} aria-label={`Close ${activeMember.name}'s profile`}>×</button>
            <TeamVideo member={activeMember} />
            <div className="team-card-body">
              <p className="team-card-role">{activeMember.role}</p>
              <h3>{activeMember.name}</h3>
              <p className="team-card-bio">{activeMember.bio}</p>
              <a className="team-card-link" href="#start">Start a conversation <span aria-hidden="true">↗</span></a>
            </div>
          </article>}
        </div>

        <div className="team-instructions" aria-hidden="true">
          <span><i /> Orbit active</span>
          <span>{activeMember ? 'Select another person to continue' : 'Click a portrait to explore'}</span>
        </div>
      </div>
    </div>
  </section>;
}
