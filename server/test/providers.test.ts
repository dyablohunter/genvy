import { describe, it, expect } from 'vitest';
import {
  StyleContractSchema,
  stylePresets,
  styleGroups,
  getStylePreset,
  getSubject,
} from '@genvy/shared';
import { TOOL_SYSTEM_PROMPTS, PROMPT_SANITIZE_SYSTEM } from '../src/prompts/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ProviderRegistry } from '../src/providers/index.js';
import { animationToSheet } from '../src/providers/retrodiffusion.js';
import {
  variantsImagePrompt,
  animationStripImagePrompt,
  neutralAnchorImagePrompt,
  neutralResetEditPrompt,
  directionalAnchorEditPrompt,
  choreographyBlock,
  classifyMotion,
  backgroundBlock,
} from '../src/prompts/index.js';

const emptyCfg = {
  openaiApiKey: '',
  retroDiffusionApiKey: '',
  // A port where nothing listens — the local provider must sit offline.
  localInferenceUrl: 'http://127.0.0.1:59998',
};

describe('provider registry', () => {
  it('registers all three providers, offline without keys/service', () => {
    const reg = new ProviderRegistry(emptyCfg);
    const status = reg.status();
    expect(status.map((s) => s.id).sort()).toEqual(['local-comfy', 'openai', 'retrodiffusion']);
    expect(status.every((s) => !s.live)).toBe(true);
  });

  it('marks only the local provider FREE, and prices it at zero', () => {
    const reg = new ProviderRegistry(emptyCfg);
    const free = Object.fromEntries(reg.status().map((s) => [s.id, s.free]));
    expect(free).toEqual({ 'local-comfy': true, openai: false, retrodiffusion: false });
    const local = reg.get('local-comfy')!;
    expect(local.capabilities.costEstimate({ prompt: 'x', orientation: 'portrait' })).toBe(0);
    expect(
      local.capabilities.costEstimate({ anchor: Buffer.alloc(0), action: 'walk', frames: 8 }),
    ).toBe(0);
  });

  it('local provider routes like an animator AND an editor, by capability only', () => {
    const local = new ProviderRegistry(emptyCfg).get('local-comfy')!;
    expect(local.capabilities.animation && !!local.animate).toBe(true);
    expect(local.capabilities.edit).toBe(true);
    expect(local.capabilities.generate).toBe(true);
  });

  it('only gpt-image-2 claims one-call candidate grids; others get server-side composition', () => {
    const reg = new ProviderRegistry(emptyCfg);
    // Verified live: one "2x2 grid" ask to local SDXL produced five strips
    // of noise; Retro Diffusion draws one sprite per call by design.
    const grids = Object.fromEntries(reg.all().map((p) => [p.id, p.capabilities.gridSheets]));
    expect(grids).toEqual({ openai: true, retrodiffusion: false, 'local-comfy': false });
  });

  it('goes live per provider when its key is present', () => {
    const reg = new ProviderRegistry({ ...emptyCfg, retroDiffusionApiKey: 'k' });
    expect(reg.get('retrodiffusion')?.live).toBe(true);
    expect(reg.get('openai')?.live).toBe(false);
  });

  it('resolve: defaults to openai, 400 on unknown, 503 on offline', () => {
    const reg = new ProviderRegistry({ ...emptyCfg, openaiApiKey: 'k' });
    expect(reg.resolve(undefined).id).toBe('openai');
    expect(() => reg.resolve('nope')).toThrowError(/Unknown image provider/);
    try {
      reg.resolve('retrodiffusion');
      expect.unreachable();
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(503);
    }
  });

  it('routes animations by capability: retro animates, gpt-image-2 edits', () => {
    const reg = new ProviderRegistry(emptyCfg);
    const retro = reg.get('retrodiffusion')!;
    // The animation route prefers animate() when a provider owns the endpoint.
    expect(retro.capabilities.animation && !!retro.animate).toBe(true);
    expect(retro.capabilities.edit).toBe(false);
    const openai = reg.get('openai')!;
    expect(openai.capabilities.edit).toBe(true);
    expect(openai.capabilities.animation).toBe(false);
  });

  it('prices an animation by its own request, not as a generation', () => {
    const retro = new ProviderRegistry(emptyCfg).get('retrodiffusion')!;
    const generate = retro.capabilities.costEstimate({ prompt: 'x', orientation: 'portrait' });
    const animate = retro.capabilities.costEstimate({
      anchor: Buffer.alloc(0),
      action: 'walk',
      frames: 8,
    });
    // Dashboard truth: $0.180 per generation, $0.140 per animation.
    expect(generate).toBe(18);
    expect(animate).toBe(14);
    expect(animate).not.toBe(generate);
  });

  it('every registered provider delivers real alpha (sheets need it)', () => {
    const reg = new ProviderRegistry(emptyCfg);
    expect(reg.all().every((p) => p.capabilities.nativeAlpha)).toBe(true);
  });

  it('recommends retrodiffusion for pixel-style animation only when live', () => {
    const offline = new ProviderRegistry(emptyCfg);
    expect(offline.recommendFor('animation', 'pixel-16bit')).toBe('openai');
    const live = new ProviderRegistry({ ...emptyCfg, retroDiffusionApiKey: 'k' });
    expect(live.recommendFor('animation', 'pixel-16bit')).toBe('retrodiffusion');
    expect(live.recommendFor('anchor', 'pixel-16bit')).toBe('openai');
  });
});

