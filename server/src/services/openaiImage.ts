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
        'Image provider rejected the prompt (content policy — trademarked characters like this are blocked). Use GENERATE CONCEPT to turn it into an original homage first.',
      ),
      { statusCode: 422 },
    );
  }
  return Object.assign(new Error(`OpenAI image error ${status}: ${body.slice(0, 500)}`), {
    statusCode: 502,
  });
}

/** Generate an image via gpt-image (low quality tier) and return the PNG bytes. */
export async function generateImage(
  prompt: string,
  orientation: ImageOrientation,
  transparent = false,
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
      quality: 'low',
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
 * Image edit with a reference image — the key to character consistency:
 * the model redraws THIS character instead of reinventing it per prompt.
 */
export async function editImage(
  prompt: string,
  reference: Buffer,
  orientation: ImageOrientation,
  transparent = false,
): Promise<Buffer> {
  if (!config.openaiApiKey) {
    throw Object.assign(new Error('OpenAI API key not configured'), { statusCode: 503 });
  }
  const form = new FormData();
  form.append('model', config.openaiImageModel);
  form.append('prompt', prompt);
  form.append('size', SIZES[orientation]);
  form.append('quality', 'low');
  form.append('n', '1');
  if (transparent) {
    form.append('background', 'transparent');
    form.append('output_format', 'png');
  }
  form.append('image', new Blob([new Uint8Array(reference)], { type: 'image/png' }), 'reference.png');

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
