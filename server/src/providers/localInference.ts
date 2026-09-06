import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageAnimateRequest,
} from './types.js';
import { providerError } from './types.js';
import * as pipe from '../services/imagePipeline.js';
import { activity } from '../services/activity.js';

/**
 * P6 — the local-inference service (ComfyUI behind a job queue) wrapped as an
 * ImageProvider. Free by definition (`costEstimate: () => 0`), optional by
 * design: when the service is down the provider stays registered but
 * offline, exactly like a provider with a missing API key, and the app
 * behaves as it does today.
 *
 * `live` is a health question, not a key question — it is answered by a
 * cached poll of the service's /health (which also requires ComfyUI itself
 * to be up: a provider that is "live" but fails every job is worse than one
 * that says OFFLINE).
 */

interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'failed';
  error?: string;
  progress?: { stage: string; step: number; steps: number; free: boolean };
}

export interface LocalInferenceOptions {
  pollIntervalMs?: number;
  healthIntervalMs?: number;
  /** Whole-job deadline — a queued 12-frame animation can legitimately take minutes. */
  jobDeadlineMs?: number;
}

export type LocalInferenceProvider = ImageProvider & { refreshHealth(): Promise<boolean> };

export function createLocalInferenceProvider(
  baseUrl: string,
  opts: LocalInferenceOptions = {},
): LocalInferenceProvider {
  const base = baseUrl.replace(/\/$/, '');
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const jobDeadlineMs = opts.jobDeadlineMs ?? 15 * 60_000;

  let healthy = false;
  let models: import('./types.js').ProviderModelInfo[] | undefined;
  async function refreshHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
      const body = res.ok
        ? ((await res.json()) as {
            ok?: boolean;
            comfy?: { up?: boolean };
            models?: import('./types.js').ProviderModelInfo[];
          })
        : null;
      healthy = !!body?.ok && !!body?.comfy?.up;
      if (body?.models) models = body.models;
    } catch {
      healthy = false;
    }
    return healthy;
  }
  // First check fire-and-forget so construction stays sync; then keep it
  // fresh in the background. unref'd: an idle timer must not hold the
  // process (or a vitest run) open.
  void refreshHealth();
  const timer = setInterval(() => void refreshHealth(), opts.healthIntervalMs ?? 15_000);
  timer.unref?.();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The job the provider is currently waiting on — the cancel target. */
  let currentJobId: string | null = null;

  async function runJob(type: string, payload: Record<string, unknown>): Promise<Buffer> {
    let submit: Response;
    try {
      submit = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, payload }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      healthy = false;
      throw providerError(503, 'Local inference LINK OFFLINE — start the local-inference service');
    }
    if (!submit.ok) {
      const body = (await submit.json().catch(() => ({}))) as { error?: string };
      throw providerError(502, `Local inference rejected the job: ${body.error ?? `HTTP ${submit.status}`}`);
    }
    const { jobId } = (await submit.json()) as { jobId?: string };
    if (!jobId) throw providerError(502, 'Local inference returned no job id');
    currentJobId = jobId;

    const deadline = Date.now() + jobDeadlineMs;
    try {
    for (;;) {
      await sleep(pollIntervalMs);
      if (Date.now() > deadline) {
        throw providerError(504, `Local inference job ${jobId} is still running after ${jobDeadlineMs / 60000} minutes`);
      }
      const res = await fetch(`${base}/jobs/${jobId}`, { signal: AbortSignal.timeout(10_000) }).catch(
        () => null,
      );
      if (!res?.ok) continue; // transient — bounded by the deadline
      const status = (await res.json()) as JobStatus;
      // Relay the service's REAL stage (frame 3/8, composing, ...) into the
      // activity feed the HUD follows — the provider is already polling, so
      // live progress costs nothing extra.
      if (status.progress?.stage) {
        // SUB layer on purpose: this is progress inside ONE job — when the
        // route runs several jobs (4 candidates), its op layer owns the band.
        activity.update({
          label: status.progress.stage,
          subStep: status.progress.step,
          subSteps: status.progress.steps,
          cancelable: true, // local jobs are the abortable kind
        });
      }
      if (status.state === 'failed') {
        throw providerError(502, `Local inference job failed: ${status.error ?? 'no reason given'}`);
      }
      if (status.state !== 'done') continue;
      const result = await fetch(`${base}/jobs/${jobId}/result`, { signal: AbortSignal.timeout(30_000) });
      if (!result.ok) throw providerError(502, `Local inference result fetch failed: HTTP ${result.status}`);
      return Buffer.from(await result.arrayBuffer());
    }
    } finally {
      currentJobId = null;
    }
  }

  /**
   * SDXL cannot emit alpha, so the workflows render onto flat chroma green
   * and the alpha is made HERE, deterministically, with the pipeline's
   * existing keyer — the provider's outputs really do carry alpha, which is
   * what `nativeAlpha: true` promises downstream.
   */
  async function keyed(png: Buffer): Promise<Buffer> {
    const raw = await pipe.loadRaw(png);
    if (pipe.hasTransparency(raw)) return png;
    return pipe.toPng(pipe.removeBackground(raw, 24, 'both'));
  }

  const styleOf = (req: { style?: unknown }) => (req.style ? { style: req.style } : {});
  const reportFree = (req: { onBilled?: (i: { cents?: number }) => void }) => req.onBilled?.({ cents: 0 });

  return {
    id: 'local-comfy',
    name: 'Local ComfyUI',
    get live() {
      return healthy;
    },
    get models() {
      return models;
    },
    offlineHint:
      'start the local-inference service (npm run dev:local) and its ComfyUI; ' +
      'a fresh start can take ~15s to show LIVE',
    async cancelCurrent(): Promise<boolean> {
      const id = currentJobId;
      if (!id) return false;
      const res = await fetch(`${base}/jobs/${id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      return !!res?.ok;
    },
    refreshHealth,
    capabilities: {
      generate: true,
      edit: true,
      multiReference: false, // one identity reference; the pose slot is the service's own skeleton
      nativeAlpha: true, // chroma-keyed server-side — the delivered PNG has real alpha
      // SDXL renders layout instructions as noise (verified live: five strips
      // of garbage from one "2x2 grid" ask) — the route composes instead.
      gridSheets: false,
      independentFrames: true, // per-frame renders: the route re-registers strips
      animation: true,
      maxSize: 1024,
      costEstimate: () => 0, // the whole point
    },
    async generate(req: ImageGenerateRequest): Promise<Buffer> {
      const png = await runJob('generate', {
        prompt: req.prompt,
        // The service skips its segmentation cutout for full-canvas art.
        transparent: req.transparent !== false,
        ...(req.modelFamily ? { family: req.modelFamily } : {}),
        ...(req.renderSize ? { width: req.renderSize, height: req.renderSize } : {}),
        ...styleOf(req),
      });
      reportFree(req);
      return req.transparent === false ? png : keyed(png);
    },
    async edit(req: ImageEditRequest): Promise<Buffer> {
      const identity = req.references.find((r) => r.role === 'identity') ?? req.references[0];
      if (!identity) throw providerError(400, 'Local inference edits need a reference image');
      const png = await runJob('edit', {
        mode: req.purpose === 'repair' ? 'repair' : 'directional',
        image: identity.image.toString('base64'),
        prompt: req.prompt,
        ...(req.modelFamily ? { family: req.modelFamily } : {}),
        ...(req.renderSize ? { renderSize: req.renderSize } : {}),
        ...styleOf(req),
      });
      reportFree(req);
      return keyed(png);
    },
    async animate(req: ImageAnimateRequest): Promise<Buffer> {
      const png = await runJob('animate', {
        anchor: req.anchor.toString('base64'),
        action: req.action,
        frames: req.frames,
        ...(req.facing ? { facing: req.facing } : {}),
        ...(req.modelFamily ? { family: req.modelFamily } : {}),
        ...(req.renderSize ? { renderSize: req.renderSize } : {}),
        ...(req.identityPrompt ? { identityPrompt: req.identityPrompt } : {}),
        prompt: req.prompt ?? '',
        ...styleOf(req),
      });
      reportFree(req);
      return keyed(png);
    },
  };
}
