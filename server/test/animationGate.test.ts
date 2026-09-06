import { describe, it, expect } from 'vitest';
import type { RawImage } from '../src/services/imagePipeline.js';
import { gateAnimationFrames, suggestsAnchorCascade } from '../src/services/animationGate.js';

type Tint = [number, number, number];
const RED: Tint = [200, 60, 60];
const GREEN: Tint = [60, 200, 60];

/**
 * Synthetic figure: a filled rectangle with a darker lower half (so greys have
 * variance for NCC) on a 100x100 transparent canvas.
 */
function rectFigure(rw: number, rh: number, tint: Tint): RawImage {
  const w = 100, h = 100;
  const data = Buffer.alloc(w * h * 4);
  const x0 = Math.floor((w - rw) / 2);
  const y0 = Math.floor((h - rh) / 2);
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4;
      const shade = y > y0 + rh / 2 ? 0.5 : 1;
      data[i] = Math.round(tint[0] * shade);
      data[i + 1] = Math.round(tint[1] * shade);
      data[i + 2] = Math.round(tint[2] * shade);
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Right triangle silhouette; mirror=true flips it so silhouettes truly differ. */
function triangleFigure(mirror: boolean, tint: Tint): RawImage {
  const w = 100, h = 100;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 20; y < 80; y++) {
    const span = Math.floor(((y - 20) / 60) * 50) + 4;
    for (let k = 0; k < span; k++) {
      const x = mirror ? 75 - k : 25 + k;
      const i = (y * w + x) * 4;
      const shade = y > 50 ? 0.5 : 1;
      data[i] = Math.round(tint[0] * shade);
      data[i + 1] = Math.round(tint[1] * shade);
      data[i + 2] = Math.round(tint[2] * shade);
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const anchor = rectFigure(40, 60, RED);

describe('animation gate', () => {
  it('passes identical on-palette frames for a non-locomotion clip', () => {
    const frames = [1, 2, 3, 4].map(() => rectFigure(40, 60, RED));
    const report = gateAnimationFrames(frames, anchor, { expectedFrames: 4, locomotion: false });
    expect(report.frames.every((f) => f.errors.length === 0)).toBe(true);
    expect(report.pass).toBe(true);
  });

  it('fails a locomotion clip whose frames are all identical (reads static)', () => {
    const frames = [1, 2, 3, 4].map(() => rectFigure(40, 60, RED));
    const report = gateAnimationFrames(frames, anchor, { expectedFrames: 4, locomotion: true });
    expect(report.staticPairs.length).toBe(3);
    expect(report.pass).toBe(false);
    expect(report.hints.join(' ')).toMatch(/static|identical/i);
  });

  it('flags palette drift when frames abandon the anchor colors', () => {
    const frames = [1, 2, 3, 4].map(() => rectFigure(40, 60, GREEN));
    const report = gateAnimationFrames(frames, anchor, { expectedFrames: 4, locomotion: false });
    expect(report.frames.every((f) => f.errors.some((e) => e.includes('palette')))).toBe(true);
    expect(report.pass).toBe(false);
    expect(report.hints.join(' ')).toMatch(/palette/i);
    expect(suggestsAnchorCascade(report)).toBe(true);
  });

  it('penalizes a frame-count mismatch', () => {
    const frames = [1, 2, 3].map(() => rectFigure(40, 60, RED));
    const report = gateAnimationFrames(frames, anchor, { expectedFrames: 4, locomotion: false });
    expect(report.score).toBeLessThan(90);
    expect(report.hints.join(' ')).toMatch(/3 frames instead of 4/);
  });

  it('sees real motion in alternating silhouettes (no static pairs)', () => {
    const frames = [false, true, false, true].map((m) => triangleFigure(m, RED));
    const report = gateAnimationFrames(frames, anchor, { expectedFrames: 4, locomotion: true });
    expect(report.staticPairs.length).toBe(0);
  });

  /** Torso + two leg columns at ±spread/2 — a crude side-view walker. */
  function walker(spread: number): RawImage {
    const w = 100, h = 100;
    const data = Buffer.alloc(w * h * 4);
    const put = (x: number, y: number, shade: number) => {
      const i = (y * w + x) * 4;
      data[i] = Math.round(RED[0] * shade);
      data[i + 1] = Math.round(RED[1] * shade);
      data[i + 2] = Math.round(RED[2] * shade);
      data[i + 3] = 255;
    };
    for (let y = 20; y < 60; y++) for (let x = 40; x < 60; x++) put(x, y, 1);
    for (const cx of [50 - spread / 2, 50 + spread / 2]) {
      for (let y = 60; y < 80; y++) {
        for (let x = Math.round(cx) - 3; x <= Math.round(cx) + 3; x++) put(x, y, 0.8);
      }
    }
    return { data, width: w, height: h };
  }

  it('detects a wholesale-mirrored sheet', () => {
    const triAnchor = triangleFigure(false, RED);
    const mirroredFrames = [1, 2, 3, 4].map(() => triangleFigure(true, RED));
    const report = gateAnimationFrames(mirroredFrames, triAnchor, {
      expectedFrames: 4,
      locomotion: false,
    });
    expect(report.hints.join(' ')).toMatch(/mirrored/i);
    const faithful = gateAnimationFrames(
      [1, 2, 3, 4].map(() => triangleFigure(false, RED)),
      triAnchor,
      { expectedFrames: 4, locomotion: false },
    );
    expect(faithful.hints.join(' ')).not.toMatch(/mirrored/i);
  });

  it('stride check: constant mid-stride poses fail, alternating contact/pass passes', () => {
    const flat = gateAnimationFrames(
      [24, 24, 24, 24].map(walker),
      anchor,
      { expectedFrames: 4, locomotion: true },
    );
    expect(flat.hints.join(' ')).toMatch(/same phase in every frame/i);

    const gait = gateAnimationFrames(
      [40, 8, 40, 8].map(walker),
      anchor,
      { expectedFrames: 4, locomotion: true },
    );
    expect(gait.hints.join(' ')).not.toMatch(/same phase in every frame/i);
  });
});
