import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IMAGE_QUALITY_TIERS } from '@genvy/shared';
import { config } from '../src/config.js';
import { createOpenAiProvider } from '../src/providers/openai.js';
import {
  EDIT_REFERENCE_SEED_CENTS,
  TYPICAL_PROMPT_TOKENS,
  canvasOf,
  clampQuality,
  imageCosts,
  outputCents,
  outputTokens,
  usageCents,
} from '../src/providers/openaiPricing.js';

/**
 * Spend is booked from the token usage each response reports; previews start
 * from OpenAI's calculator formula (exact output cost) and then learn from
 * those bills, since prompt and reference-image input is billed too. These
 * tests pin all of it without spending anything: fetch is stubbed.
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

describe("outputTokens: OpenAI's image calculator formula", () => {
  it('matches the calculator for gpt-image-2.5 (flare and sunburst alike)', () => {
    // Read off OpenAI's calculator: low 1536x1024 = 158 tokens ($0.00474),
    // low 1024x1024 = 196 tokens ($0.00588).
    for (const model of [FLARE, SUNBURST]) {
      expect(outputTokens(model, 1536, 1024, 'low')).toBe(158);
      expect(outputTokens(model, 1024, 1024, 'low')).toBe(196);
    }
    expect(outputCents(FLARE, 'tall', 'low')).toBeCloseTo(0.474, 6);
    expect(outputCents(FLARE, 'square', 'low')).toBeCloseTo(0.588, 6);
    // The renamed tiers at 1024x1024: medium 439, high 1756, xhigh 3122, max 7024.
    expect(outputTokens(FLARE, 1024, 1024, 'medium')).toBe(439);
    expect(outputTokens(FLARE, 1024, 1024, 'high')).toBe(1756);
    expect(outputTokens(FLARE, 1024, 1024, 'xhigh')).toBe(3122);
    expect(outputTokens(FLARE, 1024, 1024, 'max')).toBe(7024);
  });

  it("matches OpenAI's calculator for every tier at 1536x1024, token for token", () => {
    // Read off the calculator, low → max.
    const calculator = {
      low: { tokens: 158, dollars: 0.00474 },
      medium: { tokens: 343, dollars: 0.01029 },
      high: { tokens: 1372, dollars: 0.04116 },
      xhigh: { tokens: 2459, dollars: 0.07377 },
      max: { tokens: 5488, dollars: 0.16464 },
    } as const;
    for (const q of IMAGE_QUALITY_TIERS) {
      for (const model of [FLARE, SUNBURST]) {
        expect(outputTokens(model, 1536, 1024, q)).toBe(calculator[q].tokens);
        expect(outputTokens(model, 1024, 1536, q)).toBe(calculator[q].tokens);
      }
      expect(outputCents(FLARE, 'tall', q) / 100).toBeCloseTo(calculator[q].dollars, 9);
    }
  });

  it("names the tiers as 2.5 does: its max spends gpt-image-2's high budget", () => {
    expect(outputTokens(FLARE, 1536, 1024, 'max')).toBe(outputTokens('gpt-image-2', 1536, 1024, 'high'));
    expect(outputTokens(FLARE, 1536, 1024, 'high')).toBe(outputTokens('gpt-image-2', 1536, 1024, 'medium'));
  });

  it('prices portrait and landscape alike, and a square above both', () => {
    for (const q of IMAGE_QUALITY_TIERS) {
      expect(outputTokens(FLARE, 1024, 1536, q)).toBe(outputTokens(FLARE, 1536, 1024, q));
      expect(outputTokens(FLARE, 1024, 1024, q)).toBeGreaterThan(outputTokens(FLARE, 1536, 1024, q));
    }
  });

  it("reproduces gpt-image-2's published table with that model's constants", () => {
    // $0.006/$0.053/$0.211 square, $0.005/$0.041/$0.165 tall.
    expect(outputCents('gpt-image-2', 'square', 'low')).toBeCloseTo(0.588, 3);
    expect(outputCents('gpt-image-2', 'square', 'medium')).toBeCloseTo(5.268, 3);
    expect(outputCents('gpt-image-2', 'square', 'high')).toBeCloseTo(21.072, 3);
    expect(outputCents('gpt-image-2', 'tall', 'medium')).toBeCloseTo(4.116, 3);
    expect(outputCents('gpt-image-2', 'tall', 'high')).toBeCloseTo(16.464, 3); // 5,488 tokens
  });
});

describe('imageCosts: previews learned from billed calls', () => {
  const promptCents = (tokens: number) => (tokens * 5) / 1e4;

  it('seeds unlearned buckets: exact output + prompt text (+ a reference guess for edits)', () => {
    expect(imageCosts.estimate(FLARE, 'generate', 'square', 'low')).toEqual({
      cents: expect.closeTo(0.588 + promptCents(TYPICAL_PROMPT_TOKENS), 9),
      samples: 0,
    });
    expect(imageCosts.estimate(SUNBURST, 'edit', 'tall', 'high', 956)).toEqual({
      cents: expect.closeTo(4.116 + promptCents(956) + EDIT_REFERENCE_SEED_CENTS, 9),
      samples: 0,
    });
  });

  it('prices unbilled buckets from INPUT measured on real bills of the same op, any model', () => {
    // 16 real sunburst LOW edits averaged 1.411 cents: output 0.474 + input 0.937.
    for (let i = 0; i < 4; i++) imageCosts.observe(SUNBURST, 'edit', 'tall', 'low', 1.411);
    const g2EditLow = imageCosts.estimate('gpt-image-2', 'edit', 'tall', 'low');
    expect(g2EditLow.samples).toBe(0); // still an estimate…
    expect(g2EditLow.cents).toBeCloseTo(0.474 + 0.937, 6); // …from measured input, not the 1-cent guess
    // gpt-image-2 medium renders 1,372 output tokens; its input is the same measured 0.937.
    expect(imageCosts.estimate('gpt-image-2', 'edit', 'tall', 'medium').cents).toBeCloseTo(4.116 + 0.937, 6);
    // Generations have no edit bills to learn from, so they keep the guess.
    expect(imageCosts.estimate('gpt-image-2', 'generate', 'tall', 'low').cents).toBeCloseTo(
      0.474 + promptCents(TYPICAL_PROMPT_TOKENS),
      6,
    );
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
    expect(Object.keys(table.tall).sort()).toEqual([...IMAGE_QUALITY_TIERS].sort());
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

  it("offers every gpt-image-2.5 tier under OpenAI's names", () => {
    expect(provider().capabilities.qualityLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
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
    // Unlearned: 158 output tokens + a 1-token prompt + the reference guess.
    expect(p.capabilities.costEstimate(editReq)).toBeCloseTo(0.474 + 0.0005 + EDIT_REFERENCE_SEED_CENTS, 6);
    await p.edit(editReq);
    expect(calls).toEqual([{ url: 'https://api.openai.com/v1/images/edits', model: SUNBURST }]);
    expect(p.capabilities.costEstimate(editReq)).toBeCloseTo(6.9, 6);
    expect(p.prices!().edit.tall.low!).toEqual({ cents: expect.closeTo(6.9, 6), samples: 1 });
    // Generation previews are untouched by an edit's bill.
    expect(p.prices!().generate.tall.low!.samples).toBe(0);
  });

  it("runs the user's model pick for either op, and falls back to the op default otherwise", async () => {
    const p = provider();
    const ref = [{ image: Buffer.from(ONE_PX_PNG, 'base64'), role: 'identity' as const }];
    await p.generate({ prompt: 'x', orientation: 'portrait', modelFamily: 'gpt-image-2' });
    await p.edit({ prompt: 'x', orientation: 'portrait', modelFamily: FLARE, references: ref });
    await p.generate({ prompt: 'x', orientation: 'portrait', modelFamily: 'gpt-image-1' }); // not offered
    expect(calls.map((c) => c.model)).toEqual(['gpt-image-2', FLARE, FLARE]);
    expect(p.resolveModel!('edit', 'nonsense')).toBe(SUNBURST);
  });

  it('lists every model with its own tiers and prices', () => {
    const models = provider().models!;
    expect(models.map((m) => m.id)).toEqual([FLARE, SUNBURST, 'gpt-image-2']);
    const g2 = models.find((m) => m.id === 'gpt-image-2')!;
    expect(g2.qualityLevels).toEqual(['low', 'medium', 'high']);
    expect(Object.keys(g2.prices!.generate.tall)).toEqual(['low', 'medium', 'high']);
    // gpt-image-2 medium spends what 2.5 high does: 1,372 output tokens at 1536x1024.
    expect(g2.prices!.generate.tall.medium!.cents).toBeCloseTo(
      models.find((m) => m.id === FLARE)!.prices!.generate.tall.high!.cents,
      9,
    );
    expect(models.find((m) => m.id === SUNBURST)!.qualityLevels).toEqual([...IMAGE_QUALITY_TIERS]);
  });

  it("clamps a tier the chosen model lacks, and prices what actually runs", async () => {
    const p = provider();
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG }] }), { status: 200 });
    });
    await p.generate({ prompt: 'x', orientation: 'portrait', modelFamily: 'gpt-image-2', quality: 'max' });
    expect(JSON.parse(bodies[0]!).quality).toBe('high');
    const maxOnG2 = p.capabilities.costEstimate({ prompt: 'x', orientation: 'portrait', modelFamily: 'gpt-image-2', quality: 'max' });
    const highOnG2 = p.capabilities.costEstimate({ prompt: 'x', orientation: 'portrait', modelFamily: 'gpt-image-2', quality: 'high' });
    expect(maxOnG2).toBe(highOnG2);
  });
});

describe('clampQuality', () => {
  it('keeps tiers a model has and steps down to the nearest one it has', () => {
    expect(clampQuality(FLARE, 'max')).toBe('max');
    expect(clampQuality('gpt-image-2', 'medium')).toBe('medium');
    expect(clampQuality('gpt-image-2', 'xhigh')).toBe('high');
    expect(clampQuality('gpt-image-2', 'max')).toBe('high');
  });
});
