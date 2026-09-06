import { randomUUID } from 'node:crypto';
import type { ComfyGraph } from './workflows.js';

/**
 * Minimal ComfyUI HTTP client: upload inputs, submit a graph, poll history,
 * fetch the output image. Polling (not websockets) on purpose — the queue
 * survives a dropped connection, and the service's own SSE layer is where
 * live progress belongs.
 */

export interface ComfyClientOptions {
  baseUrl: string;
  /** Whole-job deadline; a 25-step SDXL render is seconds, minutes means stuck. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ComfyHealth {
  up: boolean;
  /** Renderer description when up (e.g. GPU name from /system_stats). */
  device?: string;
  error?: string;
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ComfyClient {
  private baseUrl: string;
  private timeoutMs: number;
  private pollIntervalMs: number;
  private clientId = randomUUID();

  constructor(opts: ComfyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 750;
  }

  async health(): Promise<ComfyHealth> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { up: false, error: `HTTP ${res.status}` };
      const stats = (await res.json()) as { devices?: { name?: string }[] };
      return { up: true, device: stats.devices?.[0]?.name };
    } catch (err) {
      return { up: false, error: (err as Error)?.message ?? 'unreachable' };
    }
  }

  /**
   * Model filenames ComfyUI currently offers for a loader node class (e.g.
   * CheckpointLoaderSimple, UNETLoader) — how /health knows which model
   * families actually have their weights installed.
   */
  async modelOptions(nodeClass: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/object_info/${nodeClass}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const info = (await res.json()) as Record<
        string,
        { input?: { required?: Record<string, unknown[]> } }
      >;
      const required = info[nodeClass]?.input?.required ?? {};
      const names: string[] = [];
      for (const spec of Object.values(required)) {
        const options = Array.isArray(spec) ? spec[0] : undefined;
        if (Array.isArray(options) && options.every((o) => typeof o === 'string')) {
          names.push(...(options as string[]));
        }
      }
      return names;
    } catch {
      return [];
    }
  }

  /** Stop whatever ComfyUI is rendering right now (job cancellation). */
  async interrupt(): Promise<void> {
    await fetch(`${this.baseUrl}/interrupt`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      /* best-effort — the job's abort signal still stops the loop */
    });
  }

  /** Upload an input image; returns the name LoadImage nodes reference it by. */
  async uploadImage(png: Buffer, name: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
    form.append('overwrite', 'true');
    const res = await fetch(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ComfyUI upload failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { name?: string; subfolder?: string };
    if (!body.name) throw new Error('ComfyUI upload returned no name');
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  /** Submit a graph and wait for its first output image. */
  async run(graph: ComfyGraph, onProgress?: (note: string) => void): Promise<Buffer> {
    const submit = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!submit.ok) {
      throw new Error(`ComfyUI rejected the workflow: HTTP ${submit.status} ${await submit.text()}`);
    }
    const { prompt_id: promptId } = (await submit.json()) as { prompt_id?: string };
    if (!promptId) throw new Error('ComfyUI returned no prompt_id');

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      await sleep(this.pollIntervalMs);
      if (Date.now() > deadline) {
        throw new Error(`ComfyUI job ${promptId} exceeded ${Math.round(this.timeoutMs / 1000)}s`);
      }
      const res = await fetch(`${this.baseUrl}/history/${promptId}`, {
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!res?.ok) continue; // transient — the deadline bounds us
      const history = (await res.json()) as Record<string, HistoryEntry>;
      const entry = history[promptId];
      if (!entry) {
        onProgress?.('waiting in the ComfyUI queue');
        continue;
      }
      const status = entry.status?.status_str ?? '';
      if (status === 'error') {
        throw new Error(`ComfyUI job ${promptId} failed: ${JSON.stringify(entry.status?.messages ?? []).slice(0, 400)}`);
      }
      const image = Object.values(entry.outputs ?? {})
        .flatMap((o) => o.images ?? [])
        .find((i) => i.type === 'output');
      if (!image) {
        if (entry.status?.completed) throw new Error(`ComfyUI job ${promptId} completed with no output image`);
        onProgress?.('rendering');
        continue;
      }
      const query = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
      });
      const view = await fetch(`${this.baseUrl}/view?${query}`, { signal: AbortSignal.timeout(30_000) });
      if (!view.ok) throw new Error(`ComfyUI /view failed: HTTP ${view.status}`);
      return Buffer.from(await view.arrayBuffer());
    }
  }
}
