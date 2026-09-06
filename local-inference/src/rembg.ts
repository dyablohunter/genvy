import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Segmentation-based background removal via rembg (u2net), run out-of-process
 * in a Python that has it installed (REMBG_PYTHON — the ComfyUI venv is the
 * natural host). Three GPU rounds proved WHY this exists: SDXL treats "flat
 * chroma background" as a theme, not a screen — it decorates (sage panels,
 * magenta scenery), and color keying can never be robust against that. A
 * segmentation model does not care what the background is.
 *
 * Strictly optional and fail-open: no python, no rembg, or any error →
 * the original PNG comes back and the provider's chroma keyer remains the
 * fallback, so the service never gets WORSE than the pre-rembg behavior.
 */

const SCRIPT =
  'import sys\n' +
  'from rembg import remove\n' +
  'inp, out = sys.argv[1], sys.argv[2]\n' +
  "open(out, 'wb').write(remove(open(inp, 'rb').read()))\n";

let availability: Promise<boolean> | null = null;

/** One import probe per process — a missing rembg should cost one failed spawn, not one per frame. */
export function rembgAvailable(python: string): Promise<boolean> {
  if (!python) return Promise.resolve(false);
  availability ??= new Promise((resolve) => {
    execFile(python, ['-c', 'import rembg'], { timeout: 30_000 }, (err) => resolve(!err));
  });
  return availability;
}

/** Test seam: forget the cached probe. */
export function resetRembgCache() {
  availability = null;
}

export async function tryRemoveBackground(png: Buffer, python: string, workDir: string): Promise<Buffer> {
  if (!(await rembgAvailable(python))) return png;
  const id = randomUUID();
  const inp = path.join(workDir, `rembg-${id}-in.png`);
  const out = path.join(workDir, `rembg-${id}-out.png`);
  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(inp, png);
    await new Promise<void>((resolve, reject) => {
      // First call downloads the u2net weights (~170MB) — allow for it.
      execFile(python, ['-c', SCRIPT, inp, out], { timeout: 300_000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    return await fs.readFile(out);
  } catch {
    return png; // fail open — the chroma keyer downstream still gets its shot
  } finally {
    void fs.rm(inp, { force: true }).catch(() => {});
    void fs.rm(out, { force: true }).catch(() => {});
  }
}
