import type { StyleContract, SpriteSubject } from '@genvy/shared';
import { STYLE_DEFER_TO_REFERENCE, stylePresets, getSubject } from '@genvy/shared';

/**
 * Image prompt scaffolds — Sprite Pipeline v2 (docs/sprite-pipeline-v2.md §E1).
 * Mechanics extracted from the September 2026 research pass: role-annotated
 * references, per-frame choreography, anchor-lock blocks, named negative
 * failure modes, and a per-provider background strategy (native alpha vs
 * mandatory chroma key for providers that fake transparency).
 */

// ---------------------------------------------------------------------------
// Text-generation system prompts (DeepSeek)
// ---------------------------------------------------------------------------

export const SPRITE_CONCEPT_SYSTEM = `You are the sprite designer inside Genvy, a 2D game creation tool built on Phaser.
The user describes something to animate; you produce a JSON concept for it.

WHAT you are designing is given as "subject" in the context: a character, creature, vehicle, prop,
pickup, weapon, projectile, effect, environment piece, hazard, machine, or UI element. Design for
THAT kind of thing — a vehicle has no arms, a pickup has no attack, a UI element has states rather
than moves. Where this prompt says "subject", it means whatever the context names.

Required JSON shape:
{
  "name": string (short, evocative),
  "description": string (1-3 sentences of game-design flavor),
  "imagePrompt": string,
  "stats": { "speed": number 50-400, "jumpPower": number 200-900, "health": integer 1-10 },
  "suggestedAnimations": [ { "slot": string, "frames": [int...], "frameRate": number } ],
  "subjectType": string (echo the context's subject id),
  "tags": [string...],
  "styleId": string,
  "paletteRoles": { "outline": string, "shadow": string, "base": string, "secondary": string, "accent": string, "highlight": string },
  "signatureProps": [string...]
}

CRITICAL — trademarked subjects. If the request names or evokes a real franchise property (a game,
film, comic or cartoon character, creature, vehicle or item), you MUST NOT reproduce its look. A
faithful description WILL be rejected by the image generator and the user gets nothing, so an
original design is the only useful answer. Keep the ARCHETYPE (role, energy, general silhouette)
and change all of the following:
- the signature COLOR COMBINATION the original is known for — pick a different palette entirely;
- the headwear, emblem, logo or insignia — invent a new one, or drop it;
- the costume/outfit shapes — different garments, not a recolor of the same ones;
- the signature facial or body feature (moustache, hairstyle, mask, ears, horns, markings);
- the name — brand new, with no franchise word or near-homophone anywhere.
Worked example — the request is a famous red-capped plumber hero: do NOT write "red cap with a
white front emblem, blue overalls, yellow shirt, thick moustache". Write something like "a stout
tinkerer in a green flat cap with a brass goggle strap, tan work jacket over a striped shirt,
mutton-chop sideburns, heavy boots". Same cheerful stocky archetype, unmistakably its own design.
FINAL CHECK before you answer: re-read name, description and imagePrompt. If someone could name the
original franchise from them, the design is too close — rewrite it before returning.

The imagePrompt describes ONLY the subject's visual appearance (colors, silhouette, materials,
mood). NEVER write art-style, medium or rendering language in it (no "pixel art", "flat vector",
"cartoon style", "painterly", "cel shaded", "3D render", "bold outlines"): the app applies the
user's chosen art style separately, and style words here fight it. The context gives that chosen
style for your awareness only — echo its id in styleId and do not describe it. Do NOT write any
view, camera angle or pose (no "side view", "3/4 top-down", "front facing", "action pose"): the
anchor chain frames every render itself, and framing words here fight it — if the user wrote
some, drop them and keep only the appearance. Do NOT mention grids, sprite sheets, backgrounds,
or frame counts — the system adds that. Keep it under 500 characters.

suggestedAnimations is the ANIMATION PLAN for this subject: which clips to produce, one at a time.
The context lists the animation slots that suit this subject type — prefer those, and only add
others that genuinely fit. Each entry: slot, frames as LOCAL indices 0..N-1 where N is the
recommended frame count for that clip (4, 6 or 8), and a sensible frameRate (subtle idles 4-6,
walk 8-10, run 10-14, jump 8, attack 10-14, hurt 8, bursts and impacts 12-16).

stats only matter for things that move under their own power (characters, creatures, vehicles);
for static subjects give modest defaults rather than inventing drama.

styleId: the context carries the style the USER already chose — echo that id back unchanged. Only
when the context has no style, pick the best fit from: ${Object.keys(stylePresets).join(', ')}
("default" means no style influence at all).
paletteRoles names the subject's key colors by role (plain color words or hex), used later for
consistency checks. signatureProps lists held objects, glows, auras, effects or attachments that
appear in the design — the neutral reference pose must OMIT these, so name every one.`;

