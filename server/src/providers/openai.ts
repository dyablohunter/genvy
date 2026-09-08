import { generateImage, editImage } from '../services/openaiImage.js';
import type { ImageProvider, ImageGenerateRequest, ImageEditRequest } from './types.js';
import { offlineError } from './types.js';

/**
 * OpenAI gpt-image-2 (never gpt-image-1) — the reference provider the whole
 * M1 flow was proven on: native alpha via `background: 'transparent'`,
 * multi-reference edits with role annotations, moderation 422 handled by the
 * caller's sanitize-and-retry pass. Wraps services/openaiImage.ts unchanged.
 */
/**
 * Published gpt-image-2 image prices, in CENTS per image, by canvas and
 * quality. Square is not a discount on the tall/wide canvas — it costs MORE
 * at every tier — so this is a table, not a ratio applied to one row.
 *
 *              1024x1024   1024x1536 / 1536x1024
 *   low          $0.006            $0.005
 *   medium       $0.053            $0.041
 *   high         $0.211            $0.165
 */
export const OPENAI_IMAGE_PRICE: Record<'square' | 'tall', Record<string, number>> = {
  square: { low: 0.6, medium: 5.3, high: 21.1 },
  tall: { low: 0.5, medium: 4.1, high: 16.5 },
};

export function createOpenAiProvider(apiKey: string): ImageProvider {
  const live = apiKey.length > 0;
  return {
    id: 'openai',
    name: 'OpenAI gpt-image-2',
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
       * Priced from OPENAI_IMAGE_PRICE — both the canvas and the quality
       * matter. High is 35x low on a square canvas, so the picker warns
       * before it is chosen: a 4-candidate high-tier forge is $0.84.
       */
      costEstimate: (req) => {
        const quality = ('quality' in req ? req.quality : undefined) ?? 'low';
        const square = 'orientation' in req && req.orientation === 'square';
        return OPENAI_IMAGE_PRICE[square ? 'square' : 'tall'][quality] ?? 0;
      },
    },
    async generate(req: ImageGenerateRequest): Promise<Buffer> {
      if (!live) throw offlineError('openai');
      return generateImage(req.prompt, req.orientation, req.transparent ?? false, req.quality ?? 'low');
    },
    async edit(req: ImageEditRequest): Promise<Buffer> {
      if (!live) throw offlineError('openai');
      return editImage(
        req.prompt,
        req.references.map((r) => r.image),
        req.orientation,
        req.transparent ?? false,
        req.quality ?? 'low',
      );
    },
  };
}
