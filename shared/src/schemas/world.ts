import { z } from 'zod';
import { AssetBaseSchema, AssetRefSchema } from './base.js';

export const TileLayerSchema = z.object({
  name: z.string().min(1),
  kind: z.literal('tiles'),
  /** rows x cols of tile indices, -1 = empty */
  data: z.array(z.array(z.number().int().min(-1))),
  visible: z.boolean().default(true),
});

export const ObjectLayerSchema = z.object({
  name: z.string().min(1),
  kind: z.literal('objects'),
  placements: z
    .array(
      z.object({
        ref: AssetRefSchema,
        x: z.number(),
        y: z.number(),
        properties: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
  visible: z.boolean().default(true),
});

/**
 * One tile STRETCHED over a block of cells. A tilemap cell can only repeat
 * its art, and a big brush that stamps nine copies of a rock reads as nine
 * rocks — a prop is the "one big rock" that painting with a wide brush
 * actually means. Coordinates and size are in TILES.
 */
export const WorldPropSchema = z.object({
  tile: z.number().int().min(0),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type WorldProp = z.infer<typeof WorldPropSchema>;

export const WorldSchema = AssetBaseSchema.extend({
  type: z.literal('world'),
  tileset: AssetRefSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  layers: z.array(z.discriminatedUnion('kind', [TileLayerSchema, ObjectLayerSchema])).min(1),
  /** Stretched-tile props drawn above the tile layers. */
  props: z.array(WorldPropSchema).default([]),
  spawnPoints: z
    .array(z.object({ name: z.string(), x: z.number(), y: z.number() }))
    .default([]),
  ambience: AssetRefSchema.optional(),
  physicsPreset: AssetRefSchema.optional(),
  cameraBehavior: AssetRefSchema.optional(),
});
export type World = z.infer<typeof WorldSchema>;
