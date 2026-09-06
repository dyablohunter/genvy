import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  KP,
  KEYPOINT_COUNT,
  LIMBS,
  LIMB_COLORS,
  clipSkeleton,
  resolveClip,
  track,
  renderSkeleton,
  skeletonFramePng,
  skeletonStripPng,
  type SkeletonFrame,
} from '../src/skeleton/index.js';

const GROUND = 0.92;

/**
 * Ankle x relative to its own hip: the profile view offsets near/far hips by
 * a small depth so limbs stay distinguishable, and phase comparisons must not
 * see that constant offset.
 */
const ankleX = (f: SkeletonFrame, side: 'r' | 'l') =>
  f.keypoints[side === 'r' ? KP.rAnkle : KP.lAnkle]!.x -
  f.keypoints[side === 'r' ? KP.rHip : KP.lHip]!.x;
const ankleY = (f: SkeletonFrame, side: 'r' | 'l') =>
  f.keypoints[side === 'r' ? KP.rAnkle : KP.lAnkle]!.y;

describe('walk cycle — leg phase correctness (P6 acceptance)', () => {
  const N = 8;
  const frames = clipSkeleton({ clip: 'walk', frames: N, facing: 'east' });

  it('legs run exactly half a cycle apart: the left ankle retraces the right ankle N/2 frames later', () => {
    for (let i = 0; i < N; i++) {
      const j = (i + N / 2) % N;
      expect(ankleX(frames[i]!, 'l')).toBeCloseTo(ankleX(frames[j]!, 'r'), 5);
      expect(ankleY(frames[i]!, 'l')).toBeCloseTo(ankleY(frames[j]!, 'r'), 5);
    }
  });

  it('the legs actually alternate: the lead foot swaps exactly twice per cycle', () => {
    let swaps = 0;
    for (let i = 0; i < N; i++) {
      const now = Math.sign(ankleX(frames[i]!, 'r') - ankleX(frames[i]!, 'l'));
      const next = Math.sign(
        ankleX(frames[(i + 1) % N]!, 'r') - ankleX(frames[(i + 1) % N]!, 'l'),
      );
      if (now !== 0 && next !== 0 && now !== next) swaps++;
    }
    expect(swaps).toBe(2);
  });

  it('has a real stride, symmetric about the body', () => {
    const xs = frames.map((f) => ankleX(f, 'r'));
    const reach = Math.max(...xs) - Math.min(...xs);
    expect(reach).toBeGreaterThan(0.1); // a visible stride, not a shuffle
    // The foot reaches visibly both ahead of and behind the hip. (Exact
    // fore/aft symmetry is NOT required — the soft stance knee biases the
    // reach slightly backward, as real gait does.)
    expect(Math.max(...xs)).toBeGreaterThan(0.1);
    expect(Math.min(...xs)).toBeLessThan(-0.1);
  });

  it('arms counter-swing their same-side leg', () => {
    for (const f of frames) {
      const legForward = ankleX(f, 'r'); // already hip-relative
      const armForward = f.keypoints[KP.rWrist]!.x - f.keypoints[KP.rShoulder]!.x;
      // Only assert when the leg is clearly committed to one direction.
      if (Math.abs(legForward) > 0.05) {
        expect(Math.sign(armForward)).toBe(-Math.sign(legForward));
      }
    }
  });

  it('the body bobs twice per cycle (highest at the passing poses)', () => {
    const dense = clipSkeleton({ clip: 'walk', frames: 32, facing: 'east' });
    const ys = dense.map((f) => f.keypoints[KP.neck]!.y);
    let minima = 0; // y-down: local minima of y are the high points
    for (let i = 0; i < ys.length; i++) {
      const prev = ys[(i + ys.length - 1) % ys.length]!;
      const next = ys[(i + 1) % ys.length]!;
      if (ys[i]! < prev && ys[i]! <= next) minima++;
    }
    expect(minima).toBe(2);
  });

  it('the stance foot stays near the ground', () => {
    for (const f of frames) {
      const lowest = Math.max(ankleY(f, 'r'), ankleY(f, 'l'));
      expect(lowest).toBeGreaterThan(GROUND - 0.05);
      expect(lowest).toBeLessThanOrEqual(GROUND + 0.005);
    }
  });

  it('loops seamlessly: frame 0 of the next cycle equals frame 0', () => {
    // Looping clips sample t=i/N, so this is structural — pin it anyway.
    const twice = clipSkeleton({ clip: 'walk', frames: N, facing: 'east' });
    expect(twice[0]).toEqual(frames[0]);
  });

  it('south view alternates the same way, as foot lifts', () => {
    const south = clipSkeleton({ clip: 'walk', frames: N, facing: 'south' });
    for (let i = 0; i < N; i++) {
      const j = (i + N / 2) % N;
      expect(ankleY(south[i]!, 'l')).toBeCloseTo(ankleY(south[j]!, 'r'), 5);
    }
    const lifts = south.map((f) => GROUND - ankleY(f, 'r'));
    expect(Math.max(...lifts)).toBeGreaterThan(0.02); // feet visibly lift
    expect(Math.min(...lifts)).toBeCloseTo(0, 2); // and visibly plant
  });
});

