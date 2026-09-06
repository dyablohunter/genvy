import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { ExportSpriteRequest } from '@genvy/shared';
import { Library, LibraryError } from '../services/library.js';
import { createZip } from '../services/zip.js';

/**
 * Sprite Pipeline v2 §C6 — export a finished sprite for an engine.
 *
 * Everything the editor knows that a game needs is written out: the packed
 * sheet, ABSOLUTE per-frame rectangles (so an engine samples rects instead of
 * guessing a grid), the pivot per view (Phaser's setOrigin), animation
 * definitions with their playback order and frame rate, and the neutral
 * anchors. Two manifests are emitted:
 *
 *   <slug>.json         genvy manifest — everything, self-describing
 *   <slug>.atlas.json   Phaser/TexturePacker JSON Array atlas, loadable as-is
 *                       with this.load.atlas(key, png, atlasJson)
 *
 * Deterministic and free: no provider call, no credits.
 */

const SLUG = /[^a-z0-9]+/g;

function slugify(name: string): string {
  const s = name.toLowerCase().replace(SLUG, '-').replace(/^-|-$/g, '');
  return s.length > 0 ? s.slice(0, 60) : 'sprite';
}

export function registerExportRoutes(app: FastifyInstance, library: Library) {
  app.post<{ Body: ExportSpriteRequest }>('/api/export/sprite', async (req) => {
    const b = req.body ?? ({} as ExportSpriteRequest);
    if (!b.assetId || !b.sheetFile || !b.frameWidth || !b.frameHeight) {
      throw new LibraryError(400, 'assetId, sheetFile, frameWidth and frameHeight are required');
    }
    const sheetAbs = library.resolveFile(`${b.assetId}/${path.basename(b.sheetFile)}`);
    const png = await fs.readFile(sheetAbs).catch(() => {
      throw new LibraryError(404, `Sheet not found: ${b.sheetFile}`);
    });
    const meta = await sharp(png).metadata();
    const sheetW = meta.width ?? 0;
    const sheetH = meta.height ?? 0;
    const columns = Math.max(1, b.columns ?? Math.max(1, Math.floor(sheetW / b.frameWidth)));

    const slug = slugify(b.name ?? 'sprite');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dirName = `${slug}-${stamp}`;
    const outDir = path.join(library.exportsDir, dirName);
    await fs.mkdir(outDir, { recursive: true });

    // Every frame any animation actually plays, in a stable order.
    const used = new Map<number, string>();
    for (const anim of b.animations ?? []) {
      anim.frames.forEach((idx, pos) => {
        if (!used.has(idx)) used.set(idx, `${anim.name}_${pos}`);
      });
    }
    // A sheet with no animation metadata still exports every grid cell.
    if (used.size === 0) {
      const rows = Math.max(1, Math.floor(sheetH / b.frameHeight));
      for (let i = 0; i < rows * columns; i++) used.set(i, `frame_${i}`);
    }

    const pivotFor = (name: string) => {
      // Frames carry their view's pivot when one was placed in the editor.
      const dir = (b.animations ?? []).find((a) => name.startsWith(`${a.name}_`))?.direction;
      return (dir && b.pivots?.[dir]) || b.pivots?.south || undefined;
    };

    const frames = [...used.entries()]
      .sort((a, c) => a[0] - c[0])
      .map(([index, name]) => {
        const x = (index % columns) * b.frameWidth;
        const y = Math.floor(index / columns) * b.frameHeight;
        const pivot = pivotFor(name);
        return {
          index,
          name,
          x,
          y,
          w: b.frameWidth,
          h: b.frameHeight,
          ...(pivot
            ? {
                // Normalized (engine origin) and in pixels, for convenience.
                pivot: { x: pivot.x, y: pivot.y },
                pivotPx: {
                  x: Math.round(pivot.x * b.frameWidth),
                  y: Math.round(pivot.y * b.frameHeight),
                },
              }
            : {}),
        };
      });

    // Neutral anchors travel with the export — they are the identity reference.
    const anchorFiles: string[] = [];
    for (const [view, file] of Object.entries(b.anchors ?? {})) {
      if (!file) continue;
      try {
        const abs = library.resolveFile(`${b.assetId}/${path.basename(file)}`);
        const outName = `anchor-${view}.png`;
        await fs.copyFile(abs, path.join(outDir, outName));
        anchorFiles.push(outName);
      } catch {
        /* a missing anchor is not fatal for an export */
      }
    }

    const imageName = `${slug}.png`;
    await fs.writeFile(path.join(outDir, imageName), png);

    const manifest = {
      genvy: {
        manifestVersion: 1,
        exportedAt: new Date().toISOString(),
        scope: b.scope ?? 'full',
        subject: b.subject,
        styleId: b.styleId,
        sourceAssetId: b.assetId,
      },
      name: b.name,
      description: b.description,
      image: imageName,
      imageSize: { w: sheetW, h: sheetH },
      frameWidth: b.frameWidth,
      frameHeight: b.frameHeight,
      columns,
      /** Origin per view, normalized 0..1 — engine origin / Phaser setOrigin. */
      pivots: b.pivots ?? {},
      anchors: anchorFiles,
      frames,
      animations: (b.animations ?? []).map((a) => ({
        name: a.name,
        direction: a.direction,
        frameRate: a.frameRate,
        repeat: a.repeat ?? -1,
        frames: a.frames,
      })),
    };
    await fs.writeFile(path.join(outDir, `${slug}.json`), JSON.stringify(manifest, null, 2));

    // Phaser / TexturePacker "JSON Array" atlas — load.atlas() reads this as-is.
    const atlas = {
      frames: frames.map((f) => ({
        filename: f.name,
        frame: { x: f.x, y: f.y, w: f.w, h: f.h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
        sourceSize: { w: f.w, h: f.h },
        ...(f.pivot ? { pivot: f.pivot } : {}),
      })),
      meta: {
        app: 'genvy',
        version: '1',
        image: imageName,
        format: 'RGBA8888',
        size: { w: sheetW, h: sheetH },
        scale: '1',
      },
    };
    await fs.writeFile(path.join(outDir, `${slug}.atlas.json`), JSON.stringify(atlas, null, 2));

    const files = [imageName, `${slug}.json`, `${slug}.atlas.json`, ...anchorFiles];

    // One bundle to hand to an engine or a teammate, instead of N downloads.
    const zipName = `${slug}.zip`;
    const zip = await createZip(
      await Promise.all(
        files.map(async (f) => ({ name: f, data: await fs.readFile(path.join(outDir, f)) })),
      ),
    );
    await fs.writeFile(path.join(outDir, zipName), zip);

    return {
      dir: dirName,
      diskPath: outDir,
      // The bundle leads; the loose files stay available for a single grab.
      bundle: {
        name: zipName,
        url: `/library/exports/${dirName}/${zipName}`,
        bytes: zip.length,
        fileCount: files.length,
      },
      files: files.map((f) => ({ name: f, url: `/library/exports/${dirName}/${f}` })),
      frameCount: frames.length,
      animationCount: (b.animations ?? []).length,
    };
  });
}
