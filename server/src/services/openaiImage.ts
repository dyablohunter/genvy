import { config } from '../config.js';
import type { ImageOrientation } from '@genvy/shared';

const SIZES: Record<ImageOrientation, string> = {
  portrait: '1024x1536',
  landscape: '1536x1024',
};

/** Turn OpenAI moderation refusals into a clear, actionable message. */
function imageApiError(status: number, body: string): Error {
  const moderated = /content_policy|moderation|safety system|not allowed by our/i.test(body);
  if (moderated) {
    return Object.assign(
      new Error(
        'Image provider refused this description (content policy — it still resembles a ' +
          'trademarked character). Nothing was charged. Edit IMAGE PROMPT to change the giveaways ' +
          '— palette, hat/emblem, outfit shapes, facial signature — or re-run GENERATE CONCEPT for ' +
          'a fresh original design.',
      ),
      { statusCode: 422 },
    );
  }
  return Object.assign(new Error(`OpenAI image error ${status}: ${body.slice(0, 500)}`), {
    statusCode: 502,
  });
}

export type ImageQuality = 'low' | 'medium' | 'high';

/** Generate an image via gpt-image and return the PNG bytes. */
export async function generateImage(
  prompt: string,
  orientation: ImageOrientation,
  transparent = false,
  quality: ImageQuality = 'low',
): Promise<Buffer> {
  if (!config.openaiApiKey) {
    throw Object.assign(new Error('OpenAI API key not configured'), { statusCode: 503 });
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiImageModel,
      prompt,
      size: SIZES[orientation],
      quality,
      n: 1,
      ...(transparent ? { background: 'transparent', output_format: 'png' } : {}),
    }),
  });
  if (!res.ok) {
    throw imageApiError(res.status, await res.text());
  }
  const data = (await res.json()) as { data: { b64_json?: string }[] };
  const b64 = data.data[0]?.b64_json;
  if (!b64) throw Object.assign(new Error('OpenAI returned no image data'), { statusCode: 502 });
  return Buffer.from(b64, 'base64');
}

/**
 * Image edit with reference image(s) — the key to character consistency:
 * the model redraws THIS character instead of reinventing it per prompt.
 * Multiple references map to gpt-image-2's `image[]` array in prompt order
 * ("Image 1", "Image 2", ... for role annotations).
 */
export async function editImage(
  prompt: string,
  reference: Buffer | Buffer[],
  orientation: ImageOrientation,
  transparent = false,
  quality: ImageQuality = 'low',
): Promise<Buffer> {
  if (!config.openaiApiKey) {
    throw Object.assign(new Error('OpenAI API key not configured'), { statusCode: 503 });
  }
  const references = Array.isArray(reference) ? reference : [reference];
  const form = new FormData();
  form.append('model', config.openaiImageModel);
  form.append('prompt', prompt);
  form.append('size', SIZES[orientation]);
  form.append('quality', quality);
  form.append('n', '1');
  if (transparent) {
    form.append('background', 'transparent');
    form.append('output_format', 'png');
  }
  const field = references.length > 1 ? 'image[]' : 'image';
  references.forEach((ref, i) => {
    form.append(field, new Blob([new Uint8Array(ref)], { type: 'image/png' }), `reference-${i + 1}.png`);
  });

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw imageApiError(res.status, await res.text());
  }
  const data = (await res.json()) as { data: { b64_json?: string }[] };
  const b64 = data.data[0]?.b64_json;
  if (!b64) throw Object.assign(new Error('OpenAI returned no image data'), { statusCode: 502 });
  return Buffer.from(b64, 'base64');
}
