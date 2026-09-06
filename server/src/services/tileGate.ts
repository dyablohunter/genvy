import type { RawImage } from './imagePipeline.js';
import { cellHash } from './imagePipeline.js';

/**
 * World Maker v2 §W1 — the tileset equivalent of `animationGate`.
 *
 * A tile sheet can look fine as a picture and still be unusable as a tileset:
 * tiles that do not wrap, a palette that drifts across the set, drawn grid
 * lines baked into the art, tiles that do not fill their cell, and duplicate
 * slots. Prompts ask for all of that and cannot guarantee any of it — so this
 * measures it deterministically, scores it, and hands back hints the retry
 * loop can feed into the next attempt.
 *
 * Provider-agnostic on purpose: it runs on gpt-image-2 sheets and locally
 * composed ones alike.
 */

export interface TileGateOptions {
  /** How many tiles the caller asked for (a short sheet is itself a failure). */
  expectedTiles?: number;
  /**
   * Tiles that are supposed to tile with themselves (ground, water, walls).
   * Props — a chest, a sign, a tree — must NOT be judged on wrap continuity,
   * so callers pass the indices that are genuinely terrain.
   */
  seamlessIndexes?: number[];
}

export interface TileReport {
  index: number;
  /** 0..1, higher is better: how well the tile's opposite edges continue into each other. */
  wrapScore: number;
  /** 0..1: how close this tile's colours are to the set as a whole. */
  paletteScore: number;
  /** Fraction of the cell that is actually drawn (opaque). */
  fill: number;
  errors: string[];
  warnings: string[];
}

export interface TileGateReport {
  score: number; // 0..100
  pass: boolean;
  tileCount: number;
  expectedTiles: number;
  tiles: TileReport[];
  /** Indices worth redrawing, worst first. */
  failedTiles: number[];
  /** Corrections for the next attempt's prompt. */
  hints: string[];
}

