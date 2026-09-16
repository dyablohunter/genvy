import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageOp, ImagePriceTable, ImageQualityTier, ImageOrientation } from '@genvy/shared';
import type { OpenAiImageUsage } from '../services/openaiImage.js';

/**
 * What OpenAI image calls cost. Two separate questions, answered separately:
 *
 * - What did THIS call cost? Every gpt-image response carries a `usage` block,
 *   so the spend ledger books tokens x published rates — exact, not a guess.
 * - What WILL a call cost? The OUTPUT is exactly predictable: OpenAI's image
 *   calculator follows a closed formula (`outputTokens`). The INPUT is not —
 *   prompt text and reference images are billed too and the calculator
 *   excludes them. So the preview is LEARNED: a rolling average of real billed
 *   calls per model, op, canvas and quality, seeded with the exact output cost
 *   plus an input estimate until a bucket has seen its first call.
 */

/** Published USD per 1M tokens. gpt-image-2.5 flare and sunburst share gpt-image-2's rates. */
export interface TokenRates {
  textIn: number;
  imageIn: number;
  imageOut: number;
}

const GPT_IMAGE_RATES: TokenRates = { textIn: 5, imageIn: 8, imageOut: 30 };

export function tokenRates(_model: string): TokenRates {
  // Every model this app may run (gpt-image-2, gpt-image-2.5-flare/-sunburst)
  // is billed at the same rates; branch here if a future model differs.
  return GPT_IMAGE_RATES;
}

/**
 * Exact cost of one call, in cents, from the usage OpenAI reported. Cached
 * input discounts are ignored (image prompts vary per call, so caching is
 * rare) — that can only overstate, never hide spend. When the input split is
 * missing, edits are charged at the image-input rate (their input is mostly
 * the reference image) and generations at the text rate.
 */
export function usageCents(model: string, op: ImageOp, usage: OpenAiImageUsage): number {
  const rates = tokenRates(model);
  const details = usage.input_tokens_details;
  const inputTokens = usage.input_tokens ?? 0;
  const text = details?.text_tokens;
  const image = details?.image_tokens;
  const inputUsd =
    text !== undefined || image !== undefined
      ? (text ?? 0) * rates.textIn + (image ?? 0) * rates.imageIn
      : inputTokens * (op === 'edit' ? rates.imageIn : rates.textIn);
  const outputUsd = (usage.output_tokens ?? 0) * rates.imageOut;
  return ((inputUsd + outputUsd) / 1e6) * 100;
}

export type PriceCanvas = 'square' | 'tall';

export function canvasOf(orientation: ImageOrientation | undefined): PriceCanvas {
  return orientation === 'square' ? 'square' : 'tall';
}

/**
 * Per-quality axis constant of OpenAI's output-token formula. gpt-image-2.5
 * renamed the tiers: its `high` spends what gpt-image-2 `medium` did, and its
 * `max` (96) what gpt-image-2 `high` did. Genvy offers low/medium/high.
 */
const QUALITY_AXIS: Record<'gpt-image-2.5' | 'gpt-image-2', Record<ImageQualityTier, number>> = {
  'gpt-image-2.5': { low: 16, medium: 24, high: 48 }, // xhigh 64, max 96 — not offered
  'gpt-image-2': { low: 16, medium: 48, high: 96 },
};

/**
 * Output tokens for one image — OpenAI's calculator formula, verified against
 * it: gpt-image-2.5 low is 158 tokens ($0.00474) at 1536x1024 and 196 tokens
 * ($0.00588) at 1024x1024; the same formula with gpt-image-2's constants
 * reproduces that model's published table. Output depends only on the canvas
 * and quality, so flare and sunburst price identically.
 *
 *   tokens = ceil(q * round(q * short / long) * (2,000,000 + w*h) / 4,000,000)
 *
 * A square costs MORE than 1536x1024 at every tier (its short-axis factor is
 * the full q), which is why the canvas is part of every price key.
 */
export function outputTokens(model: string, width: number, height: number, quality: ImageQualityTier): number {
  const axis = QUALITY_AXIS[model.startsWith('gpt-image-2.5') ? 'gpt-image-2.5' : 'gpt-image-2'];
  const q = axis[quality];
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const shortFactor = Math.floor((2 * q * short + long) / (2 * long)); // round half up, in integers
  return Math.ceil((q * shortFactor * (2_000_000 + width * height)) / 4_000_000);
}