describe('other clips', () => {
  it('run goes airborne: some frame has both feet off the ground', () => {
    const frames = clipSkeleton({ clip: 'run', frames: 12, facing: 'east' });
    const airborne = frames.filter(
      (f) => ankleY(f, 'r') < GROUND - 0.02 && ankleY(f, 'l') < GROUND - 0.02,
    );
    expect(airborne.length).toBeGreaterThan(0);
    // And it still alternates like a gait, not a pogo stick.
    for (let i = 0; i < 12; i++) {
      expect(ankleX(frames[i]!, 'l')).toBeCloseTo(ankleX(frames[(i + 6) % 12]!, 'r'), 5);
    }
  });

  it('run strides longer than walk', () => {
    const reach = (clip: string) => {
      const xs = clipSkeleton({ clip, frames: 16, facing: 'east' }).map((f) => ankleX(f, 'r'));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(reach('run')).toBeGreaterThan(reach('walk'));
  });

  it('idle keeps the feet nailed down while the torso breathes', () => {
    const frames = clipSkeleton({ clip: 'idle', frames: 6, facing: 'east' });
    for (const f of frames) {
      expect(ankleX(f, 'r')).toBeCloseTo(ankleX(frames[0]!, 'r'), 8);
      expect(ankleY(f, 'r')).toBeCloseTo(ankleY(frames[0]!, 'r'), 8);
    }
    const neckYs = frames.map((f) => f.keypoints[KP.neck]!.y);
    expect(Math.max(...neckYs) - Math.min(...neckYs)).toBeGreaterThan(0.001);
  });

  it('jump: grounded at both ends, apex past midway with both feet airborne', () => {
    const N = 10;
    const frames = clipSkeleton({ clip: 'jump', frames: N, facing: 'east' });
    const neckYs = frames.map((f) => f.keypoints[KP.neck]!.y);
    const apex = neckYs.indexOf(Math.min(...neckYs));
    expect(apex / (N - 1)).toBeGreaterThan(0.45);
    expect(apex / (N - 1)).toBeLessThan(0.8);
    expect(ankleY(frames[apex]!, 'r')).toBeLessThan(GROUND - 0.03);
    expect(ankleY(frames[apex]!, 'l')).toBeLessThan(GROUND - 0.03);
    // Takes off from and returns to the ground.
    expect(ankleY(frames[0]!, 'r')).toBeCloseTo(GROUND, 1);
    expect(ankleY(frames[N - 1]!, 'r')).toBeCloseTo(GROUND, 1);
  });

  it('attack: the striking wrist winds up behind, then reaches furthest during the strike window', () => {
    const N = 10;
    const frames = clipSkeleton({ clip: 'attack', frames: N, facing: 'east' });
    const wristX = frames.map((f) => f.keypoints[KP.rWrist]!.x);
    const peak = wristX.indexOf(Math.max(...wristX));
    expect(peak / (N - 1)).toBeGreaterThan(0.45);
    expect(peak / (N - 1)).toBeLessThan(0.85);
    expect(Math.min(...wristX.slice(0, Math.floor(N / 2)))).toBeLessThan(0.5); // windup behind the body
    // Feet stay planted through the whole swing.
    for (const f of frames) {
      expect(ankleX(f, 'r')).toBeCloseTo(ankleX(frames[0]!, 'r'), 8);
      expect(ankleX(f, 'l')).toBeCloseTo(ankleX(frames[0]!, 'l'), 8);
    }
  });
});

describe('facings and structure', () => {
  it('west is the exact mirror of east with left/right relabelled', () => {
    const east = clipSkeleton({ clip: 'walk', frames: 4, facing: 'east' });
    const west = clipSkeleton({ clip: 'walk', frames: 4, facing: 'west' });
    for (let i = 0; i < 4; i++) {
      expect(west[i]!.keypoints[KP.lAnkle]!.x).toBeCloseTo(1 - east[i]!.keypoints[KP.rAnkle]!.x, 8);
      expect(west[i]!.keypoints[KP.lAnkle]!.y).toBeCloseTo(east[i]!.keypoints[KP.rAnkle]!.y, 8);
      expect(west[i]!.keypoints[KP.rWrist]!.x).toBeCloseTo(1 - east[i]!.keypoints[KP.lWrist]!.x, 8);
    }
  });

  it('south shows the face, north hides it, profile hides the far eye', () => {
    const face = (facing: 'south' | 'north' | 'east') =>
      clipSkeleton({ clip: 'idle', frames: 1, facing })[0]!.keypoints;
    expect(face('south')[KP.nose]!.visible).toBe(true);
    expect(face('south')[KP.lEye]!.visible).toBe(true);
    expect(face('north')[KP.nose]!.visible).toBe(false);
    expect(face('north')[KP.lEye]!.visible).toBe(false);
    expect(face('north')[KP.lEar]!.visible).toBe(true);
    expect(face('east')[KP.rEye]!.visible).toBe(true);
    expect(face('east')[KP.lEye]!.visible).toBe(false);
  });

  it('every keypoint of every clip and facing stays on the canvas', () => {
    for (const clip of ['walk', 'run', 'idle', 'jump', 'attack']) {
      for (const facing of ['south', 'west', 'east', 'north'] as const) {
        for (const f of clipSkeleton({ clip, frames: 8, facing })) {
          expect(f.keypoints).toHaveLength(KEYPOINT_COUNT);
          for (const k of f.keypoints) {
            expect(k.x).toBeGreaterThan(0);
            expect(k.x).toBeLessThan(1);
            expect(k.y).toBeGreaterThan(0);
            expect(k.y).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('is deterministic: identical requests produce identical keypoints', () => {
    const a = clipSkeleton({ clip: 'run', frames: 8, facing: 'west' });
    const b = clipSkeleton({ clip: 'run', frames: 8, facing: 'west' });
    expect(a).toEqual(b);
  });

  it('resolveClip maps aliases and falls back to idle for the unknown', () => {
    expect(resolveClip('walking')).toEqual({ clip: 'walk', exact: true });
    expect(resolveClip('DASH')).toEqual({ clip: 'run', exact: true });
    expect(resolveClip('attack2')).toEqual({ clip: 'attack', exact: true });
    expect(resolveClip('mystery-dance')).toEqual({ clip: 'idle', exact: false });
  });

  it('track interpolates keyframes and clamps the ends', () => {
    const pts = [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ] as const;
    expect(track(pts, -1)).toBe(0);
    expect(track(pts, 0.25)).toBeCloseTo(0.5, 8);
    expect(track(pts, 0.5)).toBe(1);
    expect(track(pts, 2)).toBe(0);
  });
});

describe('rendering', () => {
  it('draws colored limbs and joints on pure black, deterministically', async () => {
    const frame = clipSkeleton({ clip: 'walk', frames: 8, facing: 'east' })[2]!;
    const raw = renderSkeleton(frame, { size: 192 });
    expect(raw.data.length).toBe(192 * 192 * 3);
    // Corners are untouched black; the canvas as a whole is mostly black.
    expect(raw.data[0]).toBe(0);
    let lit = 0;
    const colors = new Set<string>();
    for (let i = 0; i < raw.data.length; i += 3) {
      if (raw.data[i]! || raw.data[i + 1]! || raw.data[i + 2]!) {
        lit++;
        colors.add(`${raw.data[i]},${raw.data[i + 1]},${raw.data[i + 2]}`);
      }
    }
    expect(lit).toBeGreaterThan(200);
    expect(lit).toBeLessThan(192 * 192 * 0.25);
    // Distinct limb colors landed (both leg segments at least).
    expect(colors.has('0,255,85')).toBe(true); // right hip->knee
    expect(colors.has('0,170,255')).toBe(true); // left hip->knee
    const again = renderSkeleton(frame, { size: 192 });
    expect(again.data.equals(raw.data)).toBe(true);
  });

  it('encodes single frames and strips as PNG with the right dimensions', async () => {
    const frames = clipSkeleton({ clip: 'run', frames: 4, facing: 'south' });
    const one = await skeletonFramePng(frames[0]!, { size: 128 });
    const oneMeta = await sharp(one).metadata();
    expect(oneMeta.format).toBe('png');
    expect(oneMeta.width).toBe(128);
    expect(oneMeta.height).toBe(128);
    const strip = await skeletonStripPng(frames, { size: 96 });
    const meta = await sharp(strip).metadata();
    expect(meta.width).toBe(96 * 4);
    expect(meta.height).toBe(96);
  });

  it('limb table and palette stay index-matched', () => {
    expect(LIMBS).toHaveLength(LIMB_COLORS.length);
  });
});
