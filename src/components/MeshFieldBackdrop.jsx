import { useEffect, useRef } from 'react';
import { mountShaderCanvas, prefersReducedMotion } from '../lib/shader-canvas';

// A lattice warped by two slow drifts, lit by wandering blue lobes. Unlike the
// hero's nebula there is no raymarch loop here — every pixel is a fixed handful
// of sines — so this stays cheap enough to sit behind a mid-page content section.
const fragmentShader = `
  precision mediump float;
  uniform vec2 iResolution;
  uniform float iTime;
  uniform vec2 uWarpA;
  uniform vec2 uWarpB;
  uniform vec2 uLobeA;
  uniform vec2 uLobeB;
  varying vec2 vUv;

  const vec3 BASE = vec3(.004, .014, .045);
  const vec3 GLOW = vec3(.028, .082, .225);
  const vec3 LINE = vec3(.100, .240, .560);

  void main() {
    // Aspect-corrected and centred so the cells stay square and the lobes track
    // the middle of the section rather than the left edge.
    vec2 uv = (vUv - .5) * vec2(iResolution.x / iResolution.y, 1.0);

    // Domain warp. Two out-of-phase passes at different frequencies read as an
    // organic ripple; the mesh is dense enough that plain sines never look like
    // sines once the lattice is folded through them. Warping in uv rather than in
    // cell space keeps the ripple the same size if the density is ever retuned.
    vec2 w = uv * 6.0;
    vec2 warp = .085 * vec2(sin(w.y + uWarpA.x), cos(w.x + uWarpA.y))
              + .035 * vec2(cos(w.y * 2.3 + uWarpB.x), sin(w.x * 2.1 + uWarpB.y));
    vec2 p = (uv + warp) * 58.0;

    // |sin| falls to zero along each family of gridlines, so the product isolates
    // the cell interiors and the complement leaves the mesh itself. Raising it to
    // a power pulls the lines thin without needing a step and its aliasing.
    vec2 cell = abs(sin(p * 3.1415927));
    float mesh = pow(1.0 - cell.x * cell.y, 5.0);

    float lobeA = smoothstep(.95, .0, length(uv - uLobeA));
    float lobeB = smoothstep(.78, .0, length(uv - uLobeB));
    float glow = lobeA * .74 + lobeB * .40;

    vec3 color = mix(BASE, GLOW, glow);
    // A darker core inside the brighter lobe: the depth in the reference comes
    // from the glow reading as a halo around shadow, not as a flat spotlight.
    color *= 1.0 - smoothstep(.46, .0, length(uv - uLobeA * .62)) * .45;
    // Gridlines pick up the light, so the mesh is only really visible where the
    // glow is — it dissolves into the dark instead of tiling the whole section.
    color += LINE * mesh * (.02 + glow * .13);
    // Falls off well short of full black at the corners: this is a band between two
    // white sections, and crushed edges turn the seams into hard black rules.
    color *= 1.0 - smoothstep(.40, 1.26, length(uv)) * .74;

    // Grain: matches the reference's film texture and doubles as a dither, which
    // is what keeps a gradient this dark from banding on 8-bit displays.
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + iTime) * 43758.5453);
    color += (grain - .5) * .022;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Decorative WebGL backdrop for the services section. */
export function MeshFieldBackdrop({ className = '' }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || prefersReducedMotion()) return undefined;

    return mountShaderCanvas(container, {
      fragmentShader,
      uniforms: {
        uWarpA: { value: new Float32Array(2) },
        uWarpB: { value: new Float32Array(2) },
        uLobeA: { value: new Float32Array(2) },
        uLobeB: { value: new Float32Array(2) }
      },
      // The warp phases and lobe centres are the same for every pixel, so they are
      // stepped once per frame rather than 8 sines deep inside the fragment shader.
      onFrame(time, uniforms) {
        const warpA = uniforms.uWarpA.value;
        warpA[0] = time * .30;
        warpA[1] = -time * .25;
        const warpB = uniforms.uWarpB.value;
        warpB[0] = -time * .19;
        warpB[1] = time * .23;
        // Incommensurate periods, so the two lobes never settle into a visible loop.
        const lobeA = uniforms.uLobeA.value;
        lobeA[0] = Math.sin(time * .11) * .44;
        lobeA[1] = Math.cos(time * .09) * .27;
        const lobeB = uniforms.uLobeB.value;
        lobeB[0] = Math.cos(time * .07) * .52;
        lobeB[1] = Math.sin(time * .13) * .31;
      }
    });
  }, []);

  return <div ref={containerRef} className={`mesh-field ${className}`} aria-hidden="true" />;
}