export const TILESET_CONCEPT_SYSTEM = `You are the environment artist inside Genvy, a 2D game creation tool built on Phaser.
The user describes a world theme; you produce a JSON tileset concept.

Required JSON shape:
{
  "name": string,
  "description": string,
  "imagePrompt": string,
  "tileNames": [string x 24],
  "collidingTiles": [int...],
  "tags": [string...]
}

The image will be a 4-column x 6-row grid of 24 distinct terrain/decor tiles (indices 0-23 in
reading order). Plan a coherent set: ground/floor variants, walls or cliff edges, corners,
platforms, decorations, hazards. tileNames lists all 24 names in order. collidingTiles lists the
indices players cannot walk through (solid ground, walls, platforms).

The imagePrompt describes ONLY the art style and the 24 tile subjects in grid reading order,
compactly (e.g. "row 1: mossy stone floor, cracked stone floor, ..."). Do NOT mention background
colors or grid mechanics — the system adds that. Keep it under 800 characters.`;

export const WORLD_LAYOUT_SYSTEM = `You are the level designer inside Genvy, a 2D game creation tool built on Phaser.
Given a level description and a tileset (list of tile indices with names and which ones collide),
produce a JSON tile layout.

Required JSON shape:
{
  "name": string,
  "description": string,
  "width": int, "height": int,
  "layers": [ { "name": string, "data": [[int...]...] } ],
  "spawnPoints": [ { "name": string, "x": number, "y": number } ]
}

Rules:
- data is height rows of width tile indices; -1 means empty.
- Use ONLY tile indices that exist in the provided tileset.
- Produce 2 layers: "ground" (solid terrain using colliding tiles) and "decor" (non-colliding details).
- Make it playable: connected walkable space, no sealed-off areas, ground under spawn points.
- spawnPoints are in TILE coordinates. Always include one named "player".
- Keep width and height within what the user asked (default 40x23 if unspecified).`;

/**
 * World Maker v2: plan, don't paint. Asking for the raw grid meant ~920
 * integers per layer — truncated responses, unparseable JSON, and rooms that
 * did not connect even when it parsed. The model now supplies intent in a few
 * dozen numbers and `buildWorldGrid` guarantees the geometry.
 */
export const WORLD_PLAN_SYSTEM = `You are the level designer inside Genvy, a 2D game creation tool
built on Phaser. Given a level description, a map size and a tileset (tile indices with names and
which ones collide), produce a compact JSON PLAN. You do NOT draw tiles — a deterministic builder
carves the rooms, connects them, encloses them with walls and scatters the decor from your plan.

Required JSON shape:
{
  "name": string,
  "description": string,
  "seed": int,
  "ground": int,   // tile index for walkable floor
  "wall": int,     // tile index for solid rock/wall
  "rooms": [ { "name": string, "x": int, "y": int, "w": int, "h": int, "floor": int? } ],
  "corridorWidth": 1..3,
  "decor": [ { "tile": int, "density": 0..0.6, "on": "floor" | "wall" } ],
  "spawnPoints": [ { "name": string, "room": int } ]
}

Rules:
- Use ONLY tile indices that exist in the provided tileset. "ground" must be a non-colliding tile
  and "wall" a colliding one where the tileset offers both.
- x,y are the room's top-left corner in TILE coordinates; keep every room fully inside the map with
  at least one tile of margin, and do not overlap rooms unless you mean them to merge.
- 3-8 rooms of 4x4 to 12x8 suit a 40x23 map. Vary their size and spacing; think chambers, not a grid.
- "floor" overrides a single room's ground (a water pool, a lava chamber).
- decor densities are small: 0.05-0.2 reads as dressing, 0.5 reads as clutter.
- spawnPoints reference a ROOM INDEX (0-based) — the builder puts them at that room's centre.
  Always include one named "player".
- Return ONLY the JSON object. No prose, no code fences, no tile grids.`;

export const PROMPT_SANITIZE_SYSTEM = `An image generator rejected a visual prompt for content-policy
reasons — most often because it resembles a trademarked character or franchise (by name, signature
color combination, emblem or motifs), or contains unsafe content. Rewrite it as a clearly ORIGINAL
description. A light touch will be rejected again, so change ALL of these: the color combination
(pick different colors, not shades of the same ones), any hat/helmet/emblem/logo, the garment
shapes, and any signature facial or body feature (moustache, mask, hairstyle, markings). Drop every
franchise-adjacent name. Keep only the general archetype (e.g. "stocky cheerful workman hero") and
the described view or pose. Remove anything unsafe.
Reply with ONLY the rewritten visual description, under 400 characters.`;

export const TOOL_SYSTEM_PROMPTS: Record<string, string> = {
  sprite: SPRITE_CONCEPT_SYSTEM,
  tileset: TILESET_CONCEPT_SYSTEM,
  world: WORLD_PLAN_SYSTEM,
};

// ---------------------------------------------------------------------------
// Shared image-prompt building blocks
// ---------------------------------------------------------------------------

