import type { z } from 'zod';
import type { AssetType } from '../ids.js';
import { SpritesheetSchema } from './spritesheet.js';
import { AnimationSchema } from './animation.js';
import { CharacterSchema } from './character.js';
import { TilesetSchema } from './tileset.js';
import { WorldSchema } from './world.js';

export * from './base.js';
export * from './spritesheet.js';
export * from './animation.js';
export * from './character.js';
export * from './tileset.js';
export * from './world.js';
export * from './aiConcepts.js';

/**
 * Registry of implemented asset schemas. Types listed in ID_PREFIXES but absent
 * here belong to later milestones — the server rejects writes for them.
 */
export const assetSchemaRegistry = {
  spritesheet: SpritesheetSchema,
  animation: AnimationSchema,
  character: CharacterSchema,
  tileset: TilesetSchema,
  world: WorldSchema,
} satisfies Partial<Record<AssetType, z.ZodTypeAny>>;

export type ImplementedAssetType = keyof typeof assetSchemaRegistry;

export type AnyAsset =
  | z.infer<typeof SpritesheetSchema>
  | z.infer<typeof AnimationSchema>
  | z.infer<typeof CharacterSchema>
  | z.infer<typeof TilesetSchema>
  | z.infer<typeof WorldSchema>;

export function getAssetSchema(type: string): z.ZodTypeAny | undefined {
  return (assetSchemaRegistry as Record<string, z.ZodTypeAny>)[type];
}
