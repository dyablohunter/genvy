import { describe, it, expect } from 'vitest';
import * as pipe from '../src/services/imagePipeline.js';

/**
 * The tile sheets gpt-image-2 actually returns carry the right NUMBER of
 * cells on the wrong lattice: measured sheets drift 20-30px per row and the
 * drift accumulates downward, so an even `height / rows` cut leaves row one
 * perfect and row six two halves of its neighbours. The model does separate
 * cells with a flat gutter, and that is what these tests pin.
 */

const GUTTER: [number, number, number] = [60, 60, 60];

/**
 * Paint a sheet whose cell boundaries sit at `xs`/`ys`: a gutter-coloured
 * ground, each cell filled edge to edge with its own flat colour inset by
 * `gutter` px. A zero gutter means full-bleed art with no seam to find.
 */
function sheet(xs: number[], ys: number[], gutter: number): pipe.RawImage {
  const width = xs[xs.length - 1]!;
  const height = ys[ys.length - 1]!;
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data[p * 4] = GUTTER[0];
    data[p * 4 + 1] = GUTTER[1];
    data[p * 4 + 2] = GUTTER[2];
    data[p * 4 + 3] = 255;
  }
  let n = 0;
  for (let row = 0; row + 1 < ys.length; row++) {
    for (let col = 0; col + 1 < xs.length; col++) {
      // Deliberately far from the gutter colour in every channel.
      const tone = 120 + ((n * 37) % 120);
      n++;
      for (let y = ys[row]! + gutter; y < ys[row + 1]! - gutter; y++) {
        for (let x = xs[col]! + gutter; x < xs[col + 1]! - gutter; x++) {
          const i = (y * width + x) * 4;
          data[i] = tone;
          data[i + 1] = 255 - tone;
          data[i + 2] = (tone * 2) % 255;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { data, width, height };
}

const even = (count: number, extent: number) =>
  Array.from({ length: count + 1 }, (_, i) => Math.round((i * extent) / count));

describe('detectTileGrid', () => {
  it('leaves an evenly drawn sheet on the even lattice', () => {
    const img = sheet(even(4, 1024), even(6, 1536), 6);
    const grid = pipe.detectTileGrid(img, 4, 6);
    expect(grid.xs).toEqual([0, 256, 512, 768, 1024]);
    expect(grid.ys).toEqual([0, 256, 512, 768, 1024, 1280, 1536]);
    expect(grid.corrected).toBe(0);
  });

  it('follows the drift a real sheet has instead of cutting through art', () => {
    // The row boundaries measured off a forged sheet: correct at the top,
    // ~25px early by the bottom.
    const ys = [0, 256, 512, 743, 1000, 1250, 1536];
    const img = sheet(even(4, 1024), ys, 8);
    const grid = pipe.detectTileGrid(img, 4, 6);

    expect(grid.ys.length).toBe(7); // the COUNT is never invented
    for (const [i, want] of ys.entries()) {
      expect(Math.abs(grid.ys[i]! - want)).toBeLessThanOrEqual(8);
    }
    expect(grid.corrected).toBeGreaterThan(0);

    // What the old even cut did to the same sheet, for contrast: the last
    // interior line lands 30px inside the neighbouring tile.
    expect(Math.abs(1280 - 1250)).toBeGreaterThan(8);
  });

  it('keeps the even division when there is no gutter to find', () => {
    const img = sheet(even(4, 1024), [0, 256, 512, 743, 1000, 1250, 1536], 0);
    const grid = pipe.detectTileGrid(img, 4, 6);
    expect(grid.ys).toEqual([0, 256, 512, 768, 1024, 1280, 1536]);
    expect(grid.corrected).toBe(0);
  });

  it('never pulls a line more than a fifth of a cell', () => {
    // A wildly wrong sheet must degrade to the even cut, not to a line
    // dragged across two tiles.
    const img = sheet(even(4, 1024), [0, 120, 512, 768, 1024, 1280, 1536], 8);
    const grid = pipe.detectTileGrid(img, 4, 6);
    for (const [i, nominal] of [0, 256, 512, 768, 1024, 1280, 1536].entries()) {
      expect(Math.abs(grid.ys[i]! - nominal)).toBeLessThanOrEqual(256 * 0.18 + 1);
    }
  });
});

describe('cutCellsAt', () => {
  it('cuts one cell per lattice square, in reading order', () => {
    const ys = [0, 256, 512, 743, 1000, 1250, 1536];
    const img = sheet(even(4, 1024), ys, 8);
    const grid = pipe.detectTileGrid(img, 4, 6);
    const cells = pipe.cutCellsAt(img, grid.xs, grid.ys);
    expect(cells).toHaveLength(24);
    // Cells follow the drift, so they are NOT all the same height.
    expect(new Set(cells.map((c) => c.height)).size).toBeGreaterThan(1);
    for (const cell of cells) {
      expect(cell.data.length).toBe(cell.width * cell.height * 4);
    }
  });

  it('gives each cell its own art, not a blend of two', () => {
    const ys = [0, 256, 512, 743, 1000, 1250, 1536];
    const img = sheet(even(4, 1024), ys, 8);
    const grid = pipe.detectTileGrid(img, 4, 6);

    /** Distinct non-gutter colours inside a cell: 1 when the cut is right. */
    const tones = (cell: pipe.RawImage) => {
      const seen = new Set<string>();
      for (let y = 0; y < cell.height; y++) {
        for (let x = 0; x < cell.width; x++) {
          const i = (y * cell.width + x) * 4;
          const [r, g, b] = [cell.data[i]!, cell.data[i + 1]!, cell.data[i + 2]!];
          if (Math.abs(r - GUTTER[0]) < 20 && Math.abs(g - GUTTER[1]) < 20) continue;
          seen.add(`${r},${g},${b}`);
        }
      }
      return seen.size;
    };

    for (const cell of pipe.cutCellsAt(img, grid.xs, grid.ys)) {
      expect(tones(cell)).toBe(1);
    }
    // The even cut is what produced the bug: cells carrying two tiles' art.
    const bad = pipe.cutCellsAt(img, even(4, 1024), even(6, 1536));
    expect(bad.filter((c) => tones(c) > 1).length).toBeGreaterThan(0);
  });
});
