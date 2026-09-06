import type { RawImage } from './imagePipeline.js';
import { contentBox, flipHorizontal } from './imagePipeline.js';
import { runAnchorGate } from './anchorGate.js';

/**
 * Animation validation gates — Sprite Pipeline v2 §C4/E2. Cheap deterministic
 * CPU checks after every sheet generation: frame validity, identity drift vs
 * the accepted anchor, motion presence. Failures produce prompt-ready
 * correction hints for the bounded retry loop ("one repair attempt, then
 * publish best").
 *
 * All comparisons run on content-cropped, fixed-size resamples so sheet cell
 * size and anchor resolution don't skew the metrics.
 */

export interface AnimationFrameCheck {
  index: number;
  /** Hard failures (each costs 13 score points). */
  errors: string[];
  /** Soft flags (each costs 3 score points). */
  warnings: string[];
  identity: { histChi2: number; ncc: number; dhash: number };
}

export interface AnimationGateReport {
  score: number;
  pass: boolean;
  frameCount: number;
  expectedFrames: number;
  frames: AnimationFrameCheck[];
  /** Adjacent pairs [i, i+1] that read as static / near-duplicates. */
  staticPairs: number[];
  nearDuplicatePairs: number[];
  /** Frames with at least one error — the HUD colors these. */
  failedFrames: number[];
  /** Natural-language, prompt-ready correction hints for the retry pass. */
  hints: string[];
}

// E2 thresholds
const HIST_CHI2_FAIL = 1.2;
// NCC compares action poses against the NEUTRAL anchor, so legitimate wide
// stances score low: only a severe miss is an error, 0.5-0.7 is a warning.
const NCC_ERROR = 0.5;
const NCC_FAIL = 0.7;
// dHash compares silhouettes against the NEUTRAL anchor too — action poses
// legitimately reshape the outline, so only a deep miss is worth flagging.
const DHASH_WARN = 0.4;
const DHASH_FAIL = 0.55;
const IOU_STATIC = 0.92;
const NEAR_DUP_SIMILARITY = 0.99;
const CENTROID_DRIFT_PX = 8; // at 256 logical
const PASS_SCORE = 90;
const ALPHA_ON = 30;

// ---------------------------------------------------------------------------
// Fixed-size resampling (sync nearest-neighbor over the alpha content box)
// ---------------------------------------------------------------------------

/** Nearest-neighbor sample of the image's content box into w*h RGBA-ish planes. */
function sampleContent(img: RawImage, w: number, h: number): { grey: Float32Array; alpha: Uint8Array; rgb: Uint8Array } {
  const box = contentBox(img) ?? { x: 0, y: 0, w: img.width, h: img.height };
  const grey = new Float32Array(w * h);
  const alpha = new Uint8Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = box.y + Math.min(box.h - 1, Math.floor(((y + 0.5) / h) * box.h));
    for (let x = 0; x < w; x++) {
      const sx = box.x + Math.min(box.w - 1, Math.floor(((x + 0.5) / w) * box.w));
      const i = (sy * img.width + sx) * 4;
      const o = y * w + x;
      const a = img.data[i + 3]!;
      alpha[o] = a;
      if (a >= ALPHA_ON) {
        rgb[o * 3] = img.data[i]!;
        rgb[o * 3 + 1] = img.data[i + 1]!;
        rgb[o * 3 + 2] = img.data[i + 2]!;
        grey[o] = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
      }
    }
  }
  return { grey, alpha, rgb };
}

/** Normalized 4096-bin joint RGB histogram (16 bins/channel) over opaque pixels. */
export function colorHistogram(img: RawImage): Float32Array {
  const { alpha, rgb } = sampleContent(img, 64, 64);
  const hist = new Float32Array(4096);
  let n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! < ALPHA_ON) continue;
    const r = rgb[i * 3]! >> 4;
    const g = rgb[i * 3 + 1]! >> 4;
    const b = rgb[i * 3 + 2]! >> 4;
    hist[(r << 8) | (g << 4) | b]!++;
    n++;
  }
  if (n > 0) for (let i = 0; i < hist.length; i++) hist[i]! /= n;
  return hist;
}

