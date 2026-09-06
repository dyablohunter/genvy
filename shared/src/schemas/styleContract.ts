import { z } from 'zod';

/**
 * Sprite Pipeline v2 — StyleContract (docs/sprite-pipeline-v2.md §B).
 *
 * Pixel art is ONE style preset, not the pipeline's identity: the same
 * generation stages serve every style, and only the prompt blocks plus the
 * style-specific post-steps vary per preset. The concept step writes the
 * chosen style onto the character asset; every downstream prompt interpolates
 * the same contract.
 *
 * Lesson baked into every preset (from sprite-gen research): the style text
 * must DEFER to the attached reference image — it never re-describes body
 * type or proportions, because a style block like "compact chibi" kept
 * bulking a slim base character during testing.
 */

export const StylePostStepSchema = z.enum(['quantize', 'pixelSnap', 'despill', 'outlineClean']);
export type StylePostStep = z.infer<typeof StylePostStepSchema>;

export const StyleContractSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  /** Appended to every image prompt for this style. Never describes proportions. */
  promptBlock: z.string().max(1500),
  /** Named failure modes to avoid for this style ("avoid: ..."). */
  negativeBlock: z.string().max(1500),
  /** Delivered-resolution multiple of the 256x256 logical frame (1|2|4). */
  deliveredScale: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  /** Deterministic post-processing steps the ETL applies for this style. */
  postSteps: z.array(StylePostStepSchema).default([]),
  /** Local-provider LoRA stack (P6); ignored by API providers. */
  loraStack: z
    .array(z.object({ name: z.string().min(1), strength: z.number().min(0).max(2) }))
    .optional(),
});
export type StyleContract = z.infer<typeof StyleContractSchema>;

/** Block appended to EDIT prompts so the style defers to the attached anchor. */
export const STYLE_DEFER_TO_REFERENCE =
  'Match the attached reference EXACTLY: same rendering density, body proportions, outline ' +
  'weight, palette, shading style, and level of detail. Do not restyle.';