describe('animationToSheet', () => {
  // 16x16, 4 pages — downscaled from a real Retro Diffusion animation response.
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = () => fs.readFile(path.join(testDir, 'fixtures', 'rd-anim.gif'));

  it('decomposes an animated gif into a horizontal PNG strip', async () => {
    const sheet = await animationToSheet(await fixture());
    const meta = await sharp(sheet).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(64); // 4 frames of 16px side by side
    expect(meta.height).toBe(16);
    expect(meta.channels).toBe(4);
  });

  it('passes single-frame images through as PNG', async () => {
    const single = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 9, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const sheet = await animationToSheet(single);
    const meta = await sharp(sheet).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(8);
  });
});

describe('concept prompt guards', () => {
  it('forbids style language in imagePrompt and defers styleId to the user', () => {
    const p = TOOL_SYSTEM_PROMPTS['sprite']!;
    // The style contract owns rendering; style words in imagePrompt fight it.
    expect(p).toMatch(/NEVER write art-style, medium or rendering language/);
    expect(p).toMatch(/echo its id in styleId/);
    expect(p).toMatch(/echo that id back unchanged/);
    // Every style id is still offered for the no-context case.
    for (const id of Object.keys(stylePresets)) expect(p).toContain(id);
  });

  it('spells out the trademark transformation instead of a vague warning', () => {
    const p = TOOL_SYSTEM_PROMPTS['sprite']!;
    for (const rule of [/COLOR COMBINATION/, /emblem/i, /FINAL CHECK/]) expect(p).toMatch(rule);
    // The sanitizer must demand real changes — a light touch is rejected twice.
    expect(PROMPT_SANITIZE_SYSTEM).toMatch(/change ALL of these/);
  });
});

describe('style contracts', () => {
  it('ships a valid, self-consistent contract for every style', () => {
    for (const [id, preset] of Object.entries(stylePresets)) {
      // The key IS the id — a mismatch silently breaks lookup by styleId.
      expect(StyleContractSchema.parse(preset).id, id).toBe(id);
      expect(preset.name.length, id).toBeGreaterThan(0);
    }
    expect(getStylePreset('nope')).toBeUndefined();
    expect(getStylePreset(undefined)).toBeUndefined();
  });

  it('groups every style exactly once, for the picker', () => {
    const grouped = styleGroups.flatMap((g) => g.ids);
    expect(new Set(grouped).size, 'a style is listed in two groups').toBe(grouped.length);
    // No orphans (invisible in the UI) and no phantoms (empty options).
    expect([...grouped].sort()).toEqual(Object.keys(stylePresets).sort());
    expect(styleGroups[0]!.ids[0]).toBe('default'); // the picker's default
  });

  it('pixel presets carry pixel post-steps, painterly does not', () => {
    expect(stylePresets['pixel-16bit']?.postSteps).toContain('pixelSnap');
    expect(stylePresets['painterly']?.postSteps).toHaveLength(0);
    // Every pixel family member gets the pixel post-processing; nothing else does.
    for (const [id, preset] of Object.entries(stylePresets)) {
      const isPixel = id.startsWith('pixel');
      expect(preset.postSteps.includes('pixelSnap')).toBe(isPixel);
      expect(preset.postSteps.includes('quantize')).toBe(isPixel);
    }
    // 'default' must stay influence-free: no prompt text, no post steps.
    expect(stylePresets['default']?.promptBlock).toBe('');
    expect(stylePresets['default']?.negativeBlock).toBe('');
    expect(stylePresets['default']?.postSteps).toHaveLength(0);
  });
});

