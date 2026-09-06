/**
 * Download every model file a local family needs, into a ComfyUI install.
 *
 *   npm run fetch-models -w local-inference -- --list
 *   npm run fetch-models -w local-inference -- z-image-turbo
 *   npm run fetch-models -w local-inference -- --all --comfy /path/to/ComfyUI
 *
 * Free (no API credits), resumable in the sense that completed files are
 * skipped, and safe to re-run: a partial download lands on a .part file and
 * is only moved into place once the whole body has arrived, so an
 * interrupted run can never leave ComfyUI with a truncated model.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { MODEL_MANIFEST, REQUIRED_CUSTOM_NODES, familyDownloadSize } from '../src/modelManifest.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const families = args.filter((a) => !a.startsWith('--') && a in MODEL_MANIFEST);
const comfyDir =
  value('--comfy') ??
  process.env.COMFYUI_DIR ??
  path.resolve(process.cwd(), '..', '..', 'ComfyUI');

function human(gb: number) {
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
}

if (flag('--list') || (families.length === 0 && !flag('--all'))) {
  console.log('\nModel sets (download sizes are approximate):\n');
  for (const [family, manifest] of Object.entries(MODEL_MANIFEST)) {
    console.log(`  ${family}  —  ${human(familyDownloadSize(family))} total`);
    for (const f of manifest.files) {
      console.log(`      ${human(f.gb).padStart(8)}  ${f.dest}  (${f.role})`);
    }
  }
  console.log('\nCustom ComfyUI nodes required:');
  for (const n of REQUIRED_CUSTOM_NODES) console.log(`      ${n.url}  (${n.why})`);
  console.log(`\nComfyUI install: ${comfyDir}`);
  console.log('Usage: npm run fetch-models -w local-inference -- <family|--all> [--comfy DIR]\n');
  process.exit(0);
}

const wanted = flag('--all') ? Object.keys(MODEL_MANIFEST) : families;

async function download(url: string, dest: string) {
  const abs = path.join(comfyDir, 'models', dest);
  const part = `${abs}.part`;
  await fsp.mkdir(path.dirname(abs), { recursive: true });

  const existing = await fsp.stat(abs).catch(() => null);
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
  const expected = Number(head?.headers.get('content-length') ?? 0);
  if (existing && (!expected || existing.size === expected)) {
    console.log(`  ✓ ${dest} (already present)`);
    return;
  }

  process.stdout.write(`  ↓ ${dest} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? expected ?? 0);
  let seen = 0;
  let lastPrint = Date.now();
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (total && Date.now() - lastPrint > 2000) {
      lastPrint = Date.now();
      process.stdout.write(`\r  ↓ ${dest} ... ${((seen / total) * 100).toFixed(0)}%   `);
    }
  });
  await pipeline(source, fs.createWriteStream(part));
  await fsp.rename(part, abs); // only a COMPLETE file lands where ComfyUI looks
  process.stdout.write(`\r  ✓ ${dest} (${human(seen / 1e9)})            \n`);
}

async function main() {
  const comfyExists = await fsp.stat(comfyDir).catch(() => null);
  if (!comfyExists) {
    console.error(
      `\nComfyUI not found at ${comfyDir}\n` +
        'Pass --comfy <dir> or set COMFYUI_DIR. See docs/local-inference-setup.md.\n',
    );
    process.exit(1);
  }

  const totalGb = wanted.reduce((s, f) => s + familyDownloadSize(f), 0);
  console.log(`\nFetching ${wanted.join(', ')} into ${comfyDir}/models  (~${human(totalGb)})\n`);

  for (const family of wanted) {
    console.log(`${family}:`);
    for (const file of MODEL_MANIFEST[family]!.files) {
      try {
        await download(file.url, file.dest);
      } catch (err) {
        console.error(`  ✗ ${file.dest}: ${(err as Error).message}`);
      }
    }
  }

  console.log('\nCustom nodes (clone into ComfyUI/custom_nodes, then restart ComfyUI):');
  for (const n of REQUIRED_CUSTOM_NODES) console.log(`  git clone ${n.url}`);
  console.log('\nDone. Start ComfyUI, then: npm run dev:local\n');
}

void main();
