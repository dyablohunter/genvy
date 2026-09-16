import type { ImageOp, ImageQualityTier } from '@genvy/shared';
import { config } from '../config.js';
import { generateImage, editImage, type OpenAiImageResult } from '../services/openaiImage.js';
import type { ImageProvider, ImageGenerateRequest, ImageEditRequest } from './types.js';
import { offlineError } from './types.js';
import { canvasOf, imageCosts, usageCents } from './openaiPricing.js';

export { OPENAI_IMAGE_PRICE } from './openaiPricing.js';

/**
 * OpenAI gpt-image-2.5 (never gpt-image-1 or -2) — the reference provider the
 * whole M1 flow was proven on: native alpha via `background: 'transparent'`,
 * multi-reference edits with role annotations, moderation 422 handled by the
 * caller's sanitize-and-retry pass.
 *
 * The family ships as two variants at identical token rates, and the provider
 * runs each where it is strongest: flare (fast) for text-to-image, sunburst
 * (tighter subject preservation) for every reference edit — anchor turns,
 * animation sheets, frame repair — where identity drift is the failure.
 */
export function createOpenAiProvider(
  apiKey: string,
  models: Record<ImageOp, string> = { generate: config.openaiImageModel, edit: config.openaiEditModel },
): ImageProvider {
  const live = apiKey.length > 0;

  /**
   * Book what the call really cost, from the usage OpenAI reported: the
   * route's ledger takes it as exact, and the price book learns from it so
   * the next preview is quoted from real bills instead of a seed.
   */
  const settle = (op: ImageOp, req: ImageGenerateRequest, result: OpenAiImageResult): Buffer => {
    if (result.usage) {
      const cents = usageCents(models[op], op, result.usage);
      imageCosts.observe(models[op], op, canvasOf(req.orientation), req.quality ?? 'low', cents);
      req.onBilled?.({ cents });
    }
    return result.image;
  };

  return {
    id: 'openai',
    name: 'OpenAI GPT Image 2.5',
    modelIds: models,
    prices: () => ({
      generate: imageCosts.table(models.generate, 'generate'),
      edit: imageCosts.table(models.edit, 'edit'),
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
      qualityLevels: ['low', 'medium', 'high'],
      /**
       * The learned price for this model, op, canvas and quality — both the
       * canvas and the quality matter (high is ~35x low). Used before a call
       * for previews, and booked only when a call reported no usage.
       */
      costEstimate: (req) => {
        const op: ImageOp = 'references' in req || 'anchor' in req ? 'edit' : 'generate';
        const quality: ImageQualityTier = ('quality' in req ? req.quality : undefined) ?? 'low';
        const orientation = 'orientation' in req ? req.orientation : undefined;
        return imageCosts.estimate(models[op], op, canvasOf(orientation), quality).cents;
      },
    },
    async generate(req: ImageGenerateRequest): Promise<Buffer> {
      if (!live) throw offlineError('openai');
      const result = await generateImage(
        req.prompt,
        req.orientation,
        req.transparent ?? false,
        req.quality ?? 'low',
        models.generate,
      );
      return settle('generate', req, result);
    },
    async edit(req: ImageEditRequest): Promise<Buffer> {
      if (!live) throw offlineError('openai');
      const result = await editImage(
        req.prompt,
        req.references.map((r) => r.image),
        req.orientation,
        req.transparent ?? false,
        req.quality ?? 'low',
        models.edit,
      );
      return settle('edit', req, result);
    },
  };
}