/** Prompts are wrapped for readability, so assert on flattened whitespace. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('prompt scaffolds', () => {
  it('backgroundBlock: transparent vs mandatory chroma with color exclusion', () => {
    expect(backgroundBlock('transparent')).toMatch(/fully transparent/i);
    const chroma = backgroundBlock('chroma');
    expect(chroma).toContain('#FF00FF');
    expect(chroma).toMatch(/NO magenta/i);
  });

  it('variants prompt keeps 2x2 mechanics and adds negative failure modes', () => {
    const p = flat(variantsImagePrompt('a cactus knight', { pose: 'T-pose', styleHint: 'painterly' }));
    expect(p).toContain('2x2 grid');
    expect(p).toContain('a cactus knight');
    expect(p).toContain('T-pose');
    expect(p).toMatch(/never draw two characters side by side/);
    expect(p).toMatch(/fully transparent/i);
  });

  it('animation prompt: role annotation, anchor lock, choreography, frame count', () => {
    const p = flat(animationStripImagePrompt('attack', 8, 'sword slash'));
    expect(p).toContain('Image 1 role: identity anchor');
    expect(p).toMatch(/This sheet owns MOTION ONLY/);
    expect(p).toContain('Frame 1:');
    expect(p).toContain('Frame 8:');
    expect(p).toContain('sword slash');
    expect(p).toMatch(/exactly 8 frames/);
  });

  it('walk gets the NEAR/FAR locomotion contract and a loop-closing frame', () => {
    const p = animationStripImagePrompt('walk', 6, '');
    expect(p).toMatch(/NEAR limb is closer to the camera/);
    expect(p).toMatch(/match frame 1 closely for a clean loop/);
    const attack = animationStripImagePrompt('attack', 6, '');
    expect(attack).not.toMatch(/NEAR limb/);
  });

  it('chroma background flows into sheet prompts for no-alpha providers', () => {
    const p = animationStripImagePrompt('idle', 4, '', { background: 'chroma' });
    expect(p).toContain('#FF00FF');
    expect(p).not.toMatch(/fully transparent \(true PNG alpha/);
  });

  it('grid layout override is honored', () => {
    const p = animationStripImagePrompt('run', 8, '', { gridCols: 4, gridRows: 2 });
    expect(p).toMatch(/4 columns and 2 rows/);
  });

  it('single mode drops every grid instruction (grid-incapable providers)', () => {
    const v = flat(variantsImagePrompt('a cactus knight', { single: true, pose: 'T-pose' }));
    expect(v).toContain('exactly ONE complete');
    expect(v).toContain('a cactus knight');
    expect(v).toContain('T-pose');
    // No layout INSTRUCTIONS — "no visible grid lines" in the negative
    // rules is fine (and wanted); "arrange a 2x2 grid" is not.
    expect(v).not.toMatch(/2x2|quadrant|arranged/i);
    const a = flat(neutralAnchorImagePrompt('Bramble', 'a cactus knight', { single: true }));
    expect(a).toContain('exactly ONE complete');
    expect(a).toMatch(/facing SOUTH/);
    expect(a).not.toMatch(/2x2|quadrant|arranged/i);
  });

  it('neutral anchor prompt: canonical pose, no props, 4 candidates', () => {
    const p = flat(neutralAnchorImagePrompt('Bramble', 'a cactus knight'));
    expect(p).toMatch(/facing SOUTH/);
    expect(p).toMatch(/NO held objects/);
    expect(p).toMatch(/4 candidate variants/);
    expect(p).toMatch(/256x256/);
  });

  it('neutral reset is a preserve/change contrastive edit', () => {
    const p = neutralResetEditPrompt('the flaming sword');
    expect(p).toMatch(/Preserve from Image 1/);
    expect(p).toMatch(/Change from Image 1: remove the flaming sword/);
  });

  it('directional anchor: west profile and north back-view pitfalls', () => {
    expect(directionalAnchorEditPrompt('Bramble', 'west')).toMatch(/facing left in profile/);
    expect(directionalAnchorEditPrompt('Bramble', 'north')).toMatch(/back view/);
    expect(directionalAnchorEditPrompt('Bramble', 'north')).toMatch(/Image 1 is the approved south-facing/);
  });

  it('speaks about the subject that is actually being drawn', () => {
    const vehicle = getSubject('vehicle');
    const anchor = flat(neutralAnchorImagePrompt('Rustback', 'a hauler truck', { subject: vehicle }));
    expect(anchor).toContain('SAME vehicle');
    expect(anchor).toContain('parked at rest');
    expect(anchor).not.toMatch(/character/);

    const sheet = flat(animationStripImagePrompt('drive', 6, '', { subject: vehicle }));
    expect(sheet).toContain('EXACT vehicle');
    expect(sheet).toMatch(/never draw two vehicles side by side/);

    // A pickup has no back view, so its anchor never claims a facing.
    const pickup = flat(neutralAnchorImagePrompt('Coin', 'a gold coin', { subject: getSubject('pickup') }));
    expect(pickup).not.toMatch(/facing SOUTH/);
    expect(pickup).toContain('clearest, most readable view');
  });

  it('classifyMotion buckets categories and marks loops', () => {
    expect(classifyMotion('walk')).toEqual({ kind: 'locomotion', loops: true });
    expect(classifyMotion('idle')).toEqual({ kind: 'idle', loops: true });
    expect(classifyMotion('attack')).toEqual({ kind: 'attack', loops: false });
    expect(classifyMotion('mystery-dance')).toEqual({ kind: 'generic', loops: false });
  });

  it('choreography emits exactly N frame lines for any count', () => {
    for (const n of [4, 6, 8, 10, 12]) {
      const block = choreographyBlock('attack', n);
      expect(block.match(/^Frame \d+:/gm)).toHaveLength(n);
    }
  });
});