/** Pixel size genvy requests per price canvas (services/openaiImage.ts SIZES; portrait and landscape tokenize alike). */
const CANVAS_PX: Record<PriceCanvas, [number, number]> = { square: [1024, 1024], tall: [1536, 1024] };

export function outputCents(model: string, canvas: PriceCanvas, quality: ImageQualityTier): number {
  const [w, h] = CANVAS_PX[canvas];
  return ((outputTokens(model, w, h, quality) * tokenRates(model).imageOut) / 1e6) * 100;
}

/**
 * Prompt size assumed when a preview has no prompt in hand: genvy's image
 * prompts measure ~130 (tileset) to ~960 (8-frame animation) tokens, ~600
 * typical. At low quality that text is over half the image's cost, so it is
 * not rounding error.
 */
export const TYPICAL_PROMPT_TOKENS = 600;

/**
 * Seed surcharge for an edit's reference image, in cents — roughly 1,250 image
 * input tokens at $8/1M. Not published anywhere: it exists so an unlearned
 * edit preview is not quoted at the bare generation price, and the first
 * billed edit replaces it with the real figure.
 */
export const EDIT_REFERENCE_SEED_CENTS = 1;

const QUALITIES: ImageQualityTier[] = ['low', 'medium', 'high'];
/** Rolling window: a price change on OpenAI's side shows up within ~20 calls. */
const MAX_SAMPLES = 20;

interface Entry {
  cents: number;
  samples: number;
}

class ImageCostBook {
  private entries: Record<string, Entry> = {};
  private file = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Load learned prices from `library/image-costs.json` (the library root survives WIPE ALL). */
  async init(libraryDir: string) {
    this.file = path.join(libraryDir, 'image-costs.json');
    try {
      this.entries = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, Entry>;
    } catch {
      this.entries = {};
    }
  }

  /** Forget everything learned (tests). */
  reset() {
    this.entries = {};
  }

  private key(model: string, op: ImageOp, canvas: PriceCanvas, quality: ImageQualityTier) {
    return `${model}|${op}|${canvas}|${quality}`;
  }

  /** Fold one billed call into its bucket's rolling average. */
  observe(model: string, op: ImageOp, canvas: PriceCanvas, quality: ImageQualityTier, cents: number) {
    if (!Number.isFinite(cents) || cents <= 0) return;
    const k = this.key(model, op, canvas, quality);
    const entry = this.entries[k] ?? { cents, samples: 0 };
    entry.cents = (entry.cents * entry.samples + cents) / (entry.samples + 1);
    entry.samples = Math.min(entry.samples + 1, MAX_SAMPLES);
    this.entries[k] = entry;
    this.scheduleSave();
  }

  /**
   * Expected cents for one call: the learned average, or while unlearned the
   * seed — exact output cost + prompt text (its real length when the caller
   * has the prompt) + the reference-image guess for edits.
   */
  estimate(
    model: string,
    op: ImageOp,
    canvas: PriceCanvas,
    quality: ImageQualityTier,
    promptTokens = TYPICAL_PROMPT_TOKENS,
  ): Entry {
    const learned = this.entries[this.key(model, op, canvas, quality)];
    if (learned && learned.samples > 0) return { cents: learned.cents, samples: learned.samples };
    const promptCents = ((promptTokens * tokenRates(model).textIn) / 1e6) * 100;
    const seed =
      outputCents(model, canvas, quality) + promptCents + (op === 'edit' ? EDIT_REFERENCE_SEED_CENTS : 0);
    return { cents: seed, samples: 0 };
  }

  /** The whole canvas x quality table for one model and op, for /api/health. */
  table(model: string, op: ImageOp): ImagePriceTable {
    const row = (canvas: PriceCanvas) =>
      Object.fromEntries(QUALITIES.map((q) => [q, this.estimate(model, op, canvas, q)])) as Record<
        ImageQualityTier,
        Entry
      >;
    return { square: row('square'), tall: row('tall') };
  }

  private scheduleSave() {
    if (this.writeTimer || !this.file) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void fs.writeFile(this.file, JSON.stringify(this.entries, null, 2)).catch(() => {
        /* learned prices are best-effort; seeds still apply */
      });
    }, 500);
  }
}

export const imageCosts = new ImageCostBook();
