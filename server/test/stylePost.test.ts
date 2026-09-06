import { describe, it, expect } from 'vitest';
import { stylePresets } from '@genvy/shared';
import type { RawImage } from '../src/services/imagePipeline.js';
import {
  applyStylePost,
  buildPalette,
  quantizeToPalette,
  hardenAlpha,
  cleanOutline,
} from '../src/services/stylePost.js';

function blank(size = 16): RawImage {
  return { data: Buffer.alloc(size * size * 4), width: size, height: size };
}

function put(img: RawImage, x: number, y: number, rgba: [number, number, number, number]) {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgba[0];
  img.data[i + 1] = rgba[1];
  img.data[i + 2] = rgba[2];
  img.data[i + 3] = rgba[3];
}

function distinctOpaqueColors(img: RawImage): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! >= 128) {
      seen.add((img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!);
    }
  }
  return seen;
}

describe('style post-processing', () => {
  it('quantize collapses near-identical shades into one palette entry', () => {
    // A gradient of 64 slightly different reds — classic AI color noise.
    const img = blank(16);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        put(img, x, y, [180 + ((y * 8 + x) % 64), 40, 40, 255]);
      }
    }
    const palette = buildPalette([img], 4);
    expect(palette.length).toBeLessThanOrEqual(4);
    const out = quantizeToPalette(img, palette);
    expect(distinctOpaqueColors(out).size).toBeLessThanOrEqual(4);
  });

  it('shares ONE palette across all frames of a clip', () => {
    // Two frames whose reds differ slightly; a per-frame palette would keep
    // them different, the shared palette makes them identical.
    const a = blank(8);
    const b = blank(8);
    for (let x = 0; x < 4; x++) {
      put(a, x, 0, [30, 40, 200, 255]); // identical blue armor in both frames
      put(b, x, 0, [30, 40, 200, 255]);
      put(a, x, 4, [200, 50, 50, 255]); // red cape, drifted slightly in frame b
      put(b, x, 4, [204, 52, 51, 255]);
    }
    const palette = buildPalette([a, b], 2);
    const qa = quantizeToPalette(a, palette);
    const qb = quantizeToPalette(b, palette);
    // Both frames collapse to the SAME two colors — the drift is gone.
    expect(distinctOpaqueColors(qa)).toEqual(distinctOpaqueColors(qb));
    expect(distinctOpaqueColors(qa).size).toBe(2);
  });

  it('pixelSnap hardens every alpha value to 0 or 255', () => {
    const img = blank(8);
    put(img, 1, 1, [10, 20, 30, 90]); // AA fringe -> gone
    put(img, 2, 2, [10, 20, 30, 200]); // mostly solid -> fully solid
    const out = hardenAlpha(img);
    expect(out.data[(1 * 8 + 1) * 4 + 3]).toBe(0);
    expect(out.data[(2 * 8 + 2) * 4 + 3]).toBe(255);
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i] === 0 || out.data[i] === 255).toBe(true);
    }
  });

  it('outlineClean removes stray specks and fills 1px holes', () => {
    const img = blank(8);
    // A 3x3 solid block with its centre punched out (a hole)...
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) put(img, x, y, [90, 90, 90, 255]);
    put(img, 3, 3, [0, 0, 0, 0]);
    // ...and a lone speck far away.
    put(img, 7, 7, [200, 0, 0, 255]);
    const out = cleanOutline(img);
    expect(out.data[(3 * 8 + 3) * 4 + 3]).toBe(255); // hole filled
    expect(out.data[(7 * 8 + 7) * 4 + 3]).toBe(0); // speck gone
  });

  it('applyStylePost is a no-op for styles without postSteps', () => {
    const img = blank(8);
    put(img, 1, 1, [10, 20, 30, 90]);
    const out = applyStylePost([img], stylePresets['painterly']);
    expect(out[0]).toBe(img); // pass-through, not even a copy
    expect(applyStylePost([img], undefined)[0]).toBe(img);
  });

  it('pixel-16bit runs the full stack and produces hard, quantized frames', () => {
    const img = blank(16);
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) {
        put(img, x, y, [100 + x * 3, 60, 200 - y * 2, y === 4 ? 100 : 255]);
      }
    }
    const [out] = applyStylePost([img], stylePresets['pixel-16bit']);
    for (let i = 3; i < out!.data.length; i += 4) {
      expect(out!.data[i] === 0 || out!.data[i] === 255).toBe(true);
    }
    expect(distinctOpaqueColors(out!).size).toBeLessThanOrEqual(32);
  });
});
