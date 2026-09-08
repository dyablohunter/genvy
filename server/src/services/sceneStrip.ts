import type { RawImage } from './imagePipeline.js';

/**
 * Strip geometry for painted scenes: composing panels as the editor shows
 * them, cutting a strip into equal sections, and joining sections back into
 * one panel.
 *
 * All deterministic pixel work, deliberately kept out of the route and away
 * from the model. A panel that is mirrored on screen must be mirrored in the
 * bytes we hand an image model too — otherwise it edits an image the user is
 * not looking at — and joining N edited sections is how a panel becomes 2x or
 * 3x as long on providers whose canvases only come in a few fixed shapes.
 */

export type StripAxis = 'horizontal' | 'vertical';

export interface PanelSource extends RawImage {
  flipX?: boolean;
  flipY?: boolean;
}

/** Mirror an image in place-safe fashion, returning a new buffer. */
export function mirror(img: RawImage, flipX: boolean, flipY: boolean): RawImage {
  if (!flipX && !flipY) return { data: Buffer.from(img.data), width: img.width, height: img.height };
  const out = Buffer.alloc(img.data.length);
  const { width, height } = img;
  for (let y = 0; y < height; y++) {
    const sy = flipY ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const sx = flipX ? width - 1 - x : x;
      out.set(img.data.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { data: out, width, height };
}

/**
 * Lay panels out along the travel axis, each mirrored as the editor draws it.
 *
 * Panels of different sizes are placed at their own size and the canvas takes
 * the largest cross-axis extent — the same thing the stage does, so what the
 * model receives matches what the user sees.
 */
export function composeStrip(panels: PanelSource[], axis: StripAxis): RawImage {
  if (panels.length === 0) throw new Error('composeStrip needs at least one panel');
  const horizontal = axis === 'horizontal';
  const width = horizontal
    ? panels.reduce((sum, p) => sum + p.width, 0)
    : Math.max(...panels.map((p) => p.width));
  const height = horizontal
    ? Math.max(...panels.map((p) => p.height))
    : panels.reduce((sum, p) => sum + p.height, 0);

  const out = Buffer.alloc(width * height * 4);
  let offset = 0;
  for (const panel of panels) {
    const src = mirror(panel, panel.flipX === true, panel.flipY === true);
    const ox = horizontal ? offset : 0;
    const oy = horizontal ? 0 : offset;
    for (let y = 0; y < src.height; y++) {
      const from = y * src.width * 4;
      out.set(src.data.subarray(from, from + src.width * 4), ((oy + y) * width + ox) * 4);
    }
    offset += horizontal ? src.width : src.height;
  }
  return { data: out, width, height };
}
