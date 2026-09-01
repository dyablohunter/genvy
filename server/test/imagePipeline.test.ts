import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import * as pipe from '../src/services/imagePipeline.js';

/** Build a synthetic 4x6 grid image: magenta background, colored square per cell. */
async function makeGridImage(cellSize = 64, cols = 4, rows = 6): Promise<Buffer> {
  const width = cols * cellSize;
  const height = rows * cellSize;
  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const inner = await sharp({
      create: {
        width: cellSize / 2,
        height: cellSize / 2,
        channels: 4,
        background: { r: (i * 10) % 255, g: 128, b: 40, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    composites.push({
      input: inner,
      left: (i % cols) * cellSize + cellSize / 4,
      top: Math.floor(i / cols) * cellSize + cellSize / 4,
    });
  }
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

describe('imagePipeline', () => {
  it('detects the key color from corners', async () => {
    const img = await pipe.loadRaw(await makeGridImage());
    expect(pipe.detectKeyColor(img)).toEqual([255, 0, 255]);
  });

  it('removes the background to transparent, keeping content', async () => {
    const img = await pipe.loadRaw(await makeGridImage());
    const keyed = pipe.removeBackground(img, 24, 'both');
    // Corner is background -> alpha 0.
    expect(keyed.data[3]).toBe(0);
    // Center of cell 0 is content -> opaque.
    const cx = 32, cy = 32;
    expect(keyed.data[(cy * keyed.width + cx) * 4 + 3]).toBe(255);
  });

  it('slices a 4x6 grid into 24 aligned frames', async () => {
    const img = await pipe.loadRaw(await makeGridImage());
    const keyed = pipe.removeBackground(img, 24, 'both');
    let cells = pipe.cutCells(keyed, { cols: 4, rows: 6 });
    expect(cells).toHaveLength(24);
    cells = pipe.trimAndCenter(cells);
    // All content squares are 32x32, so trimmed cells are uniform 32x32.
    expect(cells[0]!.width).toBe(32);
    expect(cells[0]!.height).toBe(32);
  });

  it('nearest-neighbor resize hits exact dimensions', async () => {
    const img = await pipe.loadRaw(await makeGridImage());
    const cells = pipe.cutCells(img, { cols: 4, rows: 6 });
    const resized = await pipe.resizeCell(cells[0]!, 48, 48, 'nearest');
    expect(resized.width).toBe(48);
    expect(resized.height).toBe(48);
  });

  it('packs cells back into a grid image', async () => {
    const img = await pipe.loadRaw(await makeGridImage());
    const cells = pipe.cutCells(img, { cols: 4, rows: 6 });
    const packed = pipe.packCells(cells, 4);
    expect(packed.width).toBe(4 * 64);
    expect(packed.height).toBe(6 * 64);
    const png = await pipe.toPng(packed);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(256);
  });

  it('detects irregularly placed sprites on transparent background', async () => {
    // 3 sprites in row one (uneven x positions/sizes), 2 in row two.
    const sprites = [
      { left: 10, top: 20, w: 40, h: 50 },
      { left: 90, top: 15, w: 30, h: 60 },
      { left: 160, top: 25, w: 45, h: 40 },
      { left: 30, top: 120, w: 50, h: 45 },
      { left: 140, top: 130, w: 35, h: 55 },
    ];
    const composites: sharp.OverlayOptions[] = [];
    for (const s of sprites) {
      composites.push({
        input: await sharp({
          create: { width: s.w, height: s.h, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } },
        })
          .png()
          .toBuffer(),
        left: s.left,
        top: s.top,
      });
    }
    const png = await sharp({
      create: { width: 240, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const img = await pipe.loadRaw(png);
    expect(pipe.hasTransparency(img)).toBe(true);
    const boxes = pipe.detectSpriteCells(img);
    expect(boxes).toHaveLength(5);
    // Reading order: row 1 left-to-right first.
    expect(boxes[0]!.x).toBe(10);
    expect(boxes[1]!.x).toBe(90);
    expect(boxes[2]!.x).toBe(160);
    // Tight per-sprite bounds.
    expect(boxes[0]!.w).toBe(40);
    expect(boxes[0]!.h).toBe(50);
    const cells = pipe.extractBoxes(img, boxes);
    expect(cells[3]!.width).toBe(50);
  });

  it('splits poses merged by a thin beam into separate sprites', async () => {
    // Row 1: three 40x60 blocks connected by 3px-tall beams (like muzzle flashes).
    // Row 2: three separate 40x60 blocks to establish the median width.
    const block = (w: number, h: number) =>
      sharp({ create: { width: w, height: h, channels: 4, background: { r: 220, g: 60, b: 60, alpha: 1 } } })
        .png()
        .toBuffer();
    const composites: sharp.OverlayOptions[] = [];
    for (let i = 0; i < 3; i++) {
      composites.push({ input: await block(40, 60), left: 10 + i * 55, top: 10 });
      composites.push({ input: await block(40, 60), left: 10 + i * 55, top: 120 });
    }
    // Beams bridging the gaps in row 1 (15px wide, 3px tall).
    composites.push({ input: await block(15, 3), left: 50, top: 40 });
    composites.push({ input: await block(15, 3), left: 105, top: 40 });

    const png = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const img = await pipe.loadRaw(png);
    const boxes = pipe.detectSpriteCells(img);
    expect(boxes).toHaveLength(6);
  });

  it('detects green cell borders and returns their interiors', async () => {
    // Two green ring "cells" (100x140, 4px border) with a red blob inside each.
    const bar = (w: number, h: number) =>
      sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
        .png()
        .toBuffer();
    const ring = async (w: number, h: number, t: number) =>
      sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
          { input: await bar(w, t), left: 0, top: 0 },
          { input: await bar(w, t), left: 0, top: h - t },
          { input: await bar(t, h), left: 0, top: 0 },
          { input: await bar(t, h), left: w - t, top: 0 },
        ])
        .png()
        .toBuffer();
    const blob = await sharp({
      create: { width: 40, height: 60, channels: 4, background: { r: 220, g: 40, b: 40, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const png = await sharp({
      create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: await ring(100, 140, 4), left: 20, top: 20 },
        { input: await ring(100, 140, 4), left: 160, top: 30 },
        { input: blob, left: 50, top: 60 },
        { input: blob, left: 190, top: 70 },
      ])
      .png()
      .toBuffer();

    const img = await pipe.loadRaw(png);
    const cells = pipe.detectGreenCells(img);
    expect(cells).toHaveLength(2);
    // Interiors sit inside the rings (past the 4px border).
    expect(cells[0]!.x).toBeGreaterThanOrEqual(24);
    expect(cells[0]!.x + cells[0]!.w).toBeLessThanOrEqual(116);
    expect(cells[1]!.x).toBeGreaterThanOrEqual(164);
    // Stripping removes the rings entirely.
    const stripped = pipe.stripBorderColor(img);
    const remaining = pipe.detectGreenCells(stripped);
    expect(remaining).toHaveLength(0);
  });

  it('dedupes identical cells via hashing', async () => {
    // Uniform image -> all 24 cells hash the same.
    const uniform = await sharp({
      create: { width: 256, height: 384, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const img = await pipe.loadRaw(uniform);
    const cells = pipe.cutCells(img, { cols: 4, rows: 6 });
    const hashes = await Promise.all(cells.map((c) => pipe.cellHash(c)));
    expect(new Set(hashes).size).toBe(1);
  });
});
