import { IMAGE_QUALITY_TIERS, type ImageOp, type ImageQualityTier } from '@genvy/shared';
import { config } from '../config.js';
import { generateImage, editImage, type OpenAiImageResult } from '../services/openaiImage.js';
import type { ImageProvider, ImageGenerateRequest, ImageEditRequest, ProviderModelInfo } from './types.js';
import { offlineError } from './types.js';
import { canvasOf, clampQuality, imageCosts, qualityTiers, usageCents } from './openaiPricing.js';

/**
 * The OpenAI image models a user can pick for any operation. Same token
 * rates; they differ in speed, how tightly edits hold the subject, and their
 * quality tiers — gpt-image-2 has low/medium/high, the 2.5 family adds xhigh
 * and max (and renames the budgets: 2.5 `high` = gpt-image-2 `medium`).
 */
export const OPENAI_IMAGE_MODELS: { id: string; label: string }[] = [
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare · fast' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst · precise edits' },
  { id: 'gpt-image-2', label: 'GPT Image 2' },
];

/** Every workflow the pickers ask about — each OpenAI model can do all of them. */
const ALL_WORKFLOWS = ['anchor-generate', 'anchor-directional', 'animation-frame', 'repair'];

/**
 * OpenAI gpt-image models (never gpt-image-1) — the reference provider the
 * whole M1 flow was proven on: native alpha via `background: 'transparent'`,
 * multi-reference edits with role annotations, moderation 422 handled by the
 * caller's sanitize-and-retry pass.
 *
 * The user picks the model per operation (`modelFamily` on the request). With
 * no pick, each op runs its default: flare (fast) draws, sunburst (tighter
 * subject preservation) edits — OPENAI_IMAGE_MODEL / OPENAI_EDIT_MODEL.
 */
export function createOpenAiProvider(
  apiKey: string,
  defaults: Record<ImageOp, string> = { generate: config.openaiImageModel, edit: config.openaiEditModel },
): ImageProvider {
  const live = apiKey.length > 0;
  // An .env default outside the built-in list is still offered, not silently dropped.
  const known = [...new Set([...OPENAI_IMAGE_MODELS.map((m) => m.id), defaults.generate, defaults.edit])];
  const labelOf = (id: string) => OPENAI_IMAGE_MODELS.find((m) => m.id === id)?.label ?? id;

  /** The user's pick when this provider offers it, else the op's default. */
  const resolveModel = (op: ImageOp, requested?: string): string =>
    requested && known.includes(requested) ? requested : defaults[op];

  /**
   * Book what the call really cost, from the usage OpenAI reported: the
   * route's ledger takes it as exact, and the price book learns from it so
   * the next preview is quoted from real bills instead of a seed.
   */
  const settle = (
    op: ImageOp,
    model: string,
    quality: ImageQualityTier,
    req: ImageGenerateRequest,
    result: OpenAiImageResult,
  ): Buffer => {
    if (result.usage) {
      const cents = usageCents(model, op, result.usage);
      imageCosts.observe(model, op, canvasOf(req.orientation), quality, cents);
      req.onBilled?.({ cents });
    }
    return result.image;
  };

  return {
    id: 'openai',
    name: 'OpenAI GPT Image',
    modelIds: defaults,
    resolveModel,
    // Recomputed on every /api/health so each model's learned prices are current.
    get models(): ProviderModelInfo[] {
      return known.map((id) => ({
        id,
        label: labelOf(id),
        verified: true,
        available: true,
        workflows: ALL_WORKFLOWS,
        qualityLevels: qualityTiers(id),
        prices: { generate: imageCosts.table(id, 'generate'), edit: imageCosts.table(id, 'edit') },
      }));
    },
    prices: () => ({
      generate: imageCosts.table(defaults.generate, 'generate'),
      edit: imageCosts.table(defaults.edit, 'edit'),
    }),
    live,
    capabilities: {
      generate: true,
      edit: true,
      multiReference: true,
      nativeAlpha: true,
      gridSheets: true, // reliably lays out 2x2 candidate grids in one call
      animation: false,
      maxSize: 1536,
      // Every tier some model offers; each model lists its own in `models`.
      qualityLevels: [...IMAGE_QUALITY_TIERS],
      /**
       * The learned price for the model this call will run on, at the tier it
       * will really run (clamped to that model's tiers), for this canvas.
       * Used before a call for previews, and booked only when a call reported
       * no usage.
       */
      costEstimate: (req) => {
        const op: ImageOp = 'references' in req || 'anchor' in req ? 'edit' : 'generate';
        const model = resolveModel(op, req.modelFamily);
        const quality = clampQuality(model, ('quality' in req ? req.quality : undefined) ?? 'low');
        const orientation = 'orientation' in req ? req.orientation : undefined;
        // ~4 chars per token: the prompt's own length beats a typical guess.
        const promptTokens = req.prompt ? Math.ceil(req.prompt.length / 4) : undefined;
        return imageCosts.estimate(model, op, canvasOf(orientation), quality, promptTokens).cents;
      },
    },
    async generate(req: ImageGenerateRequest): Promise<Buffer> {
      if (!live) throw offlineError('openai');
      const model = resolveModel('generate', req.modelFamily);
      const quality = clampQuality(model, req.quality ?? 'low');
      const result = await generateImage(req.prompt, req.orientation, req.transparent ?? false, quality, model);
      return settle('generate', model, quality, req, result);
    },
    async edit(req: ImageEditRequest): Promise<Buffer> {
      if (!live) throw offlineError('openai');
      const model = resolveModel('edit', req.modelFamily);
      const quality = clampQuality(model, req.quality ?? 'low');
      const result = await editImage(
        req.prompt,
        req.references.map((r) => r.image),
        req.orientation,
        req.transparent ?? false,
        quality,
        model,
      );
      return settle('edit', model, quality, req, result);
    },
  };
}
