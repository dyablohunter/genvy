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

function isBorderGreen(data: Buffer, i: number): boolean {
  const r = data[i]!;
  const g = data[i + 1]!;
  const b = data[i + 2]!;
  return data[i + 3]! > 8 && g >= 140 && r <= 110 && b <= 110 && g > r + 60 && g > b + 60;
}

/**
 * Find the green (#00FF00) cell borders the prompts ask the model to draw and
 * return each cell's INTERIOR as a frame box. Deterministic: whatever crosses
 * a border is clipped at the cell wall instead of merging neighbors.
 */
export function detectGreenCells(img: RawImage, minSize = 24): CellBox[] {
  const { data, width, height } = img;
  const visited = new Uint8Array(width * height);
  const comps: { box: CellBox; pixels: number }[] = [];

  for (let start = 0; start < width * height; start++) {
    if (visited[start] || !isBorderGreen(data, start * 4)) continue;
    // Flood fill this green component, tracking its bbox.
    let minX = width, minY = height, maxX = 0, maxY = 0, pixels = 0;
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p / width) | 0;
      pixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [p - 1, p + 1, p - width, p + width];
      for (const n of neighbors) {
        if (n < 0 || n >= width * height || visited[n]) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue; // no row wrap
        if (isBorderGreen(data, n * 4)) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    // A cell border is a large, sparse (ring-like) component.
    if (w >= minSize && h >= minSize && pixels < w * h * 0.5) {
      comps.push({ box: { x: minX, y: minY, w, h }, pixels });
    }
  }

  // Interiors, inset past the measured border thickness.
  const cells: CellBox[] = [];
  for (const { box } of comps) {
    const midY = box.y + Math.floor(box.h / 2);
    const midX = box.x + Math.floor(box.w / 2);
    const thickness = (scan: (t: number) => number) => {
      let t = 0;
      while (t < box.w / 4 && t < box.h / 4 && isBorderGreen(data, scan(t) * 4)) t++;
      return Math.max(t, 2);
    };
    const tL = thickness((t) => midY * width + box.x + t);
    const tR = thickness((t) => midY * width + box.x + box.w - 1 - t);
    const tT = thickness((t) => (box.y + t) * width + midX);
    const tB = thickness((t) => (box.y + box.h - 1 - t) * width + midX);
    const inset = {
      x: box.x + tL + 1,
      y: box.y + tT + 1,
      w: box.w - tL - tR - 2,
      h: box.h - tT - tB - 2,
    };
    if (inset.w >= minSize && inset.h >= minSize) cells.push(inset);
  }

  // Drop cells nested inside another (double-ring artifacts) — keep the outer.
  const kept = cells.filter((c, i) =>
    !cells.some(
      (o, j) =>
        j !== i &&
        o.x <= c.x && o.y <= c.y &&
        o.x + o.w >= c.x + c.w && o.y + o.h >= c.y + c.h &&
        (o.w > c.w || o.h > c.h),
    ),
  );
  return readingOrder(kept);
}

/**
 * Erase the pure-green (#00FF00) cell borders the prompts ask the model to
 * draw around each pose. Tolerant of anti-aliased edges; a no-op when the
 * image has no such borders.
 */
export function stripBorderColor(img: RawImage): RawImage {
  const out = Buffer.from(img.data);
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p * 4;
    if (out[i + 3]! <= 8) continue;
    const r = out[i]!;
    const g = out[i + 1]!;
    const b = out[i + 2]!;
    if (g >= 140 && r <= 110 && b <= 110 && g > r + 60 && g > b + 60) {
      out[i + 3] = 0;
    }
  }
  return { data: out, width: img.width, height: img.height };
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
