import sharp from 'sharp';
import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageAnimateRequest,
  ProviderBilling,
} from './types.js';
import { providerError, offlineError } from './types.js';

/**
 * Retro Diffusion — pixel-style sprites up to 384px plus a purpose-built
 * animation endpoint (anchor frame + action -> transparent spritesheet).
 * docs/sprite-pipeline-v2.md §E4: `POST /v1/inferences` with `X-RD-Token`;
 * animation via `input_image` (32-256px) + `prompt_style:
 * rd_advanced_animation__<action>` + `frames_duration` in {4,6,8,10,12,16}.
 */

/**
 * v2 queues every job and answers with a task id — holding the connection
 * open (the v1 pattern) makes long animations die at their gateway with an
 * nginx 502 while the inference keeps running and billing.
 */
const API_BASE = 'https://api.retrodiffusion.ai/v2';
const ALLOWED_FRAMES = [4, 6, 8, 10, 12, 16];
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;
/** How long to wait for a queued job before giving up on it. */
const JOB_DEADLINE_MS = 300_000;
/** Their edge answers with an nginx page when a job outlives the gateway. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_RETRIES = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gateway HTML is noise — keep the status, drop the markup. */
function describeFailure(status: number, body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    const title = /<title>([^<]+)<\/title>/i.exec(trimmed)?.[1]?.trim();
    return title ? `${title} (from their gateway, not your prompt)` : `HTTP ${status}`;
  }
  return trimmed.slice(0, 400);
}

/** Actions with a dedicated rd_advanced_animation style; others go through custom_action. */
const ANIMATION_STYLES: Record<string, string> = {
  walk: 'walking',
  walking: 'walking',
  idle: 'idle',
  attack: 'attack',
  jump: 'jump',
  crouch: 'crouch',
  destroy: 'destroy',
  subtle_motion: 'subtle_motion',
};

function nearestFrameCount(frames: number): number {
  return ALLOWED_FRAMES.reduce((best, f) =>
    Math.abs(f - frames) < Math.abs(best - frames) ? f : best,
  );
}

/**
 * The animation endpoint returns an animated GIF (verified live 2026-09-02),
 * but the pipeline consumes PNG spritesheets — decompose the frames into one
 * horizontal PNG strip. Single-frame or already-PNG payloads pass through.
 */
export async function animationToSheet(image: Buffer): Promise<Buffer> {
  const meta = await sharp(image, { animated: true }).metadata();
  const pages = meta.pages ?? 1;
  const width = meta.width ?? 0;
  const height = meta.pageHeight ?? (pages > 1 ? Math.round((meta.height ?? 0) / pages) : meta.height ?? 0);
  if (pages <= 1 || width < 1 || height < 1) return sharp(image).png().toBuffer();
  const frames = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      sharp(image, { page: i }).ensureAlpha().png().toBuffer(),
    ),
  );
  return sharp({
    create: { width: width * pages, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(frames.map((input, i) => ({ input, left: i * width, top: 0 })))
    .png()
    .toBuffer();
}

/**
 * Anchor input must be 32-256px. The API sizes the output from width/height,
 * which must describe the image we actually send — so report the resized
 * dimensions rather than assuming a square.
 */
async function toAnchorInput(
  anchor: Buffer,
): Promise<{ base64: string; width: number; height: number }> {
  const { data, info } = await sharp(anchor)
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true, kernel: 'nearest' })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { base64: data.toString('base64'), width: info.width, height: info.height };
}

