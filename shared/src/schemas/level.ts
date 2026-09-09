import { z } from 'zod';
import { AssetBaseSchema, AssetRefSchema } from './base.js';
import { SceneShapeSchema } from './scene.js';
import { WorldPropSchema } from './world.js';

/**
 * A LEVEL: the thing a player walks through, and the thing the editor edits.
 *
 * It exists because a level is not one medium. It may have a painted
 * backdrop, a tile grid, or both, plus the gameplay geometry laid over them —
 * and asking the user to choose a "type" up front forced that decision before
 * they knew what the level needed. The parts keep their own asset types
 * (a scene is artwork, a tileset is a palette; they export and re-forge
 * differently) and the level REFERENCES them, owning only what is genuinely
 * its own: the grid, the zones, the props and the spawns.
 */

/** Which layer a stroke lands on. Present layers are the ones with content. */
export const LEVEL_LAYERS = ['backdrop', 'tiles', 'zones'] as const;
export type LevelLayer = (typeof LEVEL_LAYERS)[number];

export const LevelSchema = AssetBaseSchema.extend({
  type: z.literal('level'),
  /** The painted backdrop, when this level has one. */
  scene: AssetRefSchema.optional(),
  /** The tile palette, when this level has a grid. */
  tileset: AssetRefSchema.optional(),
  width: z.number().int().positive().default(40),
  height: z.number().int().positive().default(23),
  tileWidth: z.number().int().positive().default(64),
  tileHeight: z.number().int().positive().default(64),
  /** Rows of tile indices, -1 = empty. Empty array when there is no grid. */
  tiles: z.array(z.array(z.number().int().min(-1))).default([]),
  /** One tile stretched across a block of cells. */
  props: z.array(WorldPropSchema).default([]),
  /** Collision and gameplay zones as a coarse grid, over the whole level. */
  mask: z
    .object({
      cellSize: z.number().int().min(4).max(128).default(16),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      data: z.array(z.array(z.number().int().min(0).max(31))),
    })
    .optional(),
  /** Vector collision shapes, in level pixels. */
  shapes: z.array(SceneShapeSchema).default([]),
  spawnPoints: z
    .array(z.object({ name: z.string(), x: z.number(), y: z.number() }))
    .default([]),
});
export type Level = z.infer<typeof LevelSchema>;
