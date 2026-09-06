import { describe, it, expect } from 'vitest';
import type { RawImage } from '../src/services/imagePipeline.js';
import { equalizeCellHeights } from '../src/services/imagePipeline.js';

const cell = (width: number, height: number): RawImage => {
  const data = Buffer.alloc(width * height * 4, 255);
  return { data, width, height };
};

describe('equalizeCellHeights — independent-frame strips', () => {
  it('scales every cell to the median height, keeping aspect', async () => {
    const out = await equalizeCellHeights([cell(10, 40), cell(12, 60), cell(8, 50)]);
    expect(out.map((c) => c.height)).toEqual([50, 50, 50]);
    // Aspect kept: 10x40 -> 13x50 (rounded), 12x60 -> 10x50.
    expect(out[0]!.width).toBe(13);
    expect(out[1]!.width).toBe(10);
    expect(out[2]!.width).toBe(8); // already median — untouched
  });

  it('leaves near-median and single cells alone', async () => {
    const a = cell(10, 50);
    const b = cell(10, 51); // within 1px — not worth a resample
    const out = await equalizeCellHeights([a, b, cell(10, 50)]);
    expect(out[1]).toBe(b);
    const single = [cell(9, 33)];
    expect(await equalizeCellHeights(single)).toBe(single);
  });
});
