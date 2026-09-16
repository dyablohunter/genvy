import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageOp, ImagePriceTable, ImageQualityTier, ImageOrientation } from '@genvy/shared';
import type { OpenAiImageUsage } from '../services/openaiImage.js';

/**
 * What OpenAI image calls cost. Two separate questions, answered separately:
 *
 * - What did THIS call cost? Every gpt-image response carries a `usage` block,
 *   so the spend ledger books tokens x published rates — exact, not a guess.
 * - What WILL a call cost? OpenAI publishes token rates but no per-image table
 *   for gpt-image-2.5, and its token counts differ from gpt-image-2's. So the
 *   preview is LEARNED: a rolling average of real billed calls per model, op,
 *   canvas and quality, seeded from the published gpt-image-2 prices until a
 *   bucket has seen its first call.
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
 * Seed per-image prices in CENTS: the published gpt-image-2 table (same token
 * rates). Square is not a discount on the tall/wide canvas — it costs MORE at
 * every tier.
 *
 *              1024x1024   1024x1536 / 1536x1024
 *   low          $0.006            $0.005
 *   medium       $0.053            $0.041
 *   high         $0.211            $0.165
 */
export const OPENAI_IMAGE_PRICE: Record<PriceCanvas, Record<ImageQualityTier, number>> = {
  square: { low: 0.6, medium: 5.3, high: 21.1 },
  tall: { low: 0.5, medium: 4.1, high: 16.5 },
};

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

  /** Expected cents for one call: the learned average, or the seed while unlearned. */
  estimate(model: string, op: ImageOp, canvas: PriceCanvas, quality: ImageQualityTier): Entry {
    const learned = this.entries[this.key(model, op, canvas, quality)];
    if (learned && learned.samples > 0) return { cents: learned.cents, samples: learned.samples };
    const seed = OPENAI_IMAGE_PRICE[canvas][quality] + (op === 'edit' ? EDIT_REFERENCE_SEED_CENTS : 0);
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
