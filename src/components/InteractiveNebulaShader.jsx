import { useEffect, useRef } from 'react';
import { mountShaderCanvas, prefersReducedMotion } from '../lib/shader-canvas';

// Everything constant across a frame is computed on the CPU in onFrame instead of
// being recomputed per pixel. `field()` runs 12 times per pixel, so the two
// rotations and the sin() it used to contain were ~36 transcendental ops per pixel
// spent recalculating identical values.
const fragmentShader = `
  precision mediump float;
  uniform vec2 iResolution;
  uniform float iTime;
  uniform mat2 uRotXZ;
  uniform mat2 uRotXY;
  uniform float uSinT;
  uniform float uQOffset;
  varying vec2 vUv;
  float field(vec3 p) {
    p.xz *= uRotXZ;
    p.xy *= uRotXY;
    vec3 q = p * 1.8 + uQOffset;
    return length(p + vec3(uSinT)) * log(length(p) + 1.0) + sin(q.x + sin(q.z + sin(q.y))) * .5 - 1.0;
  }
  void main() {
    vec2 uv = (vUv * iResolution - .5 * iResolution) / min(iResolution.x, iResolution.y);
    vec3 color = vec3(0.0);
    float distanceAlongRay = 2.6;
    for (int i = 0; i < 6; i++) {
      vec3 point = vec3(0.0, 0.0, 5.0) + normalize(vec3(uv, -1.0)) * distanceAlongRay;
      float density = field(point);
      float edge = clamp((density - field(point + .1)) * .5, -.1, 1.0);
      vec3 palette = vec3(.025, .10, .24) + vec3(.38, .13, .75) * edge;
      palette += vec3(.03, .23, .50) * (sin(iTime * .16 + point.y) * .5 + .5);
      color = color * palette + smoothstep(2.5, 0.0, density) * .62 * palette;
      distanceAlongRay += min(density, 1.0);
    }
    color *= .52 + smoothstep(1.15, .18, length(uv)) * .48;
    gl_FragColor = vec4(color, .96);
  }
`;

/** Decorative WebGL background for the AI-focused hero. */
export function InteractiveNebulaShader({ className = '' }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || prefersReducedMotion()) return undefined;

    return mountShaderCanvas(container, {
      fragmentShader,
      uniforms: {
        uRotXZ: { value: new Float32Array([1, 0, 0, 1]) },
        uRotXY: { value: new Float32Array([1, 0, 0, 1]) },
        uSinT: { value: 0 },
        uQOffset: { value: 0 }
      },
      onFrame(time, uniforms) {
        const xz = time * .10;
        const xy = time * .06;
        const cosXZ = Math.cos(xz), sinXZ = Math.sin(xz);
        const cosXY = Math.cos(xy), sinXY = Math.sin(xy);
        // Column-major, matching the mat2(c, -s, s, c) this replaced.
        const rotXZ = uniforms.uRotXZ.value;
        rotXZ[0] = cosXZ; rotXZ[1] = -sinXZ; rotXZ[2] = sinXZ; rotXZ[3] = cosXZ;
        const rotXY = uniforms.uRotXY.value;
        rotXY[0] = cosXY; rotXY[1] = -sinXY; rotXY[2] = sinXY; rotXY[3] = cosXY;
        uniforms.uSinT.value = Math.sin(time * .22);
        uniforms.uQOffset.value = time * .28;
      }
    });
  }, []);

  return <div ref={containerRef} className={`nebula-shader ${className}`} aria-hidden="true" />;
}
