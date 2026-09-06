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
  // ---- Sprite Pipeline v2 (C1) — optional so pre-v2 concepts keep validating ----
  /** StyleContract preset id chosen for this character (see styleContract.ts). */
  styleId: z.string().max(60).optional(),
  /** Palette roles for consistency checks: outline/shadow/base/secondary/accent/highlight. */
  paletteRoles: z
    .object({
      outline: z.string().max(30),
      shadow: z.string().max(30),
      base: z.string().max(30),
      secondary: z.string().max(30),
      accent: z.string().max(30),
      highlight: z.string().max(30),
    })
    .partial()
    .optional(),
  /** Signature props/effects the neutral anchor must STRIP (weapons, glows, auras). */
  signatureProps: z.array(z.string().max(80)).default([]),
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

/**
 * World Maker v2: the model plans, CODE builds the grid.
 *
 * The old `worldLayout` asked DeepSeek for every tile index of a 40x23 map —
 * ~920 integers per layer. That blew the token budget (truncated, unparseable
 * JSON) and, when it did parse, produced rooms that did not connect and walls
 * that did not enclose. This asks for a few dozen numbers instead: rooms,
 * roles and densities. `buildWorldGrid` turns them into a correct map.
 */
export const WorldPlanSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(600).default(''),
  /** Fixed seed so the same plan always builds the same map. */
  seed: z.number().int().min(0).optional(),
  /** Tile index used for walkable floor. */
  ground: z.number().int().min(0),
  /** Tile index used for solid walls / the surrounding rock. */
  wall: z.number().int().min(0),
  rooms: z
    .array(
      z.object({
        name: z.string().max(40).default(''),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        w: z.number().int().min(2),
        h: z.number().int().min(2),
        /** Optional per-room floor (water pool, lava chamber...). */
        floor: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(24),
  corridorWidth: z.number().int().min(1).max(3).default(1),
  /** Scattered dressing; density is a fraction of eligible cells. */
  decor: z
    .array(
      z.object({
        tile: z.number().int().min(0),
        density: z.number().min(0).max(0.6),
        on: z.enum(['floor', 'wall']).default('floor'),
      }),
    )
    .max(8)
    .default([]),
  /** Spawn points name a ROOM; the builder resolves the coordinates. */
  spawnPoints: z
    .array(z.object({ name: z.string().min(1).max(40), room: z.number().int().min(0) }))
    .max(8)
    .default([]),
});
export type WorldPlan = z.infer<typeof WorldPlanSchema>;

export const aiConceptSchemas = {
  characterConcept: CharacterConceptSchema,
  tilesetConcept: TilesetConceptSchema,
  worldLayout: WorldLayoutSchema,
  worldPlan: WorldPlanSchema,
} as const;

export type AiConceptSchemaName = keyof typeof aiConceptSchemas;
