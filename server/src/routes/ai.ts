import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { aiConceptSchemas, type AiTextRequest, newAssetId } from '@genvy/shared';
import { generateJson, generateText } from '../services/deepseek.js';
import { generateImage, editImage } from '../services/openaiImage.js';
import {
  TOOL_SYSTEM_PROMPTS,
  PROMPT_SANITIZE_SYSTEM,
  characterVariantsImagePrompt,
  animationStripImagePrompt,
  tilesetImagePrompt,
} from '../prompts/index.js';
import { Library, LibraryError } from '../services/library.js';

const SAFE_NAME = /^[\w.-]+\.png$/;

interface AiImageBody {
  prompt: string;
  orientation: 'portrait' | 'landscape';
  assetId?: string;
  kind?: 'variants' | 'animation' | 'tileset' | 'raw';
  /** For kind 'animation': library file ("<assetId>/variant.png") used as the reference. */
  referenceFile?: string;
  category?: string;
  frames?: number;
  gridCols?: number;
  gridRows?: number;
  outName?: string;
  styleHint?: string;
  cellBorders?: boolean;
  pose?: string;
}

export function registerAiRoutes(app: FastifyInstance, library: Library) {
  app.post<{ Body: AiTextRequest }>('/api/ai/text', async (req) => {
    const { tool, prompt, schemaName, context, temperature } = req.body ?? {};
    if (!tool || !prompt) throw new LibraryError(400, 'Body must include tool and prompt');
    const system = TOOL_SYSTEM_PROMPTS[tool];
    if (!system) throw new LibraryError(400, `Unknown tool: ${tool}`);
    const userPrompt = context
      ? `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`
      : prompt;
    if (schemaName) {
      const schema = aiConceptSchemas[schemaName];
      if (!schema) throw new LibraryError(400, `Unknown schema: ${schemaName}`);
      const result = await generateJson(
        system, userPrompt, schema as import('zod').ZodType<unknown>, temperature,
      );
      return { result };
    }
    const text = await generateText(system, userPrompt, temperature);
    return { result: { text } };
  });

  app.post<{ Body: AiImageBody }>('/api/ai/image', async (req) => {
    const { prompt, orientation, assetId, kind, referenceFile, category, frames, styleHint } =
      req.body ?? {};
    if (!prompt || !orientation) {
      throw new LibraryError(400, 'Body must include prompt and orientation');
    }
    const outName = req.body.outName && SAFE_NAME.test(req.body.outName) ? req.body.outName : 'raw.png';
    const transparent = kind === 'variants' || kind === 'animation';

    const isModerated = (err: unknown) => (err as { statusCode?: number }).statusCode === 422;

    let png: Buffer;
    if (kind === 'animation') {
      if (!referenceFile) throw new LibraryError(400, 'kind "animation" requires referenceFile');
      const refAbs = library.resolveFile(referenceFile);
      let ref: Buffer;
      try {
        ref = await fs.readFile(refAbs);
      } catch {
        throw new LibraryError(404, `Reference file not found: ${referenceFile}`);
      }
      const buildAnim = (notes: string) =>
        animationStripImagePrompt(
          category ?? 'idle',
          frames ?? 4,
          notes,
          styleHint,
          req.body.gridCols,
          req.body.gridRows,
          req.body.cellBorders,
        );
      try {
        png = await editImage(buildAnim(prompt), ref, orientation, true);
      } catch (err) {
        if (!isModerated(err) || prompt.trim().length === 0) throw err;
        req.log.warn({ prompt }, 'image moderation rejection — sanitizing motion notes and retrying');
        const cleaned = await generateText(PROMPT_SANITIZE_SYSTEM, prompt);
        png = await editImage(buildAnim(cleaned), ref, orientation, true);
      }
    } else {
      const build = (p: string) =>
        kind === 'variants'
          ? characterVariantsImagePrompt(p, styleHint, req.body.cellBorders, req.body.pose)
          : kind === 'tileset'
            ? tilesetImagePrompt(p)
            : p;
      try {
        png = await generateImage(build(prompt), orientation, transparent);
      } catch (err) {
        if (!isModerated(err)) throw err;
        req.log.warn({ prompt }, 'image moderation rejection — sanitizing prompt and retrying');
        const cleaned = await generateText(PROMPT_SANITIZE_SYSTEM, prompt);
        png = await generateImage(build(cleaned), orientation, transparent);
      }
    }

    const id = assetId && assetId.length > 0 ? assetId : newAssetId('spritesheet');
    const dir = await library.fileDir(id);
    await fs.writeFile(path.join(dir, outName), png);
    const meta = await sharp(png).metadata();
    return {
      fileRef: { path: `${id}/${outName}`, width: meta.width, height: meta.height },
      assetId: id,
    };
  });
}
