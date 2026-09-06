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
  kind: z.number().int().min(1).max(8),
  type: z.enum(['polygon', 'rect', 'triangle', 'circle']),
  points: z.array(ScenePointSchema).max(512).default([]),
  radius: z.number().nonnegative().optional(),
});
export type SceneShape = z.infer<typeof SceneShapeSchema>;

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
      data: z.array(z.array(z.number().int().min(0).max(8))),
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
 */
export const SCENE_MASK_KINDS = [
  { id: 1, key: 'solid', label: 'SOLID', color: '#ff3d5a', hint: 'walls, ground, anything blocking' },
  { id: 2, key: 'platform', label: 'PLATFORM', color: '#3dff8c', hint: 'one-way: land on top, jump through' },
  { id: 3, key: 'ladder', label: 'LADDER', color: '#ffc63d', hint: 'climbable' },
  { id: 4, key: 'water', label: 'WATER', color: '#1de9ff', hint: 'swim / slow movement' },
  { id: 5, key: 'hazard', label: 'HAZARD', color: '#ff9d1d', hint: 'damage on contact' },
  { id: 6, key: 'trigger', label: 'TRIGGER', color: '#b06dff', hint: 'events, doors, checkpoints' },
] as const;

export type SceneMaskKind = (typeof SCENE_MASK_KINDS)[number]['key'];
