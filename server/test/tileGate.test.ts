import { describe, it, expect } from 'vitest';
import type { RawImage } from '../src/services/imagePipeline.js';
import { gateTiles, wrapContinuity } from '../src/services/tileGate.js';

/**
 * Synthetic tiles with known properties — the gate must separate "looks fine
 * as a picture" from "works as a tileset".
 */

const SIZE = 32;

function make(fn: (x: number, y: number) => [number, number, number, number]): RawImage {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * SIZE + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width: SIZE, height: SIZE };
}

/** Continuous across the wrap: a full sine period in both axes. */
const seamlessTile = (base = 90) =>
  make((x, y) => {
    const v =
      base +
      18 * Math.sin((x / SIZE) * Math.PI * 2) +
      18 * Math.sin((y / SIZE) * Math.PI * 2);
    return [v, v + 12, v - 20, 255];
  });

/** A gradient: bright at the left edge, dark at the right — a hard seam when repeated. */
const seamedTile = () =>
  make((x) => {
    const v = 30 + (x / SIZE) * 190;
    return [v, v + 10, v - 15, 255];
  });

describe('wrapContinuity', () => {
  it('scores a seamless texture high and a gradient low', () => {
    expect(wrapContinuity(seamlessTile())).toBeGreaterThan(0.8);
    expect(wrapContinuity(seamedTile())).toBeLessThan(0.3);
  });

  it('treats a flat tile as seamless (no internal texture, no seam)', () => {
    expect(wrapContinuity(make(() => [80, 120, 60, 255]))).toBeGreaterThan(0.9);
  });
});

describe('gateTiles', () => {
  it('passes a cohesive, seamless, full-bleed set', async () => {
    const tiles = [seamlessTile(88), seamlessTile(94), seamlessTile(84), seamlessTile(97)];
    const report = await gateTiles(tiles);
    expect(report.pass).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(70);
    expect(report.failedTiles).toEqual([]);
    expect(report.hints).toEqual([]);
  });

  it('flags a tile that will not repeat, and says why', async () => {
    const report = await gateTiles([seamlessTile(), seamlessTile(92), seamedTile()]);
    expect(report.pass).toBe(false);
    expect(report.failedTiles).toContain(2);
    expect(report.tiles[2]!.errors.join(' ')).toMatch(/does not tile/);
    expect(report.hints.join(' ')).toMatch(/continue exactly/);
  });

  it('does not judge prop tiles on seam continuity', async () => {
    const tiles = [seamlessTile(), seamlessTile(92), seamedTile()];
    // Tile 2 is a signpost, not ground: only 0 and 1 are terrain.
    const report = await gateTiles(tiles, { seamlessIndexes: [0, 1] });
    expect(report.tiles[2]!.errors.join(' ')).not.toMatch(/does not tile/);
    expect(report.failedTiles).not.toContain(2);
  });

  it('catches an off-palette tile that reads as a different set', async () => {
    const magenta = make(() => [230, 20, 210, 255]);
    const report = await gateTiles([seamlessTile(), seamlessTile(90), seamlessTile(86), magenta]);
    expect(report.tiles[3]!.paletteScore).toBeLessThan(0.5);
    expect(report.tiles[3]!.errors.join(' ')).toMatch(/palette/);
    expect(report.hints.join(' ')).toMatch(/ONE palette/);
  });

  it('catches empty cells, gapped art and drawn grid lines', async () => {
    const empty = make(() => [0, 0, 0, 0]);
    const gapped = make((x, y) => {
      const inset = x > 5 && x < SIZE - 6 && y > 5 && y < SIZE - 6;
      return inset ? [90, 102, 70, 255] : [0, 0, 0, 0];
    });
    const framed = make((x, y) => {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      return edge ? [10, 10, 10, 255] : [140, 150, 120, 255];
    });
    const report = await gateTiles([seamlessTile(), empty, gapped, framed]);
    expect(report.tiles[1]!.errors.join(' ')).toMatch(/empty/);
    expect(report.tiles[2]!.errors.join(' ')).toMatch(/fill its cell/);
    expect(report.tiles[3]!.errors.join(' ')).toMatch(/grid line/);
    expect(report.hints.join(' ')).toMatch(/NO grid lines/);
    expect(report.pass).toBe(false);
  });

  it('warns about duplicate tiles without failing the sheet for them', async () => {
    const t = seamlessTile();
    const report = await gateTiles([t, seamlessTile(92), { ...t }]);
    expect(report.tiles[2]!.warnings.join(' ')).toMatch(/duplicate of tile 1/);
    expect(report.failedTiles).not.toContain(2); // a warning, not a fault
  });

  it('penalises a short sheet and reports the shortfall', async () => {
    const report = await gateTiles([seamlessTile(), seamlessTile(92)], { expectedTiles: 6 });
    expect(report.pass).toBe(false);
    expect(report.tileCount).toBe(2);
    expect(report.expectedTiles).toBe(6);
    expect(report.hints.join(' ')).toMatch(/2 tiles instead of 6/);
  });
});
