import type { ImageOp, ImageProviderStatus, ImageQualityTier } from '@genvy/shared';

/**
 * Which MODEL a request will run on, for everything that has to say so, price
 * it or time it: busy labels, quality pickers, cost previews, and
 * progress-bar buckets — plus the shared model/quality select filling every
 * tool uses.
 *
 * A provider can offer several models (OpenAI: gpt-image-2.5 flare and
 * sunburst, gpt-image-2; the local service: its families), and the user picks
 * one per operation. Models differ in latency, price and even which quality
 * tiers exist, so a label, a price or a timing bucket that ignores the pick is
 * wrong for every other model. The roster comes from /api/health, remembered
 * by the API layer whenever it is fetched.
 */

let roster: ImageProviderStatus[] = [];

export function rememberProviders(providers: ImageProviderStatus[]) {
  roster = providers;
}

/** Request kinds the server runs as reference edits — mirrors EDIT_KINDS in server/src/routes/ai.ts. */
const EDIT_KINDS = new Set(['animation', 'anchorDirectional', 'neutralReset', 'sceneCutout']);

export function opForKind(kind: string | undefined): ImageOp {
  return kind && EDIT_KINDS.has(kind) ? 'edit' : 'generate';
}

/** The server's defaults, used until the roster has loaded (the server default provider is openai). */
const OPENAI_DEFAULT_MODELS: Record<ImageOp, string> = {
  generate: 'gpt-image-2.5-flare',
  edit: 'gpt-image-2.5-sunburst',
};

type ProviderModel = NonNullable<ImageProviderStatus['models']>[number];

/** The picked model's roster entry, when the provider offers it. */
export function modelInfo(p: ImageProviderStatus | undefined, family: string | undefined): ProviderModel | undefined {
  return family ? p?.models?.find((m) => m.id === family) : undefined;
}

/**
 * Model id that will run `op` on this provider: the user's pick when the
 * provider offers it, else the provider's default for that op. Undefined for
 * providers that name no model.
 */
export function modelIdFor(providerId: string | undefined, op: ImageOp, family?: string): string | undefined {
  const id = providerId || 'openai';
  const p = roster.find((x) => x.id === id);
  if (p) {
    if (modelInfo(p, family)) return family;
    return p.modelIds?.[op];
  }
  return id === 'openai' ? (family ?? OPENAI_DEFAULT_MODELS[op]) : undefined;
}

/** Busy-label name for API models that name themselves ("GPT-IMAGE-2.5-SUNBURST"). */
export function modelTag(providerId: string | undefined, op: ImageOp, family?: string): string | undefined {
  const id = providerId || 'openai';
  const p = roster.find((x) => x.id === id);
  // Local families have human labels of their own — callers name those.
  if (p && !p.modelIds) return undefined;
  return modelIdFor(id, op, family)?.toUpperCase();
}

/**
 * Timing-bucket segment: the provider plus the model that runs, so flare,
 * sunburst, gpt-image-2 and each local family never pace against each
 * other's runs.
 */
export function timingTag(providerId: string | undefined, op: ImageOp, family?: string): string {
  const id = providerId || 'openai';
  const model = modelIdFor(id, op, family);
  return model ? `${id}:${model}` : id;
}

/**
 * Latency relative to gpt-image-2, which every hand-set fallback duration was
 * tuned on. OpenAI publishes flare at ~50% lower latency; sunburst is slower
 * than flare with no published figure, so it keeps the gpt-image-2 pacing.
 * Only an unlearned bucket's first run uses this — real runs take over.
 */
const LATENCY_VS_GPT_IMAGE_2: Record<string, number> = {
  'gpt-image-2': 1,
  'gpt-image-2.5-flare': 0.5,
  'gpt-image-2.5-sunburst': 1,
};

export function scaleFallback(ms: number, providerId: string | undefined, op: ImageOp, family?: string): number {
  const model = modelIdFor(providerId, op, family);
  return Math.round(ms * (model ? (LATENCY_VS_GPT_IMAGE_2[model] ?? 1) : 1));
}

