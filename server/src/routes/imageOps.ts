import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  RemoveBgRequest,
  CropRectRequest,
  SliceSheetRequest,
  AutoSliceRequest,
  ExtractTilesRequest,
  DownscaleRequest,
  FlipRequest,
  AnchorGateRequest,
} from '@genvy/shared';
import { getStylePreset } from '@genvy/shared';
import { Library, LibraryError } from '../services/library.js';
import * as pipe from '../services/imagePipeline.js';
import { gateTiles, wrapContinuity } from '../services/tileGate.js';
import { makeSeamlessTile } from '../services/seamless.js';
import { applyStylePost } from '../services/stylePost.js';
import { runAnchorGate } from '../services/anchorGate.js';

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

  /**
   * Crop one image file to a rectangle, byte-faithfully — deterministic,
   * free, no AI. The scene strip's panel crop. NOT the sprite forge's
   * /api/image/crop: that one chroma-keys an opaque source on the way
   * through, which would mangle a painted panel.
   */
  app.post<{ Body: CropRectRequest }>('/api/image/crop-rect', async (req) => {
    const b = req.body ?? ({} as CropRectRequest);
    if (!b.assetId || !b.sourceFile) throw new LibraryError(400, 'assetId and sourceFile required');
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    const x = Math.max(0, Math.floor(b.x));
    const y = Math.max(0, Math.floor(b.y));
    const w = Math.min(raw.width - x, Math.floor(b.w));
    const h = Math.min(raw.height - y, Math.floor(b.h));
    if (w < 8 || h < 8) throw new LibraryError(400, 'crop rectangle too small');
    const [cell] = pipe.extractBoxes(raw, [{ x, y, w, h }]);
    const png = await pipe.toPng(cell!);
    const rel = await save(b.assetId, b.outName && /^[\w.-]+\.png$/.test(b.outName) ? b.outName : `crop_${Date.now().toString(36)}.png`, png);
    return { fileRef: { path: rel, width: w, height: h } };
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
    cells = applyStylePost(cells, getStylePreset(b.styleId));

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
      if (!pipe.hasTransparency(raw)) {
        raw = pipe.removeBackground(raw, Math.min(Math.max(b.tolerance ?? 24, 0), 64), 'both');
      }
      return { boxes: pipe.detectSpriteCells(raw) };
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
      pad?: number;
    };
  }>('/api/image/crop', async (req) => {
    const b = req.body ?? ({} as { assetId: string; sourceFile: string; box: pipe.CellBox; outName: string });
    if (!b.assetId || !b.sourceFile || !b.box || !SAFE_OUT.test(b.outName ?? '')) {
      throw new LibraryError(400, 'assetId, sourceFile, box and a valid outName required');
    }
    let raw = await pipe.loadRaw(await loadSource(b.sourceAssetId ?? b.assetId, b.sourceFile));
    if (!pipe.hasTransparency(raw)) raw = pipe.removeBackground(raw, 24, 'both');
    let box = b.box;
    if (b.pad && b.pad > 0) {
      // Grow the box by a fraction of its longest side, clamped to the source —
      // content cut off at the source edge stays edge-touching so the anchor
      // gate can detect it.
      const p = Math.round(Math.max(box.w, box.h) * Math.min(b.pad, 0.5));
      const x = Math.max(0, box.x - p);
      const y = Math.max(0, box.y - p);
      box = {
        x,
        y,
        w: Math.min(raw.width - x, box.w + (box.x - x) + p),
        h: Math.min(raw.height - y, box.h + (box.y - y) + p),
      };
    }
    const cell = pipe.extractBoxes(raw, [box])[0]!;
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

  /** Horizontal mirror — the east anchor is a free, computed flip of west. */
  app.post<{ Body: FlipRequest }>('/api/image/flip', async (req) => {
    const b = req.body ?? ({} as FlipRequest);
    if (!b.assetId || !b.sourceFile || !SAFE_OUT.test(b.outName ?? '')) {
      throw new LibraryError(400, 'assetId, sourceFile and a valid outName required');
    }
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    // mirror:false is a straight copy — re-filing an anchor under another view.
    let out = b.mirror === false ? raw : pipe.flipHorizontal(raw);
    let pivot = b.pivot;
    if (b.mirror !== false && pivot) pivot = { x: 1 - pivot.x, y: pivot.y };
    if (b.rotate) {
      if (pivot) {
        const turned = await pipe.rotateAboutPivot(out, b.rotate, pivot);
        out = turned.img;
        pivot = turned.pivot;
      } else {
        out = await pipe.rotateImage(out, b.rotate);
      }
    }
    const rel = await save(b.assetId, b.outName, await pipe.toPng(out));
    // Frame boxes travel with the image, so a derived sheet stays sliceable.
    const boxes = b.boxes?.map((box) =>
      pipe.transformBox(box, raw.width, raw.height, {
        mirror: b.mirror !== false,
        rotate: b.rotate,
      }),
    );
    return {
      fileRef: { path: rel, width: out.width, height: out.height },
      ...(boxes ? { boxes } : {}),
      ...(pivot ? { pivot } : {}),
    };
  });

  /**
   * Anchor lock gate (Sprite Pipeline v2 §C2.2, BLOCKING) — deterministic
   * checks on a picked neutral anchor; no writes, no credits.
   */
  app.post<{ Body: AnchorGateRequest }>('/api/image/anchor-gate', async (req) => {
    const b = req.body ?? ({} as AnchorGateRequest);
    if (!b.assetId || !b.sourceFile) throw new LibraryError(400, 'assetId and sourceFile required');
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    return runAnchorGate(raw);
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
    } else {
      groups = pipe.detectSpriteCells(raw, { expected: b.expectedFrames }).map((box) => [box]);
    }
    if (groups.length === 0) {
      throw new LibraryError(422, 'No sprites detected — try REMOVE BACKGROUND first or adjust the image');
    }
    const boxes = groups.map((g) => pipe.unionBox(g));
    // Shared foot baseline + foot-centroid X across the clip's frames.
    let cells = pipe.registerCells(pipe.extractGroups(raw, groups));

    // bodyHeightPx wins when given (cross-clip height matching): scale so the
    // body measures the same in every clip of the character. Otherwise
    // targetFrameSize caps the longest side; 0 = keep native resolution.
    const target = b.targetFrameSize ?? 48;
    const w0 = cells[0]!.width;
    // Registration crops to content, so the frame height IS the body height.
    const h0 = cells[0]!.height;
    const scale =
      b.bodyHeightPx && b.bodyHeightPx > 0
        ? b.bodyHeightPx / h0
        : target > 0
          ? target / Math.max(w0, h0)
          : 1;
    if (Math.abs(scale - 1) > 0.001) {
      const tw = Math.max(1, Math.round(w0 * scale));
      const th = Math.max(1, Math.round(h0 * scale));
      cells = await Promise.all(cells.map((c) => pipe.resizeCell(c, tw, th, 'nearest')));
    }
    // Style postSteps run per clip AFTER the downscale: the nearest resize put
    // the pixels on the final grid, these steps make them read as the style.
    cells = applyStylePost(cells, getStylePreset(b.styleId));
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
      bodyHeight: th,
    };
  });

  /**
   * Compose the master sheet from per-animation strips: one animation per row,
   * all frames normalized to a shared cell size, bottom-centered.
   */
  app.post<{
    Body: {
      assetId: string;
      styleId?: string;
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
    // Normalize every frame across ALL animations to one cell size, sharing a
    // ground line and a foot-centroid X (§C5). registerCells, not
    // trimAndCenter: bbox-centering re-introduces exactly the horizontal
    // jitter registration removed — a reaching arm drags the body sideways —
    // and this sheet is what gets saved and exported.
    let all = partCells.flat();
    all = pipe.registerCells(all);
    // One shared palette across the WHOLE master sheet, so clips can't drift
    // in color from each other.
    all = applyStylePost(all, getStylePreset(b.styleId));
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

  /**
   * Drop one tile from a packed tileset and repack the rest, preserving
   * order. The caller must remap its world data with the returned mapping:
   * a removed tile's cells become -1 and everything after it shifts down —
   * doing that silently would repaint a level with the wrong art.
   */
  app.post<{
    Body: { assetId: string; sourceFile: string; tileWidth: number; tileHeight: number; index: number };
  }>('/api/image/remove-tile', async (req) => {
    const b = req.body ?? ({} as { assetId: string; sourceFile: string; tileWidth: number; tileHeight: number; index: number });
    if (!b.assetId || !b.sourceFile || !b.tileWidth || !b.tileHeight || b.index === undefined) {
      throw new LibraryError(400, 'assetId, sourceFile, tileWidth, tileHeight and index required');
    }
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    const cols = Math.max(1, Math.floor(raw.width / b.tileWidth));
    const rows = Math.max(1, Math.floor(raw.height / b.tileHeight));
    const cells = pipe.cutCells(raw, { cols, rows });
    if (b.index < 0 || b.index >= cells.length) {
      throw new LibraryError(400, `index ${b.index} is outside the ${cells.length}-tile set`);
    }
    const kept = cells.filter((_, i) => i !== b.index);
    if (kept.length === 0) throw new LibraryError(400, 'A tileset needs at least one tile');

    // old index -> new index (-1 for the removed tile).
    const indexMap = cells.map((_, i) => (i === b.index ? -1 : i < b.index ? i : i - 1));
    const packed = pipe.packCells(kept, Math.min(kept.length, 8));
    const png = await pipe.toPng(packed);
    const rel = await save(b.assetId, 'tileset.png', png);
    const thumbRel = await save(b.assetId, 'thumb.png', await pipe.makeThumbnail(png));
    return {
      tileset: { path: rel, width: packed.width, height: packed.height },
      tileWidth: b.tileWidth,
      tileHeight: b.tileHeight,
      tileCount: kept.length,
      indexMap,
      thumbnail: thumbRel,
    };
  });

  /**
   * Make chosen tiles tile: offset each by half and heal the exposed cross
   * seam (services/seamless.ts). Deterministic and free — no model can be
   * trusted to draw a wrapping texture, so we build one from what it drew.
   */
  app.post<{
    Body: {
      assetId: string;
      sourceFile: string;
      tileWidth: number;
      tileHeight: number;
      index: number;
      mode?: 'offset' | 'h' | 'v' | 'both';
      band?: number;
    };
  }>('/api/image/seamless-variant', async (req) => {
    const b = req.body ?? ({} as { assetId: string; sourceFile: string; tileWidth: number; tileHeight: number; index: number });
    if (!b.assetId || !b.sourceFile || !b.tileWidth || !b.tileHeight || b.index === undefined) {
      throw new LibraryError(400, 'assetId, sourceFile, tileWidth, tileHeight and index required');
    }
    const raw = await pipe.loadRaw(await loadSource(b.assetId, b.sourceFile));
    const cols = Math.max(1, Math.floor(raw.width / b.tileWidth));
    const rows = Math.max(1, Math.floor(raw.height / b.tileHeight));
    const cells = pipe.cutCells(raw, { cols, rows });
    const source = cells[b.index];
    if (!source) throw new LibraryError(400, `index ${b.index} is outside the ${cells.length}-tile set`);

    // APPEND the wrapping version rather than overwriting the original: the
    // source tile keeps its look for props and edges, and any map already
    // painted with it stays exactly as it was.
    const variant = makeSeamlessTile(source, b.mode ?? 'offset', b.band ? { band: b.band } : {});
    const next = [...cells, variant];
    const packed = pipe.packCells(next, Math.min(next.length, 8));
    const png = await pipe.toPng(packed);
    const rel = await save(b.assetId, 'tileset.png', png);
    const thumbRel = await save(b.assetId, 'thumb.png', await pipe.makeThumbnail(png));
    return {
      tileset: { path: rel, width: packed.width, height: packed.height },
      thumbnail: thumbRel,
      newIndex: next.length - 1,
      tileCount: next.length,
      /** Wrap continuity 0-100 before and after, so the UI can prove it helped. */
      before: Math.round(wrapContinuity(source) * 100),
      after: Math.round(wrapContinuity(variant) * 100),
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
    /**
     * World Maker v2 §W1: score the cut set the way animations are scored —
     * seams, palette cohesion, fill, drawn grid lines, duplicates. Advisory
     * (the tileset is saved either way); the UI surfaces it and the retry
     * loop can feed `hints` back into the next attempt.
     */
    let gate: Awaited<ReturnType<typeof gateTiles>> | undefined;
    try {
      gate = await gateTiles(cells, {
        expectedTiles: b.cols * b.rows,
        ...(b.seamlessIndexes ? { seamlessIndexes: b.seamlessIndexes } : {}),
      });
      req.log.info(
        { score: gate.score, pass: gate.pass, failed: gate.failedTiles, hints: gate.hints },
        'tile gate report',
      );
    } catch (err) {
      req.log.warn({ err }, 'tile gate failed — returning the tileset ungated');
    }
    return {
      tileset: { path: rel, width: packed.width, height: packed.height },
      tileWidth: size,
      tileHeight: size,
      tileCount: cells.length,
      indexMap,
      thumbnail: thumbRel,
      ...(gate
        ? {
            gate: {
              score: gate.score,
              pass: gate.pass,
              failedTiles: gate.failedTiles,
              hints: gate.hints,
            },
          }
        : {}),
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
