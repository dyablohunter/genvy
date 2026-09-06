/**
 * Manual provider smoke test — SPENDS REAL API CREDITS (~$0.25). Run sparingly:
 *   npm run smoke:providers -w server
 * Verifies Retro Diffusion live: one sprite, then one animation from it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { createRetroDiffusionProvider } from '../src/providers/retrodiffusion.js';

async function describePng(label: string, png: Buffer, file: string) {
  const meta = await sharp(png).metadata();
  const stats = await sharp(png).stats();
  const alpha = meta.channels === 4 ? stats.channels[3] : undefined;
  const hasAlpha = alpha ? alpha.min < 250 : false;
  console.log(
    `   OK: ${label} ${meta.width}x${meta.height} ${meta.format}, ` +
      `${meta.channels} channels, real transparency: ${hasAlpha} -> ${file}`,
  );
}

async function main() {
  const outDir = path.join(config.libraryDir, 'files', 'smoke-providers');
  await fs.mkdir(outDir, { recursive: true });

  console.log('1/2 Retro Diffusion sprite (remove_bg — expect real alpha)...');
  const rd = createRetroDiffusionProvider(config.retroDiffusionApiKey);
  if (!rd.live) throw new Error('RETRODIFFUSION_API_KEY missing');
  const rdSprite = await rd.generate({
    prompt: 'small grumpy robot janitor, full body, neutral idle stance facing the camera',
    orientation: 'portrait',
    transparent: true,
  });
  const rdSpriteFile = path.join(outDir, 'rd-sprite.png');
  await fs.writeFile(rdSpriteFile, rdSprite);
  await describePng('rd sprite', rdSprite, rdSpriteFile);

  console.log('2/2 Retro Diffusion animation (walking, 4 frames, anchored on the sprite)...');
  const rdAnim = await rd.animate!({
    anchor: rdSprite,
    action: 'walk',
    frames: 4,
    prompt: 'small robot janitor walking in place',
  });
  const rdAnimFile = path.join(outDir, 'rd-walk.png');
  await fs.writeFile(rdAnimFile, rdAnim);
  await describePng('rd animation', rdAnim, rdAnimFile);

  console.log('PROVIDER SMOKE TEST PASSED — inspect the PNGs visually.');
}

main().catch((err) => {
  console.error('PROVIDER SMOKE TEST FAILED:', err);
  process.exit(1);
});
