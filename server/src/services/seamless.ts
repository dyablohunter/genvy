import type { RawImage } from './imagePipeline.js';

/**
 * World Maker v2 — MAKE a tile seamless instead of asking a model to draw one.
 *
 * No image generator reliably produces a wrapping texture: it has no concept
 * of the tile's opposite edge. The classical fix has been standard in image
 * editors for decades, and it is deterministic:
 *
 *   1. OFFSET the tile by half its width and height (wrapping). Rolling does
 *      not change how the tile tiles — it just moves the tile's outer seam
 *      into the middle of the image, where it becomes visible and editable.
 *   2. HEAL that cross-shaped seam. The new outer edges are the tile's old
 *      centre, which was already continuous, so once the cross is healed the
 *      tile wraps perfectly.
 *
 * The healing here is a feathered cross-fade across the seam band — the
 * deterministic cousin of content-aware fill. On texture (rock, grass, water)
 * it is invisible; on tiles with a strong single subject it softens a narrow
 * band, which is why this is applied to TERRAIN tiles, not props.
 */

function idx(img: RawImage, x: number, y: number): number {
  return (y * img.width + x) * 4;
}

/** Roll the image by (dx, dy) with wrapping. */
export function offsetWrap(img: RawImage, dx: number, dy: number): RawImage {
  const out = Buffer.alloc(img.data.length);
  for (let y = 0; y < img.height; y++) {
    const sy = (((y - dy) % img.height) + img.height) % img.height;
    for (let x = 0; x < img.width; x++) {
      const sx = (((x - dx) % img.width) + img.width) % img.width;
      img.data.copy(out, idx(img, x, y), idx(img, sx, sy), idx(img, sx, sy) + 4);
    }
  }
  return { data: out, width: img.width, height: img.height };
}

/** Smoothstep — a cosine-ish ramp reads better than a straight line. */
const ramp = (t: number) => t * t * (3 - 2 * t);

/**
 * Blend a vertical band centred on `cx` by cross-fading the columns either
 * side of it, so the hard seam becomes a gradual transition.
 */
function healVertical(img: RawImage, cx: number, halfBand: number): void {
  const left = Math.max(0, cx - halfBand);
  const right = Math.min(img.width - 1, cx + halfBand - 1);
  if (right <= left) return;
  const span = right - left;
  for (let y = 0; y < img.height; y++) {
    const a = idx(img, left, y);
    const b = idx(img, right, y);
    for (let x = left + 1; x < right; x++) {
      const t = ramp((x - left) / span);
      const i = idx(img, x, y);
      for (let c = 0; c < 4; c++) {
        // Mix the existing pixel with the straight interpolation between the
        // band's edges: keeps texture, kills the discontinuity.
        const interpolated = img.data[a + c]! * (1 - t) + img.data[b + c]! * t;
        img.data[i + c] = Math.round(img.data[i + c]! * 0.35 + interpolated * 0.65);
      }
    }
  }
}

/** The same, for a horizontal band centred on `cy`. */
function healHorizontal(img: RawImage, cy: number, halfBand: number): void {
  const top = Math.max(0, cy - halfBand);
  const bottom = Math.min(img.height - 1, cy + halfBand - 1);
  if (bottom <= top) return;
  const span = bottom - top;
  for (let x = 0; x < img.width; x++) {
    const a = idx(img, x, top);
    const b = idx(img, x, bottom);
    for (let y = top + 1; y < bottom; y++) {
      const t = ramp((y - top) / span);
      const i = idx(img, x, y);
      for (let c = 0; c < 4; c++) {
        const interpolated = img.data[a + c]! * (1 - t) + img.data[b + c]! * t;
        img.data[i + c] = Math.round(img.data[i + c]! * 0.35 + interpolated * 0.65);
      }
    }
  }
}

export interface SeamlessOptions {
  /**
   * Width of the healed band, as a fraction of the tile (default 0.18). Wider
   * hides a worse seam but softens more of the texture.
   */
  band?: number;
}

/**
 * How to force a tile to wrap:
 *  - 'offset': roll by half and heal the exposed cross. Keeps the art
 *    asymmetric; best for organic texture.
 *  - 'h' / 'v': mirror one axis into the other half, so the opposite edges
 *    become identical BY CONSTRUCTION. Perfectly seamless on that axis, at
 *    the cost of visible symmetry.
 *  - 'both': mirror both axes — a kaleidoscope quadrant, guaranteed to tile
 *    in every direction. Strongest guarantee, strongest symmetry.
 */
export type SeamlessMode = 'offset' | 'h' | 'v' | 'both';

/** Copy the left half over the right, mirrored (so column 0 matches column W-1). */
function mirrorIntoRight(img: RawImage): void {
  const half = Math.floor(img.width / 2);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < half; x++) {
      const src = idx(img, x, y);
      const dst = idx(img, img.width - 1 - x, y);
      img.data.copy(img.data, dst, src, src + 4);
    }
  }
}

/** Copy the top half over the bottom, mirrored (row 0 matches row H-1). */
function mirrorIntoBottom(img: RawImage): void {
  const half = Math.floor(img.height / 2);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < img.width; x++) {
      const src = idx(img, x, y);
      const dst = idx(img, x, img.height - 1 - y);
      img.data.copy(img.data, dst, src, src + 4);
    }
  }
}

/**
 * Produce a wrapping version of a tile with the chosen method. Mirror modes
 * still get a light heal along the mirror axis: the join is mathematically
 * continuous but the sudden flip in texture direction reads as a crease.
 */
export function makeSeamlessTile(
  tile: RawImage,
  mode: SeamlessMode = 'offset',
  opts: SeamlessOptions = {},
): RawImage {
  if (tile.width < 8 || tile.height < 8) return tile;
  if (mode === 'offset') return makeSeamless(tile, opts);

  const out: RawImage = {
    data: Buffer.from(tile.data),
    width: tile.width,
    height: tile.height,
  };
  const halfBandX = Math.max(2, Math.round((tile.width * (opts.band ?? 0.12)) / 2));
  const halfBandY = Math.max(2, Math.round((tile.height * (opts.band ?? 0.12)) / 2));
  if (mode === 'h' || mode === 'both') {
    mirrorIntoRight(out);
    healVertical(out, Math.floor(out.width / 2), halfBandX);
  }
  if (mode === 'v' || mode === 'both') {
    mirrorIntoBottom(out);
    healHorizontal(out, Math.floor(out.height / 2), halfBandY);
  }
  return out;
}

/** Offset by half, heal the exposed cross: the result tiles with itself. */
export function makeSeamless(tile: RawImage, opts: SeamlessOptions = {}): RawImage {
  if (tile.width < 8 || tile.height < 8) return tile;
  const rolled = offsetWrap(tile, Math.floor(tile.width / 2), Math.floor(tile.height / 2));
  const halfBandX = Math.max(2, Math.round((tile.width * (opts.band ?? 0.18)) / 2));
  const halfBandY = Math.max(2, Math.round((tile.height * (opts.band ?? 0.18)) / 2));
  // The seam now runs down the middle column and across the middle row.
  healVertical(rolled, Math.floor(tile.width / 2), halfBandX);
  healHorizontal(rolled, Math.floor(tile.height / 2), halfBandY);
  return rolled;
}
