import { describe, it, expect } from 'vitest';
import type { RawImage } from '../src/services/imagePipeline.js';
import { flipHorizontal } from '../src/services/imagePipeline.js';
import { runAnchorGate } from '../src/services/anchorGate.js';

/** Synthetic RGBA image: painter(x, y) => opaque white pixel. */
function img(width: number, height: number, painter: (x: number, y: number) => boolean): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!painter(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const inRect = (x: number, y: number, rx: number, ry: number, rw: number, rh: number) =>
  x >= rx && x < rx + rw && y >= ry && y < ry + rh;

describe('anchor lock gate', () => {
  it('passes a centered, padded, single-blob figure', () => {
    const report = runAnchorGate(img(100, 100, (x, y) => inRect(x, y, 30, 20, 40, 60)));
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it('fails "uncropped" and "corners" when the figure is cut off at an edge', () => {
    const report = runAnchorGate(img(100, 100, (x, y) => inRect(x, y, 0, 0, 50, 100)));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.pass]));
    expect(byId['uncropped']).toBe(false);
    expect(byId['corners']).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('tolerates a few pixels grazing an edge (only a real run means cut off)', () => {
    const report = runAnchorGate(
      img(100, 100, (x, y) => inRect(x, y, 30, 20, 40, 60) || (y === 0 && x >= 50 && x < 52)),
    );
    expect(report.checks.find((c) => c.id === 'uncropped')?.pass).toBe(true);
  });

  it('fails "singleBlob" for two separate figures of similar size', () => {
    const report = runAnchorGate(
      img(100, 100, (x, y) => inRect(x, y, 10, 30, 25, 40) || inRect(x, y, 60, 30, 25, 40)),
    );
    expect(report.checks.find((c) => c.id === 'singleBlob')?.pass).toBe(false);
  });

  it('tolerates small detached fragments (largest blob still >= 70%)', () => {
    const report = runAnchorGate(
      img(100, 100, (x, y) => inRect(x, y, 30, 20, 40, 60) || inRect(x, y, 80, 80, 4, 4)),
    );
    expect(report.checks.find((c) => c.id === 'singleBlob')?.pass).toBe(true);
  });

  it('fails "content" on a nearly empty image', () => {
    const report = runAnchorGate(img(100, 100, (x, y) => inRect(x, y, 50, 50, 3, 3)));
    expect(report.checks.find((c) => c.id === 'content')?.pass).toBe(false);
  });

  it('fails "centered" when the mass sits far off-center', () => {
    const report = runAnchorGate(img(200, 100, (x, y) => inRect(x, y, 4, 40, 20, 30)));
    expect(report.checks.find((c) => c.id === 'centered')?.pass).toBe(false);
  });
});

describe('flipHorizontal', () => {
  it('mirrors pixels across the vertical axis', () => {
    const src = img(10, 4, (x, y) => x === 2 && y === 1);
    const out = flipHorizontal(src);
    expect(out.data[(1 * 10 + 7) * 4 + 3]).toBe(255); // 2 -> width-1-2 = 7
    expect(out.data[(1 * 10 + 2) * 4 + 3]).toBe(0);
    expect(flipHorizontal(out).data.equals(src.data)).toBe(true); // involution
  });
});