export const stylePresets: Record<string, StyleContract> = {
  // First = the picker's default: no style influence at all. Prompts carry
  // only the user's own art direction, and no postSteps run.
  default: {
    id: 'default',
    name: 'Default',
    promptBlock: '',
    negativeBlock: '',
    deliveredScale: 1,
    postSteps: [],
  },
  'pixel-8bit': {
    id: 'pixel-8bit',
    name: 'Pixel 8-bit',
    promptBlock:
      '8-bit NES-era pixel art: very large chunky pixels on a coarse grid, a severely limited ' +
      'palette (roughly 8-16 colors, at most 3-4 per object), flat blocks of color with minimal ' +
      'shading and no gradients, bold simple silhouettes, hard pixel edges with no anti-aliasing, ' +
      'readable at very small size.',
    negativeBlock:
      'Avoid: smooth gradients, soft or blended shading, anti-aliased edges, painterly rendering, ' +
      '3D render, photorealism, fine detail, large color counts, dithering noise.',
    deliveredScale: 4,
    postSteps: ['quantize', 'pixelSnap', 'outlineClean'],
  },
  'pixel-16bit': {
    id: 'pixel-16bit',
    name: 'Pixel 16-bit',
    promptBlock:
      '16-bit era pixel art: chunky clearly visible pixels, crisp 1px dark outlines, flat cel ' +
      'shading with a limited cohesive palette (roughly 32 colors), hard pixel edges with no ' +
      'anti-aliasing, readable at small game scale.',
    negativeBlock:
      'Avoid: painterly rendering, 3D render, glossy lighting, soft gradients, anti-aliased ' +
      'high-detail edges, photorealism, dithering noise.',
    deliveredScale: 4,
    postSteps: ['quantize', 'pixelSnap', 'outlineClean'],
  },
  'pixel-hd': {
    id: 'pixel-hd',
    name: 'Pixel HD',
    promptBlock:
      'High-resolution modern pixel art: fine pixel clusters, clean selective outlines, rich ' +
      'but controlled palette, subtle pixel-level shading, hard edges with no anti-aliasing.',
    negativeBlock:
      'Avoid: painterly rendering, 3D render, glossy lighting, soft gradients, anti-aliased ' +
      'edges, photorealism.',
    deliveredScale: 2,
    postSteps: ['quantize', 'pixelSnap'],
  },
  painterly: {
    id: 'painterly',
    name: 'Painterly',
    promptBlock:
      'Painterly digital illustration: visible brushwork, soft blended shading, atmospheric ' +
      'color, confident silhouette read, edges may be soft but the figure stays crisp against ' +
      'the background.',
    negativeBlock:
      'Avoid: pixel art, visible pixel grid, dithering, hard cel outlines, photograph, 3D render.',
    deliveredScale: 1,
    postSteps: [],
  },
  cartoon: {
    id: 'cartoon',
    name: 'Cartoon',
    promptBlock:
      'Clean cartoon style: bold consistent outlines, flat vivid colors with simple two-tone ' +
      'cel shading, expressive readable shapes.',
    negativeBlock:
      'Avoid: pixel art, photorealism, 3D render, painterly texture, gradient-heavy rendering, ' +
      'sketchy broken linework.',
    deliveredScale: 1,
    postSteps: [],
  },
  'hand-drawn': {
    id: 'hand-drawn',
    name: 'Hand-drawn',
    promptBlock:
      'Hand-drawn ink-and-wash style: expressive slightly irregular ink linework, textured ' +
      'strokes, muted watercolor-like fills, deliberate sketch energy while keeping the ' +
      'silhouette clean and closed.',
    negativeBlock:
      'Avoid: pixel art, 3D render, photorealism, perfectly uniform vector lines, open or ' +
      'broken silhouette edges.',
    deliveredScale: 1,
    postSteps: [],
  },
  'flat-vector': {
    id: 'flat-vector',
    name: 'Flat vector',
    promptBlock:
      'Flat vector style: simple geometric shapes, completely flat fills, minimal or no ' +
      'outlines, restrained modern palette, no texture or grain.',
    negativeBlock:
      'Avoid: pixel art, gradients, painterly texture, 3D render, drop shadows, photorealism.',
    deliveredScale: 1,
    postSteps: [],
  },
  'pixel-monochrome': {
    id: 'pixel-monochrome',
    name: 'Pixel monochrome',
    promptBlock:
      'Monochrome Game Boy-style pixel art: exactly four values of one hue (classic olive-green ' +
      'or grayscale), chunky pixels, shading expressed only through those four values and ' +
      'dithering patterns, hard edges with no anti-aliasing.',
    negativeBlock:
      'Avoid: full color, gradients, anti-aliased edges, painterly rendering, 3D render, ' +
      'photorealism.',
    deliveredScale: 4,
    postSteps: ['quantize', 'pixelSnap', 'outlineClean'],
  },
  'pixel-isometric': {
    id: 'pixel-isometric',
    name: 'Pixel isometric',
    promptBlock:
      'Isometric pixel art: 2:1 isometric projection, clean pixel edges along the isometric ' +
      'axes, limited cohesive palette, flat cel shading with a consistent light direction, ' +
      'crisp readable volumes, no anti-aliasing.',
    negativeBlock:
      'Avoid: perspective distortion, front-on flat view, painterly rendering, 3D render, ' +
      'soft gradients, anti-aliased edges.',
    deliveredScale: 4,
    postSteps: ['quantize', 'pixelSnap', 'outlineClean'],
  },
  anime: {
    id: 'anime',
    name: 'Anime / cel',
    promptBlock:
      'Anime cel-shaded style: clean confident linework of varying weight, flat color fills with ' +
      'crisp two-tone shadow shapes, expressive stylized features, subtle rim light, ' +
      'production-cel cleanliness.',
    negativeBlock:
      'Avoid: pixel art, photorealism, 3D render, muddy painterly blending, sketchy broken ' +
      'linework, heavy texture.',
    deliveredScale: 1,
    postSteps: [],
  },
  comic: {
    id: 'comic',
    name: 'Comic / ink',
    promptBlock:
      'Western comic-book style: bold black ink outlines, dramatic hatching and spotted blacks ' +
      'for shadow, saturated flat colors over the inks, dynamic exaggerated forms.',
    negativeBlock:
      'Avoid: pixel art, photorealism, 3D render, soft airbrushed gradients, thin uniform ' +
      'vector lines, pastel washes.',
    deliveredScale: 1,
    postSteps: [],
  },
  storybook: {
    id: 'storybook',
    name: 'Storybook',
    promptBlock:
      "Children's storybook illustration: soft gouache and colored-pencil texture, warm friendly " +
      'shapes, gentle rounded proportions, cozy muted palette, visible paper grain.',
    negativeBlock:
      'Avoid: pixel art, 3D render, photorealism, harsh outlines, neon saturation, gritty ' +
      'texture, horror tone.',
    deliveredScale: 1,
    postSteps: [],
  },
  'dark-fantasy': {
    id: 'dark-fantasy',
    name: 'Dark fantasy',
    promptBlock:
      'Dark fantasy illustration: moody desaturated palette with one strong accent, heavy ' +
      'chiaroscuro lighting, weathered ornate detail, grim atmospheric mood, painterly but ' +
      'sharp silhouette.',
    negativeBlock:
      'Avoid: pixel art, bright cheerful palette, cartoon proportions, 3D render, ' +
      'photorealism, flat lighting.',
    deliveredScale: 1,
    postSteps: [],
  },
  'neon-cyber': {
    id: 'neon-cyber',
    name: 'Neon cyber',
    promptBlock:
      'Neon cyberpunk style: dark base tones lit by saturated neon rim light (cyan, magenta, ' +
      'electric green), glowing accents and emissive trim, high contrast, sleek techwear ' +
      'surfaces with subtle reflections.',
    negativeBlock:
      'Avoid: pastel palettes, daylight flat lighting, pixel art, photorealism, medieval ' +
      'fantasy trappings, muddy contrast.',
    deliveredScale: 1,
    postSteps: [],
  },
  watercolor: {
    id: 'watercolor',
    name: 'Watercolor',
    promptBlock:
      'Watercolor illustration: translucent washes with visible pigment blooms and edges, wet ' +
      'granular texture, soft color bleeds contained by a confident silhouette, light paper ' +
      'white left as highlight.',
    negativeBlock:
      'Avoid: pixel art, 3D render, photorealism, hard vector outlines, flat digital fills, ' +
      'neon saturation.',
    deliveredScale: 1,
    postSteps: [],
  },
  'clay-3d': {
    id: 'clay-3d',
    name: 'Clay / 3D toy',
    promptBlock:
      'Stylized 3D clay-render look: soft matte shading like modeling clay or vinyl toys, ' +
      'rounded chunky forms, gentle ambient occlusion, soft studio key light, playful tactile ' +
      'surfaces.',
    negativeBlock:
      'Avoid: pixel art, flat 2D vector, harsh outlines, photorealistic materials, gritty ' +
      'texture, motion blur.',
    deliveredScale: 1,
    postSteps: [],
  },
  'low-poly': {
    id: 'low-poly',
    name: 'Low poly',
    promptBlock:
      'Low-poly render style: visible flat triangular facets, faceted shading with hard ' +
      'boundaries between planes, simple bright palette, clean geometric silhouette.',
    negativeBlock:
      'Avoid: smooth organic surfaces, pixel art, painterly texture, photorealism, ' +
      'high-detail sculpting, soft gradients.',
    deliveredScale: 1,
    postSteps: [],
  },
  'pixel-1bit': {
    id: 'pixel-1bit',
    name: 'Pixel 1-bit',
    promptBlock:
      'Strict 1-bit pixel art: pure black and pure white only, no greys, shading expressed solely ' +
      'through dithering patterns and hatching, chunky pixels, bold readable silhouette.',
    negativeBlock:
      'Avoid: any color, grey tones, gradients, anti-aliasing, painterly rendering, 3D render, ' +
      'photorealism.',
    deliveredScale: 4,
    postSteps: ['quantize', 'pixelSnap', 'outlineClean'],
  },
  voxel: {
    id: 'voxel',
    name: 'Voxel',
    promptBlock:
      'Voxel art: the form built from visible cubic blocks of uniform size, crisp cube faces with ' +
      'flat per-face shading, clean stair-stepped edges, bright limited palette, isometric-friendly ' +
      'chunky volumes.',
    negativeBlock:
      'Avoid: smooth curved surfaces, organic sculpting, painterly texture, photorealism, ' +
      'motion blur, soft gradients.',
    deliveredScale: 1,
    postSteps: [],
  },
  'paper-cutout': {
    id: 'paper-cutout',
    name: 'Paper cutout',
    promptBlock:
      'Layered paper-craft style: shapes that read as cut construction paper with clean scissor ' +
      'edges, subtle drop shadows between stacked layers, matte fibrous paper texture, flat ' +
      'cheerful colors.',
    negativeBlock:
      'Avoid: pixel art, photorealism, 3D render, glossy surfaces, painterly blending, ' +
      'fine line detail.',
    deliveredScale: 1,
    postSteps: [],
  },
  'chalk-neon': {
    id: 'chalk-neon',
    name: 'Chalk / neon glow',
    promptBlock:
      'Glowing chalk-line style: bright luminous outlines that read as neon tubes or chalk on a ' +
      'dark board, soft outer glow, minimal or dark interior fills, high contrast against ' +
      'darkness.',
    negativeBlock:
      'Avoid: daylight scenes, flat matte fills without glow, pixel art, photorealism, ' +
      '3D render, pale washed-out colors.',
    deliveredScale: 1,
    postSteps: [],
  },
  'retro-vector': {
    id: 'retro-vector',
    name: 'Retro arcade vector',
    promptBlock:
      'Early-80s vector arcade look: bright thin glowing wireframe lines on black, simple ' +
      'geometric construction, phosphor bloom, few colors, no fills or minimal dark fills.',
    negativeBlock:
      'Avoid: solid shaded fills, textures, pixel art, photorealism, 3D render, ' +
      'pastel palettes, thick outlines.',
    deliveredScale: 1,
    postSteps: [],
  },
  'oil-painting': {
    id: 'oil-painting',
    name: 'Oil painting',
    promptBlock:
      'Classical oil painting: thick visible impasto brushstrokes, rich layered glazes, warm ' +
      'old-master lighting, canvas grain, deep saturated darks with luminous highlights.',
    negativeBlock:
      'Avoid: pixel art, flat vector fills, 3D render, digital airbrush smoothness, ' +
      'neon colors, hard cel outlines.',
    deliveredScale: 1,
    postSteps: [],
  },
  'stained-glass': {
    id: 'stained-glass',
    name: 'Stained glass',
    promptBlock:
      'Stained-glass style: bold black leading lines dividing flat panes of luminous saturated ' +
      'color, light glowing through the glass, simplified symbolic shapes, subtle glass texture.',
    negativeBlock:
      'Avoid: soft gradients within panes, photorealism, pixel art, 3D render, ' +
      'muted desaturated palettes, sketchy linework.',
    deliveredScale: 1,
    postSteps: [],
  },
  claymation: {
    id: 'claymation',
    name: 'Claymation',
    promptBlock:
      'Stop-motion claymation look: hand-sculpted plasticine surfaces with visible fingerprints ' +
      'and tool marks, slightly uneven handmade forms, soft practical studio lighting, tactile ' +
      'matte finish.',
    negativeBlock:
      'Avoid: perfectly smooth digital surfaces, pixel art, flat vector, photorealism, ' +
      'glossy plastic sheen, motion blur.',
    deliveredScale: 1,
    postSteps: [],
  },
  'sticker-toon': {
    id: 'sticker-toon',
    name: 'Sticker toon',
    promptBlock:
      'Die-cut sticker style: chunky rounded cartoon shapes with a thick uniform white border ' +
      'around the whole figure, glossy vivid fills, simple bold features, cute mascot energy.',
    negativeBlock:
      'Avoid: fine detail, painterly texture, pixel art, photorealism, 3D render, ' +
      'muted palettes, thin fragile outlines.',
    deliveredScale: 1,
    postSteps: [],
  },
  'ink-wash': {
    id: 'ink-wash',
    name: 'Sumi-e ink wash',
    promptBlock:
      'Sumi-e ink wash: confident tapering brushstrokes in black ink, expressive dry-brush ' +
      'texture, large areas of empty space, minimal muted color accents, calligraphic economy.',
    negativeBlock:
      'Avoid: dense rendering, pixel art, 3D render, photorealism, uniform vector lines, ' +
      'saturated full-color fills.',
    deliveredScale: 1,
    postSteps: [],
  },
  blueprint: {
    id: 'blueprint',
    name: 'Blueprint / schematic',
    promptBlock:
      'Technical blueprint style: precise thin white or cyan line drawing on deep blue, ' +
      'construction lines and annotations implied, orthographic clarity, no shading beyond ' +
      'hatching.',
    negativeBlock:
      'Avoid: full-color rendering, painterly shading, pixel art, photorealism, 3D render, ' +
      'warm palettes.',
    deliveredScale: 1,
    postSteps: [],
  },
  silhouette: {
    id: 'silhouette',
    name: 'Silhouette',
    promptBlock:
      'Bold silhouette style: the form read almost entirely as a solid shape with minimal ' +
      'interior detail, one or two accent colors for key features, extremely clear and ' +
      'recognizable outline.',
    negativeBlock:
      'Avoid: busy interior detail, gradients, photorealism, 3D render, faint or broken ' +
      'edges, low contrast against the background.',
    deliveredScale: 1,
    postSteps: [],
  },
};