/**
 * Background strategy per provider (docs §C3): native alpha is the default for
 * providers that truly support it (gpt-image-2, Retro Diffusion); the chroma
 * workflow is MANDATORY for providers without real alpha (they draw literal
 * checkerboards) and the fallback retry when native alpha comes back dirty.
 */
export type BackgroundMode = 'transparent' | 'chroma';

export const DEFAULT_CHROMA_HEX = '#FF00FF';

const CHROMA_NAMES: Record<string, string> = {
  '#FF00FF': 'magenta',
  '#00FF00': 'green',
  '#00FFFF': 'cyan',
  '#0000FF': 'blue',
};

export function backgroundBlock(mode: BackgroundMode = 'transparent', chromaHex = DEFAULT_CHROMA_HEX): string {
  if (mode === 'chroma') {
    const colorName = CHROMA_NAMES[chromaHex.toUpperCase()] ?? chromaHex;
    return `Background: every background pixel is one single flat solid ${chromaHex} (${colorName}) —
no gradient, no vignette, no texture, no checkerboard pattern, no scenery. The character itself must
contain NO ${colorName} or ${colorName}-adjacent colors anywhere, so the background keys out cleanly.`;
  }
  return `Background: fully transparent (true PNG alpha channel). No scenery, no floor, no
checkerboard pattern — genuinely empty transparent pixels everywhere outside the subject.`;
}

/** Named failure modes (docs §E1), phrased for whatever is being drawn. */
export function negativeFailureModes(plural = 'characters', noun = 'character'): string {
  return `Negative constraints (hard rules):
- never draw two ${plural} side by side within one frame position
- do not merge cells or create comic panels; no visible grid lines, borders, or separators
- do not recenter the ${noun} differently per frame
- no motion arcs, speed lines, action streaks, afterimages, blur, or smears
- no cast/contact/drop shadows, floor patches, or landing marks
- no detached effects: floating stars, loose sparkles, disconnected outline bits
- no text, labels, frame numbers, guide marks, UI, or scenery
- do not turn the background into a floor, room, horizon, or environment`;
}

/**
 * Role annotation for reference images — the load-bearing trick for
 * gpt-image-2-class models: each attached image gets an explicit role so the
 * model preserves identity from one and copies nothing from the others.
 */
export function referenceRoleBlock(roles: ('identity' | 'layout')[]): string {
  return roles
    .map((role, i) =>
      role === 'identity'
        ? `Image ${i + 1} role: identity anchor. Preserve this exact identity, detail level,
face, outfit, palette, prop, proportions, silhouette, and sprite scale.`
        : `Image ${i + 1} role: layout guide. Use it only for frame count, slot spacing, centering, and
safe padding. Do not copy or reproduce its content — no visible boxes, guide lines, or labels may
appear in the output.`,
    )
    .join('\n');
}

/** NEAR/FAR limb contract for side-view locomotion (walk/run) — machine-checkable. */
export const SIDE_VIEW_LOCOMOTION_BLOCK = `Side-view locomotion contract: name limbs by camera depth,
never by screen side — the NEAR limb is closer to the camera, the FAR limb is behind it. The FAR leg
and FAR arm render in a visibly darker shade of the same hue — roughly 20-30% darker — in every
frame. Exactly two wide split stances per cycle, half a cycle apart; a cycle with only one split
stance is a hop. Foot separation at contact extremes is at least 20% of character height. For runs,
include two true flight frames. Do not let a single pose determine every frame's leg phase.`;

/** Style contract text for GENERATION prompts (no reference attached). */
function styleBlock(style?: StyleContract, styleHint?: string): string {
  const parts: string[] = [];
  // The 'default' preset has empty blocks — no style influence, no stray text.
  const styleText = style ? `${style.promptBlock} ${style.negativeBlock}`.trim() : '';
  if (styleText) parts.push(`Art style: ${styleText}`);
  if (styleHint) parts.push(`Art direction: ${styleHint}.`);
  return parts.length ? `\n${parts.join('\n')}` : '';
}

/**
 * Style contract text for EDIT prompts (reference attached): the style must
 * DEFER to the reference — never re-describe proportions (a "compact chibi"
 * style default kept bulking a slim base in testing).
 */