export function createRetroDiffusionProvider(apiKey: string): ImageProvider {
  const live = apiKey.length > 0;

  interface TaskPayload {
    status?: string;
    task_id?: string;
    base64_images?: string[];
    error?: string;
    message?: string;
    /** Dollars, per their API — what this call cost and what is left. */
    balance_cost?: number;
    remaining_balance?: number;
  }

  const headers = { 'Content-Type': 'application/json', 'X-RD-Token': apiKey };

  /** One HTTP round trip, retrying only transient gateway/network failures. */
  async function http(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: true; data: TaskPayload } | { ok: false; failure: string; status: number }> {
    let lastFailure = 'network error';
    let lastStatus = 0;
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        lastFailure =
          (err as Error)?.name === 'TimeoutError'
            ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
            : ((err as Error)?.message ?? 'network error');
        continue;
      }
      if (res.ok) return { ok: true, data: (await res.json()) as TaskPayload };

      const text = await res.text();
      if (/moderat|nsfw|content policy|not allowed/i.test(text)) {
        throw providerError(422, 'Retro Diffusion rejected the prompt (content policy).');
      }
      lastStatus = res.status;
      lastFailure = describeFailure(res.status, text);
      if (!TRANSIENT_STATUS.has(res.status)) break;
    }
    return { ok: false, failure: lastFailure, status: lastStatus };
  }

  /**
   * Submit a job and poll it to completion. The queue is the contract here:
   * the submit call returns a task id in seconds, and the (possibly minutes
   * long) render is collected by polling, so nothing is lost to a gateway
   * timeout and every paid job is actually delivered.
   */
  async function call(
    body: Record<string, unknown>,
    onBilled?: (info: ProviderBilling) => void,
  ): Promise<Buffer> {
    /** Their figures are dollars; ours are cents. */
    const report = (p: TaskPayload) => {
      if (!onBilled) return;
      if (p.balance_cost === undefined && p.remaining_balance === undefined) return;
      onBilled({
        cents: p.balance_cost === undefined ? undefined : Math.round(p.balance_cost * 100 * 1000) / 1000,
        balanceCents:
          p.remaining_balance === undefined ? undefined : Math.round(p.remaining_balance * 100),
      });
    };
    const submit = await http(`${API_BASE}/inferences`, {
      method: 'POST',
      body: JSON.stringify({ ...body, async: true }),
    });
    if (!submit.ok) {
      throw providerError(
        submit.status && !TRANSIENT_STATUS.has(submit.status) ? 502 : 504,
        `Retro Diffusion would not accept the job — ${submit.failure}.`,
      );
    }

    // Small jobs may come back inline; anything queued gives us a task id.
    const inline = submit.data.base64_images?.[0];
    if (inline) {
      report(submit.data);
      return Buffer.from(inline, 'base64');
    }
    const taskId = submit.data.task_id;
    if (!taskId) throw providerError(502, 'Retro Diffusion returned neither an image nor a task id');

    const deadline = Date.now() + JOB_DEADLINE_MS;
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await http(`${API_BASE}/inferences/tasks/${taskId}`, { method: 'GET' });
      if (poll.ok) {
        const status = (poll.data.status ?? '').toLowerCase();
        const b64 = poll.data.base64_images?.[0];
        if (b64) {
          report(poll.data);
          return Buffer.from(b64, 'base64');
        }
        if (status === 'failed') {
          throw providerError(
            502,
            `Retro Diffusion job ${taskId} failed: ${poll.data.error ?? poll.data.message ?? 'no reason given'}`,
          );
        }
        if (status === 'succeeded') {
          throw providerError(502, `Retro Diffusion job ${taskId} succeeded but returned no image`);
        }
      }
      if (Date.now() > deadline) {
        throw providerError(
          504,
          `Retro Diffusion job ${taskId} is still running after ${JOB_DEADLINE_MS / 60000} minutes. ` +
            'It stays retrievable on their dashboard for 24h; try fewer frames, or forge this clip with gpt-image-2.',
        );
      }
    }
  }

  return {
    id: 'retrodiffusion',
    name: 'Retro Diffusion',
    live,
    capabilities: {
      generate: true,
      edit: false, // reference_images steer style, not true instruction edits
      multiReference: false,
      nativeAlpha: true, // remove_bg delivers a real alpha channel
      gridSheets: false, // draws one sprite per call; the route composes candidate grids
      animation: true,
      maxSize: 384,
      // Observed on their API Activity dashboard: $0.140 per animation,
      // $0.180 per rd_pro generation.
      costEstimate: (req) => ('anchor' in req ? 14 : 18),
    },
    async generate(req: ImageGenerateRequest): Promise<Buffer> {
      if (!live) throw offlineError('retrodiffusion');
      return call(
        {
          prompt: req.prompt,
          prompt_style: 'rd_pro__default',
          width: 256,
          height: 256,
          num_images: 1,
          remove_bg: req.transparent ?? true,
        },
        req.onBilled,
      );
    },
    async edit(): Promise<Buffer> {
      throw providerError(400, 'Retro Diffusion does not support instruction edits — use animate() or another provider');
    },
    async animate(req: ImageAnimateRequest): Promise<Buffer> {
      if (!live) throw offlineError('retrodiffusion');
      const mapped = ANIMATION_STYLES[req.action.toLowerCase()];
      const anchor = await toAnchorInput(req.anchor);
      const result = await call(
        {
          prompt: req.prompt ?? `${req.action} animation`,
          prompt_style: mapped
            ? `rd_advanced_animation__${mapped}`
            : 'rd_advanced_animation__custom_action',
          input_image: anchor.base64,
          // Must describe the image we actually sent, not a presumed square.
          width: anchor.width,
          height: anchor.height,
          frames_duration: nearestFrameCount(req.frames),
          num_images: 1,
          remove_bg: true,
        },
        req.onBilled,
      );
      try {
        // The endpoint answers with an animated GIF; the pipeline wants a strip.
        return await animationToSheet(result);
      } catch (err) {
        throw providerError(
          502,
          `Retro Diffusion returned an animation this build could not decode: ${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    },
  };
}
