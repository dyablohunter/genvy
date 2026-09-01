/**
 * Manual AI smoke test — SPENDS REAL API CREDITS. Run sparingly:
 *   npm run smoke:ai -w server
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CharacterConceptSchema } from '@genvy/shared';
import { generateJson } from '../src/services/deepseek.js';
import { generateImage } from '../src/services/openaiImage.js';
import { SPRITE_CONCEPT_SYSTEM, spriteSheetImagePrompt } from '../src/prompts/index.js';
import * as pipe from '../src/services/imagePipeline.js';
import { config } from '../src/config.js';

async function main() {
  console.log('1/3 DeepSeek concept generation...');
  const concept = await generateJson(
    SPRITE_CONCEPT_SYSTEM,
    'a small grumpy robot janitor',
    CharacterConceptSchema,
  );
  console.log('   OK:', concept.name, '-', concept.imagePrompt.slice(0, 80));

  console.log('2/3 GPT image generation (low quality, portrait)...');
  const png = await generateImage(spriteSheetImagePrompt(concept.imagePrompt), 'portrait');
  const outDir = path.join(config.libraryDir, 'files', 'smoke-test');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'raw.png'), png);
  console.log('   OK: saved', path.join(outDir, 'raw.png'));

  console.log('3/3 Full pipeline: remove-bg -> slice -> pack...');
  const raw = await pipe.loadRaw(png);
  const keyed = pipe.removeBackground(raw, 24, 'both');
  let cells = pipe.cutCells(keyed, { cols: 4, rows: 6 });
  cells = pipe.trimAndCenter(cells);
  cells = await Promise.all(cells.map((c) => pipe.resizeCell(c, 48, 48, 'nearest')));
  const packed = pipe.packCells(cells, 4);
  await fs.writeFile(path.join(outDir, 'sheet.png'), await pipe.toPng(packed));
  console.log('   OK: saved', path.join(outDir, 'sheet.png'), `(${packed.width}x${packed.height})`);
  console.log('SMOKE TEST PASSED — inspect the PNGs visually.');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
