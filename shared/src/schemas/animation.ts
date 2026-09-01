import { z } from 'zod';
import { AssetBaseSchema, AssetRefSchema } from './base.js';

export const AnimationSchema = AssetBaseSchema.extend({
  type: z.literal('animation'),
  spritesheet: AssetRefSchema,
  frames: z.array(z.number().int().min(0)).min(1),
  frameRate: z.number().positive().max(120).default(10),
  repeat: z.number().int().min(-1).default(-1),
  yoyo: z.boolean().default(false),
});
export type AnimationAsset = z.infer<typeof AnimationSchema>;
