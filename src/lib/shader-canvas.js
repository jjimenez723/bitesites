/**
 * Mounts a fullscreen-quad fragment shader into `container` and returns a cleanup
 * function. Callable straight from useEffect: three is imported lazily, so the
 * caller gets a synchronous teardown even though the renderer appears a tick later.
 *
 * Every decorative background on the page wants the same four things — don't run
 * off-screen, don't fight the compositor during scroll, don't render more pixels
 * than the effect needs, and don't render more frames than the eye reads — so they
 * live here once instead of in each shader.
 */
export function mountShaderCanvas(container, {
  fragmentShader,
  uniforms: extraUniforms = {},
  onFrame,
  // A drifting background reads the same at 30fps and costs half as much.
  fps = 30,
  // The shader runs per pixel, so the pixel ratio is the single biggest lever on
  // what a background costs: halving it roughly halves the GPU time. Soft, blurry
  // effects hide the resolution loss; raise these only for one with hard edges.
  pixelRatio = { modest: .75, full: 1.25 }
}) {
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

    const modest =
      window.matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, modest ? pixelRatio.modest : pixelRatio.full));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // performance.now() rather than THREE.Clock, which three has deprecated in
    // favour of an addon — and the only thing ever asked of it was elapsed
    // seconds, which is one subtraction. Stamped at setup instead of on the first
    // frame, so the shader's clock starts when the canvas does.
    const startedAt = performance.now();
    // Plain typed arrays rather than THREE.Vector2/Matrix3: three uploads either,
    // and this keeps shaders from having to import three to describe a uniform.
    const uniforms = {
      iTime: { value: 0 },
      iResolution: { value: new Float32Array(2) },
      ...extraUniforms
    };
    const material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      fragmentShader
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geometry, material));

    let resizeFrame = 0;
    const resize = () => {
      resizeFrame = 0;
      const { clientWidth: width, clientHeight: height } = container;
      renderer.setSize(width, height, false);
      uniforms.iResolution.value[0] = width;
      uniforms.iResolution.value[1] = height;
    };
    // Mobile browsers fire resize continuously as the URL bar collapses.
    const queueResize = () => {
      if (!resizeFrame) resizeFrame = window.requestAnimationFrame(resize);
    };
    window.addEventListener('resize', queueResize, { passive: true });
    resize();

    const frameInterval = 1 / fps;
    let lastRender = -Infinity;
    const render = () => {
      const time = (performance.now() - startedAt) / 1000;
      if (time - lastRender < frameInterval) return;
      lastRender = time;
      uniforms.iTime.value = time;
      // Anything constant across a frame is computed once on the CPU here rather
      // than being recomputed per pixel in the shader.
      if (onFrame) onFrame(time, uniforms);
      renderer.render(scene, camera);
    };

    // These are single sections of a long page. Rendering one while the visitor is
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
}

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
