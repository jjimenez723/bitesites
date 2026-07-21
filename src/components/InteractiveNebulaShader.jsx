import { useEffect, useRef } from 'react';

/** Decorative WebGL background for the AI-focused hero. */
export function InteractiveNebulaShader({ className = '' }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let disposed = false;
    let cleanup = () => {};

    import('three').then(THREE => {
      if (disposed) return;
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const clock = new THREE.Clock();
      const uniforms = { iTime: { value: 0 }, iResolution: { value: new THREE.Vector2() } };
      const material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      fragmentShader: `
        precision mediump float;
        uniform vec2 iResolution;
        uniform float iTime;
        varying vec2 vUv;
        mat2 rotate2d(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
        float field(vec3 p) {
          p.xz *= rotate2d(iTime * .10);
          p.xy *= rotate2d(iTime * .06);
          vec3 q = p * 1.8 + iTime * .28;
          return length(p + vec3(sin(iTime * .22))) * log(length(p) + 1.0) + sin(q.x + sin(q.z + sin(q.y))) * .5 - 1.0;
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
      `,
      });
      const geometry = new THREE.PlaneGeometry(2, 2);
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      const resize = () => {
        const { clientWidth: width, clientHeight: height } = container;
        renderer.setSize(width, height, false);
        uniforms.iResolution.value.set(width, height);
      };
      window.addEventListener('resize', resize);
      resize();
      renderer.setAnimationLoop(() => {
        uniforms.iTime.value = clock.getElapsedTime();
        renderer.render(scene, camera);
      });

      cleanup = () => {
        window.removeEventListener('resize', resize);
        renderer.setAnimationLoop(null);
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
      if (disposed) cleanup();
    }).catch(() => {});

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={containerRef} className={`nebula-shader ${className}`} aria-hidden="true" />;
}
