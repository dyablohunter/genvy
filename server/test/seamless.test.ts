import { describe, it, expect } from 'vitest';
import type { RawImage } from '../src/services/imagePipeline.js';
import { makeSeamless, makeSeamlessTile, offsetWrap } from '../src/services/seamless.js';
import { wrapContinuity } from '../src/services/tileGate.js';

const SIZE = 48;

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

const px = (img: RawImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

/** A gradient tile: bright left, dark right — a hard seam when repeated. */
const gradient = () =>
  make((x) => {
    const v = 20 + (x / SIZE) * 200;
    return [v, v * 0.8, 255 - v, 255];
  });

/** Noise with a deterministic pattern, no wrap continuity. */
const patchy = () =>
  make((x, y) => {
    const v = 40 + ((x * 7 + y * 13) % 180);
    return [v, 200 - v, (v * 3) % 255, 255];
  });

describe('offsetWrap', () => {
  it('rolls pixels with wrapping and loses nothing', () => {
    const img = gradient();
    const rolled = offsetWrap(img, 10, 5);
    expect(px(rolled, 10, 5)).toEqual(px(img, 0, 0));
    expect(px(rolled, 0, 0)).toEqual(px(img, SIZE - 10, SIZE - 5));
    // Rolling is a permutation: the same multiset of pixels comes back.
    const sum = (i: RawImage) => i.data.reduce((s, v) => s + v, 0);
    expect(sum(rolled)).toBe(sum(img));
  });
});

describe('makeSeamless', () => {
  it('turns a hard-seamed gradient into a tile that wraps', () => {
    const before = gradient();
    const after = makeSeamless(before);
    expect(wrapContinuity(before)).toBeLessThan(0.3);
    expect(wrapContinuity(after)).toBeGreaterThan(0.85);
  });

  it('helps a busy pattern too, without flattening it', () => {
    const before = patchy();
    const after = makeSeamless(before);
    expect(wrapContinuity(after)).toBeGreaterThan(wrapContinuity(before));
    // Texture survives: the healed tile is not a flat fill.
    const values = new Set<number>();
    for (let x = 0; x < SIZE; x++) values.add(after.data[(10 * SIZE + x) * 4]!);
    expect(values.size).toBeGreaterThan(6);
  });

  it('keeps the tile size and alpha, and is deterministic', () => {
    const a = makeSeamless(gradient());
    const b = makeSeamless(gradient());
    expect(a.width).toBe(SIZE);
    expect(a.height).toBe(SIZE);
    expect(a.data.equals(b.data)).toBe(true);
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
  });

  it('mirror modes make the mirrored axis wrap exactly', () => {
    const src = gradient();
    const h = makeSeamlessTile(src, 'h');
    // Column 0 and column W-1 are the same pixel after a horizontal mirror.
    expect(px(h, 0, 10)).toEqual(px(h, SIZE - 1, 10));
    const v = makeSeamlessTile(src, 'v');
    expect(px(v, 10, 0)).toEqual(px(v, 10, SIZE - 1));
    const both = makeSeamlessTile(patchy(), 'both');
    expect(px(both, 0, 7)).toEqual(px(both, SIZE - 1, 7));
    expect(px(both, 7, 0)).toEqual(px(both, 7, SIZE - 1));
    expect(wrapContinuity(both)).toBeGreaterThan(0.85);
  });

  it('mirror keeps the source half intact (it is a derivation, not a repaint)', () => {
    const src = patchy();
    const h = makeSeamlessTile(src, 'h');
    // The untouched left half outside the healed band still matches the source.
    expect(px(h, 2, 5)).toEqual(px(src, 2, 5));
  });

  it('leaves tiny tiles alone rather than smearing them', () => {
    const tiny: RawImage = { data: Buffer.alloc(4 * 4 * 4, 200), width: 4, height: 4 };
    expect(makeSeamless(tiny)).toBe(tiny);
  });
});
