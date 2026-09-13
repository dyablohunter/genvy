import sharp from 'sharp';

export interface RawImage {
  data: Buffer; // RGBA
  width: number;
  height: number;
}

export async function loadRaw(input: Buffer | string): Promise<RawImage> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function toPng(img: RawImage): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toBuffer();
}

function colorDist(data: Buffer, i: number, r: number, g: number, b: number): number {
  return Math.max(
    Math.abs(data[i]! - r),
    Math.abs(data[i + 1]! - g),
    Math.abs(data[i + 2]! - b),
  );
}

/** Dominant corner color = background key color. */
export function detectKeyColor(img: RawImage): [number, number, number] {
  const { data, width, height } = img;
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
  const counts = new Map<string, { c: [number, number, number]; n: number }>();
  for (const i of corners) {
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    const cur = counts.get(key) ?? { c: [data[i]!, data[i + 1]!, data[i + 2]!], n: 0 };
    cur.n++;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]!.c;
}

/**
 * Background removal: flood fill from every edge pixel within tolerance, then an
 * optional tighter global chroma pass for isolated speckles. Sets alpha to 0.
 */
export function removeBackground(
  img: RawImage,
  tolerance = 24,
  mode: 'floodfill' | 'chroma' | 'both' = 'both',
): RawImage {
  const { data, width, height } = img;
  const [r, g, b] = detectKeyColor(img);
  const out = Buffer.from(data);

  if (mode === 'floodfill' || mode === 'both') {
    const visited = new Uint8Array(width * height);
    const stack: number[] = [];
    const push = (x: number, y: number) => {
      const p = y * width + x;
      if (visited[p]) return;
      if (colorDist(data, p * 4, r, g, b) <= tolerance) {
        visited[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < width; x++) {
      push(x, 0);
      push(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      push(0, y);
      push(width - 1, y);
    }
    while (stack.length > 0) {
      const p = stack.pop()!;
      out[p * 4 + 3] = 0;
      const x = p % width;
      const y = (p / width) | 0;
      if (x > 0) push(x - 1, y);
      if (x < width - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < height - 1) push(x, y + 1);
    }
  }

  if (mode === 'chroma' || mode === 'both') {
    const tight = mode === 'chroma' ? tolerance : Math.max(4, tolerance >> 1);
    for (let p = 0; p < width * height; p++) {
      if (out[p * 4 + 3] !== 0 && colorDist(data, p * 4, r, g, b) <= tight) {
        out[p * 4 + 3] = 0;
      }
    }
  }

  return { data: out, width, height };
}

export interface GridParams {
  cols: number;
  rows: number;
  offsetX?: number;
  offsetY?: number;
  cellWidth?: number;
  cellHeight?: number;
}

/** Cut a grid of cells out of an image. Returns cells in reading order. */
export function cutCells(img: RawImage, p: GridParams): RawImage[] {
  const offsetX = p.offsetX ?? 0;
  const offsetY = p.offsetY ?? 0;
  const cw = p.cellWidth ?? Math.floor((img.width - offsetX) / p.cols);
  const ch = p.cellHeight ?? Math.floor((img.height - offsetY) / p.rows);
  const cells: RawImage[] = [];
  for (let row = 0; row < p.rows; row++) {
    for (let col = 0; col < p.cols; col++) {
      const cell = Buffer.alloc(cw * ch * 4);
      const sx = offsetX + col * cw;
      const sy = offsetY + row * ch;
      for (let y = 0; y < ch; y++) {
        const srcY = sy + y;
        if (srcY < 0 || srcY >= img.height) continue;
        const srcStart = (srcY * img.width + Math.max(sx, 0)) * 4;
        const copyW = Math.min(cw, img.width - sx);
        if (copyW <= 0) continue;
        img.data.copy(cell, y * cw * 4, srcStart, srcStart + copyW * 4);
      }
      cells.push({ data: cell, width: cw, height: ch });
    }
  }
  return cells;
}

/**
 * Where an AI-drawn tile sheet's cells ACTUALLY begin and end.
 *
 * The model is asked for a `cols`x`rows` grid and it draws that many cells —
 * but it does not draw them on an even lattice. Measured sheets drift by
 * 20-30px per row, and the drift accumulates downward, so cutting at
 * `height / rows` bisects the artwork: row one is perfect and row six is two
 * halves of its neighbours. That is the "tiles overlay other tiles" bug.
 *
 * The model does leave a clue: it separates cells with a flat gutter of one
 * background colour. So keep the EXPECTED cell count — the tile names and
 * collision flags index by position, and inventing a different count would
 * misname every tile — and correct each line individually to the gutter the
 * model drew near it. A full-bleed sheet (terrain touching edge to edge) has
 * no gutter to find and keeps the even division, which is what it wants.
 */
export interface DetectedGrid {
  /** Cut lines along x, including 0 and the width: `cols + 1` entries. */
  xs: number[];
  /** Cut lines along y, including 0 and the height: `rows + 1` entries. */
  ys: number[];
  /** How many lines the drawn gutters moved off the even division. */
  corrected: number;
}

/** How far off the even lattice a line may be pulled, as a share of a cell. */
const GRID_SNAP_WINDOW = 0.18;
/** A gutter row/column is this fraction of pixels within tolerance of the gutter colour. */
const GRID_GUTTER_SHARE = 0.9;
/** Per-channel tolerance when matching the gutter colour (a gutter has grain). */
const GRID_GUTTER_TOLERANCE = 26;

function colorAt(img: RawImage, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/**
 * The gutter's colour, sampled from the pixels lying ON the even lattice —
 * which is where a gutter is, within the snap window. Sampling the image
 * border instead picks up whatever the corner tiles happen to be.
 */
function gutterColor(img: RawImage, xs: number[], ys: number[]): [number, number, number] {
  const counts = new Map<string, number>();
  const bump = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const [r, g, b] = colorAt(img, x, y);
    // Quantise to 32 levels per channel: exact colours never repeat in
    // rendered art, but a gutter's family of near-greys does.
    const key = `${r >> 3},${g >> 3},${b >> 3}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const y of ys) for (let d = -3; d <= 3; d++) for (let x = 0; x < img.width; x += 2) bump(x, y + d);
  for (const x of xs) for (let d = -3; d <= 3; d++) for (let y = 0; y < img.height; y += 2) bump(x + d, y);
  let best = '0,0,0';
  let bestN = -1;
  for (const [key, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = key;
    }
  }
  const [r, g, b] = best.split(',').map((v) => (Number(v) << 3) + 4);
  return [r!, g!, b!];
}

/** Runs of consecutive rows (or columns) that are almost entirely gutter. */
function gutterBands(
  img: RawImage,
  axis: 'x' | 'y',
  gutter: [number, number, number],
): { center: number; width: number }[] {
  const along = axis === 'y' ? img.height : img.width;
  const across = axis === 'y' ? img.width : img.height;
  const bands: { center: number; width: number }[] = [];
  let start = -1;
  for (let a = 0; a <= along; a++) {
    let hit = 0;
    if (a < along) {
      for (let b = 0; b < across; b++) {
        const [r, g, bl] = axis === 'y' ? colorAt(img, b, a) : colorAt(img, a, b);
        if (
          Math.abs(r - gutter[0]) < GRID_GUTTER_TOLERANCE &&
          Math.abs(g - gutter[1]) < GRID_GUTTER_TOLERANCE &&
          Math.abs(bl - gutter[2]) < GRID_GUTTER_TOLERANCE
        ) {
          hit++;
        }
      }
    }
    if (a < along && hit / across >= GRID_GUTTER_SHARE) {
      if (start < 0) start = a;
    } else if (start >= 0) {
      bands.push({ center: (start + a) / 2, width: a - start });
      start = -1;
    }
  }
  // Bands touching an edge are the sheet's own margin, not a cut line.
  return bands.filter((b) => b.center > 1 && b.center < along - 1);
}

function snapLines(nominal: number[], bands: { center: number; width: number }[], cell: number) {
  let corrected = 0;
  const lines = nominal.map((p, i) => {
    if (i === 0 || i === nominal.length - 1) return p;
    const near = bands.filter((b) => Math.abs(b.center - p) <= cell * GRID_SNAP_WINDOW);
    if (near.length === 0) return p;
    // The widest gutter in the window is the cell break; a narrow flat run
    // inside a tile's artwork is not.
    const pick = near.reduce((a, b) => (b.width > a.width ? b : a));
    if (Math.round(pick.center) !== Math.round(p)) corrected++;
    return pick.center;
  });
  return { lines: lines.map((v) => Math.round(v)), corrected };
}

/**
 * Find the real cut lines of a `cols`x`rows` tile sheet. Never changes the
 * cell COUNT — only where the cuts fall.
 */
export function detectTileGrid(img: RawImage, cols: number, rows: number): DetectedGrid {
  const nomX = Array.from({ length: cols + 1 }, (_, i) => (i * img.width) / cols);
  const nomY = Array.from({ length: rows + 1 }, (_, i) => (i * img.height) / rows);
  const gutter = gutterColor(
    img,
    nomX.slice(1, -1).map(Math.round),
    nomY.slice(1, -1).map(Math.round),
  );
  const x = snapLines(nomX, gutterBands(img, 'x', gutter), img.width / cols);
  const y = snapLines(nomY, gutterBands(img, 'y', gutter), img.height / rows);
  return { xs: x.lines, ys: y.lines, corrected: x.corrected + y.corrected };
}

/**
 * Cut cells at explicit boundaries. Unlike `cutCells` the cells may differ in
 * size — a drifting sheet has no single cell size — so callers normalise them
 * with `resizeCell` before packing.
 */
export function cutCellsAt(img: RawImage, xs: number[], ys: number[]): RawImage[] {
  const cells: RawImage[] = [];
  for (let row = 0; row + 1 < ys.length; row++) {
    for (let col = 0; col + 1 < xs.length; col++) {
      const sx = Math.max(0, xs[col]!);
      const sy = Math.max(0, ys[row]!);
      const cw = Math.max(1, Math.min(xs[col + 1]!, img.width) - sx);
      const ch = Math.max(1, Math.min(ys[row + 1]!, img.height) - sy);
      const cell = Buffer.alloc(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        const srcStart = ((sy + y) * img.width + sx) * 4;
        img.data.copy(cell, y * cw * 4, srcStart, srcStart + cw * 4);
      }
      cells.push({ data: cell, width: cw, height: ch });
    }
  }
  return cells;
}

export interface CellBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Detect individual sprites in an image with a transparent background by
 * projecting alpha: first split into horizontal content bands (rows), then
 * split each band into vertical segments (one per sprite). Robust against
 * the irregular, non-grid layouts AI image models actually produce.
 * Returns boxes in reading order.
 */
export function detectSpriteCells(
  img: RawImage,
  opts: { alphaThreshold?: number; minGap?: number; minSize?: number; expected?: number } = {},
): CellBox[] {
  const alphaThreshold = opts.alphaThreshold ?? 8;
  const minGap = opts.minGap ?? 4;
  const minSize = opts.minSize ?? 12;
  const { data, width, height } = img;

  const rowHas = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > alphaThreshold) {
        rowHas[y] = 1;
        break;
      }
    }
  }

  const bands = findRuns(rowHas, minGap, minSize);
  const boxes: CellBox[] = [];

  for (const [y0, y1] of bands) {
    const colHas = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      for (let y = y0; y <= y1; y++) {
        if (data[(y * width + x) * 4 + 3]! > alphaThreshold) {
          colHas[x] = 1;
          break;
        }
      }
    }
    for (const [x0, x1] of findRuns(colHas, minGap, minSize)) {
      // Tighten the vertical bounds for this specific segment.
      let top = y1;
      let bottom = y0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (data[(y * width + x) * 4 + 3]! > alphaThreshold) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            break;
          }
        }
      }
      boxes.push({ x: x0, y: top, w: x1 - x0 + 1, h: bottom - top + 1 });
    }
  }
  let out = splitMergedBoxes(img, boxes, alphaThreshold, minSize);

  // When the caller knows how many frames were requested and we found fewer,
  // boxes are merged along SOME axis (columns holding two rows, or rows
  // holding beam-joined poses). Try both axes and keep whichever result is
  // closer to the expected count with sane pose proportions.
  if (opts.expected && out.length > 0 && out.length < opts.expected) {
    const ratio = opts.expected / out.length;
    const avgW = out.reduce((s, b) => s + b.w, 0) / out.length;
    const avgH = out.reduce((s, b) => s + b.h, 0) / out.length;
    const forced = { maxBridgeFrac: 0.6 };
    const candX = readingOrder(
      splitAxis(img, out, alphaThreshold, minSize, 'x', { median: avgW / ratio, ...forced }),
    );
    const candY = readingOrder(
      splitAxis(img, out, alphaThreshold, minSize, 'y', { median: avgH / ratio, ...forced }),
    );
    // Poses are typically ~1.6x taller than wide; slivers score badly.
    const aspectPenalty = (bs: CellBox[]) =>
      bs.reduce((s, b) => s + Math.abs(Math.log(b.h / Math.max(1, b.w)) - Math.log(1.6)), 0) /
      Math.max(1, bs.length);
    const score = (bs: CellBox[]) => Math.abs(bs.length - opts.expected!) * 10 + aspectPenalty(bs);
    let best = score(candX) <= score(candY) ? candX : candY;
    // Still short? Grid merges can need both axes (columns AND beam joins).
    if (best.length < opts.expected) {
      const axis: 'x' | 'y' = best === candX ? 'y' : 'x';
      const m = axis === 'x' ? avgW / ratio : avgH / ratio;
      const second = readingOrder(
        splitAxis(img, best, alphaThreshold, minSize, axis, { median: m, ...forced }),
      );
      if (score(second) < score(best)) best = second;
    }
    if (score(best) < score(out)) out = best;
  }
  return out;
}

/**
 * Poses connected by thin effects (beams) merge horizontally; staggered rows
 * merge vertically when their bands overlap. Split boxes much larger than the
 * median along either axis at low-density valleys, then restore reading order.
 */
function splitMergedBoxes(
  img: RawImage,
  boxes: CellBox[],
  alphaThreshold: number,
  minSize: number,
): CellBox[] {
  let out = splitAxis(img, boxes, alphaThreshold, minSize, 'x');
  out = splitAxis(img, out, alphaThreshold, minSize, 'y');
  return readingOrder(out);
}

function splitAxis(
  img: RawImage,
  boxes: CellBox[],
  alphaThreshold: number,
  minSize: number,
  axis: 'x' | 'y',
  override?: { median: number; maxBridgeFrac: number },
): CellBox[] {
  if (boxes.length < 2 && !override) return boxes;
  const { data, width } = img;
  const sizes = boxes.map((b) => (axis === 'x' ? b.w : b.h)).sort((a, b) => a - b);
  const median = override?.median ?? sizes[Math.floor(sizes.length / 2)]!;
  const bridgeFrac = override?.maxBridgeFrac ?? 0.2;
  const out: CellBox[] = [];

  for (const box of boxes) {
    const len = axis === 'x' ? box.w : box.h;
    const crossLen = axis === 'x' ? box.h : box.w;
    if (median <= 0 || len <= median * 1.6) {
      out.push(box);
      continue;
    }
    const parts = Math.min(Math.max(Math.round(len / median), 2), 8);
    const density: number[] = new Array(len).fill(0);
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < crossLen; c++) {
        const x = axis === 'x' ? box.x + i : box.x + c;
        const y = axis === 'x' ? box.y + c : box.y + i;
        if (data[(y * width + x) * 4 + 3]! > alphaThreshold) density[i]!++;
      }
    }
    // A valid cut is a valley whose content is a small fraction of the cross size.
    const maxBridge = Math.max(2, Math.round(crossLen * bridgeFrac));
    const cuts: number[] = [0];
    for (let k = 1; k < parts; k++) {
      const center = Math.round((len * k) / parts);
      const span = Math.max(2, Math.round(len * 0.15));
      let best = -1;
      let bestV = Infinity;
      const lo = Math.max(cuts[cuts.length - 1]! + minSize, center - span);
      const hi = Math.min(len - minSize, center + span);
      for (let i = lo; i <= hi; i++) {
        if (density[i]! < bestV) {
          bestV = density[i]!;
          best = i;
        }
      }
      if (best >= 0 && bestV <= maxBridge) cuts.push(best);
    }
    cuts.push(len);
    if (cuts.length <= 2) {
      out.push(box);
      continue;
    }
    for (let k = 0; k < cuts.length - 1; k++) {
      const ax0 = axis === 'x' ? box.x + cuts[k]! : box.x;
      const ax1 = axis === 'x' ? box.x + cuts[k + 1]! - 1 : box.x + box.w - 1;
      const ay0 = axis === 'y' ? box.y + cuts[k]! : box.y;
      const ay1 = axis === 'y' ? box.y + cuts[k + 1]! - 1 : box.y + box.h - 1;
      let minX = ax1, maxX = ax0, minY = ay1, maxY = ay0;
      for (let y = ay0; y <= ay1; y++) {
        for (let x = ax0; x <= ax1; x++) {
          if (data[(y * width + x) * 4 + 3]! > alphaThreshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX - minX + 1 >= minSize && maxY - minY + 1 >= minSize) {
        out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
    }
  }
  return out;
}

/** Group boxes into visual rows (≥50% vertical overlap), sort rows top-down, boxes left-right. */
function readingOrder(boxes: CellBox[]): CellBox[] {
  const rows: { yMin: number; yMax: number; items: CellBox[] }[] = [];
  for (const b of [...boxes].sort((a, b) => a.y - b.y)) {
    const row = rows.find((r) => {
      const overlap = Math.min(r.yMax, b.y + b.h) - Math.max(r.yMin, b.y);
      return overlap > b.h * 0.5;
    });
    if (row) {
      row.items.push(b);
      row.yMin = Math.min(row.yMin, b.y);
      row.yMax = Math.max(row.yMax, b.y + b.h);
    } else {
      rows.push({ yMin: b.y, yMax: b.y + b.h, items: [b] });
    }
  }
  rows.sort((a, b) => a.yMin - b.yMin);
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

/** Runs of 1s in a profile, merging gaps shorter than minGap, dropping runs shorter than minSize. */
function findRuns(profile: Uint8Array, minGap: number, minSize: number): [number, number][] {
  const raw: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] && start < 0) start = i;
    if (!profile[i] && start >= 0) {
      raw.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start, profile.length - 1]);

  const merged: [number, number][] = [];
  for (const run of raw) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] - 1 < minGap) last[1] = run[1];
    else merged.push([...run]);
  }
  return merged.filter(([a, b]) => b - a + 1 >= minSize);
}

/**
 * Extract one cell per group of rectangles. The cell spans the group's union
 * bounding box, but ONLY pixels inside member rectangles are copied — pixels
 * from overlapping neighbors outside the drawn rects are excluded.
 */
export function extractGroups(img: RawImage, groups: CellBox[][]): RawImage[] {
  return groups.map((rects) => {
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const cell = Buffer.alloc(w * h * 4);
    for (const r of rects) {
      for (let y = 0; y < r.h; y++) {
        const srcY = r.y + y;
        if (srcY < 0 || srcY >= img.height) continue;
        const src = (srcY * img.width + r.x) * 4;
        const dst = ((srcY - y0) * w + (r.x - x0)) * 4;
        img.data.copy(cell, dst, src, src + r.w * 4);
      }
    }
    return { data: cell, width: w, height: h };
  });
}

/** Union bounding box of a rect group. */
export function unionBox(rects: CellBox[]): CellBox {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  return {
    x: x0,
    y: y0,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x0,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y0,
  };
}

/** Extract arbitrary boxes as cells (unclipped copies). */
export function extractBoxes(img: RawImage, boxes: CellBox[]): RawImage[] {
  return boxes.map((b) => {
    const cell = Buffer.alloc(b.w * b.h * 4);
    for (let y = 0; y < b.h; y++) {
      const src = ((b.y + y) * img.width + b.x) * 4;
      img.data.copy(cell, y * b.w * 4, src, src + b.w * 4);
    }
    return { data: cell, width: b.w, height: b.h };
  });
}

/**
 * Quarter-turn rotation (clockwise, lossless). A side-view sprite rotated 90°
 * is the same object aiming up or down — free views for anything whose facing
 * is just an orientation.
 */
export async function rotateImage(img: RawImage, degrees: number): Promise<RawImage> {
  const turn = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  if (turn === 0) return img;
  const { data, info } = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .rotate(turn, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Rotate about an arbitrary point rather than the image centre. A weapon turns
 * around its grip, not around the middle of its bounding box — rotating about
 * the centre is what makes derived views drift out of alignment.
 *
 * The image is first padded so the pivot IS the centre (rotation about the
 * centre then equals rotation about the pivot), turned, and trimmed back to
 * content; the pivot's new normalized position travels with it.
 */
export async function rotateAboutPivot(
  img: RawImage,
  degrees: number,
  pivot: { x: number; y: number },
): Promise<{ img: RawImage; pivot: { x: number; y: number } }> {
  const px = Math.max(0, Math.min(1, pivot.x)) * img.width;
  const py = Math.max(0, Math.min(1, pivot.y)) * img.height;
  const halfW = Math.max(px, img.width - px);
  const halfH = Math.max(py, img.height - py);
  const width = Math.max(1, Math.ceil(halfW * 2));
  const height = Math.max(1, Math.ceil(halfH * 2));

  const padded = Buffer.alloc(width * height * 4);
  const dx = Math.round(halfW - px);
  const dy = Math.round(halfH - py);
  for (let y = 0; y < img.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= height) continue;
    const src = y * img.width * 4;
    img.data.copy(padded, (ty * width + dx) * 4, src, src + img.width * 4);
  }

  const turned = await rotateImage({ data: padded, width, height }, degrees);
  const box = contentBox(turned);
  if (!box) return { img: turned, pivot: { x: 0.5, y: 0.5 } };
  const cut = extractBoxes(turned, [box])[0]!;
  return {
    img: cut,
    // The pivot is the centre of the rotated canvas, re-expressed in the crop.
    pivot: { x: (turned.width / 2 - box.x) / box.w, y: (turned.height / 2 - box.y) / box.h },
  };
}

/**
 * Map a box through the same mirror/rotation applied to its image, so a
 * derived sheet keeps knowing where its frames are. Image coords, y down,
 * rotation clockwise.
 */
export function transformBox(
  box: CellBox,
  srcW: number,
  srcH: number,
  opts: { mirror?: boolean; rotate?: number } = {},
): CellBox {
  let { x, y, w, h } = box;
  let width = srcW;
  if (opts.mirror) x = width - (x + w);
  const turn = ((Math.round((opts.rotate ?? 0) / 90) * 90) % 360 + 360) % 360;
  const height = srcH;
  if (turn === 90) return { x: height - (y + h), y: x, w: h, h: w };
  if (turn === 180) return { x: width - (x + w), y: height - (y + h), w, h };
  if (turn === 270) return { x: y, y: width - (x + w), w: h, h: w };
  return { x, y, w, h };
}

/** Horizontal mirror — the east anchor is a computed flip of west, never generated. */
export function flipHorizontal(img: RawImage): RawImage {
  const { width, height, data } = img;
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      data.copy(out, row + (width - 1 - x) * 4, row + x * 4, row + x * 4 + 4);
    }
  }
  return { data: out, width, height };
}

/** True when the image has any meaningfully transparent pixels. */
export function hasTransparency(img: RawImage): boolean {
  for (let p = 3; p < img.data.length; p += 4) {
    if (img.data[p]! < 128) return true;
  }
  return false;
}

/** Content bounding box based on alpha; null when the cell is fully transparent. */
export function contentBox(img: RawImage): { x: number; y: number; w: number; h: number } | null {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Trim all cells to the union content size and re-center each horizontally,
 * bottom-aligned (so animation frames share a ground line).
 */
export function trimAndCenter(cells: RawImage[]): RawImage[] {
  const boxes = cells.map(contentBox);
  let maxW = 1, maxH = 1;
  for (const b of boxes) {
    if (b) {
      maxW = Math.max(maxW, b.w);
      maxH = Math.max(maxH, b.h);
    }
  }
  return cells.map((cell, i) => {
    const b = boxes[i];
    const out = Buffer.alloc(maxW * maxH * 4);
    if (b) {
      const dx = Math.floor((maxW - b.w) / 2);
      const dy = maxH - b.h; // bottom align
      for (let y = 0; y < b.h; y++) {
        const src = ((b.y + y) * cell.width + b.x) * 4;
        cell.data.copy(out, ((dy + y) * maxW + dx) * 4, src, src + b.w * 4);
      }
    }
    return { data: out, width: maxW, height: maxH };
  });
}

/**
 * X of the character's foot mass: centroid of the alpha in the bottom band of
 * the content box. Sprite Pipeline v2 §E3 — more stable than the bbox centre
 * for poses that throw limbs sideways (walk contacts, kicks, lunges), which
 * is what makes a cycle jitter when frames are centred by bounding box.
 */
export function footCentroidX(
  cell: RawImage,
  box: { x: number; y: number; w: number; h: number },
  bandFraction = 0.2,
): number {
  const band = Math.max(1, Math.round(box.h * bandFraction));
  const top = box.y + box.h - band;
  let sum = 0;
  let n = 0;
  for (let y = top; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (cell.data[(y * cell.width + x) * 4 + 3]! > 8) {
        sum += x;
        n++;
      }
    }
  }
  return n > 0 ? sum / n : box.x + box.w / 2;
}

/**
 * Shared registration for the frames of one clip: every frame lands on a
 * common foot baseline (bottom of alpha) and a common foot-centroid X, on one
 * canvas sized to hold them all. Replaces bbox centring, which shifted the
 * body sideways whenever a pose reached out.
 *
 * The canvas height equals the tallest frame's content height, so the frame
 * height IS the clip's body height — that is what cross-clip height matching
 * scales against.
 */
export function registerCells(cells: RawImage[]): RawImage[] {
  const boxes = cells.map(contentBox);
  const feet = cells.map((cell, i) => {
    const b = boxes[i];
    return b ? footCentroidX(cell, b) : 0;
  });

  let maxLeft = 1;
  let maxRight = 1;
  let maxH = 1;
  cells.forEach((_, i) => {
    const b = boxes[i];
    if (!b) return;
    maxLeft = Math.max(maxLeft, feet[i]! - b.x);
    maxRight = Math.max(maxRight, b.x + b.w - feet[i]!);
    maxH = Math.max(maxH, b.h);
  });

  const anchorX = Math.ceil(maxLeft);
  const width = Math.max(1, anchorX + Math.ceil(maxRight));
  const height = Math.max(1, maxH);

  return cells.map((cell, i) => {
    const b = boxes[i];
    const out = Buffer.alloc(width * height * 4);
    if (b) {
      const dx = Math.max(0, Math.min(width - b.w, Math.round(anchorX - (feet[i]! - b.x))));
      const dy = height - b.h; // shared foot baseline
      for (let y = 0; y < b.h; y++) {
        const src = ((b.y + y) * cell.width + b.x) * 4;
        cell.data.copy(out, ((dy + y) * width + dx) * 4, src, src + b.w * 4);
      }
    }
    return { data: out, width, height };
  });
}

/**
 * Targeted repair (§C4): erase one frame's region of a raw sheet and paste a
 * replacement pose into it, bottom-aligned and horizontally centred. Patching
 * the RAW keeps it the single source of truth, so re-slicing, resampling and
 * manual editing all keep working afterwards.
 */
export function replaceRegion(target: RawImage, box: CellBox, cell: RawImage): RawImage {
  const out = Buffer.from(target.data);
  const x0 = Math.max(0, Math.min(box.x, target.width));
  const y0 = Math.max(0, Math.min(box.y, target.height));
  const x1 = Math.max(x0, Math.min(box.x + box.w, target.width));
  const y1 = Math.max(y0, Math.min(box.y + box.h, target.height));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out[(y * target.width + x) * 4 + 3] = 0;
  }

  const dx = x0 + Math.floor((x1 - x0 - cell.width) / 2);
  const dy = y1 - cell.height; // share the frame's ground line
  for (let y = 0; y < cell.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= target.height) continue;
    for (let x = 0; x < cell.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= target.width) continue;
      const si = (y * cell.width + x) * 4;
      if (cell.data[si + 3]! === 0) continue;
      const ti = (ty * target.width + tx) * 4;
      out[ti] = cell.data[si]!;
      out[ti + 1] = cell.data[si + 1]!;
      out[ti + 2] = cell.data[si + 2]!;
      out[ti + 3] = cell.data[si + 3]!;
    }
  }
  return { data: out, width: target.width, height: target.height };
}

export async function resizeCell(
  cell: RawImage,
  targetW: number,
  targetH: number,
  kernel: 'nearest' | 'lanczos3' = 'nearest',
): Promise<RawImage> {
  const { data, info } = await sharp(cell.data, {
    raw: { width: cell.width, height: cell.height, channels: 4 },
  })
    .resize(targetW, targetH, { kernel, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Pack equally-sized cells into a grid image with the given column count. */
/**
 * Locally rendered clips draw every frame as an INDEPENDENT image, so the
 * figure's scale drifts frame to frame and a walk pulses. Scale each cell to
 * the MEDIAN content height (aspect kept, nearest-neighbor) before
 * registration. This is scale equalization only — bbox recentering stays
 * banned (a reaching limb must never drag the body sideways).
 */
export async function equalizeCellHeights(cells: RawImage[]): Promise<RawImage[]> {
  if (cells.length < 2) return cells;
  const heights = [...cells.map((c) => c.height)].sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)]!;
  return Promise.all(
    cells.map((c) => {
      if (Math.abs(c.height - median) <= 1) return c;
      const f = median / c.height;
      return resizeCell(c, Math.max(1, Math.round(c.width * f)), median, 'nearest');
    }),
  );
}

export function packCells(cells: RawImage[], cols: number): RawImage {
  const cw = cells[0]!.width;
  const ch = cells[0]!.height;
  const rows = Math.ceil(cells.length / cols);
  const out = Buffer.alloc(cols * cw * rows * ch * 4);
  const outW = cols * cw;
  cells.forEach((cell, i) => {
    const gx = (i % cols) * cw;
    const gy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) {
      const src = y * cw * 4;
      cell.data.copy(out, ((gy + y) * outW + gx) * 4, src, src + cw * 4);
    }
  });
  return { data: out, width: outW, height: rows * ch };
}

/** Average-hash a cell for dedupe (8x8 grayscale threshold). */
export async function cellHash(cell: RawImage): Promise<string> {
  const small = await resizeCell(cell, 8, 8, 'nearest');
  const gray: number[] = [];
  for (let p = 0; p < 64; p++) {
    const i = p * 4;
    const a = small.data[i + 3]! / 255;
    gray.push(((small.data[i]! + small.data[i + 1]! + small.data[i + 2]!) / 3) * a);
  }
  const avg = gray.reduce((s, v) => s + v, 0) / 64;
  return gray.map((v) => (v > avg ? '1' : '0')).join('');
}

export async function makeThumbnail(png: Buffer, size = 128): Promise<Buffer> {
  return sharp(png)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}
