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

export const WorldSchema = AssetBaseSchema.extend({
  type: z.literal('world'),
  tileset: AssetRefSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  layers: z.array(z.discriminatedUnion('kind', [TileLayerSchema, ObjectLayerSchema])).min(1),
  spawnPoints: z
    .array(z.object({ name: z.string(), x: z.number(), y: z.number() }))
    .default([]),
  ambience: AssetRefSchema.optional(),
  physicsPreset: AssetRefSchema.optional(),
  cameraBehavior: AssetRefSchema.optional(),
});
export type World = z.infer<typeof WorldSchema>;
