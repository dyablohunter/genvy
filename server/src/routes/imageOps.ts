import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  RemoveBgRequest,
  SliceSheetRequest,
  AutoSliceRequest,
  ExtractTilesRequest,
  DownscaleRequest,
} from '@genvy/shared';
import { Library, LibraryError } from '../services/library.js';
import * as pipe from '../services/imagePipeline.js';

export function registerImageOpRoutes(app: FastifyInstance, library: Library) {
  const loadSource = async (assetId: string, sourceFile: string) => {
    const abs = library.resolveFile(`${assetId}/${path.basename(sourceFile)}`);
    try {
      return await fs.readFile(abs);
    } catch {
      throw new LibraryError(404, `Source file not found: ${sourceFile}`);
    }
  };

  const save = async (assetId: string, name: string, png: Buffer) => {
    const dir = await library.fileDir(assetId);
    await fs.writeFile(path.join(dir, name), png);
    return `${assetId}/${name}`;
  };

  app.post<{ Body: RemoveBgRequest }>('/api/image/remove-bg', async (req) => {
    const { assetId, sourceFile, tolerance = 24, mode = 'both' } = req.body ?? {};
    if (!assetId || !sourceFile) throw new LibraryError(400, 'assetId and sourceFile required');
    const raw = await pipe.loadRaw(await loadSource(assetId, sourceFile));
    const keyed = pipe.removeBackground(raw, Math.min(Math.max(tolerance, 0), 64), mode);
    const png = await pipe.toPng(keyed);
    const rel = await save(assetId, 'keyed.png', png);
    return { fileRef: { path: rel, width: keyed.width, height: keyed.height } };
  });

  app.post<{ Body: SliceSheetRequest }>('/api/image/slice-sheet', async (req) => {
    const b = req.body ?? ({} as SliceSheetRequest);
    if (!b.assetId || !b.sourceFile || !b.cols || !b.rows) {
      throw new LibraryError(400, 'assetId, sourceFile, cols, rows required');
    }
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    let cells = pipe.cutCells(raw, b);
    if (b.trim !== false) cells = pipe.trimAndCenter(cells);

    if (b.targetFrameSize) {
      const w0 = cells[0]!.width;
      const h0 = cells[0]!.height;
      const scale = b.targetFrameSize / Math.max(w0, h0);
      const tw = Math.max(1, Math.round(w0 * scale));
      const th = Math.max(1, Math.round(h0 * scale));
      cells = await Promise.all(cells.map((c) => pipe.resizeCell(c, tw, th, 'nearest')));
    }

    const packed = pipe.packCells(cells, b.cols);
    const png = await pipe.toPng(packed);
    const rel = await save(b.assetId, 'sheet.png', png);
    const thumbRel = await save(b.assetId, 'thumb.png', await pipe.makeThumbnail(png));
    return {
      sheet: { path: rel, width: packed.width, height: packed.height },
      frameWidth: cells[0]!.width,
      frameHeight: cells[0]!.height,
      frameCount: cells.length,
      thumbnail: thumbRel,
    };
  });

  const SAFE_OUT = /^[\w.-]+\.png$/;

  /** Detect sprite bounding boxes only (no writes) — used for variant picking. */
  app.post<{ Body: { assetId: string; sourceFile: string; tolerance?: number } }>(
    '/api/image/detect',
    async (req) => {
      const b = req.body ?? ({} as { assetId: string; sourceFile: string });
      if (!b.assetId || !b.sourceFile) throw new LibraryError(400, 'assetId and sourceFile required');
      let raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
      const greenCells = pipe.detectGreenCells(raw);
      raw = pipe.stripBorderColor(raw);
      if (!pipe.hasTransparency(raw)) {
        raw = pipe.removeBackground(raw, Math.min(Math.max(b.tolerance ?? 24, 0), 64), 'both');
      }
      return { boxes: greenCells.length >= 2 ? greenCells : pipe.detectSpriteCells(raw) };
    },
  );

  /**
   * Crop one box out of a source image into its own file. sourceAssetId lets a
   * variant workspace pull its crop from the shared session dir.
   */
  app.post<{
    Body: {
      assetId: string;
      sourceAssetId?: string;
      sourceFile: string;
      box: pipe.CellBox;
      outName: string;
      variantIndex?: number;
    };
  }>('/api/image/crop', async (req) => {
    const b = req.body ?? ({} as { assetId: string; sourceFile: string; box: pipe.CellBox; outName: string });
    if (!b.assetId || !b.sourceFile || !b.box || !SAFE_OUT.test(b.outName ?? '')) {
      throw new LibraryError(400, 'assetId, sourceFile, box and a valid outName required');
    }
    let raw = await pipe.loadRaw(await loadSource(b.sourceAssetId ?? b.assetId, b.sourceFile));
    raw = pipe.stripBorderColor(raw);
    if (!pipe.hasTransparency(raw)) raw = pipe.removeBackground(raw, 24, 'both');
    const cell = pipe.extractBoxes(raw, [b.box])[0]!;
    const png = await pipe.toPng(cell);
    const rel = await save(b.assetId, b.outName, png);
    // Record the parent session so recovery can group workspaces under it.
    if (b.sourceAssetId) {
      const dir = await library.fileDir(b.assetId);
      await fs.writeFile(
        path.join(dir, 'source.json'),
        JSON.stringify({ sessionId: b.sourceAssetId, variantIndex: b.variantIndex ?? null }),
      );
    }
    return { fileRef: { path: rel, width: cell.width, height: cell.height } };
  });

  /**
   * Sprite-aware slicing: detects each pose from alpha instead of assuming a
   * grid, so irregular AI layouts still produce clean, aligned frames.
   */
  app.post<{ Body: AutoSliceRequest }>('/api/image/auto-slice', async (req) => {
    const b = req.body ?? ({} as AutoSliceRequest);
    if (!b.assetId || !b.sourceFile) throw new LibraryError(400, 'assetId and sourceFile required');
    const outName = b.outName && SAFE_OUT.test(b.outName) ? b.outName : 'sheet.png';
    let raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    // Green cell borders (when the model drew them) are the most reliable cuts.
    const greenCells = pipe.detectGreenCells(raw);
    raw = pipe.stripBorderColor(raw);
    // Solid-background sources (uploads) get keyed first so alpha detection works.
    if (!pipe.hasTransparency(raw)) {
      raw = pipe.removeBackground(raw, Math.min(Math.max(b.tolerance ?? 24, 0), 64), 'both');
    }
    // Unify all sources into rect GROUPS (one frame = one group, possibly
    // several rects whose union-mask defines the pose's pixels).
    const clamp = (box: pipe.CellBox): pipe.CellBox => {
      const x = Math.max(0, Math.min(Math.round(box.x), raw.width - 1));
      const y = Math.max(0, Math.min(Math.round(box.y), raw.height - 1));
      return {
        x,
        y,
        w: Math.max(1, Math.min(Math.round(box.w), raw.width - x)),
        h: Math.max(1, Math.min(Math.round(box.h), raw.height - y)),
      };
    };
    let groups: pipe.CellBox[][];
    if (b.groups && b.groups.length > 0) {
      groups = b.groups.filter((g) => g.length > 0).map((g) => g.map(clamp));
    } else if (b.boxes && b.boxes.length > 0) {
      groups = b.boxes.map((box) => [clamp(box)]);
    } else if (greenCells.length >= 2) {
      groups = greenCells.map((box) => [box]);
    } else {
      groups = pipe.detectSpriteCells(raw, { expected: b.expectedFrames }).map((box) => [box]);
    }
    if (groups.length === 0) {
      throw new LibraryError(422, 'No sprites detected — try REMOVE BACKGROUND first or adjust the image');
    }
    const boxes = groups.map((g) => pipe.unionBox(g));
    let cells = pipe.trimAndCenter(pipe.extractGroups(raw, groups));

    // targetFrameSize 0 = keep the native (original) resolution.
    const target = b.targetFrameSize ?? 48;
    if (target > 0) {
      const w0 = cells[0]!.width;
      const h0 = cells[0]!.height;
      const scale = target / Math.max(w0, h0);
      const tw = Math.max(1, Math.round(w0 * scale));
      const th = Math.max(1, Math.round(h0 * scale));
      cells = await Promise.all(cells.map((c) => pipe.resizeCell(c, tw, th, 'nearest')));
    }
    const tw = cells[0]!.width;
    const th = cells[0]!.height;

    const columns = Math.min(cells.length, Math.max(1, b.columns ?? 4));
    const packed = pipe.packCells(cells, columns);
    const png = await pipe.toPng(packed);
    const rel = await save(b.assetId, outName, png);
    const thumbRel =
      outName === 'sheet.png' ? await save(b.assetId, 'thumb.png', await pipe.makeThumbnail(png)) : '';
    return {
      sheet: { path: rel, width: packed.width, height: packed.height },
      frameWidth: tw,
      frameHeight: th,
      frameCount: cells.length,
      columns,
      boxes,
      thumbnail: thumbRel,
    };
  });

  /**
   * Compose the master sheet from per-animation strips: one animation per row,
   * all frames normalized to a shared cell size, bottom-centered.
   */
  app.post<{
    Body: {
      assetId: string;
      parts: {
        file: string;
        frameWidth: number;
        frameHeight: number;
        count: number;
        frames?: number[];
      }[];
    };
  }>('/api/image/compose-sheet', async (req) => {
    const b = req.body ?? ({} as { assetId: string; parts: [] });
    if (!b.assetId || !Array.isArray(b.parts) || b.parts.length === 0) {
      throw new LibraryError(400, 'assetId and parts required');
    }
    const partCells: pipe.RawImage[][] = [];
    for (const part of b.parts) {
      const raw = await pipe.loadRaw(await loadSource(b.assetId, part.file));
      const cells = pipe.cutCells(raw, {
        cols: part.count,
        rows: 1,
        cellWidth: part.frameWidth,
        cellHeight: part.frameHeight,
      });
      // Keep only the frames the clip actually plays, in playback order.
      const selected =
        part.frames && part.frames.length > 0
          ? part.frames.filter((i) => i >= 0 && i < cells.length).map((i) => cells[i]!)
          : cells;
      partCells.push(selected.length > 0 ? selected : cells);
    }
    // Normalize every frame across all animations to one shared cell size.
    let all = partCells.flat();
    all = pipe.trimAndCenter(all);
    const cw = all[0]!.width;
    const ch = all[0]!.height;
    // Row widths come from the SELECTED frames, not the raw strip length.
    const partCounts = partCells.map((cells) => cells.length);
    const columns = Math.max(...partCounts);

    // Re-pack row by row: each animation occupies its own row (padded with blanks).
    const rows: pipe.RawImage[] = [];
    let cursor = 0;
    const ranges: { file: string; start: number; count: number }[] = [];
    for (let r = 0; r < b.parts.length; r++) {
      const count = partCounts[r]!;
      const rowCells = all.slice(cursor, cursor + count);
      cursor += count;
      while (rowCells.length < columns) {
        rowCells.push({ data: Buffer.alloc(cw * ch * 4), width: cw, height: ch });
      }
      rows.push(pipe.packCells(rowCells, columns));
      ranges.push({ file: b.parts[r]!.file, start: r * columns, count });
    }
    const packed = pipe.packCells(rows, 1);
    const png = await pipe.toPng(packed);
    const rel = await save(b.assetId, 'sheet.png', png);
    const thumbRel = await save(b.assetId, 'thumb.png', await pipe.makeThumbnail(png));
    return {
      sheet: { path: rel, width: packed.width, height: packed.height },
      frameWidth: cw,
      frameHeight: ch,
      columns,
      ranges,
      thumbnail: thumbRel,
    };
  });

  app.post<{ Body: ExtractTilesRequest }>('/api/image/extract-tiles', async (req) => {
    const b = req.body ?? ({} as ExtractTilesRequest);
    if (!b.assetId || !b.sourceFile || !b.cols || !b.rows) {
      throw new LibraryError(400, 'assetId, sourceFile, cols, rows required');
    }
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    let cells = pipe.cutCells(raw, b);

    const size = b.targetTileSize ?? 48;
    cells = await Promise.all(cells.map((c) => pipe.resizeCell(c, size, size, 'nearest')));

    let indexMap = cells.map((_, i) => i);
    if (b.dedupe) {
      const hashes = await Promise.all(cells.map((c) => pipe.cellHash(c)));
      const seen = new Map<string, number>();
      const unique: pipe.RawImage[] = [];
      indexMap = hashes.map((h, i) => {
        const existing = seen.get(h);
        if (existing !== undefined) return existing;
        const idx = unique.length;
        seen.set(h, idx);
        unique.push(cells[i]!);
        return idx;
      });
      cells = unique;
    }

    const cols = Math.min(cells.length, 8);
    const packed = pipe.packCells(cells, cols);
    const png = await pipe.toPng(packed);
    const rel = await save(b.assetId, 'tileset.png', png);
    const thumbRel = await save(b.assetId, 'thumb.png', await pipe.makeThumbnail(png));
    return {
      tileset: { path: rel, width: packed.width, height: packed.height },
      tileWidth: size,
      tileHeight: size,
      tileCount: cells.length,
      indexMap,
      thumbnail: thumbRel,
    };
  });

  app.post<{ Body: DownscaleRequest }>('/api/image/downscale', async (req) => {
    const b = req.body ?? ({} as DownscaleRequest);
    if (!b.assetId || !b.sourceFile) throw new LibraryError(400, 'assetId and sourceFile required');
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    const targetW = b.targetWidth ?? Math.max(1, Math.round(raw.width * (b.scale ?? 0.25)));
    const targetH = Math.max(1, Math.round(raw.height * (targetW / raw.width)));
    const kernel = b.kernel === 'lanczos' ? 'lanczos3' : 'nearest';
    const resized = await pipe.resizeCell(raw, targetW, targetH, kernel);
    const png = await pipe.toPng(resized);
    const rel = await save(b.assetId, 'scaled.png', png);
    return { fileRef: { path: rel, width: targetW, height: targetH } };
  });
}
