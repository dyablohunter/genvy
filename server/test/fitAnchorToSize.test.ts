import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ANCHOR_PAD, fitAnchorToSize, contentBox, loadRaw } from '../src/services/imagePipeline.js';

/**
 * An edited anchor comes back from the model as a full 1024x1536 or 1536x1024
 * canvas; it must be re-saved at the size of the anchor it replaces — the
 * longer side matched, the aspect kept, the figure padded like a picked crop.
 */

/** A transparent canvas with one opaque rectangle standing in for the figure. */
async function canvas(w: number, h: number, fig: { x: number; y: number; w: number; h: number }) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = fig.y; y < fig.y + fig.h; y++) {
    for (let x = fig.x; x < fig.x + fig.w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 200;
      data[i + 1] = 40;
      data[i + 2] = 90;
      data[i + 3] = 255;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

describe('fitAnchorToSize', () => {
  it('re-saves a tall model canvas at the replaced anchor height', async () => {
    // Model output: 1024x1536 with a 400x1200 figure; the anchor it replaces is 318x756.
    const png = await canvas(1024, 1536, { x: 312, y: 168, w: 400, h: 1200 });
    const out = await sharp(await fitAnchorToSize(png, { width: 318, height: 756 })).metadata();
    expect(out.height).toBe(756); // longer side matched
    // Aspect of the padded figure: (400 + 2p) / (1200 + 2p), p = 8% of 1200.
    const pad = Math.round(1200 * ANCHOR_PAD);
    expect(out.width).toBe(Math.round((400 + 2 * pad) * (756 / (1200 + 2 * pad))));
  });

  it('matches the WIDTH when the anchor is wider than tall', async () => {
    const png = await canvas(1536, 1024, { x: 168, y: 312, w: 1200, h: 400 });
    const out = await sharp(await fitAnchorToSize(png, { width: 700, height: 300 })).metadata();
    expect(out.width).toBe(700);
    expect(out.height!).toBeLessThan(700);
  });

  it('keeps the figure centred with a margin on every side', async () => {
    const png = await canvas(1024, 1536, { x: 100, y: 50, w: 300, h: 900 }); // off-centre in the canvas
    const raw = await loadRaw(await fitAnchorToSize(png, { width: 300, height: 600 }));
    const box = contentBox(raw)!;
    const left = box.x;
    const right = raw.width - (box.x + box.w);
    const top = box.y;
    const bottom = raw.height - (box.y + box.h);
    for (const margin of [left, right, top, bottom]) expect(margin).toBeGreaterThan(0);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2);
  });

  it('returns the image unchanged when there is no figure to fit', async () => {
    const empty = await sharp({
      create: { width: 64, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await fitAnchorToSize(empty, { width: 32, height: 48 });
    expect(out.equals(empty)).toBe(true);
  });
});
