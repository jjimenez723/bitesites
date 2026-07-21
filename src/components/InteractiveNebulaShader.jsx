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
        // No antialiasing: the scene is a single fullscreen quad, so MSAA has no
        // edges to smooth — it just costs a resolve pass and the memory bandwidth
        // that goes with it. `low-power` keeps laptops on the integrated GPU;
        // switching to the discrete one for a background is its own source of hitches.
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
      } catch {
        return;
      }

      // A soft nebula hides resolution loss, and this is the single biggest lever
      // on what the hero costs: the shader runs per pixel, so halving the pixel
      // ratio roughly halves the GPU time.
      const modest =
        window.matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, modest ? .75 : 1.25));
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const clock = new THREE.Clock();
      // Everything below that is constant across a frame is computed once on the
      // CPU instead of being recomputed per pixel. `field()` runs 12 times per
      // pixel, so the two rotations and the sin() it used to contain were ~36
      // transcendental ops per pixel spent recalculating identical values.
      const uniforms = {
        iTime: { value: 0 },
        iResolution: { value: new THREE.Vector2() },
        uRotXZ: { value: new Float32Array([1, 0, 0, 1]) },
        uRotXY: { value: new Float32Array([1, 0, 0, 1]) },
        uSinT: { value: 0 },
        uQOffset: { value: 0 }
      };
      const material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      fragmentShader: `
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
      `,
      });
      const geometry = new THREE.PlaneGeometry(2, 2);
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      let resizeFrame = 0;
      const resize = () => {
        resizeFrame = 0;
        const { clientWidth: width, clientHeight: height } = container;
        renderer.setSize(width, height, false);
        uniforms.iResolution.value.set(width, height);
      };
      // Mobile browsers fire resize continuously as the URL bar collapses.
      const queueResize = () => {
        if (!resizeFrame) resizeFrame = window.requestAnimationFrame(resize);
      };
      window.addEventListener('resize', queueResize, { passive: true });
      resize();

      // A drifting nebula reads the same at 30fps and costs half as much.
      const FRAME_INTERVAL = 1 / 30;
      let lastRender = -Infinity;
      const render = () => {
        const time = clock.getElapsedTime();
        if (time - lastRender < FRAME_INTERVAL) return;
        lastRender = time;

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
        uniforms.iTime.value = time;
        renderer.render(scene, camera);
      };

      // The hero is one section of a long page. Rendering it while the visitor is
      // reading the footer burns GPU that the compositor needs for scrolling.
      let running = false;
      const start = () => {
        if (running || disposed) return;
        running = true;
        renderer.setAnimationLoop(render);
      };
      const stop = () => {
        if (!running) return;
        running = false;
        renderer.setAnimationLoop(null);
      };
      const observer = new IntersectionObserver(
        ([entry]) => (entry.isIntersecting ? start() : stop()),
        { threshold: 0 }
      );
      observer.observe(container);

      cleanup = () => {
        observer.disconnect();
        stop();
        window.removeEventListener('resize', queueResize);
        if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
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
