import { describe, it, expect } from 'vitest';
import { mirror, composeStrip } from '../src/services/sceneStrip.js';
import type { RawImage } from '../src/services/imagePipeline.js';

/**
 * Strip geometry has to be exact: these buffers are what an image model is
 * shown. A panel mirrored on screen but not in the bytes means the model
 * edits a picture the user is not looking at.
 */

/** An image whose every pixel encodes its own coordinates, so moves show up. */
const probe = (w: number, h: number, tag = 0): RawImage => {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = tag;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
};

const at = (img: RawImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

describe('mirror', () => {
  it('flips horizontally without touching rows', () => {
    const out = mirror(probe(4, 3), true, false);
    expect(at(out, 0, 1)).toEqual([3, 1, 0]);
    expect(at(out, 3, 1)).toEqual([0, 1, 0]);
  });

  it('flips vertically without touching columns', () => {
    const out = mirror(probe(4, 3), false, true);
    expect(at(out, 1, 0)).toEqual([1, 2, 0]);
    expect(at(out, 1, 2)).toEqual([1, 0, 0]);
  });

  it('flips both axes together', () => {
    const out = mirror(probe(4, 3), true, true);
    expect(at(out, 0, 0)).toEqual([3, 2, 0]);
  });

  it('copies rather than aliasing when nothing is flipped', () => {
    const src = probe(2, 2);
    const out = mirror(src, false, false);
    expect(out.data).toEqual(src.data);
    expect(out.data).not.toBe(src.data);
  });
});

describe('composeStrip', () => {
  it('lays panels along the travel axis in order', () => {
    const strip = composeStrip([probe(4, 3, 1), probe(4, 3, 2)], 'horizontal');
    expect(strip.width).toBe(8);
    expect(strip.height).toBe(3);
    expect(at(strip, 0, 0)[2]).toBe(1); // first panel
    expect(at(strip, 4, 0)[2]).toBe(2); // second starts where the first ends
  });

  it('stacks panels for a vertical strip', () => {
    const strip = composeStrip([probe(4, 3, 1), probe(4, 3, 2)], 'vertical');
    expect(strip.width).toBe(4);
    expect(strip.height).toBe(6);
    expect(at(strip, 0, 3)[2]).toBe(2);
  });

  it('applies each panel’s own mirroring as it places it', () => {
    const strip = composeStrip(
      [
        { ...probe(4, 3, 1), flipX: false },
        { ...probe(4, 3, 2), flipX: true },
      ],
      'horizontal',
    );
    // The mirrored panel starts at its own far edge.
    expect(at(strip, 4, 0)[0]).toBe(3);
    expect(at(strip, 7, 0)[0]).toBe(0);
    // The unmirrored one is untouched.
    expect(at(strip, 0, 0)[0]).toBe(0);
  });

  it('refuses an empty strip rather than inventing a canvas', () => {
    expect(() => composeStrip([], 'horizontal')).toThrow();
  });
});
