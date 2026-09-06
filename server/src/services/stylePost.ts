import type { StyleContract, StylePostStep } from '@genvy/shared';
import type { RawImage } from './imagePipeline.js';

/**
 * Sprite Pipeline v2 §B — style-conditional post-processing.
 *
 * The StyleContract's `postSteps` run here, deterministically, at the SLICE
 * stage (after the nearest-neighbor downscale to final frame size, before
 * packing). The provider's raw output is never touched, so re-running the
 * pipeline stays free. All steps operate on a whole clip at once because the
 * one thing that ruins pixel-art animations is per-frame drift: the palette is
 * built ONCE across every frame and shared.
 *
 * Steps:
 * - quantize:     median-cut palette reduction (paletteSize colors, default 32)
 *                 with the palette shared across all frames of the clip.
 * - pixelSnap:    hard alpha (0|255) — the nearest downscale already put the
 *                 pixels on the final grid; this kills the AA fringe the model
 *                 painted, which reads as blur at game scale.
 * - outlineClean: despeckle — orphan opaque pixels (≤1 opaque neighbour) go
 *                 transparent, holes fully surrounded by opaque pixels are
 *                 filled with the neighbour majority color.
 * - despill:      no-op today; both live providers have native alpha, so there
 *                 is no chroma spill to remove. Kept in the enum for a future
 *                 chroma-route provider.
 */

const ALPHA_OPAQUE = 128;

export function hardenAlpha(cell: RawImage): RawImage {
  const data = Buffer.from(cell.data);
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i]! >= ALPHA_OPAQUE ? 255 : 0;
  }
  return { data, width: cell.width, height: cell.height };
}

/** Median-cut over the opaque pixels of ALL cells; one palette for the clip. */
export function buildPalette(cells: RawImage[], maxColors: number): [number, number, number][] {
  // Sample opaque pixels (stride keeps huge sheets cheap; small frames sample all).
  const pixels: [number, number, number][] = [];
  for (const cell of cells) {
    const total = cell.width * cell.height;
    const stride = Math.max(1, Math.floor(total / 4096));
    for (let p = 0; p < total; p += stride) {
      const i = p * 4;
      if (cell.data[i + 3]! >= ALPHA_OPAQUE) {
        pixels.push([cell.data[i]!, cell.data[i + 1]!, cell.data[i + 2]!]);
      }
    }
  }
  if (pixels.length === 0) return [];

  type Bucket = [number, number, number][];
  let buckets: Bucket[] = [pixels];
  while (buckets.length < maxColors) {
    // Split the bucket with the widest channel range.
    let widest = -1;
    let widestRange = 0;
    let widestChannel = 0;
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b]!;
      if (bucket.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255;
        let max = 0;
        for (const px of bucket) {
          if (px[c]! < min) min = px[c]!;
          if (px[c]! > max) max = px[c]!;
        }
        if (max - min > widestRange) {
          widestRange = max - min;
          widest = b;
          widestChannel = c;
        }
      }
    }
    if (widest < 0 || widestRange === 0) break; // nothing left to split
    const bucket = buckets[widest]!;
    bucket.sort((a, b) => a[widestChannel]! - b[widestChannel]!);
    const mid = bucket.length >> 1;
    buckets.splice(widest, 1, bucket.slice(0, mid), bucket.slice(mid));
  }
  return buckets.map((bucket) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const px of bucket) {
      r += px[0]!;
      g += px[1]!;
      bl += px[2]!;
    }
    const n = bucket.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

function nearestIndex(palette: [number, number, number][], r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i]!;
    const dist = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function quantizeToPalette(cell: RawImage, palette: [number, number, number][]): RawImage {
  if (palette.length === 0) return cell;
  const data = Buffer.from(cell.data);
  // Exact-color memo: pixel-art frames repeat few colors, so this is ~free.
  const memo = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < ALPHA_OPAQUE) continue;
    const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    let idx = memo.get(key);
    if (idx === undefined) {
      idx = nearestIndex(palette, data[i]!, data[i + 1]!, data[i + 2]!);
      memo.set(key, idx);
    }
    const [r, g, b] = palette[idx]!;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return { data, width: cell.width, height: cell.height };
}

/**
 * Despeckle: orphan opaque pixels (≤1 opaque 4-neighbour) become transparent;
 * 1px transparent holes (all 4 neighbours opaque) take the majority neighbour
 * color. One pass each way is enough at sprite scale.
 */
export function cleanOutline(cell: RawImage): RawImage {
  const { width: w, height: h } = cell;
  const data = Buffer.from(cell.data);
  const opaque = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && cell.data[(y * w + x) * 4 + 3]! >= ALPHA_OPAQUE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const neighbours =
        (opaque(x - 1, y) ? 1 : 0) +
        (opaque(x + 1, y) ? 1 : 0) +
        (opaque(x, y - 1) ? 1 : 0) +
        (opaque(x, y + 1) ? 1 : 0);
      if (cell.data[i + 3]! >= ALPHA_OPAQUE) {
        if (neighbours <= 1) data[i + 3] = 0; // stray speck
      } else if (neighbours === 4) {
        // 1px hole: copy the left neighbour (any neighbour is opaque; left is
        // deterministic and visually indistinguishable at this size).
        const n = ((y * w + x) - 1) * 4;
        data[i] = cell.data[n]!;
        data[i + 1] = cell.data[n + 1]!;
        data[i + 2] = cell.data[n + 2]!;
        data[i + 3] = 255;
      }
    }
  }
  return { data, width: w, height: h };
}

/** Default clip palette size per style; only pixel styles quantize today. */
const PALETTE_SIZE: Record<string, number> = {
  // NES-era art lives on a handful of colors; enforcing that is most of what
  // makes 8-bit read as 8-bit.
  'pixel-8bit': 16,
  'pixel-16bit': 32,
  'pixel-hd': 64,
};

/**
 * Run the style's postSteps over a clip's cells. Order is fixed regardless of
 * declaration order: snap → quantize → clean (quantizing after the alpha
 * harden keeps AA fringe out of the palette; cleaning last removes what
 * quantization exposed). No style, or no steps → the cells pass through.
 */
export function applyStylePost(cells: RawImage[], style?: StyleContract): RawImage[] {
  const steps = new Set<StylePostStep>(style?.postSteps ?? []);
  if (steps.size === 0) return cells;
  let out = cells;
  if (steps.has('pixelSnap')) out = out.map(hardenAlpha);
  if (steps.has('quantize')) {
    const palette = buildPalette(out, PALETTE_SIZE[style!.id] ?? 32);
    out = out.map((c) => quantizeToPalette(c, palette));
  }
  if (steps.has('outlineClean')) out = out.map(cleanOutline);
  return out;
}
