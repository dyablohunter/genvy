import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tryRemoveBackground, rembgAvailable, resetRembgCache } from '../src/rembg.js';

/**
 * The rembg step must be strictly optional and fail-open: a box without the
 * Python/rembg pair gets the original bytes back and the chroma keyer stays
 * the fallback — the service never degrades below its pre-rembg behavior.
 */

describe('rembg wrapper', () => {
  beforeEach(() => resetRembgCache());

  it('is unavailable with no python configured', async () => {
    expect(await rembgAvailable('')).toBe(false);
  });

  it('fails open: a missing executable returns the original buffer untouched', async () => {
    const png = Buffer.from('not-really-a-png');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genvy-rembg-'));
    const out = await tryRemoveBackground(png, 'definitely-not-a-real-python.exe', dir);
    expect(out.equals(png)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('caches the availability probe per process', async () => {
    const a = rembgAvailable('definitely-not-a-real-python.exe');
    const b = rembgAvailable('definitely-not-a-real-python.exe');
    expect(a).toBe(b); // same promise — one spawn, not one per frame
    expect(await a).toBe(false);
  });
});
