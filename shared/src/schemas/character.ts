import { z } from 'zod';
import { AssetBaseSchema, AssetRefSchema } from './base.js';

export const CharacterStatsSchema = z.object({
  speed: z.number().min(0).default(160),
  jumpPower: z.number().min(0).default(400),
  health: z.number().int().min(1).default(3),
});

export const CharacterSchema = AssetBaseSchema.extend({
  type: z.literal('character'),
  sheet: AssetRefSchema,
  /** Named animation slots (idle, walk, jump, ...) -> animation asset refs. */
  animations: z.record(z.string(), AssetRefSchema).default({}),
  stats: CharacterStatsSchema.default({}),
  physicsPreset: AssetRefSchema.optional(),
  controls: z.enum(['platformer', 'topdown', 'twinstick']).default('platformer'),
});
export type Character = z.infer<typeof CharacterSchema>;
