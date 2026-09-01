import { z } from 'zod';
import { ID_PREFIXES } from '../ids.js';

export const AssetTypeSchema = z.enum(
  Object.keys(ID_PREFIXES) as [keyof typeof ID_PREFIXES, ...(keyof typeof ID_PREFIXES)[]],
);

export const AssetRefSchema = z.object({
  id: z.string().min(1),
  type: AssetTypeSchema,
});

/** Server-relative path to a binary under /library/files, e.g. "sht_ab12cd34ef/sheet.png" */
export const FileRefSchema = z.object({
  path: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const AssetBaseSchema = z.object({
  id: z.string().min(1),
  type: AssetTypeSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(4000).default(''),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  thumbnail: z.string().optional(),
});
export type AssetBase = z.infer<typeof AssetBaseSchema>;
