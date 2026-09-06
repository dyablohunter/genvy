import { generateImage, editImage } from '../services/openaiImage.js';
import type { ImageProvider, ImageGenerateRequest, ImageEditRequest } from './types.js';
import { offlineError } from './types.js';

/**
 * OpenAI gpt-image-2 (never gpt-image-1) — the reference provider the whole
 * M1 flow was proven on: native alpha via `background: 'transparent'`,
 * multi-reference edits with role annotations, moderation 422 handled by the
 * caller's sanitize-and-retry pass. Wraps services/openaiImage.ts unchanged.
 */
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
       * Published gpt-image-2 pricing at the sizes genvy renders
       * (1024x1536 / 1536x1024): low $0.005, medium $0.041, high $0.165.
       * High is 33x low, so the picker warns before it is chosen — a
       * 4-candidate high-tier forge is $0.66, not pocket change.
       */
      costEstimate: (req) => {
        const quality = 'quality' in req ? req.quality : undefined;
        return quality === 'high' ? 16.5 : quality === 'medium' ? 4.1 : 0.5;
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
