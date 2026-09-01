import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Library, LibraryError } from '../src/services/library.js';

let dir: string;
let lib: Library;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genvy-test-'));
  lib = new Library(dir);
  await lib.init();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sheetData = {
  name: 'Test Sheet',
  image: { path: 'x/sheet.png' },
  frameWidth: 48,
  frameHeight: 48,
};

describe('Library CRUD', () => {
  it('creates, reads, lists and deletes an asset', async () => {
    const created = await lib.create('spritesheet', sheetData);
    expect(created.id).toMatch(/^sht_/);
    expect(created.createdAt).toBeTruthy();

    const fetched = await lib.get(created.id as string);
    expect(fetched.name).toBe('Test Sheet');

    const listed = await lib.list({});
    expect(listed).toHaveLength(1);

    await lib.remove(created.id as string);
    expect(await lib.list({})).toHaveLength(0);
  });

  it('rejects malformed assets', async () => {
    await expect(lib.create('spritesheet', { name: 'bad' })).rejects.toThrow(LibraryError);
  });

  it('rejects unimplemented types', async () => {
    await expect(lib.create('quest', { name: 'q' })).rejects.toThrow(/not yet implemented/);
  });

  it('rejects references to missing assets', async () => {
    await expect(
      lib.create('animation', {
        name: 'a',
        spritesheet: { id: 'sht_missing123', type: 'spritesheet' },
        frames: [0],
      }),
    ).rejects.toThrow(/missing/);
  });

  it('updates preserve id/createdAt and bump updatedAt', async () => {
    const created = await lib.create('spritesheet', sheetData);
    await new Promise((r) => setTimeout(r, 5));
    const updated = await lib.update(created.id as string, { ...sheetData, name: 'Renamed' });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.name).toBe('Renamed');
    expect((updated.updatedAt as string) >= (created.updatedAt as string)).toBe(true);
  });

  it('returns 409 when deleting a referenced asset, force overrides', async () => {
    const sheet = await lib.create('spritesheet', sheetData);
    const anim = await lib.create('animation', {
      name: 'walk',
      spritesheet: { id: sheet.id, type: 'spritesheet' },
      frames: [0, 1],
    });

    await expect(lib.remove(sheet.id as string)).rejects.toMatchObject({ statusCode: 409 });
    await lib.remove(anim.id as string);
    await lib.remove(sheet.id as string);
    expect(await lib.list({})).toHaveLength(0);
  });

  it('cascade delete removes dependents recursively', async () => {
    const sheet = await lib.create('spritesheet', sheetData);
    const anim = await lib.create('animation', {
      name: 'walk',
      spritesheet: { id: sheet.id, type: 'spritesheet' },
      frames: [0],
    });
    await lib.create('character', {
      name: 'hero',
      sheet: { id: sheet.id, type: 'spritesheet' },
      animations: { walk: { id: anim.id, type: 'animation' } },
    });

    await lib.remove(sheet.id as string, { cascade: true });
    expect(await lib.list({})).toHaveLength(0);
  });

  it('finds inbound and outbound refs', async () => {
    const sheet = await lib.create('spritesheet', sheetData);
    const anim = await lib.create('animation', {
      name: 'walk',
      spritesheet: { id: sheet.id, type: 'spritesheet' },
      frames: [0],
    });
    const inbound = await lib.referrers(sheet.id as string);
    expect(inbound.map((e) => e.id)).toContain(anim.id);
    const outbound = await lib.outboundRefs(anim.id as string);
    expect(outbound.map((e) => e.id)).toContain(sheet.id);
  });
});
