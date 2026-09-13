import { describe, it, expect } from 'vitest';
import * as pipe from '../src/services/imagePipeline.js';

/**
 * A level with no backdrop used to borrow its tileset's first tile as an
 * icon, so every grid level built from one palette showed the same square.
 * What a tile level looks like IS its arrangement, and the arrangement is
 * data — so it is composed here rather than screenshotted off a canvas.
 */

/** A 2x2 sheet of flat 4px tiles, each a distinct solid colour. */
function sheet(): pipe.RawImage {
  const tw = 4;
  const cols = 2;
  const rows = 2;
  const width = cols * tw;
  const height = rows * tw;
  const data = Buffer.alloc(width * height * 4);
  const tones = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  for (let t = 0; t < 4; t++) {
    const ox = (t % cols) * tw;
    const oy = Math.floor(t / cols) * tw;
    for (let y = 0; y < tw; y++) {
      for (let x = 0; x < tw; x++) {
        const i = ((oy + y) * width + ox + x) * 4;
        data[i] = tones[t]![0]!;
        data[i + 1] = tones[t]![1]!;
        data[i + 2] = tones[t]![2]!;
        data[i + 3] = 255;
      }
    }
  }
  return { data, width, height };
}

const pixel = (img: pipe.RawImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('composeTileGrid', () => {
  const plan = (tiles: number[][], props?: pipe.TileGridPlan['props']) => ({
    tiles,
    ...(props ? { props } : {}),
    tileWidth: 4,
    tileHeight: 4,
  });

  it('paints each cell with the tile it names', () => {
    const out = pipe.composeTileGrid(sheet(), plan([
      [0, 1],
      [2, 3],
    ]));
    expect(out).not.toBeNull();
    expect(out!.width).toBe(8);
    expect(out!.height).toBe(8);
    expect(pixel(out!, 1, 1)).toEqual([255, 0, 0, 255]); // tile 0, top-left
    expect(pixel(out!, 5, 1)).toEqual([0, 255, 0, 255]); // tile 1, top-right
    expect(pixel(out!, 1, 5)).toEqual([0, 0, 255, 255]); // tile 2, bottom-left
    expect(pixel(out!, 5, 5)).toEqual([255, 255, 0, 255]); // tile 3
  });

  it('leaves empty cells transparent', () => {
    const out = pipe.composeTileGrid(sheet(), plan([[0, -1]]));
    expect(pixel(out!, 1, 1)![3]).toBe(255);
    expect(pixel(out!, 5, 1)![3]).toBe(0);
  });

  it('returns null when nothing is painted, so the caller can fall back', () => {
    expect(pipe.composeTileGrid(sheet(), plan([]))).toBeNull();
    expect(pipe.composeTileGrid(sheet(), plan([[-1, -1], [-1, -1]]))).toBeNull();
  });

  it('stretches a prop across its whole block', () => {
    // A 2x2 prop of tile 1 over an otherwise empty 2x2 grid.
    const out = pipe.composeTileGrid(
      sheet(),
      plan([[-1, -1], [-1, -1]], [{ tile: 1, x: 0, y: 0, w: 2, h: 2 }]),
    );
    expect(out).not.toBeNull();
    // Every pixel of the block is the prop's colour, corners included.
    for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7], [4, 4]]) {
      expect(pixel(out!, x!, y!)).toEqual([0, 255, 0, 255]);
    }
  });

  it('draws props over the grid, not under it', () => {
    const out = pipe.composeTileGrid(
      sheet(),
      plan([[0, 0], [0, 0]], [{ tile: 3, x: 1, y: 1, w: 1, h: 1 }]),
    );
    expect(pixel(out!, 1, 1)).toEqual([255, 0, 0, 255]); // grid shows through
    expect(pixel(out!, 5, 5)).toEqual([255, 255, 0, 255]); // prop on top
  });

  it('grows to fit a prop that reaches past the grid', () => {
    const out = pipe.composeTileGrid(
      sheet(),
      plan([[0]], [{ tile: 1, x: 2, y: 3, w: 1, h: 1 }]),
    );
    expect(out!.width).toBe(12); // 3 columns
    expect(out!.height).toBe(16); // 4 rows
    expect(pixel(out!, 9, 13)).toEqual([0, 255, 0, 255]);
  });

  it('ignores a tile index that is off the sheet instead of reading garbage', () => {
    const out = pipe.composeTileGrid(sheet(), plan([[0, 99]]));
    expect(pixel(out!, 1, 1)![3]).toBe(255);
    expect(pixel(out!, 5, 1)![3]).toBe(0);
  });

  it('handles a ragged grid, which is what a grown level is', () => {
    const out = pipe.composeTileGrid(sheet(), plan([[0], [1, 2]]));
    expect(out!.width).toBe(8);
    expect(out!.height).toBe(8);
    expect(pixel(out!, 5, 1)![3]).toBe(0); // nothing in the short row
    expect(pixel(out!, 5, 5)).toEqual([0, 0, 255, 255]);
  });
});
