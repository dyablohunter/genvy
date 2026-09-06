import { z } from 'zod';
import { AssetBaseSchema, FileRefSchema } from './base.js';

export const TilesetSchema = AssetBaseSchema.extend({
  type: z.literal('tileset'),
  image: FileRefSchema,
  sourceImage: FileRefSchema.optional(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  tiles: z
    .array(
      z.object({
        index: z.number().int().min(0),
        name: z.string().default(''),
        collides: z.boolean().default(false),
        tags: z.array(z.string()).default([]),
        /** Index this tile was derived from (seamless variants, rotations). */
        derivedFrom: z.number().int().min(0).optional(),
      }),
    )
    .default([]),
});
export type Tileset = z.infer<typeof TilesetSchema>;
