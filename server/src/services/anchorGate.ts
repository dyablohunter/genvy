import type { RawImage } from './imagePipeline.js';

/**
 * Anchor lock gate — Sprite Pipeline v2 §C2.2 (BLOCKING).
 * "A weak idle anchor poisons every state": before any directional anchor or
 * animation is unlocked, the picked neutral anchor must pass these cheap,
 * deterministic CPU checks (thresholds from §E2). All checks run on the
 * already-keyed alpha image (the crop route produced transparency).
 */

export interface AnchorGateCheck {
  id: 'corners' | 'content' | 'uncropped' | 'singleBlob' | 'centered';
  pass: boolean;
  detail: string;
}

export interface AnchorGateReport {
  pass: boolean;
  checks: AnchorGateCheck[];
}

const ALPHA_CONTENT = 30; // a pixel this opaque counts as content (E2: corners alpha < 30)

/** Largest 4-connected content blob, as a fraction of all content pixels. */
function largestBlobFraction(img: RawImage): { fraction: number; blobs: number } {
  const { width, height, data } = img;
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let total = 0;
  let largest = 0;
  let blobs = 0;
  for (let start = 0; start < width * height; start++) {
    if (visited[start] || data[start * 4 + 3]! < ALPHA_CONTENT) continue;
    blobs++;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    while (top > 0) {
      const p = stack[--top]!;
      size++;
      const x = p % width;
      const y = (p / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (visited[np] || data[np * 4 + 3]! < ALPHA_CONTENT) continue;
        visited[np] = 1;
        stack[top++] = np;
      }
    }
    total += size;
    if (size > largest) largest = size;
  }
  return { fraction: total > 0 ? largest / total : 0, blobs };
}

export function runAnchorGate(img: RawImage): AnchorGateReport {
  const { width, height, data } = img;
  const checks: AnchorGateCheck[] = [];

  // 1. Corners transparent (background truly keyed out, nothing bleeding in).
  const cornerAlpha = ([x, y]: readonly [number, number]) => data[(y * width + x) * 4 + 3]!;
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ] as const;
  const worstCorner = Math.max(...corners.map(cornerAlpha));
  checks.push({
    id: 'corners',
    pass: worstCorner < ALPHA_CONTENT,
    detail: `max corner alpha ${worstCorner} (limit ${ALPHA_CONTENT})`,
  });

  // 2. Enough content pixels (≥2%) + centroid while we scan.
  let content = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let p = 0; p < width * height; p++) {
    if (data[p * 4 + 3]! < ALPHA_CONTENT) continue;
    content++;
    const x = p % width;
    const y = (p / width) | 0;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const contentPct = (content / (width * height)) * 100;
  checks.push({
    id: 'content',
    pass: contentPct >= 2,
    detail: `${contentPct.toFixed(1)}% content pixels (need ≥2%)`,
  });

  // 3. Full body uncropped: a real cut leaves a RUN of content along an edge.
  //    A stray antialiased pixel or a toe grazing the border is not a crop, so
  //    each edge needs meaningful mass before it counts.
  const edgeRun = (pick: (i: number) => number, span: number) => {
    let n = 0;
    for (let i = 0; i < span; i++) if (data[pick(i) * 4 + 3]! >= ALPHA_CONTENT) n++;
    return n;
  };
  const minRun = (extent: number) => Math.max(3, extent * 0.06);
  const touches: string[] = [];
  if (edgeRun((x) => x, width) > minRun(maxX - minX + 1)) touches.push('top');
  if (edgeRun((x) => (height - 1) * width + x, width) > minRun(maxX - minX + 1)) touches.push('bottom');
  if (edgeRun((y) => y * width, height) > minRun(maxY - minY + 1)) touches.push('left');
  if (edgeRun((y) => y * width + width - 1, height) > minRun(maxY - minY + 1)) touches.push('right');
  checks.push({
    id: 'uncropped',
    pass: content > 0 && touches.length === 0,
    detail: touches.length
      ? `content runs along the ${touches.join('/')} edge (looks cut off)`
      : 'padding on all sides',
  });

  // 4. Single connected component: largest blob ≥70% of content
  //    (catches two figures, detached props, floating fragments).
  const { fraction, blobs } = largestBlobFraction(img);
  checks.push({
    id: 'singleBlob',
    pass: content > 0 && fraction >= 0.7,
    detail: `largest of ${blobs} blob(s) holds ${(fraction * 100).toFixed(0)}% of content (need ≥70%)`,
  });

  // 5. Centered: centroid inside the middle 60% both axes.
  const cx = content > 0 ? sumX / content / width : 0.5;
  const cy = content > 0 ? sumY / content / height : 0.5;
  const centered = cx >= 0.2 && cx <= 0.8 && cy >= 0.2 && cy <= 0.8;
  checks.push({
    id: 'centered',
    pass: content > 0 && centered,
    detail: `centroid at ${(cx * 100).toFixed(0)}%,${(cy * 100).toFixed(0)}% (need 20-80%)`,
  });

  return { pass: checks.every((c) => c.pass), checks };
}
