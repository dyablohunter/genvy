import { z } from 'zod';
import { AssetBaseSchema, FileRefSchema } from './base.js';

/**
 * A painted SCENE: one image that IS the level backdrop, rather than a grid of
 * tiles assembled into one. This is how isometric, hand-painted side-scroller
 * and adventure-game levels are actually built — a single illustration the
 * game camera pans across, with gameplay geometry laid over it.
 *
 * Kept separate from `world` on purpose: a world is a tilemap (indices,
 * layers, autotiling), a scene is artwork. They export differently and are
 * edited differently, and pretending one is the other would compromise both.
 */

/** How the scene is framed — drives the prompt and, later, the collision maths. */
export const SceneViewSchema = z.enum(['isometric', 'side', 'topdown', 'threequarter']);
export type SceneView = z.infer<typeof SceneViewSchema>;

/** A point in IMAGE pixels — not mask cells. Sub-pixel values are allowed. */
export const ScenePointSchema = z.object({ x: z.number(), y: z.number() });
export type ScenePoint = z.infer<typeof ScenePointSchema>;

/**
 * One vector collision shape. `points` carries the geometry for every type:
 * a polygon's vertices, a rect's two opposite corners, a triangle's three
 * corners, and for a circle the single centre point plus `radius`.
 */
export const SceneShapeSchema = z.object({
  id: z.string().min(1).max(40),
  /** Which SCENE_MASK_KINDS id this shape means (solid, water, ...). */
  kind: z.number().int().min(1).max(31),
  type: z.enum(['polygon', 'rect', 'triangle', 'circle']),
  points: z.array(ScenePointSchema).max(512).default([]),
  radius: z.number().nonnegative().optional(),
  /**
   * Surface friction as a multiplier on normal footing (1). Set per shape so
   * two ramps in the same level can behave differently — an icy one and a dry
   * one — without needing two mask kinds. Omitted = the kind's default.
   */
  friction: z.number().min(0).max(4).optional(),
  /** A name for the shape, so triggers and spawns can be referred to. */
  label: z.string().max(40).optional(),
});
export type SceneShape = z.infer<typeof SceneShapeSchema>;

/**
 * Which way a level repeats. A looping backdrop is not one image used twice —
 * it is a STRIP of panels the camera travels along, and the strip is the
 * thing being authored, so it has to be a first-class part of the asset.
 */
export const SceneLoopSchema = z.enum(['none', 'horizontal', 'vertical']);
export type SceneLoop = z.infer<typeof SceneLoopSchema>;

/**
 * One panel of a looping strip. A panel is either its own render or a
 * flipped copy of one already paid for — mirroring a panel is free and is how
 * a short strip is stretched into a long level without another API call.
 */
export const SceneSegmentSchema = z.object({
  id: z.string().min(1).max(40),
  image: FileRefSchema,
  /** Mirrored horizontally / vertically when drawn. */
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  /** What this panel was asked for, when it was generated separately. */
  prompt: z.string().max(2000).optional(),
});
export type SceneSegment = z.infer<typeof SceneSegmentSchema>;

export const SceneSchema = AssetBaseSchema.extend({
  type: z.literal('scene'),
  image: FileRefSchema,
  /** The untouched generation, kept so later passes never re-spend credits. */
  sourceImage: FileRefSchema.optional(),
  view: SceneViewSchema.default('side'),
  /** The art direction that produced it — editable and re-forgeable. */
  prompt: z.string().max(2000).default(''),
  styleId: z.string().max(60).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * The gameplay layer painted OVER the artwork: which pixels are solid,
   * which are one-way platforms, ladders, water or hazards. A painted scene
   * is only a picture until this exists — it is what makes it playable.
   *
   * Stored as a coarse grid rather than a pixel mask: a game reads it
   * directly as a collision map, it survives scaling, and it is small enough
   * to live in the asset JSON.
   */
  mask: z
    .object({
      /** Pixels per mask cell (16 = a 1024px scene becomes 64 cells wide). */
      cellSize: z.number().int().min(4).max(128).default(16),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      /** rows of mask ids; 0 = empty. See SCENE_MASK_KINDS. */
      data: z.array(z.array(z.number().int().min(0).max(31))),
    })
    .optional(),
  /**
   * VECTOR collision shapes, in image pixels. The grid mask above is what a
   * brush paints; these are what a traced outline or a placed primitive
   * produces, and they are deliberately NOT quantised to the mask grid — a
   * cave floor traced as cells comes out ragged no matter how fine the cells
   * are, and a circle or a triangle cannot be expressed by a square grid at
   * all. An engine reads both: shapes as polygons/circles, the mask as tiles.
   */
  shapes: z.array(SceneShapeSchema).default([]),
  /** Which axis this level repeats along, if any. */
  loop: SceneLoopSchema.default('none'),
  /**
   * The strip, in travel order. EMPTY means the scene is the single `image`
   * above; once the timeline is used, this holds every panel including the
   * first, so panel order and per-panel mirroring survive a reload.
   */
  segments: z.array(SceneSegmentSchema).max(64).default([]),
  /**
   * Optional parallax layers cut from (or generated beside) the scene, far to
   * near. Empty for a flat backdrop.
   */
  layers: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        image: FileRefSchema,
        /** 0 = fixed to the camera, 1 = moves with the world. */
        scrollFactor: z.number().min(0).max(2).default(1),
      }),
    )
    .default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

