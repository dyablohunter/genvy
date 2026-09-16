import type { ImageOp, ImageProviderStatus } from '@genvy/shared';

/**
 * Which MODEL a request will run on, for everything that has to say so or
 * time it: busy labels, cost previews, and progress-bar buckets.
 *
 * A provider can run different models per kind of call (OpenAI: flare draws,
 * sunburst edits), and those models differ in latency and price. A label that
 * says only "GPT-IMAGE-2.5", or a timing bucket shared by both, is wrong for
 * one of them every time. The roster comes from /api/health, remembered by the
 * API layer whenever it is fetched.
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

/** Model id that will run `op` on this provider, when the provider names one. */
export function modelIdFor(providerId: string | undefined, op: ImageOp): string | undefined {
  const id = providerId || 'openai';
  const p = roster.find((x) => x.id === id);
  if (p?.modelIds) return p.modelIds[op];
  return id === 'openai' ? OPENAI_DEFAULT_MODELS[op] : undefined;
}

/** Busy-label name for that model ("GPT-IMAGE-2.5-SUNBURST"), when the provider names one. */
export function modelTag(providerId: string | undefined, op: ImageOp): string | undefined {
  return modelIdFor(providerId, op)?.toUpperCase();
}

/**
 * Timing-bucket segment: the provider plus its model for this op, so flare and
 * sunburst — or an env-var model swap — never pace against each other's runs.
 */
export function timingTag(providerId: string | undefined, op: ImageOp): string {
  const id = providerId || 'openai';
  const model = modelIdFor(id, op);
  return model ? `${id}:${model}` : id;
}

/**
 * Latency relative to gpt-image-2, which every hand-set fallback duration was
 * tuned on. OpenAI publishes flare at ~50% lower latency; sunburst is slower
 * than flare with no published figure, so it keeps the gpt-image-2 pacing.
 * Only an unlearned bucket's first run uses this — real runs take over.
 */
const LATENCY_VS_GPT_IMAGE_2: Record<string, number> = {
  'gpt-image-2.5-flare': 0.5,
  'gpt-image-2.5-sunburst': 1,
};

export function scaleFallback(ms: number, providerId: string | undefined, op: ImageOp): number {
  const model = modelIdFor(providerId, op);
  return Math.round(ms * (model ? (LATENCY_VS_GPT_IMAGE_2[model] ?? 1) : 1));
}
