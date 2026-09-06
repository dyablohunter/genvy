/**
 * Mask geometry: turning a traced outline into filled collision cells.
 *
 * This lives in shared, as pure functions over a plain grid, because it is
 * geometry — the same rule the runtime will use when it reads the mask back.
 * Keeping it out of the Phaser scene is what makes it testable at all, and
 * deterministic geometry is the house rule (see the sprite pipeline's
 * registration code for the same reasoning).
 */

export interface MaskPoint {
  x: number;
  y: number;
}

/**
 * The outline of any scene shape, as a polygon in image pixels.
 *
 * One definition, used by the editor to draw and hit-test, and by anything
 * that later exports collision. A circle becomes a 32-gon: fine enough that
 * nobody sees the facets, coarse enough to stay cheap — and, unlike a raster
 * mask, its resolution does not depend on how far the camera is zoomed in.
 */
export function shapeOutline(shape: {
  type: 'polygon' | 'rect' | 'triangle' | 'circle';
  points: MaskPoint[];
  radius?: number;
}): MaskPoint[] {
  if (shape.type === 'circle') {
    const c = shape.points[0];
    const r = shape.radius ?? 0;
    if (!c || r <= 0) return [];
    const steps = 32;
    return Array.from({ length: steps }, (_, i) => {
      const a = (i / steps) * Math.PI * 2;
      return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    });
  }
  if (shape.type === 'rect') {
    const [a, b] = shape.points;
    if (!a || !b) return [];
    return [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
  }
  return shape.points.slice();
}

/** Even-odd containment against a polygon in the same units as the point. */
export function pointInPolygon(points: MaskPoint[], x: number, y: number): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > y !== b.y > y) {
      const ix = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (x < ix) inside = !inside;
    }
  }
  return inside;
}

/** Whether a point falls inside a scene shape, circles included exactly. */
export function pointInShape(
  shape: { type: 'polygon' | 'rect' | 'triangle' | 'circle'; points: MaskPoint[]; radius?: number },
  x: number,
  y: number,
): boolean {
  if (shape.type === 'circle') {
    const c = shape.points[0];
    const r = shape.radius ?? 0;
    if (!c) return false;
    return (x - c.x) ** 2 + (y - c.y) ** 2 <= r * r;
  }
  return pointInPolygon(shapeOutline(shape), x, y);
}

/** Stamp a straight run of cells between two points, endpoints included. */
export function strokeMaskLine(
  mask: number[][],
  from: MaskPoint,
  to: MaskPoint,
  value: number,
): number {
  const height = mask.length;
  const width = mask[0]?.length ?? 0;
  if (height === 0 || width === 0) return 0;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  let changed = 0;
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    if (y < 0 || x < 0 || y >= height || x >= width) continue;
    if (mask[y]![x] === value) continue;
    mask[y]![x] = value;
    changed++;
  }
  return changed;
}

/**
 * Fill a closed polygon of mask cells, its outline included.
 *
 * Even-odd ray casting on cell CENTRES: a cell belongs to the shape when its
 * middle is inside the outline. The outline is then stroked as well, because
 * a traced edge that runs along cell boundaries would otherwise fall outside
 * the test and leave the shape's border unpainted — a one-cell gap in a floor
 * is a character falling through it.
 *
 * Returns how many cells actually changed; the mask is mutated in place.
 */
export function fillMaskPolygon(mask: number[][], points: MaskPoint[], value: number): number {
  const height = mask.length;
  const width = mask[0]?.length ?? 0;
  if (points.length < 3 || height === 0 || width === 0) return 0;

  const minY = Math.max(0, Math.min(...points.map((p) => p.y)));
  const maxY = Math.min(height - 1, Math.max(...points.map((p) => p.y)));
  const minX = Math.max(0, Math.min(...points.map((p) => p.x)));
  const maxX = Math.min(width - 1, Math.max(...points.map((p) => p.x)));

  let filled = 0;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i]!;
        const b = points[j]!;
        const ay = a.y + 0.5;
        const by = b.y + 0.5;
        if (ay > py !== by > py) {
          const ix = ((b.x - a.x) * (py - ay)) / (by - ay) + a.x + 0.5;
          if (px < ix) inside = !inside;
        }
      }
      if (!inside) continue;
      if (mask[y]![x] === value) continue;
      mask[y]![x] = value;
      filled++;
    }
  }
  for (let i = 0; i < points.length; i++) {
    filled += strokeMaskLine(mask, points[i]!, points[(i + 1) % points.length]!, value);
  }
  return filled;
}