/**
 * What a painted mask cell means. Ids are stored in scene.mask.data, so the
 * ORDER IS PART OF THE FORMAT — append new kinds, never reorder them.
 *
 * `icon` is how the layer is offered in the editor: a dozen word-buttons do
 * not fit a panel column, and a row of glyphs reads faster once learned. The
 * label and hint stay — they are the tooltip and the confirmation toast.
 */
export const SCENE_MASK_KINDS = [
  { id: 1, key: 'solid', icon: '█', label: 'SOLID', color: '#ff3d5a', hint: 'walls, ground, anything blocking' },
  { id: 2, key: 'platform', icon: '▬', label: 'PLATFORM', color: '#3dff8c', hint: 'one-way: land on top, jump through' },
  { id: 3, key: 'ladder', icon: '‖', label: 'LADDER', color: '#ffc63d', hint: 'climbable' },
  { id: 4, key: 'water', icon: '≈', label: 'WATER', color: '#1de9ff', hint: 'swim / slow movement' },
  { id: 5, key: 'hazard', icon: '⚠', label: 'HAZARD', color: '#ff9d1d', hint: 'damage on contact' },
  { id: 6, key: 'trigger', icon: '⚑', label: 'TRIGGER', color: '#b06dff', hint: 'events, doors, checkpoints' },
  {
    id: 7,
    key: 'walkable',
    icon: '◌',
    label: 'WALKABLE',
    color: '#7d8bff',
    hint: 'where actors and NPCs may move — paint the path, not the walls',
  },
  {
    id: 8,
    key: 'spawnPlayer',
    icon: '✦',
    label: 'PLAYER SPAWN',
    color: '#ff6bd6',
    hint: 'where the PLAYER enters — the test dummy spawns here',
  },
  {
    id: 9,
    key: 'ledge',
    icon: '⌐',
    label: 'LEDGE',
    color: '#c9a06b',
    hint: 'a height change: step or fall down it, but not up',
  },
  {
    id: 10,
    key: 'cover',
    icon: '☁',
    label: 'COVER',
    color: '#8de0c0',
    hint: 'drawn over the actor — foliage, roofs, foreground',
  },
  {
    id: 11,
    key: 'ramp',
    icon: '◢',
    label: 'RAMP',
    color: '#ff7f50',
    hint: 'an angled surface walked up and down — slide-prone',
  },
  {
    id: 12,
    key: 'stairs',
    icon: '≣',
    label: 'STAIRS',
    color: '#d8a0ff',
    hint: 'stepped ascent — climbed at a steady pace, no sliding',
  },
  {
    id: 13,
    key: 'spawnNpc',
    icon: '✧',
    label: 'NPC SPAWN',
    color: '#d66bff',
    hint: 'where NPCs and enemies enter',
  },
] as const;

export type SceneMaskKind = (typeof SCENE_MASK_KINDS)[number]['key'];

/**
 * The panels of a scene, whatever it was saved as. A scene with no strip is
 * a strip of one — callers should never have to branch on that.
 */
export function sceneSegments(scene: {
  image: { path: string; width?: number; height?: number };
  segments?: SceneSegment[];
}): SceneSegment[] {
  if (scene.segments && scene.segments.length > 0) return scene.segments;
  return [{ id: 'seg_1', image: scene.image, flipX: false, flipY: false }];
}

/**
 * Which layers a view actually needs.
 *
 * A side-scroller is authored as NEGATIVE space: paint what blocks, and
 * everything else is air. A top-down or isometric map is the opposite — the
 * walkable path is a fraction of the image, so painting where actors MAY go
 * is far less work than fencing off everything they may not, and it is what
 * a navigation grid wants anyway. Offering one fixed list forced the wrong
 * one of those on half the scenes.
 *
 * The full roster stays reachable in the editor; this is the default set.
 */
export const SCENE_VIEW_MASK_KINDS: Record<SceneView, SceneMaskKind[]> = {
  side: ['solid', 'platform', 'ramp', 'stairs', 'ladder', 'water', 'hazard', 'trigger', 'spawnPlayer', 'spawnNpc', 'cover'],
  isometric: ['walkable', 'solid', 'ramp', 'stairs', 'ledge', 'water', 'hazard', 'trigger', 'spawnPlayer', 'spawnNpc', 'cover'],
  threequarter: ['walkable', 'solid', 'ramp', 'stairs', 'ledge', 'water', 'hazard', 'trigger', 'spawnPlayer', 'spawnNpc', 'cover'],
  topdown: ['walkable', 'solid', 'stairs', 'water', 'hazard', 'trigger', 'spawnPlayer', 'spawnNpc', 'cover'],
};

/**
 * How slippery each surface is by default, as a multiplier on normal ground
 * (1 = ordinary footing). A ramp and a flight of stairs are both angled, and
 * they do NOT behave the same: you slide down one and you do not slide down
 * the other, which is exactly the difference a friction value carries.
 * Per-shape `friction` overrides this — one icy ramp among dry ones.
 */
export const SCENE_KIND_FRICTION: Partial<Record<SceneMaskKind, number>> = {
  ramp: 0.7,
  stairs: 1,
  water: 0.35,
  ledge: 0.9,
  platform: 1,
  solid: 1,
};

/** The default friction for a kind; 1 when the kind has no opinion. */
export function defaultFriction(kind: SceneMaskKind): number {
  return SCENE_KIND_FRICTION[kind] ?? 1;
}

/** The mask kinds a view leads with, in the order they should be offered. */
export function maskKindsForView(view: SceneView) {
  const wanted = SCENE_VIEW_MASK_KINDS[view] ?? SCENE_VIEW_MASK_KINDS.side;
  return wanted.map((key) => SCENE_MASK_KINDS.find((k) => k.key === key)!);
}