export type StylePresetId = keyof typeof stylePresets;

/**
 * Presentation order for pickers: grouped by family, because a flat list of
 * ~20 styles is unreadable. Every preset must appear in exactly one group
 * (guarded by a test).
 */
export const styleGroups: { label: string; ids: string[] }[] = [
  { label: 'No style', ids: ['default'] },
  {
    label: 'Pixel art',
    ids: [
      'pixel-1bit',
      'pixel-8bit',
      'pixel-16bit',
      'pixel-hd',
      'pixel-monochrome',
      'pixel-isometric',
    ],
  },
  {
    label: 'Illustration',
    ids: [
      'cartoon',
      'sticker-toon',
      'anime',
      'comic',
      'hand-drawn',
      'storybook',
      'watercolor',
      'ink-wash',
      'painterly',
      'oil-painting',
      'dark-fantasy',
      'neon-cyber',
    ],
  },
  {
    label: 'Graphic',
    ids: ['flat-vector', 'silhouette', 'paper-cutout', 'stained-glass', 'blueprint'],
  },
  { label: 'Retro screen', ids: ['retro-vector', 'chalk-neon'] },
  { label: '3D-styled', ids: ['clay-3d', 'low-poly', 'voxel', 'claymation'] },
];

export function getStylePreset(id: string | undefined): StyleContract | undefined {
  return id ? stylePresets[id] : undefined;
}