function styleBlockForEdit(style?: StyleContract, styleHint?: string): string {
  const parts: string[] = [STYLE_DEFER_TO_REFERENCE];
  if (style?.negativeBlock) parts.push(style.negativeBlock);
  if (styleHint) parts.push(`Art direction: ${styleHint}.`);
  return `\n${parts.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Per-frame choreography (docs §C3/E1)
// ---------------------------------------------------------------------------

const IDLE_PHASES = [
  'neutral stance, weight settled',
  'slight inhale — shoulders rise a few pixels',
  'hair and cloth settle downward',
  'tiny secondary movement (blink, cloth ripple)',
  'slight exhale — shoulders lower',
  'hand or accessory sways subtly',
  'return toward neutral',
  'opposite subtle cloth sway',
  'settle back toward the frame 1 stance',
];

const ATTACK_PHASES = [
  'neutral ready stance, feet planted, no active effect',
  'anticipation — attack limb rises, body coils back',
  'peak wind-up, weight loaded on the back foot',
  'release — the attack launches forward, body extends',
  'follow-through — full extension, slight forward lean',
  'recoil peak — body absorbs the momentum',
  'recovery — limbs pull back toward stance',
  'return to calm ready stance, no active effect',
];

const JUMP_PHASES = [
  'anticipation crouch — knees bend, arms pull back',
  'launch — legs extend hard, body stretches upward',
  'rise — body compact, arms up',
  'apex — weightless, slight tuck',
  'fall — legs reach downward, arms out for balance',
  'landing contact — knees flex to absorb impact',
  'recovery — body rises back to standing',
];

const HURT_PHASES = [
  'impact — head and torso snap back, limbs loose',
  'recoil peak — body bent away from the hit',
  'stagger — one foot slides back for balance',
  'recovery toward the neutral stance',
];

/**
 * Full 8-phase gait so every frame names a DISTINCT leg phase — the research
 * failure mode is one mid-stride pose repeated with only arm variation.
 */
const WALK_PHASES = [
  'CONTACT — NEAR leg planted far forward at full stride, FAR leg stretched far back with toes pushing off, feet at maximum separation, arms counter-swung to their extremes',
  'weight shift — body drops onto the NEAR leg, FAR foot peeling off the ground behind',
  'PASSING — FAR leg swings under the body past the NEAR leg, feet close together, body at its highest point',
  'reach — FAR leg extends forward, heel about to strike, body sinking',
  'CONTACT MIRRORED — FAR leg planted far forward at full stride, NEAR leg stretched far back pushing off, feet at maximum separation, arms counter-swung the opposite way',
  'weight shift — body drops onto the FAR leg, NEAR foot peeling off behind',
  'PASSING — NEAR leg swings under the body past the FAR leg, feet close together, body at its highest point',
  'reach — NEAR leg extends forward, heel about to strike, closing the cycle',
];

function sampleArc(phases: string[], frames: number): string[] {
  return Array.from({ length: frames }, (_, i) => {
    const t = frames === 1 ? 0 : i / (frames - 1);
    return phases[Math.min(phases.length - 1, Math.round(t * (phases.length - 1)))]!;
  });
}

function sampleCycle(phases: string[], frames: number): string[] {
  return Array.from({ length: frames }, (_, i) => phases[Math.floor((i / frames) * phases.length)]!);
}

export type MotionKind = 'idle' | 'locomotion' | 'jump' | 'attack' | 'hurt' | 'generic';

export function classifyMotion(category: string): { kind: MotionKind; loops: boolean } {
  const c = category.toLowerCase();
  if (/idle|breath|stand/.test(c)) return { kind: 'idle', loops: true };
  if (/walk|run|sprint|march|crawl|fly|swim/.test(c)) return { kind: 'locomotion', loops: true };
  if (/jump|leap|hop/.test(c)) return { kind: 'jump', loops: false };
  if (/attack|shoot|cast|slash|punch|kick|throw|fire/.test(c)) return { kind: 'attack', loops: false };
  if (/hurt|hit|damage|stun/.test(c)) return { kind: 'hurt', loops: false };
  return { kind: 'generic', loops: false };
}

/**
 * Per-frame choreography: each frame described individually (ready →
 * anticipation → action → release → recoil → settle), loops closing with a
 * match-frame-1 instruction.
 */
export function choreographyPhases(category: string, frames: number): string[] {
  const { kind } = classifyMotion(category);
  return kind === 'idle'
    ? sampleArc(IDLE_PHASES, frames)
    : kind === 'locomotion'
      ? sampleCycle(WALK_PHASES, frames)
      : kind === 'jump'
        ? sampleArc(JUMP_PHASES, frames)
        : kind === 'hurt'
          ? sampleArc(HURT_PHASES, frames)
          : sampleArc(ATTACK_PHASES, frames);
}

export function choreographyBlock(category: string, frames: number): string {
  const { loops } = classifyMotion(category);
  const phases = choreographyPhases(category, frames);
  const lines = phases.map((p, i) => `Frame ${i + 1}: ${p}.`);
  if (loops) {
    lines[lines.length - 1] = `Frame ${frames}: ${phases[frames - 1]} — must flow seamlessly back into
frame 1; match frame 1 closely for a clean loop.`;
  }
  return `Frame choreography:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Layout / separation blocks (kept from M1 — proven with the slicer)
// ---------------------------------------------------------------------------

function separationBlock(unit: string): string {
  return `Each ${unit} must NEVER touch or overlap another on the vertical or horizontal axis — leave
WIDE empty background gaps (at least half a subject's width) between every ${unit}.`;
}

export interface ImagePromptOpts {
  /** What is being drawn — supplies the noun every prompt uses. */
  subject?: SpriteSubject;
  /** User-chosen art direction text (e.g. from the realism/stylized slider). */
  styleHint?: string;
  /** Sprite Pipeline v2 style contract; its blocks are interpolated. */
  style?: StyleContract;
  /** Provider background strategy: 'transparent' (native alpha) or 'chroma'. */
  background?: BackgroundMode;
  chromaHex?: string;
}

// ---------------------------------------------------------------------------
// Variants flow (existing UX, rewritten prompt)
// ---------------------------------------------------------------------------

export interface VariantsPromptOpts extends ImagePromptOpts {
  /** Pose all variants share (from the pose preset select). */
  pose?: string;
  /**
   * ONE figure per image instead of the 2x2 grid — for providers without the
   * gridSheets capability (local SDXL, Retro Diffusion), where the route
   * renders four singles and composes the grid itself.
   */
  single?: boolean;
}

/**
 * One image, four design variations of the same concept (2x2) — or ONE
 * variation when `single` (grid-incapable providers get four of these
 * composed server-side). Only technical pipeline constraints are imposed
 * here — pose, angle, view and art direction belong to the user's own
 * prompt and the style options.
 */
export function variantsImagePrompt(appearance: string, opts: VariantsPromptOpts = {}): string {
  const subj = opts.subject ?? getSubject();
  if (opts.single) {
    // MINIMAL on purpose: single mode serves CLIP-prompted providers (SDXL),
    // where negation is not understood — a "no comic panels, no grid lines"
    // list embeds panels and grids as positive content (verified live: the
    // full prose prompt produced sheets of themed panels). The provider's
    // own negative channel carries the real prohibitions.
    const poseLine = opts.pose ? ` The ${subj.noun} holds this pose: ${opts.pose}.` : '';
    return `exactly ONE complete 2D video game ${subj.noun}, centered, fully visible from head to
toe with empty margin on all sides. The ${subj.noun}: ${appearance}${styleBlock(opts.style, opts.styleHint)}${poseLine}`;
  }
  const poseLine = opts.pose ? `\nAll four ${subj.plural} hold the SAME pose: ${opts.pose}.` : '';
  return `Four DIFFERENT design variations of the same 2D video game ${subj.noun}, arranged as a 2x2
grid. Each quadrant contains exactly ONE complete ${subj.noun}. The four designs vary in details,
color palette accents, and silhouette flair while clearly remaining the same base ${subj.noun}.
Base ${subj.noun}: ${appearance}${styleBlock(opts.style, opts.styleHint)}${poseLine}
Layout: all four ${subj.plural} at the exact same scale, each entirely inside its own quadrant with
padding on all sides. ${separationBlock(subj.noun)}
${backgroundBlock(opts.background, opts.chromaHex)}
${negativeFailureModes(subj.plural, subj.noun)}`;
}

/** Legacy full pose-sheet prompt (kept for the smoke script). */
export function spriteSheetImagePrompt(appearance: string): string {
  return variantsImagePrompt(appearance);
}

// ---------------------------------------------------------------------------
// Animation sheets (rewritten per §C3: anchor lock + choreography)
// ---------------------------------------------------------------------------

export interface AnimationPromptOpts extends ImagePromptOpts {
  gridCols?: number;
  gridRows?: number;
  /** Anchor direction the clip animates in — locks the facing in every frame. */
  facing?: 'south' | 'west' | 'east' | 'north';
}

const FACING_TEXT: Record<NonNullable<AnimationPromptOpts['facing']>, string> = {
  south: 'SOUTH — directly toward the camera',
  west: 'WEST — facing LEFT in side profile',
  east: 'EAST — facing RIGHT in side profile',
  north: 'NORTH — away from the camera (back view)',
};

/**
 * One animation at a time, drawn from a reference image (variant today,
 * directional anchor in P2). The reference owns identity; this sheet owns
 * MOTION ONLY. User notes remain first-class motion direction.
 */
export function animationStripImagePrompt(
  category: string,
  frames: number,
  notes: string,
  opts: AnimationPromptOpts = {},
): string {
  const motion = notes.trim().length > 0 ? `\nMotion notes from the designer: ${notes.trim()}.` : '';
  const layout =
    opts.gridCols && opts.gridRows
      ? `exactly ${opts.gridCols} columns and ${opts.gridRows} rows, reading left-to-right,
top-to-bottom`
      : frames <= 8
        ? `ONE horizontal row of ${frames} slots`
        : `neat horizontal rows of up to 8, reading left-to-right, top-to-bottom`;
  const locomotion =
    classifyMotion(category).kind === 'locomotion' ? `\n${SIDE_VIEW_LOCOMOTION_BLOCK}` : '';
  const subj = opts.subject ?? getSubject();
  return `${referenceRoleBlock(['identity'])}
Redraw the EXACT ${subj.noun} from Image 1 as an animation sheet of exactly ${frames} frames of a
"${category}" animation, in chronological order.${motion}

Anchor lock: the reference image owns identity, details, colors and side-specific features. This
sheet owns MOTION ONLY. Spend the variation budget on the parts that actually move — contacts,
counter-swing, height, lean, secondary motion — and on loop continuity. Do not redesign or
reinterpret identity details while animating. Prefer a subtler animation over any change that
mutates its identity.${
    opts.facing
      ? `\nFacing lock: the ${subj.noun} faces ${FACING_TEXT[opts.facing]} in EVERY frame, exactly
matching the reference image's facing. NEVER mirror, flip, or turn it to the opposite side in any
frame.`
      : ''
  }${styleBlockForEdit(opts.style, opts.styleHint)}

${choreographyBlock(category, frames)}${locomotion}

Layout: exactly ${frames} ${subj.plural} total in the whole image; ${layout}; every pose entirely
inside its own slot with wide gaps; all poses at the exact same scale as the reference, fully
visible; consistent baseline across all frames.
${separationBlock('pose')}
${backgroundBlock(opts.background, opts.chromaHex)}
${negativeFailureModes(subj.plural, subj.noun)}`;
}

/**
 * ONE frame of a clip, redrawn against the anchor (§C4 targeted repair). Used
 * when the gate rejects a couple of frames: re-rolling the whole sheet throws
 * away the good poses too, so only the failures are regenerated and pasted
 * back into the raw sheet.
 */
export function singleFrameImagePrompt(
  category: string,
  frames: number,
  index: number,
  notes: string,
  opts: AnimationPromptOpts = {},
): string {
  const phases = choreographyPhases(category, frames);
  const phase = phases[Math.min(Math.max(index, 0), phases.length - 1)] ?? 'the next beat of the motion';
  const motion = notes.trim().length > 0 ? `\nMotion notes from the designer: ${notes.trim()}.` : '';
  const locomotion =
    classifyMotion(category).kind === 'locomotion' ? `\n${SIDE_VIEW_LOCOMOTION_BLOCK}` : '';
  const subj = opts.subject ?? getSubject();
  const facing = opts.facing
    ? `\nFacing lock: the ${subj.noun} faces ${FACING_TEXT[opts.facing]}, exactly matching Image 1.
NEVER mirror or turn it.`
    : '';
  return `${referenceRoleBlock(['identity'])}
Redraw the EXACT ${subj.noun} from Image 1 as ONE single pose: frame ${index + 1} of a ${frames}-frame
"${category}" animation.${motion}

This pose: ${phase}.

Anchor lock: Image 1 owns identity, colors and details — this drawing owns the POSE ONLY. Match its
proportions, palette, outline weight and sprite scale exactly, so this frame drops into the existing
sheet unnoticed.${facing}${styleBlockForEdit(opts.style, opts.styleHint)}${locomotion}

Layout: exactly ONE ${subj.noun}, centered, fully visible, on the same baseline as the reference and
at the same scale. No grid, no extra poses, no duplicates.
${backgroundBlock(opts.background, opts.chromaHex)}
${negativeFailureModes(subj.plural, subj.noun)}`;
}

// ---------------------------------------------------------------------------
// Anchor chain prompts (§C2 — consumed by the P2 UX, shipped with P1)
// ---------------------------------------------------------------------------

export interface AnchorPromptOpts extends ImagePromptOpts {
  /** Logical frame size the artwork should behave like (default 256). */
  logicalSize?: number;
  /** Delivered resolution text (default 1024). */
  outputSize?: number;
  /** ONE candidate per image (grid-incapable providers; see VariantsPromptOpts.single). */
  single?: boolean;
}

/**
 * Neutral south anchor: ONE call producing 4 candidate variants of the
 * canonical neutral idle (2x2, user picks — reuses the variant-picker UX).
 * "Anchors are boring on purpose."
 */
export function neutralAnchorImagePrompt(
  name: string,
  archetype: string,
  opts: AnchorPromptOpts = {},
): string {
  const subj = opts.subject ?? getSubject();
  const logical = opts.logicalSize ?? 256;
  const output = opts.outputSize ?? 1024;
  const facing = subj.directional ? 'facing SOUTH directly toward the camera' : 'in its clearest, most readable view';
  if (opts.single) {
    // MINIMAL for CLIP-prompted providers — see variantsImagePrompt.single.
    // Even "sprite frames"/"frame rules" prose is a hazard there: CLIP
    // embeds "frames" as content and draws sheets of panels.
    return `exactly ONE complete 2D video game ${subj.noun}, ${facing}, centered, fully visible
from head to toe with empty margin on all sides, ${subj.anchorPose}, no held objects, ${name},
${archetype}${styleBlock(opts.style, opts.styleHint)}`;
  }
  const layout = `Create 4 candidate variants of the SAME ${subj.noun} arranged as a 2x2 grid, each quadrant containing
exactly ONE complete ${subj.noun} in the identical pose described below; the variants differ only in
minor detail and palette.`;
  const frameRules = `Frame rules: one ${subj.noun} per quadrant, centered, fully visible, resting at bottom-center, with
ample padding on all sides. ${separationBlock(subj.noun)}`;
  return `Intended use: neutral reference sprite frames for a 2D game. Final artwork should behave
like one logical ${logical}x${logical} in-game frame per ${subj.noun}, delivered at ${output} so
detail reads cleanly at game scale.

${layout}

Subject: ${name}, ${archetype}, ${facing}. This is the CANONICAL REFERENCE pose — ${subj.anchorPose}.
Every identifying feature visible, no motion blur, no dramatic angle. Proportions, palette and
silhouette MUST be reproducible — every later animation frame will be matched against this
image.${styleBlock(opts.style, opts.styleHint)}

${frameRules}

Critical constraints: NO held objects, NO glow, particles, smoke, aura, projectile, or charged
action pose. Anchors are neutral on purpose — effects belong in the animations only. No scenery,
extra props, borders, UI, text, logo, or watermark.
${backgroundBlock(opts.background, opts.chromaHex)}
${negativeFailureModes(subj.plural, subj.noun)}`;
}

/**
 * Neutral reset: the anchor came back holding an effect/prop — preserve/change
 * contrastive edit against the flawed anchor instead of re-rolling from text.
 */
export function neutralResetEditPrompt(
  dynamicEffect: string,
  bodyPart = 'the hands',
  candidates = 1,
  subject: SpriteSubject = getSubject(),
): string {
  const layout =
    candidates > 1
      ? `create ${candidates} candidate variants of the same neutral anchor as Image 1, arranged as
a 2x2 grid`
      : `redraw the neutral anchor from Image 1 as one single complete ${subject.noun}, centered
with ample padding`;
  return `Primary request: ${layout}. The only intended correction from Image 1 is
removing ${dynamicEffect}.

Preserve from Image 1: the same readability, silhouette and proportions, the same colors, the same
detail size, the same centered composition, the same rendering treatment.
Change from Image 1: remove ${dynamicEffect}; remove glow, particles, smoke, aura, projectile, and
any charged/active pose; return ${bodyPart} to a neutral resting state.
Avoid: redesigning the ${subject.noun}, simplifying identity details, changing scale or silhouette.`;
}

export type AnchorDirection = 'south' | 'west' | 'east' | 'north';

/**
 * Directional anchor from the approved south anchor (identity ref = south
 * anchor ONLY). East is a horizontal flip of west, computed, never generated.
 */
/**
 * Per-view geometry lock, shared by forge and refine. The NORTH block spells
 * out back-view extremity anatomy because models reliably default to their
 * front-view habit: claws/toes curling toward the camera on a figure seen
 * from behind.
 */
function anchorViewSpec(direction: AnchorDirection, subj: SpriteSubject): string {
  const views: Record<AnchorDirection, string> = {
    west: `WEST: facing left in profile, the whole ${subj.noun} visible, turned a full 3/4 to the left.`,
    east: `EAST: facing right in profile, the whole ${subj.noun} visible, turned a full 3/4 to the right.`,
    north:
      `NORTH: seen from behind (back view), the whole ${subj.noun} visible. Back views tend to` +
      ' incorrectly center or float attachments — keep every one exactly where the reference' +
      ' places it. Back-view extremities are seen from BEHIND too: show heels and the backs of' +
      ' the legs/ankles; toes, talons and claws point AWAY from the camera, so at most their tips' +
      ' peek past the sides of each foot — never full claws curling toward the viewer. Hands and' +
      ' paws show knuckles and backs, never palms or pads. The head shows the back of the skull,' +
      ' not the face.',
    south: `SOUTH: seen from the front, facing the camera, the whole ${subj.noun} visible.`,
  };
  return views[direction];
}

export function directionalAnchorEditPrompt(
  name: string,
  direction: AnchorDirection,
  silhouetteDetails?: string,
  opts: ImagePromptOpts = {},
): string {
  const subj = opts.subject ?? getSubject();
  const view = anchorViewSpec(direction, subj);
  const details = silhouetteDetails
    ? `\nSide-specific silhouette details to render explicitly: ${silhouetteDetails}.`
    : '';
  return `Image 1 is the approved south-facing identity anchor for ${name}. Preserve the same
identity, palette, proportions, silhouette, attachments and rendering style.
Create a new ${direction.toUpperCase()}-facing anchor frame of the same ${subj.noun} in the same
neutral state. ${view}${details}
Attachment placement: keep parts attached naturally; if something is awkward in this view, reduce
its visibility rather than relocating it incorrectly.${styleBlockForEdit(opts.style, opts.styleHint)}
Critical: no dynamic effects; this is a neutral anchor the animations will be generated from.
One ${subj.noun} only, centered, fully visible, resting at bottom-center, ample padding.
${backgroundBlock(opts.background, opts.chromaHex)}
${negativeFailureModes(subj.plural, subj.noun)}`;
}

/**
 * Refine an EXISTING directional anchor in place: image 1 is that view itself,
 * and the user's notes are corrections to apply — everything else must stay.
 */
export function refineAnchorEditPrompt(
  name: string,
  direction: AnchorDirection,
  corrections?: string,
  opts: ImagePromptOpts = {},
): string {
  const subj = opts.subject ?? getSubject();
  const fix = corrections
    ? `Apply exactly these corrections and nothing else:\n${corrections}`
    : 'Redraw it cleanly, fixing any anatomical or rendering flaws, changing nothing else.';
  return `Image 1 is the current ${direction.toUpperCase()}-facing neutral anchor for ${name}.
Redraw the SAME ${direction.toUpperCase()}-facing view of the same ${subj.noun}: identical identity,
palette, proportions, silhouette, attachments, pose and rendering style.
${anchorViewSpec(direction, subj)}
${fix}
Everything the corrections do not mention stays exactly as in the reference.${styleBlockForEdit(opts.style, opts.styleHint)}
Critical: no dynamic effects; this is a neutral anchor the animations will be generated from.
One ${subj.noun} only, centered, fully visible, resting at bottom-center, ample padding.
${backgroundBlock(opts.background, opts.chromaHex)}
${negativeFailureModes(subj.plural, subj.noun)}`;
}

// ---------------------------------------------------------------------------
// Tilesets (unchanged mechanics)
// ---------------------------------------------------------------------------

/** Wraps a tileset description in strict tile-grid constraints. */
/** How a scene is framed; each view has its own hard rules. */
export type SceneView = 'isometric' | 'side' | 'topdown' | 'threequarter';

const SCENE_VIEW_RULES: Record<SceneView, string> = {
  isometric:
    'True 2:1 isometric projection, camera fixed at 30 degrees, ALL parallel edges consistent ' +
    'across the whole image, no vanishing-point perspective anywhere.',
  side:
    'Flat orthographic SIDE view, camera perpendicular to the scene as in a 2D platformer. ' +
    'The ground line runs horizontally; no floor recedes toward a horizon.',
  topdown:
    'Straight TOP-DOWN view looking directly at the ground, as in a classic action-RPG. ' +
    'Objects are seen from above; no walls tilt toward the camera.',
  threequarter:
    'Three-quarter overhead view (camera slightly above and angled, JRPG-style), consistent ' +
    'across the whole image — every object tilts the same amount.',
};

export interface ScenePromptOpts extends ImagePromptOpts {
  view?: SceneView;
  /** The scene loops horizontally (endless runners, scrolling backdrops). */
  seamless?: boolean;
}

/**
 * A playable SCENE, not an illustration. Two things separate them and both
 * are failure modes worth naming: an illustration has a subject in the middle
 * and a vignette around it (a level must be readable and traversable edge to
 * edge), and an illustration is happy to include the hero (a level must be
 * empty, because the game puts characters on top of it).
 */
export function sceneImagePrompt(description: string, opts: ScenePromptOpts = {}): string {
  const view = opts.view ?? 'side';
  return `A complete 2D game LEVEL BACKGROUND — the playable environment itself, not an illustration
of it. ${SCENE_VIEW_RULES[view]}

Scene: ${description}${styleBlock(opts.style, opts.styleHint)}

Level requirements:
- EMPTY of characters, creatures, players, NPCs and vehicles. The game places those on top; anything
  drawn here would be a permanent painted-in actor.
- Composed for play: clear traversable ground, readable platforms/paths, obstacles that read as
  solid, and depth conveyed by layered background elements rather than by blur.
- Full bleed. The art reaches all four edges with no border, frame, vignette, dark corners or
  passe-partout, and nothing important is cropped at the edges.
- Consistent lighting from ONE direction across the whole scene, and one coherent palette.
- No user interface, no HUD, no text, no labels, no watermark, no logo, no title card.
- No isolated focal "hero shot" composition — the interest is spread across the whole width.${
    opts.seamless
      ? '\n- The LEFT and RIGHT edges must continue into each other so the scene loops horizontally: ' +
        'no unique landmark hard against either edge, and matching horizon height and ground line.'
      : ''
  }`;
}

export function tilesetImagePrompt(subjects: string): string {
  return `A 2D video game tileset: a strict grid of exactly 4 columns and 6 rows (24 square tiles).
Tile subjects in reading order: ${subjects}
CRITICAL REQUIREMENTS: perfectly uniform square cells; each tile fills its entire cell edge-to-edge
with NO gaps between tiles; tiles designed to seamlessly connect with each other; consistent
pixel-art game style and palette across all tiles; top-down/side-on orthographic game view;
NO grid lines, NO borders, NO text, NO labels; crisp clean edges.`;
}
