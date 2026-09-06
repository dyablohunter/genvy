import { describe, it, expect } from 'vitest';
import type { RawImage } from '../src/services/imagePipeline.js';
import {
  registerCells,
  footCentroidX,
  contentBox,
  replaceRegion,
  rotateImage,
  rotateAboutPivot,
  flipHorizontal,
} from '../src/services/imagePipeline.js';
import { deriveOp, getSubject } from '@genvy/shared';

/**
 * A "pose": a body column plus an optional outstretched arm. The feet stay at
 * a fixed x so registration must keep the body still while the arm reaches.
 */
function pose(opts: {
  footX: number;
  armReach?: number; // +right / -left, 0 = none
  height?: number;
  canvas?: number;
}): RawImage {
  const size = opts.canvas ?? 80;
  const h = opts.height ?? 40;
  const data = Buffer.alloc(size * size * 4);
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = 200;
    data[i + 1] = 80;
    data[i + 2] = 80;
    data[i + 3] = 255;
  };
  const bottom = size - 10;
  // Body: 6px wide column centred on footX.
  for (let y = bottom - h; y <= bottom; y++) {
    for (let x = opts.footX - 3; x <= opts.footX + 3; x++) put(x, y);
  }
  // Arm: a horizontal bar near the top of the body.
  if (opts.armReach) {
    const y = bottom - h + 4;
    const step = opts.armReach > 0 ? 1 : -1;
    for (let k = 0; k !== opts.armReach; k += step) {
      put(opts.footX + k, y);
      put(opts.footX + k, y + 1);
    }
  }
  return { data, width: size, height: size };
}

/** Column of the body's centre of mass in the upper half (where the torso is). */
function torsoCentreX(img: RawImage): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height / 2; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 8) {
        sum += x;
        n++;
      }
    }
  }
  return n > 0 ? sum / n : 0;
}

