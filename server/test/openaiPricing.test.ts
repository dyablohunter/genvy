import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../src/config.js';
import { createOpenAiProvider } from '../src/providers/openai.js';
import {
  EDIT_REFERENCE_SEED_CENTS,
  OPENAI_IMAGE_PRICE,
  canvasOf,
  imageCosts,
  usageCents,
} from '../src/providers/openaiPricing.js';

/**
 * gpt-image-2.5 has no published per-image table, so spend is booked from the
 * token usage each response reports, and previews are learned from those bills.
 * These tests pin both halves without spending anything: fetch is stubbed.
 */

const FLARE = 'gpt-image-2.5-flare';
const SUNBURST = 'gpt-image-2.5-sunburst';
const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeEach(() => imageCosts.reset());

describe('usageCents: tokens x published rates', () => {
  it('prices text input, image input and image output separately', () => {
    // 1000 text in ($5/M) + 2000 image in ($8/M) + 4000 out ($30/M)
    // = $0.005 + $0.016 + $0.12 = $0.141 = 14.1 cents
    const cents = usageCents(SUNBURST, 'edit', {
      input_tokens: 3000,
      output_tokens: 4000,
      input_tokens_details: { text_tokens: 1000, image_tokens: 2000 },
    });
    expect(cents).toBeCloseTo(14.1, 6);
  });

  it('without an input split, charges edits at the image rate and generations at the text rate', () => {
    const usage = { input_tokens: 1000, output_tokens: 0 };
    expect(usageCents(SUNBURST, 'edit', usage)).toBeCloseTo(0.8, 6); // $8/M
    expect(usageCents(FLARE, 'generate', usage)).toBeCloseTo(0.5, 6); // $5/M
  });
});

describe('imageCosts: previews learned from billed calls', () => {
  it('seeds unlearned buckets, with a reference-image surcharge for edits', () => {
    expect(imageCosts.estimate(FLARE, 'generate', 'square', 'low')).toEqual({
      cents: OPENAI_IMAGE_PRICE.square.low,
      samples: 0,
    });
    expect(imageCosts.estimate(SUNBURST, 'edit', 'tall', 'high')).toEqual({
      cents: OPENAI_IMAGE_PRICE.tall.high + EDIT_REFERENCE_SEED_CENTS,
      samples: 0,
    });
  });

  it('replaces the seed with the running average of real bills', () => {
    imageCosts.observe(FLARE, 'generate', 'tall', 'medium', 3);
    imageCosts.observe(FLARE, 'generate', 'tall', 'medium', 5);
    expect(imageCosts.estimate(FLARE, 'generate', 'tall', 'medium')).toEqual({ cents: 4, samples: 2 });
  });

  it('keeps models, ops, canvases and tiers in separate buckets', () => {
    imageCosts.observe(SUNBURST, 'edit', 'tall', 'low', 9);
    expect(imageCosts.estimate(SUNBURST, 'edit', 'tall', 'low').samples).toBe(1);
    expect(imageCosts.estimate(FLARE, 'edit', 'tall', 'low').samples).toBe(0);
    expect(imageCosts.estimate(SUNBURST, 'generate', 'tall', 'low').samples).toBe(0);
    expect(imageCosts.estimate(SUNBURST, 'edit', 'square', 'low').samples).toBe(0);
    expect(imageCosts.estimate(SUNBURST, 'edit', 'tall', 'medium').samples).toBe(0);
  });

  it('serves a full canvas x quality table for /api/health', () => {
    const table = imageCosts.table(FLARE, 'generate');
    expect(Object.keys(table).sort()).toEqual(['square', 'tall']);
    expect(Object.keys(table.tall).sort()).toEqual(['high', 'low', 'medium']);
  });

  it('maps both non-square canvases to one price row', () => {
    expect(canvasOf('portrait')).toBe('tall');
    expect(canvasOf('landscape')).toBe('tall');
    expect(canvasOf('square')).toBe('square');
  });
});

describe('OpenAI provider: flare draws, sunburst edits, usage is billed exactly', () => {
  const calls: { url: string; model: string | null }[] = [];
  const savedKey = config.openaiApiKey;

  beforeEach(() => {
    calls.length = 0;
    config.openaiApiKey = 'test-key';
    vi.stubGlobal('fetch', async (url: string, init: { body: string | FormData }) => {
      const model =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as { model: string }).model
          : (init.body.get('model') as string | null);
      calls.push({ url, model });
      return new Response(
        JSON.stringify({
          data: [{ b64_json: ONE_PX_PNG }],
          usage: {
            input_tokens: 1200,
            output_tokens: 2000,
            input_tokens_details: { text_tokens: 200, image_tokens: 1000 },
          },
        }),
        { status: 200 },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.openaiApiKey = savedKey;
  });

  const provider = () => createOpenAiProvider('test-key', { generate: FLARE, edit: SUNBURST });

  it('names the model each op runs on', () => {
    expect(provider().modelIds).toEqual({ generate: FLARE, edit: SUNBURST });
  });

  it('generates with flare and bills the reported usage', async () => {
    const billed: number[] = [];
    await provider().generate({
      prompt: 'x',
      orientation: 'portrait',
      quality: 'low',
      onBilled: (b) => billed.push(b.cents!),
    });
    expect(calls).toEqual([{ url: 'https://api.openai.com/v1/images/generations', model: FLARE }]);
    // 200 text x $5 + 1000 image x $8 + 2000 out x $30, per 1M = $0.069
    expect(billed).toHaveLength(1);
    expect(billed[0]).toBeCloseTo(6.9, 6);
  });

  it('edits with sunburst, and the preview learns the real price', async () => {
    const p = provider();
    const editReq = {
      prompt: 'x',
      orientation: 'portrait' as const,
      quality: 'low' as const,
      references: [{ image: Buffer.from(ONE_PX_PNG, 'base64'), role: 'identity' as const }],
    };
    expect(p.capabilities.costEstimate(editReq)).toBeCloseTo(
      OPENAI_IMAGE_PRICE.tall.low + EDIT_REFERENCE_SEED_CENTS,
      6,
    );
    await p.edit(editReq);
    expect(calls).toEqual([{ url: 'https://api.openai.com/v1/images/edits', model: SUNBURST }]);
    expect(p.capabilities.costEstimate(editReq)).toBeCloseTo(6.9, 6);
    expect(p.prices!().edit.tall.low).toEqual({ cents: expect.closeTo(6.9, 6), samples: 1 });
    // Generation previews are untouched by an edit's bill.
    expect(p.prices!().generate.tall.low.samples).toBe(0);
  });
});
