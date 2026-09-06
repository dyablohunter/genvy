import { describe, it, expect } from 'vitest';
import {
  fillMaskPolygon,
  strokeMaskLine,
  shapeOutline,
  pointInShape,
  SceneSchema,
  type MaskPoint,
} from '@genvy/shared';

/**
 * The SHAPE pen's contract: a traced outline becomes a solid region with no
 * gap along its own edge, concave shapes stay concave, and nothing is written
 * outside the grid. A one-cell hole in a mask is a character falling through
 * a floor, so these are pinned.
 */

const grid = (w: number, h: number) =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => 0));

const count = (mask: number[][], value: number) =>
  mask.flat().filter((v) => v === value).length;

describe('fillMaskPolygon', () => {
  it('fills a rectangle including its outline', () => {
    const mask = grid(10, 10);
    const square: MaskPoint[] = [
      { x: 2, y: 2 },
      { x: 6, y: 2 },
      { x: 6, y: 6 },
      { x: 2, y: 6 },
    ];
    const filled = fillMaskPolygon(mask, square, 1);
    // 5x5 block from (2,2) to (6,6) inclusive.
    expect(count(mask, 1)).toBe(25);
    expect(filled).toBe(25);
    for (let y = 2; y <= 6; y++) {
      for (let x = 2; x <= 6; x++) expect(mask[y]![x]).toBe(1);
    }
    // Nothing outside it.
    expect(mask[1]![2]).toBe(0);
    expect(mask[7]![6]).toBe(0);
    expect(mask[2]![7]).toBe(0);
  });

  it('leaves no gap along the traced edge', () => {
    const mask = grid(20, 20);
    const shape: MaskPoint[] = [
      { x: 3, y: 15 },
      { x: 9, y: 9 }, // a diagonal, the case a scanline fill misses
      { x: 15, y: 15 },
    ];
    fillMaskPolygon(mask, shape, 1);
    // Every outline cell is painted: walk the edges and check each step.
    for (let i = 0; i < shape.length; i++) {
      const a = shape[i]!;
      const b = shape[(i + 1) % shape.length]!;
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = Math.round(a.x + (b.x - a.x) * t);
        const y = Math.round(a.y + (b.y - a.y) * t);
        expect(mask[y]![x]).toBe(1);
      }
    }
  });

  it('keeps a concave shape concave', () => {
    const mask = grid(12, 12);
    // An L: the notch in the top-right must stay empty.
    const l: MaskPoint[] = [
      { x: 1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 5 },
      { x: 9, y: 5 },
      { x: 9, y: 9 },
      { x: 1, y: 9 },
    ];
    fillMaskPolygon(mask, l, 2);
    expect(mask[2]![3]).toBe(2); // inside the upper arm
    expect(mask[7]![7]).toBe(2); // inside the lower arm
    expect(mask[2]![8]).toBe(0); // the notch
    expect(mask[3]![7]).toBe(0);
  });

  it('clips to the grid instead of writing outside it', () => {
    const mask = grid(6, 6);
    const overhang: MaskPoint[] = [
      { x: -5, y: -5 },
      { x: 20, y: -5 },
      { x: 20, y: 20 },
      { x: -5, y: 20 },
    ];
    expect(() => fillMaskPolygon(mask, overhang, 3)).not.toThrow();
    expect(count(mask, 3)).toBe(36); // the whole grid, nothing beyond
  });

  it('ignores degenerate outlines and empty grids', () => {
    const mask = grid(5, 5);
    expect(fillMaskPolygon(mask, [{ x: 1, y: 1 }], 1)).toBe(0);
    expect(fillMaskPolygon(mask, [{ x: 1, y: 1 }, { x: 3, y: 3 }], 1)).toBe(0);
    expect(count(mask, 1)).toBe(0);
    expect(fillMaskPolygon([], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }], 1)).toBe(0);
  });

  it('counts only cells it changed, so a repeat fill is a no-op', () => {
    const mask = grid(8, 8);
    const tri: MaskPoint[] = [
      { x: 1, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 6 },
    ];
    const first = fillMaskPolygon(mask, tri, 1);
    expect(first).toBeGreaterThan(0);
    expect(fillMaskPolygon(mask, tri, 1)).toBe(0);
  });

  it('erases with value 0 exactly as it fills', () => {
    const mask = grid(8, 8);
    const square: MaskPoint[] = [
      { x: 1, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 6 },
      { x: 1, y: 6 },
    ];
    fillMaskPolygon(mask, square, 1);
    const inner: MaskPoint[] = [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 4 },
      { x: 3, y: 4 },
    ];
    fillMaskPolygon(mask, inner, 0);
    expect(mask[3]![3]).toBe(0);
    expect(mask[1]![1]).toBe(1);
  });
});