describe('frame registration', () => {
  it('footCentroidX tracks the feet, not the outstretched arm', () => {
    const img = pose({ footX: 40, armReach: 20 });
    const box = contentBox(img)!;
    // The bbox centre is dragged right by the arm; the foot centroid is not.
    expect(box.x + box.w / 2).toBeGreaterThan(45);
    expect(footCentroidX(img, box)).toBeCloseTo(40, 0);
  });

  it('keeps the body still across frames whose limbs reach different ways', () => {
    const frames = [
      pose({ footX: 40 }),
      pose({ footX: 40, armReach: 18 }),
      pose({ footX: 40, armReach: -18 }),
    ];
    const registered = registerCells(frames);
    const centres = registered.map(torsoCentreX);
    for (const c of centres) expect(Math.abs(c - centres[0]!)).toBeLessThanOrEqual(2);
  });

  it('shares one foot baseline and crops the canvas to the tallest body', () => {
    const registered = registerCells([
      pose({ footX: 40, height: 40 }),
      pose({ footX: 40, height: 30 }),
    ]);
    // Canvas height == tallest content height, so frameHeight IS body height.
    expect(registered[0]!.height).toBe(41);
    const bottomRowOpaque = (img: RawImage) => {
      const y = img.height - 1;
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3]! > 8) return true;
      }
      return false;
    };
    // Both frames touch the bottom row: they stand on the same ground line.
    expect(registered.every(bottomRowOpaque)).toBe(true);
  });

  it('replaceRegion swaps one frame in place, leaving its neighbours untouched', () => {
    // A "sheet": two poses side by side on one canvas.
    const sheet: RawImage = { data: Buffer.alloc(160 * 80 * 4), width: 160, height: 80 };
    const paint = (x0: number, tint: number) => {
      for (let y = 30; y < 70; y++) {
        for (let x = x0; x < x0 + 20; x++) {
          const i = (y * 160 + x) * 4;
          sheet.data[i] = tint;
          sheet.data[i + 3] = 255;
        }
      }
    };
    paint(20, 100); // frame 0
    paint(100, 200); // frame 1

    const replacement = pose({ footX: 40, height: 30, canvas: 60 });
    const cut = (() => {
      const b = contentBox(replacement)!;
      const out = Buffer.alloc(b.w * b.h * 4);
      for (let y = 0; y < b.h; y++) {
        const src = ((b.y + y) * replacement.width + b.x) * 4;
        replacement.data.copy(out, y * b.w * 4, src, src + b.w * 4);
      }
      return { data: out, width: b.w, height: b.h };
    })();

    const patched = replaceRegion(sheet, { x: 0, y: 0, w: 80, h: 80 }, cut);
    // Frame 1's pixels survive verbatim...
    const untouched = (img: RawImage) => img.data[(50 * 160 + 110) * 4 + 3];
    expect(untouched(patched)).toBe(255);
    expect(patched.data[(50 * 160 + 110) * 4]).toBe(200);
    // ...while frame 0's slot now holds the replacement, standing on the
    // slot's ground line rather than the old pose's.
    const left = contentBox({
      data: Buffer.from(patched.data),
      width: patched.width,
      height: patched.height,
    })!;
    expect(left.x).toBeLessThan(80);
    const bottomRow = 79;
    let opaqueOnGround = 0;
    for (let x = 0; x < 80; x++) {
      if (patched.data[(bottomRow * 160 + x) * 4 + 3]! > 8) opaqueOnGround++;
    }
    expect(opaqueOnGround).toBeGreaterThan(0);
  });

  it('derives a side view into the other facings for free', async () => {
    // A wide "gun": clearly asymmetric so a rotation is visible in the size.
    const side = pose({ footX: 40, height: 12, canvas: 80 });
    const rotated = await rotateImage(side, 90);
    expect(rotated.width).toBe(side.height);
    expect(rotated.height).toBe(side.width);
    // Mirroring twice is identity, so west->east->west round-trips exactly.
    expect(flipHorizontal(flipHorizontal(side)).data.equals(side.data)).toBe(true);
  });

  it('reaches a mirrored facing from a rotated one without flipping it over', () => {
    // The bug this pins: deriving WEST from the NORTH view as a pure rotation
    // composes into a 180 turn from east — barrel left, but grip up.
    const op = deriveOp('north', 'west')!;
    expect(op.mirror).toBe(true); // handedness differs, so a mirror is required
    expect(op.degrees).toBe(270);
    // Round trips stay consistent in both directions.
    expect(deriveOp('west', 'north')).toEqual({ from: 'west', mirror: true, degrees: 270 });
    expect(deriveOp('north', 'south')).toEqual({ from: 'north', mirror: false, degrees: 180 });
  });

  it('rotates about the pivot, not the bounding-box centre', async () => {
    // A bar with its "grip" at the far left: rotating about the centre and
    // about the grip land the grip in different places.
    const bar: RawImage = { data: Buffer.alloc(80 * 80 * 4), width: 80, height: 80 };
    for (let y = 38; y < 42; y++) {
      for (let x = 10; x < 70; x++) {
        const i = (y * 80 + x) * 4;
        bar.data[i] = 200;
        bar.data[i + 3] = 255;
      }
    }
    const grip = { x: 10 / 80, y: 40 / 80 };
    const turned = await rotateAboutPivot(bar, 90, grip);
    // The result is still the same bar, now vertical...
    expect(turned.img.height).toBeGreaterThan(turned.img.width);
    // ...and the pivot travelled with it, staying on the bar itself.
    expect(turned.pivot.x).toBeGreaterThanOrEqual(0);
    expect(turned.pivot.x).toBeLessThanOrEqual(1);
    expect(turned.pivot.y).toBeGreaterThanOrEqual(0);
    expect(turned.pivot.y).toBeLessThanOrEqual(1);
    // Rotating about the grip keeps it at an END of the vertical bar, whereas
    // a centre rotation would put it in the middle.
    expect(Math.min(turned.pivot.y, 1 - turned.pivot.y)).toBeLessThan(0.25);
  });

  it('a weapon gets every facing without generating anything', () => {
    const weapon = getSubject('weapon');
    expect(weapon.primaryView).toBe('east');
    expect(weapon.derivation).toBe('derive');
    // West is a MIRROR, never a 180 turn — that would hang the gun upside down.
    expect(deriveOp('east', 'west')).toEqual({ from: 'east', mirror: true, degrees: 0 });
    // Aiming up/down are quarter turns of the same drawing.
    expect(deriveOp('east', 'north')).toEqual({ from: 'east', mirror: false, degrees: 270 });
    expect(deriveOp('east', 'south')).toEqual({ from: 'east', mirror: false, degrees: 90 });
    // A character's back is a different picture — never derived.
    expect(getSubject('character').derivation).toBe('generate');
  });

  it('keeps one ground line and one body centre ACROSS clips (master sheet)', () => {
    // Frames from two different clips, drawn at different sizes and with
    // limbs reaching opposite ways — what compose-sheet gets handed. Bbox
    // centering would slide the bodies apart; registration must not.
    const idle = [pose({ footX: 40, height: 40 }), pose({ footX: 40, height: 40, armReach: 16 })];
    const walk = [pose({ footX: 30, height: 38, armReach: -20 }), pose({ footX: 52, height: 38 })];
    const registered = registerCells([...idle, ...walk]);

    const w = registered[0]!.width;
    const h = registered[0]!.height;
    expect(registered.every((c) => c.width === w && c.height === h)).toBe(true);

    // Measure where registration actually aligns: the feet. (A torso metric
    // would include the outstretched arms and report their reach as drift.)
    const footCentre = (img: RawImage) => footCentroidX(img, contentBox(img)!);
    const feet = registered.map(footCentre);
    for (const f of feet) expect(Math.abs(f - feet[0]!)).toBeLessThanOrEqual(1);

    const standsOnGround = (img: RawImage) => {
      const y = img.height - 1;
      for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3]! > 8) return true;
      return false;
    };
    expect(registered.every(standsOnGround)).toBe(true);
  });

  it('produces uniform frames and tolerates an empty frame', () => {
    const registered = registerCells([
      pose({ footX: 30, armReach: 12 }),
      { data: Buffer.alloc(80 * 80 * 4), width: 80, height: 80 },
      pose({ footX: 55 }),
    ]);
    const w = registered[0]!.width;
    const h = registered[0]!.height;
    expect(registered.every((c) => c.width === w && c.height === h)).toBe(true);
    expect(contentBox(registered[1]!)).toBeNull();
  });
});
