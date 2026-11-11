// Turns a polygon drawn on a fixed-size board into a CSS clip-path with rounded
// corners, so the bento hero's panels can have angled edges that still meet in
// soft curves. Points are in board units; the result is in percent, so it
// scales with any element that keeps the board's aspect ratio.
export function roundedPolygon(points, { width, height, radius = 24, steps = 6 } = {}) {
  const out = [];
  const count = points.length;
  for (let index = 0; index < count; index += 1) {
    const [px, py] = points[(index - 1 + count) % count];
    const [cx, cy] = points[index];
    const [nx, ny] = points[(index + 1) % count];
    const inLength = Math.hypot(cx - px, cy - py);
    const outLength = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const start = [cx + (px - cx) * (r / inLength), cy + (py - cy) * (r / inLength)];
    const end = [cx + (nx - cx) * (r / outLength), cy + (ny - cy) * (r / outLength)];
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const a = (1 - t) ** 2;
      const b = 2 * (1 - t) * t;
      const c = t ** 2;
      out.push([a * start[0] + b * cx + c * end[0], a * start[1] + b * cy + c * end[1]]);
    }
  }
  const pct = (value, size) => `${Math.round((value / size) * 10000) / 100}%`;
  return `polygon(${out.map(([x, y]) => `${pct(x, width)} ${pct(y, height)}`).join(', ')})`;
}
