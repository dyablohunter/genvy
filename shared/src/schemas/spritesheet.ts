import { z } from 'zod';
import { AssetBaseSchema, FileRefSchema } from './base.js';

export const SpritesheetSchema = AssetBaseSchema.extend({
  type: z.literal('spritesheet'),
  image: FileRefSchema,
  /** Original AI/raw image kept for re-processing without re-spending credits. */
  sourceImage: FileRefSchema.optional(),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  margin: z.number().int().min(0).default(0),
  spacing: z.number().int().min(0).default(0),
  frames: z
    .array(
      z.object({
        index: z.number().int().min(0),
        name: z.string().optional(),
      }),
    )
    .default([]),
});
export type Spritesheet = z.infer<typeof SpritesheetSchema>;
