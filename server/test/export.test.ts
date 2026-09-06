import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import sharp from 'sharp';
import { Library } from '../src/services/library.js';
import { registerExportRoutes } from '../src/routes/export.js';

async function makeApp(root: string) {
  const library = new Library(root);
  await library.init();
  const app = Fastify();
  registerExportRoutes(app, library);
  return { app, library };
}

/** A 4x2 grid sheet of 10x20 cells. */
async function writeSheet(dir: string, name: string) {
  const png = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), png);
}

describe('engine export', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'genvy-export-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes absolute frame rects, pivots and a loadable Phaser atlas', async () => {
    const { app, library } = await makeApp(root);
    await writeSheet(path.join(library.filesDir, 'ws1'), 'sheet.png');

    const res = await app.inject({
      method: 'POST',
      url: '/api/export/sprite',
      payload: {
        assetId: 'ws1',
        sheetFile: 'sheet.png',
        name: 'Emerald Phoenix V1',
        scope: 'full',
        frameWidth: 10,
        frameHeight: 20,
        columns: 4,
        subject: 'creature',
        pivots: { south: { x: 0.5, y: 0.9 } },
        animations: [
          { name: 'idle_south', direction: 'south', frameRate: 6, frames: [0, 1, 2, 3] },
          { name: 'walk_south', direction: 'south', frameRate: 9, frames: [4, 5] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.frameCount).toBe(6);
    expect(body.animationCount).toBe(2);

    const dir = path.join(library.exportsDir, body.dir);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'emerald-phoenix-v1.json'), 'utf8'));
    // Rects are ABSOLUTE positions in the sheet, row-major over the grid.
    expect(manifest.frames[0]).toMatchObject({ index: 0, x: 0, y: 0, w: 10, h: 20 });
    expect(manifest.frames[4]).toMatchObject({ index: 4, x: 0, y: 20 });
    expect(manifest.frames[5]).toMatchObject({ index: 5, x: 10, y: 20 });
    // Pivot travels both normalized (engine origin) and in pixels.
    expect(manifest.frames[0].pivot).toEqual({ x: 0.5, y: 0.9 });
    expect(manifest.frames[0].pivotPx).toEqual({ x: 5, y: 18 });
    expect(manifest.animations.map((a: { name: string }) => a.name)).toEqual([
      'idle_south',
      'walk_south',
    ]);
    expect(manifest.genvy.subject).toBe('creature');

    // The Phaser atlas is a valid JSON-Array atlas naming the exported PNG.
    const atlas = JSON.parse(await fs.readFile(path.join(dir, 'emerald-phoenix-v1.atlas.json'), 'utf8'));
    expect(atlas.meta.image).toBe('emerald-phoenix-v1.png');
    expect(atlas.meta.size).toEqual({ w: 40, h: 40 });
    expect(atlas.frames[0]).toMatchObject({
      filename: 'idle_south_0',
      frame: { x: 0, y: 0, w: 10, h: 20 },
      rotated: false,
      trimmed: false,
    });
    // The image itself is copied beside the manifests.
    const png = await fs.readFile(path.join(dir, 'emerald-phoenix-v1.png'));
    expect((await sharp(png).metadata()).width).toBe(40);
  });

  it('copies the neutral anchors and survives a missing one', async () => {
    const { app, library } = await makeApp(root);
    const wsDir = path.join(library.filesDir, 'ws2');
    await writeSheet(wsDir, 'sheet.png');
    await writeSheet(wsDir, 'anchor-south.png');

    const res = await app.inject({
      method: 'POST',
      url: '/api/export/sprite',
      payload: {
        assetId: 'ws2',
        sheetFile: 'sheet.png',
        name: 'Gun',
        frameWidth: 20,
        frameHeight: 40,
        anchors: { south: 'anchor-south.png', west: 'anchor-west.png' }, // west absent
        animations: [{ name: 'idle_south', frameRate: 6, frames: [0, 1] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().files.map((f: { name: string }) => f.name);
    expect(names).toContain('anchor-south.png');
    expect(names).not.toContain('anchor-west.png');
  });

  it('bundles every produced file into one archive', async () => {
    const { app, library } = await makeApp(root);
    await writeSheet(path.join(library.filesDir, 'ws3'), 'sheet.png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/export/sprite',
      payload: {
        assetId: 'ws3',
        sheetFile: 'sheet.png',
        name: 'Bundled Sprite',
        frameWidth: 20,
        frameHeight: 40,
        animations: [{ name: 'idle_south', frameRate: 6, frames: [0, 1] }],
      },
    });
    const body = res.json();
    expect(body.bundle.name).toBe('bundled-sprite.zip');
    expect(body.bundle.fileCount).toBe(body.files.length);
    expect(body.bundle.bytes).toBeGreaterThan(0);
    // The zip is on disk beside the loose files, and is a real ZIP.
    const zip = await fs.readFile(path.join(library.exportsDir, body.dir, 'bundled-sprite.zip'));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.length).toBe(body.bundle.bytes);
  });

  it('rejects a sheet that does not exist', async () => {
    const { app } = await makeApp(root);
    const res = await app.inject({
      method: 'POST',
      url: '/api/export/sprite',
      payload: { assetId: 'nope', sheetFile: 'sheet.png', name: 'X', frameWidth: 8, frameHeight: 8 },
    });
    expect(res.statusCode).toBe(404);
  });
});