describe('strokeMaskLine', () => {
  it('paints both endpoints and every step between', () => {
    const mask = grid(10, 10);
    const changed = strokeMaskLine(mask, { x: 0, y: 0 }, { x: 5, y: 5 }, 1);
    expect(changed).toBe(6);
    for (let i = 0; i <= 5; i++) expect(mask[i]![i]).toBe(1);
  });

  it('paints a single cell when both ends are the same', () => {
    const mask = grid(4, 4);
    expect(strokeMaskLine(mask, { x: 2, y: 2 }, { x: 2, y: 2 }, 1)).toBe(1);
    expect(mask[2]![2]).toBe(1);
  });
});

/**
 * Vector shapes are the SHAPE pen's output: they follow the artwork instead
 * of the mask grid, which is the whole reason they exist. These pin that they
 * stay unquantised and that hit-testing agrees with what is drawn.
 */
describe('scene shapes', () => {
  it('keeps sub-cell precision — a traced outline is not snapped to a grid', () => {
    const shape = {
      type: 'polygon' as const,
      points: [
        { x: 10.5, y: 20.25 },
        { x: 64.75, y: 18 },
        { x: 40, y: 55.5 },
      ],
    };
    expect(shapeOutline(shape)).toEqual(shape.points);
    // A point 0.4px inside the top edge still counts as inside.
    expect(pointInShape(shape, 40, 21)).toBe(true);
  });

  it('expands a rect into its four corners in order', () => {
    const outline = shapeOutline({
      type: 'rect',
      points: [
        { x: 10, y: 5 },
        { x: 30, y: 25 },
      ],
    });
    expect(outline).toEqual([
      { x: 10, y: 5 },
      { x: 30, y: 5 },
      { x: 30, y: 25 },
      { x: 10, y: 25 },
    ]);
  });

  it('expands a circle into a closed ring around its centre', () => {
    const circle = { type: 'circle' as const, points: [{ x: 100, y: 100 }], radius: 20 };
    const outline = shapeOutline(circle);
    expect(outline).toHaveLength(32);
    for (const p of outline) {
      expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(20, 6);
    }
    // Containment uses the true circle, not the facets: a point just inside
    // the radius but outside a chord still reads as inside.
    expect(pointInShape(circle, 100 + 19.99, 100)).toBe(true);
    expect(pointInShape(circle, 100 + 20.01, 100)).toBe(false);
  });

  it('hit-tests a triangle by its actual slope', () => {
    const tri = {
      type: 'triangle' as const,
      points: [
        { x: 50, y: 0 }, // apex
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    };
    expect(pointInShape(tri, 50, 90)).toBe(true); // deep inside
    expect(pointInShape(tri, 5, 10)).toBe(false); // above the left slope
    expect(pointInShape(tri, 95, 10)).toBe(false); // above the right slope
  });

  it('reports degenerate shapes as containing nothing', () => {
    expect(pointInShape({ type: 'polygon', points: [{ x: 0, y: 0 }] }, 0, 0)).toBe(false);
    expect(pointInShape({ type: 'circle', points: [], radius: 10 }, 0, 0)).toBe(false);
    expect(shapeOutline({ type: 'rect', points: [{ x: 1, y: 1 }] })).toEqual([]);
  });

  it('round-trips through the scene schema', () => {
    const scene = SceneSchema.parse({
      id: 'scn_test',
      type: 'scene',
      name: 'Cave',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      image: { path: 'scn_test/raw.png' },
      width: 1024,
      height: 512,
      shapes: [
        { id: 'sh_1', kind: 1, type: 'polygon', points: [{ x: 1.5, y: 2.5 }, { x: 9, y: 2 }, { x: 5, y: 9 }] },
        { id: 'sh_2', kind: 4, type: 'circle', points: [{ x: 60, y: 60 }], radius: 12 },
      ],
    });
    expect(scene.shapes).toHaveLength(2);
    expect(scene.shapes[0]!.points[0]!.x).toBe(1.5); // fractions survive
    // A scene without shapes still parses — older assets predate the field.
    const bare = SceneSchema.parse({
      id: 'scn_old',
      type: 'scene',
      name: 'Old',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      image: { path: 'scn_old/raw.png' },
      width: 8,
      height: 8,
    });
    expect(bare.shapes).toEqual([]);
  });
});
