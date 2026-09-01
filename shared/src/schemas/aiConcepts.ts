import { z } from 'zod';

/**
 * Structured outputs the AI (DeepSeek) must produce per tool.
 * These are validated server-side before ever reaching the client.
 */

export const CharacterConceptSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(1000),
  /** Prompt handed to the image model; the server wraps it in grid/background constraints. */
  imagePrompt: z.string().min(1).max(1500),
  stats: z.object({
    speed: z.number().min(0).max(1000),
    jumpPower: z.number().min(0).max(2000),
    health: z.number().int().min(1).max(100),
  }),
  /** Suggested animation clips mapped to frame cells of the generated 4x6 pose sheet. */
  suggestedAnimations: z
    .array(
      z.object({
        slot: z.string().min(1),
        frames: z.array(z.number().int().min(0)).min(1),
        frameRate: z.number().positive().max(60),
      }),
    )
    .default([]),
  tags: z.array(z.string()).default([]),
});
export type CharacterConcept = z.infer<typeof CharacterConceptSchema>;

export const TilesetConceptSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(1000),
  imagePrompt: z.string().min(1).max(1500),
  /** Names for each tile cell in reading order; length should match grid size. */
  tileNames: z.array(z.string()).default([]),
  /** Indices of tiles that should default to collidable (walls, floors). */
  collidingTiles: z.array(z.number().int().min(0)).default([]),
  tags: z.array(z.string()).default([]),
});
export type TilesetConcept = z.infer<typeof TilesetConceptSchema>;

export const WorldLayoutSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(1000).default(''),
  width: z.number().int().min(8).max(200),
  height: z.number().int().min(8).max(200),
  layers: z
    .array(
      z.object({
        name: z.string().min(1),
        /** rows of tile indices, -1 = empty */
        data: z.array(z.array(z.number().int().min(-1))),
      }),
    )
    .min(1),
  spawnPoints: z
    .array(z.object({ name: z.string(), x: z.number(), y: z.number() }))
    .default([]),
});
export type WorldLayout = z.infer<typeof WorldLayoutSchema>;

export const aiConceptSchemas = {
  characterConcept: CharacterConceptSchema,
  tilesetConcept: TilesetConceptSchema,
  worldLayout: WorldLayoutSchema,
} as const;

export type AiConceptSchemaName = keyof typeof aiConceptSchemas;