export function chiSquared(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const s = a[i]! + b[i]!;
    if (s > 0) sum += ((a[i]! - b[i]!) * (a[i]! - b[i]!)) / s;
  }
  return sum;
}

/** Normalized cross-correlation of 32x32 content-cropped greys. */
export function nccVsAnchor(frame: RawImage, anchor: RawImage): number {
  const a = sampleContent(frame, 32, 32).grey;
  const b = sampleContent(anchor, 32, 32).grey;
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= a.length;
  mb /= b.length;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    dot += da * db;
    na += da * da;
    nb += db * db;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 64-bit dHash over the alpha silhouette (9x8 grid, horizontal gradient). */
export function silhouetteDHash(img: RawImage): Uint8Array {
  const { alpha } = sampleContent(img, 9, 8);
  const bits = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits[y * 8 + x] = alpha[y * 9 + x]! > alpha[y * 9 + x + 1]! ? 1 : 0;
    }
  }
  return bits;
}

export function dhashSimilarity(a: Uint8Array, b: Uint8Array): number {
  let same = 0;
  for (let i = 0; i < 64; i++) if (a[i] === b[i]) same++;
  return same / 64;
}

/** Silhouette IoU on 64x64 content-cropped binary alpha. */
export function silhouetteIoU(a: RawImage, b: RawImage): number {
  const sa = sampleContent(a, 64, 64).alpha;
  const sb = sampleContent(b, 64, 64).alpha;
  let inter = 0, union = 0;
  for (let i = 0; i < sa.length; i++) {
    const pa = sa[i]! >= ALPHA_ON;
    const pb = sb[i]! >= ALPHA_ON;
    if (pa && pb) inter++;
    if (pa || pb) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * Foot spread: horizontal alpha extent of the bottom 20% band (0..64 on the
 * content-cropped sample). A real gait alternates wide contact stances and
 * narrow passing stances; one repeated mid-stride pose keeps this constant.
 */
export function footSpread(img: RawImage): number {
  const { alpha } = sampleContent(img, 64, 64);
  let minX = 64, maxX = -1;
  for (let y = 51; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (alpha[y * 64 + x]! < ALPHA_ON) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return maxX < 0 ? 0 : maxX - minX + 1;
}

/**
 * Mean luminance of the foremost foot region (bottom band, outermost 20% of
 * columns on the given side). With the NEAR/FAR limb contract (FAR limbs
 * 20-30% darker), a real cycle alternates which leg leads, so this value
 * swings across frames; a single re-posed leg keeps it flat.
 */
export function leadFootShade(img: RawImage, side: 'left' | 'right'): number {
  const { alpha, grey } = sampleContent(img, 64, 64);
  const cols = side === 'right' ? [51, 64] : [0, 13];
  let sum = 0, n = 0;
  for (let y = 51; y < 64; y++) {
    for (let x = cols[0]!; x < cols[1]!; x++) {
      const i = y * 64 + x;
      if (alpha[i]! < ALPHA_ON) continue;
      sum += grey[i]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

function centroidAt256(img: RawImage): { x: number; y: number } {
  let sx = 0, sy = 0, n = 0;
  for (let p = 0; p < img.width * img.height; p++) {
    if (img.data[p * 4 + 3]! < ALPHA_ON) continue;
    sx += p % img.width;
    sy += (p / img.width) | 0;
    n++;
  }
  if (n === 0) return { x: 128, y: 128 };
  return { x: ((sx / n) * 256) / img.width, y: ((sy / n) * 256) / img.height };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function gateAnimationFrames(
  frames: RawImage[],
  anchor: RawImage,
  opts: { expectedFrames: number; locomotion: boolean },
): AnimationGateReport {
  const anchorHist = colorHistogram(anchor);
  const checks: AnimationFrameCheck[] = [];
  const staticPairs: number[] = [];
  const nearDuplicatePairs: number[] = [];
  const hintSet = new Set<string>();

  const hashes = frames.map(silhouetteDHash);

  frames.forEach((frame, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Frame validity (reuses the anchor gate's corner/content/blob/centroid checks).
    const validity = runAnchorGate(frame);
    for (const c of validity.checks) {
      // A tight sprite cell legitimately touches its own crop edges.
      if (c.id === 'uncropped' || c.id === 'corners') continue;
      if (!c.pass) errors.push(`${c.id}: ${c.detail}`);
    }

    // Identity drift vs the anchor.
    const histChi2 = chiSquared(colorHistogram(frame), anchorHist);
    const ncc = nccVsAnchor(frame, anchor);
    const dhash = dhashSimilarity(hashes[i]!, silhouetteDHash(anchor));
    if (histChi2 > HIST_CHI2_FAIL) {
      errors.push(`palette drift (chi2 ${histChi2.toFixed(2)} > ${HIST_CHI2_FAIL})`);
      hintSet.add(
        'Frame-to-frame color identity drift was detected. Copy the accepted anchor palette, ' +
          'outfit colors, hair color, face markings, and outline weight in every pose.',
      );
    }
    if (ncc < NCC_ERROR) {
      errors.push(`structure drift (ncc ${ncc.toFixed(2)} < ${NCC_ERROR})`);
      hintSet.add(
        'Some poses drift from the reference character structure. Redraw every frame as the ' +
          'EXACT same character with the same proportions and detail level; do not redesign.',
      );
    } else if (ncc < NCC_FAIL) {
      warnings.push(`mild structure drift (ncc ${ncc.toFixed(2)} < ${NCC_FAIL})`);
    }
    if (dhash < DHASH_WARN) {
      warnings.push(`silhouette drift (dhash ${dhash.toFixed(2)} < ${DHASH_WARN})`);
      hintSet.add(
        'Keep every pose recognizably the same silhouette as the reference; prefer subtler ' +
          'motion over any change that mutates the character identity.',
      );
    }
    if (errors.some((e) => e.startsWith('singleBlob'))) {
      hintSet.add(
        'Some frame slots contain multiple figures or detached fragments. Draw exactly ONE ' +
          'connected character per slot with no loose effects.',
      );
    }

    checks.push({ index: i, errors, warnings, identity: { histChi2, ncc, dhash } });
  });

  // Motion presence + near-duplicates + centroid drift on adjacent pairs.
  for (let i = 0; i + 1 < frames.length; i++) {
    const iou = silhouetteIoU(frames[i]!, frames[i + 1]!);
    const sim = dhashSimilarity(hashes[i]!, hashes[i + 1]!);
    if (opts.locomotion && iou > IOU_STATIC) staticPairs.push(i);
    if (sim > NEAR_DUP_SIMILARITY && iou > IOU_STATIC) {
      nearDuplicatePairs.push(i);
      checks[i + 1]!.warnings.push(`near-duplicate of frame ${i + 1}`);
    }
    const ca = centroidAt256(frames[i]!);
    const cb = centroidAt256(frames[i + 1]!);
    const drift = Math.hypot(ca.x - cb.x, ca.y - cb.y);
    if (drift > CENTROID_DRIFT_PX * 4) {
      checks[i + 1]!.warnings.push(`large centroid jump (${drift.toFixed(0)}px @256)`);
    }
  }
  // Mirror detection: models default to right-facing and often flip a
  // left-facing reference wholesale. If frames match the FLIPPED anchor much
  // better than the anchor itself, the whole sheet is mirrored.
  let mirrored = false;
  if (frames.length > 0) {
    const flipped = flipHorizontal(anchor);
    const mean = (ref: RawImage) =>
      frames.reduce((s, f) => s + nccVsAnchor(f, ref), 0) / frames.length;
    if (mean(flipped) - mean(anchor) > 0.15) {
      mirrored = true;
      hintSet.add(
        'The whole sheet is MIRRORED relative to the reference. Keep the character facing the ' +
          'SAME direction as the reference image in every frame; never flip or turn it around.',
      );
    }
  }

  // Stride alternation (locomotion): the bottom-band foot spread must swing
  // between wide contact stances and narrow passing stances. This is the
  // check that catches "same mid-stride pose in every frame, only the arms
  // move" — which silhouette IoU alone reads as motion.
  let strideOk = true;
  if (opts.locomotion && frames.length >= 4) {
    const spreads = frames.map(footSpread);
    const min = Math.min(...spreads);
    const max = Math.max(...spreads);
    strideOk = max - min >= 64 * 0.14;
    if (!strideOk) {
      hintSet.add(
        'The legs are in the SAME phase in every frame — the walk reads as one pose. Show ' +
          'exactly two wide split stances per cycle (half a cycle apart, alternating which leg ' +
          'leads, feet far apart) and passing frames between them with the feet close together ' +
          'under the body.',
      );
    }
  }

  // Leg-swap check (locomotion): with FAR limbs rendered darker, the leading
  // foot's shade must alternate across the cycle. Flat shade = the same leg
  // always leads (soft penalty — stylized sheets may ignore the darkening).
  let legSwapOk = true;
  if (opts.locomotion && frames.length >= 4) {
    const range = (side: 'left' | 'right') => {
      const shades = frames.map((f) => leadFootShade(f, side)).filter((s) => s > 0);
      return shades.length >= 2 ? Math.max(...shades) - Math.min(...shades) : 0;
    };
    legSwapOk = Math.max(range('left'), range('right')) >= 15;
    if (!legSwapOk) {
      hintSet.add(
        'The SAME leg leads in every frame. Alternate which leg is forward across the cycle, ' +
          'and render the FAR leg and FAR arm 20-30% darker than the NEAR ones in every frame ' +
          'so the leg swap stays readable.',
      );
    }
  }

  const noMotion = opts.locomotion && frames.length > 1 && staticPairs.length >= frames.length - 1;
  if (noMotion) {
    hintSet.add(
      'Adjacent frames are nearly identical, so the animation reads as a static pose. ' +
        'Increase pose-to-pose movement: alternating leg contacts, arm counter-swing, torso ' +
        'lean, and body-height changes across the cycle.',
    );
  }
  if (nearDuplicatePairs.length > 0) {
    hintSet.add('Do not repeat the same pose in consecutive frames; every frame advances the motion.');
  }

  // Row score (E2).
  let score = 100;
  const countDiff = Math.abs(frames.length - opts.expectedFrames);
  if (countDiff > 0) {
    score -= 35 + 10 * countDiff;
    hintSet.add(
      `The sheet contained ${frames.length} frames instead of ${opts.expectedFrames}. Draw ` +
        `exactly ${opts.expectedFrames} clearly separated frames.`,
    );
  }
  const meanDhash = checks.length
    ? checks.reduce((s, c) => s + c.identity.dhash, 0) / checks.length
    : 1;
  const meanChi2 = checks.length
    ? checks.reduce((s, c) => s + c.identity.histChi2, 0) / checks.length
    : 0;
  // Errors bite per frame; warnings are capped so 8 frames of mild flags
  // can't sink an otherwise-correct sheet on their own.
  const errorCount = checks.reduce((s, c) => s + c.errors.length, 0);
  const warningCount = checks.reduce((s, c) => s + c.warnings.length, 0);
  score -= 13 * errorCount + Math.min(15, 3 * warningCount);
  if (noMotion) score -= 12;
  if (mirrored) score -= 20;
  if (!strideOk) score -= 15;
  if (!legSwapOk) score -= 8;
  if (meanDhash < DHASH_WARN) score -= 10;
  if (meanChi2 > HIST_CHI2_FAIL) score -= 10;
  score = Math.max(0, Math.round(score));

  return {
    score,
    pass: score >= PASS_SCORE,
    frameCount: frames.length,
    expectedFrames: opts.expectedFrames,
    frames: checks,
    staticPairs,
    nearDuplicatePairs,
    failedFrames: checks.filter((c) => c.errors.length > 0).map((c) => c.index),
    hints: [...hintSet],
  };
}

/**
 * Anchor-cascade heuristic: when most frames fail PALETTE identity (the
 * pose-independent signal), the anchor (not the frames) is the likely
 * culprit — the HUD suggests regenerating it. Structure misses alone don't
 * count: action poses legitimately differ from the neutral anchor.
 */
export function suggestsAnchorCascade(report: AnimationGateReport): boolean {
  const paletteFails = report.frames.filter((c) =>
    c.errors.some((e) => e.includes('palette drift')),
  ).length;
  return report.frames.length > 0 && paletteFails / report.frames.length >= 0.5;
}