/** The quality tiers the picked model offers (else the provider's), in order. */
export function qualityTiersFor(p: ImageProviderStatus | undefined, family: string | undefined): ImageQualityTier[] {
  return modelInfo(p, family)?.qualityLevels ?? p?.capabilities.qualityLevels ?? [];
}

/** One image's learned price for the picked model (else the provider default), op, canvas and tier. */
export function priceEntry(
  p: ImageProviderStatus | undefined,
  family: string | undefined,
  op: ImageOp,
  canvas: 'square' | 'tall',
  tier: ImageQualityTier,
): { cents: number; samples: number } | undefined {
  return (modelInfo(p, family)?.prices ?? p?.prices)?.[op]?.[canvas]?.[tier];
}

/** "$0.008", or "~$0.008" while no billed call has priced it yet. */
export function formatPrice(entry: { cents: number; samples: number }, calls = 1): string {
  return `${entry.samples === 0 ? '~' : ''}$${((entry.cents / 100) * calls).toFixed(3)}`;
}

/**
 * Fill a MODEL select for one job. Every model is listed; ones that are
 * untested, missing their weights or unable to do this job are named and
 * disabled. The selection keeps the user's previous pick when it still
 * works, else the provider's default model for `op`, else the first usable.
 * Returns whether the provider offers a model choice at all.
 */
export function fillModelOptions(
  sel: HTMLSelectElement,
  p: ImageProviderStatus | undefined,
  workflow: string,
  op: ImageOp,
): boolean {
  const models = p?.models ?? [];
  const previous = sel.value;
  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const can = m.workflows.includes(workflow);
    const tags = [...(m.heavy ? ['VERY SLOW'] : []), ...(can ? [] : ['CANNOT DO THIS JOB'])];
    opt.textContent = !m.verified
      ? `${m.label.toUpperCase()} · UNTESTED`
      : !m.available
        ? `${m.label.toUpperCase()} · MODELS MISSING`
        : tags.length
          ? `${m.label.toUpperCase()} · ${tags.join(' · ')}`
          : m.label.toUpperCase();
    opt.disabled = !m.verified || !m.available || !can;
    sel.appendChild(opt);
  }
  const usable = models.filter((m) => m.verified && m.available && m.workflows.includes(workflow));
  const fallback = usable.find((m) => m.id === p?.modelIds?.[op]) ?? usable[0];
  sel.value = usable.some((m) => m.id === previous) ? previous : fallback?.id ?? '';
  return models.length > 0;
}

/**
 * Fill a QUALITY select with the tiers the picked model offers, each labelled
 * with its price for `op` on `canvas`. Keeps the previous tier when this model
 * has it, else steps down to the nearest tier it does have (never up — a
 * model switch must not quietly raise the cost). Returns whether there are
 * tiers to show.
 */
export function fillQualityOptions(
  sel: HTMLSelectElement,
  p: ImageProviderStatus | undefined,
  family: string | undefined,
  op: ImageOp,
  canvas: 'square' | 'tall',
): boolean {
  const tiers = qualityTiersFor(p, family);
  const previous = sel.value as ImageQualityTier;
  sel.innerHTML = '';
  for (const tier of tiers) {
    const opt = document.createElement('option');
    opt.value = tier;
    const entry = priceEntry(p, family, op, canvas, tier);
    opt.textContent = entry ? `${tier.toUpperCase()} · ${formatPrice(entry)}` : tier.toUpperCase();
    sel.appendChild(opt);
  }
  if (tiers.length === 0) return false;
  if (tiers.includes(previous)) {
    sel.value = previous;
  } else {
    const order: ImageQualityTier[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    const below = order.slice(0, Math.max(0, order.indexOf(previous)) + 1).reverse();
    sel.value = below.find((t) => tiers.includes(t)) ?? tiers[0]!;
  }
  return true;
}

/** Two fields on one line at a 60/40 split — PROVIDER (or MODEL) beside QUALITY everywhere. */
export function splitRow(left: HTMLElement, right: HTMLElement): HTMLDivElement {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  left.style.flex = '1 1 60%';
  right.style.flex = '1 1 40%';
  for (const f of [left, right]) f.style.minWidth = '0';
  row.append(left, right);
  return row;
}