/** Mean absolute RGB difference between two equal-length pixel runs. */
function meanDiff(a: number[], b: number[]): number {
  if (a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

function column(img: RawImage, x: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < img.height; y++) {
    const i = (y * img.width + x) * 4;
    out.push(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
  }
  return out;
}

function row(img: RawImage, y: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    out.push(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
  }
  return out;
}

/**
 * How seamlessly a tile repeats: the jump across the wrap seam (last column
 * to first column) measured against the tile's OWN average column-to-column
 * change. Relative, not absolute — a noisy texture is allowed a noisy seam,
 * a flat one is not. 1 = the seam is no worse than the tile's own texture.
 */
export function wrapContinuity(tile: RawImage): number {
  if (tile.width < 3 || tile.height < 3) return 1;
  let internalX = 0;
  for (let x = 1; x < tile.width; x++) internalX += meanDiff(column(tile, x - 1), column(tile, x));
  internalX /= tile.width - 1;
  let internalY = 0;
  for (let y = 1; y < tile.height; y++) internalY += meanDiff(row(tile, y - 1), row(tile, y));
  internalY /= tile.height - 1;

  const seamX = meanDiff(column(tile, tile.width - 1), column(tile, 0));
  const seamY = meanDiff(row(tile, tile.height - 1), row(tile, 0));

  // A flat tile has ~0 internal change; guard the ratio so it stays finite.
  const ratioX = seamX / Math.max(internalX, 1);
  const ratioY = seamY / Math.max(internalY, 1);
  const worst = Math.max(ratioX, ratioY);
  // <=1.5x internal variation reads as seamless; 6x is a hard visible seam.
  return Math.max(0, Math.min(1, 1 - (worst - 1.5) / 4.5));
}

/** Mean RGB of the drawn (opaque) pixels, plus how much of the cell is drawn. */
function tileStats(tile: RawImage): { mean: [number, number, number]; fill: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const total = tile.width * tile.height;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (tile.data[i + 3]! < 24) continue;
    r += tile.data[i]!;
    g += tile.data[i + 1]!;
    b += tile.data[i + 2]!;
    n++;
  }
  if (n === 0) return { mean: [0, 0, 0], fill: 0 };
  return { mean: [r / n, g / n, b / n], fill: n / total };
}

/**
 * Grid lines drawn INTO the art: a border row/column that is markedly darker
 * than the tile's interior. The prompt forbids them; models draw them anyway,
 * and once baked in they show as a lattice over the whole map.
 */
function hasDrawnBorder(tile: RawImage): boolean {
  if (tile.width < 6 || tile.height < 6) return false;
  const lum = (px: number[]) => {
    let sum = 0;
    for (let i = 0; i < px.length; i += 3) sum += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
    return sum / (px.length / 3);
  };
  const edges = [
    lum(row(tile, 0)),
    lum(row(tile, tile.height - 1)),
    lum(column(tile, 0)),
    lum(column(tile, tile.width - 1)),
  ];
  const inner = [
    lum(row(tile, 2)),
    lum(row(tile, tile.height - 3)),
    lum(column(tile, 2)),
    lum(column(tile, tile.width - 3)),
  ];
  // All four edges much darker than the ring just inside them = a frame.
  return edges.every((e, i) => e < inner[i]! - 28);
}

/**
 * Score a cut tileset. `tiles` are the already-extracted cells, in sheet
 * reading order.
 */
export async function gateTiles(
  tiles: RawImage[],
  opts: TileGateOptions = {},
): Promise<TileGateReport> {
  const expectedTiles = opts.expectedTiles ?? tiles.length;
  const seamless = new Set(opts.seamlessIndexes ?? tiles.map((_, i) => i));
  const stats = tiles.map(tileStats);

  // Set-wide colour centre, from the drawn tiles only.
  const drawn = stats.filter((s) => s.fill > 0.02);
  const setMean: [number, number, number] = drawn.length
    ? [
        drawn.reduce((s, t) => s + t.mean[0], 0) / drawn.length,
        drawn.reduce((s, t) => s + t.mean[1], 0) / drawn.length,
        drawn.reduce((s, t) => s + t.mean[2], 0) / drawn.length,
      ]
    : [0, 0, 0];

  const hashes = await Promise.all(tiles.map((t) => cellHash(t)));
  const seen = new Map<string, number>();

  const reports: TileReport[] = tiles.map((tile, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const { mean, fill } = stats[index]!;

    const wrapScore = seamless.has(index) ? wrapContinuity(tile) : 1;
    if (seamless.has(index) && wrapScore < 0.45) {
      errors.push('does not tile: a hard seam appears where the tile repeats');
    } else if (seamless.has(index) && wrapScore < 0.7) {
      warnings.push('edges nearly line up but the repeat is still visible');
    }

    // Distance from the set's colour centre, normalised to a 0..1 score.
    const dist = Math.hypot(mean[0] - setMean[0], mean[1] - setMean[1], mean[2] - setMean[2]);
    const paletteScore = Math.max(0, Math.min(1, 1 - dist / 160));
    if (fill > 0.02 && paletteScore < 0.45) {
      errors.push('palette does not match the rest of the set');
    }

    if (fill < 0.5) {
      errors.push(
        fill < 0.02
          ? 'tile is empty'
          : 'tile does not fill its cell — art must reach every edge, with no border gap',
      );
    }
    if (hasDrawnBorder(tile)) errors.push('a grid line/border is drawn into the tile');

    const firstSeen = seen.get(hashes[index]!);
    if (firstSeen === undefined) seen.set(hashes[index]!, index);
    else warnings.push(`duplicate of tile ${firstSeen + 1}`);

    return { index, wrapScore, paletteScore, fill, errors, warnings };
  });

  // Score: seam quality and palette cohesion carry the sheet; hard faults
  // (empty cells, drawn borders) subtract on top.
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);
  const seamAvg = avg(reports.filter((r) => seamless.has(r.index)).map((r) => r.wrapScore));
  const paletteAvg = avg(reports.filter((r) => r.fill > 0.02).map((r) => r.paletteScore));
  const faults = reports.reduce((n, r) => n + r.errors.length, 0);
  const missing = Math.max(0, expectedTiles - tiles.length);

  let score = Math.round(seamAvg * 45 + paletteAvg * 35 + 20);
  score -= faults * 6;
  score -= missing * 8;
  score = Math.max(0, Math.min(100, score));

  const failedTiles = reports
    .filter((r) => r.errors.length > 0)
    .sort((a, b) => b.errors.length - a.errors.length || a.wrapScore - b.wrapScore)
    .map((r) => r.index);

  const hints: string[] = [];
  if (seamAvg < 0.7) {
    hints.push(
      'Tiles must repeat seamlessly: the art running off the right edge has to continue exactly ' +
        'at the left edge (and bottom into top). No vignetting, no darker rim, no centred motif.',
    );
  }
  if (paletteAvg < 0.7) {
    hints.push(
      'Every tile shares ONE palette and one light direction — they are pieces of a single set, ' +
        'not separate illustrations.',
    );
  }
  if (reports.some((r) => r.errors.some((e) => e.includes('grid line')))) {
    hints.push('Draw NO grid lines, frames or borders — tiles butt directly against each other.');
  }
  if (reports.some((r) => r.errors.some((e) => e.includes('fill its cell')))) {
    hints.push('Each tile fills its whole cell edge to edge; leave no transparent margin.');
  }
  if (missing > 0) hints.push(`The sheet held ${tiles.length} tiles instead of ${expectedTiles}.`);

  return {
    score,
    pass: score >= 70 && failedTiles.length === 0 && missing === 0,
    tileCount: tiles.length,
    expectedTiles,
    tiles: reports,
    failedTiles,
    hints,
  };
}
