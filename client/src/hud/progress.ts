/**
 * Learned durations for the determinate progress bar.
 *
 * Every AI request (image, video, text — API or local inference) runs behind a
 * busy indicator whose bar fills over the LEARNED average for that kind of
 * operation, so the estimate sharpens as the user works. Buckets are keyed by
 * what actually drives the duration (operation + shape, e.g. frame count),
 * never by asset id. See CLAUDE.md "Progress feedback".
 */

const KEY = 'genvy-durations';
/** Rolling window: recent runs keep influence when providers/models change. */
const MAX_SAMPLES = 20;

interface Bucket {
  avg: number;
  n: number;
}

function load(): Record<string, Bucket> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Bucket>;
  } catch {
    return {};
  }
}

/** Average duration for this bucket, or the caller's fallback when unlearned. */
export function expectedDuration(key: string, fallbackMs: number): number {
  const entry = load()[key];
  return entry && entry.n > 0 ? entry.avg : fallbackMs;
}

/** Fold one completed run into its bucket's rolling average. */
export function recordDuration(key: string, ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    const map = load();
    const entry = map[key] ?? { avg: ms, n: 0 };
    entry.avg = (entry.avg * entry.n + ms) / (entry.n + 1);
    entry.n = Math.min(entry.n + 1, MAX_SAMPLES);
    map[key] = entry;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — estimates fall back to the defaults */
  }
}

/** What the estimator has learned so far (for debugging the progress bar). */
export function durationStats(): Record<string, Bucket> {
  return load();
}

/**
 * Timing bucket + human label for one image/video generation request, derived
 * from the request body. Used by the API layer's safety net so EVERY AI
 * generation shows a determinate bar even if its call site forgot to wrap it
 * (see CLAUDE.md "Progress feedback").
 */
export function aiImageBucket(body: { kind?: string; frames?: number; provider?: string }): {
  key: string;
  fallbackMs: number;
  label: string;
} {
  const kind = body.kind ?? 'raw';
  const provider = (body.provider ?? 'openai').toUpperCase().replace('OPENAI', 'GPT-IMAGE-2');
  switch (kind) {
    case 'anchor':
    case 'variants':
      return {
        key: `img:${provider}:anchor`,
        fallbackMs: 48000,
        label: `${provider} · DRAWING 4 NEUTRAL ANCHOR CANDIDATES...`,
      };
    case 'anchorDirectional':
      return {
        key: `img:${provider}:anchorDirectional`,
        fallbackMs: 38000,
        label: `${provider} · EDITING THE ANCHOR INTO A NEW VIEW...`,
      };
    case 'neutralReset':
      return {
        key: `img:${provider}:neutralReset`,
        fallbackMs: 38000,
        label: `${provider} · STRIPPING PROPS & EFFECTS FROM THE ANCHOR...`,
      };
    case 'animation': {
      const frames = body.frames ?? 4;
      return {
        key: `img:${provider}:animation:${frames}`,
        fallbackMs: 30000 + frames * 2500,
        label: `${provider} · DRAWING A ${frames}-FRAME ANIMATION SHEET...`,
      };
    }
    case 'tileset':
      return {
        key: `img:${provider}:tileset`,
        fallbackMs: 50000,
        label: `${provider} · DRAWING THE TILE GRID...`,
      };
    default:
      return {
        key: `img:${provider}:raw`,
        fallbackMs: 35000,
        label: `${provider} · GENERATING IMAGE...`,
      };
  }
}
