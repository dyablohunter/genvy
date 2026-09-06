import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { ComfyClient } from './comfy.js';
import { JobQueue } from './queue.js';
import { LocalUsage } from './usage.js';
import { JOB_TYPES, makeRunner, type JobType, type RunnerDeps, SkeletonPayloadSchema } from './jobs.js';
import { rembgAvailable } from './rembg.js';
import { getModelFamily, MODEL_FAMILIES } from './models.js';
import { clipSkeleton, skeletonStripPng } from './skeleton/index.js';

/**
 * The local-inference HTTP service. Same shape as the API providers Genvy
 * already speaks to: submit a job, watch its progress (SSE or polling),
 * collect a PNG. Genvy's server wraps this behind the ImageProvider
 * interface; nothing in the app talks to ComfyUI directly.
 */

export interface ServerOptions {
  comfyUrl: string;
  /** '' = the model family's default checkpoint. */
  checkpoint: string;
  renderSize: number;
  dataDir: string;
  /** Model family driving the workflows (src/models.ts); default z-image-turbo. */
  modelFamily?: string;
  /** Per-render ComfyUI deadline; big models need far more than the 300s default. */
  comfyJobTimeoutMs?: number;
  /** Python with rembg installed; '' disables segmentation cutouts. */
  rembgPython?: string;
  logger?: boolean;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false, bodyLimit: 64 * 1024 * 1024 });
  const comfy = new ComfyClient({ baseUrl: opts.comfyUrl, timeoutMs: opts.comfyJobTimeoutMs });
  const family = getModelFamily(opts.modelFamily);
  const deps: RunnerDeps = {
    comfy,
    renderSize: opts.renderSize,
    checkpoint: opts.checkpoint,
    family,
    configFamilyId: family.id,
    rembgPython: opts.rembgPython ?? '',
    dataDir: opts.dataDir,
  };
  const queue = new JobQueue();
  const usage = new LocalUsage();
  await usage.init(opts.dataDir);

  queue.onFinished = (job, ms) => {
    usage.record(job.type, { ms, failed: job.state === 'failed', images: job.state === 'done' ? 1 : 0 });
  };

  await app.register(cors, { origin: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: `Invalid payload: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: (err as Error).message ?? 'Internal error' });
  });

  /** Liveness + whether the GPU backend behind it is reachable. */
  app.get('/health', async () => {
    const comfyHealth = await comfy.health();
    // Which families have their weights actually installed: union of every
    // model filename ComfyUI's loader nodes offer right now.
    const installed = new Set(
      comfyHealth.up
        ? (
            await Promise.all(
              ['CheckpointLoaderSimple', 'UNETLoader', 'UnetLoaderGGUF'].map((c) =>
                comfy.modelOptions(c),
              ),
            )
          ).flat()
        : [],
    );
    return {
      ok: true,
      service: 'genvy-local-inference',
      comfy: comfyHealth,
      rembg: deps.rembgPython ? await rembgAvailable(deps.rembgPython) : false,
      /** The service default; jobs may override per-request via payload.family. */
      model: {
        family: family.id,
        label: family.label,
        checkpoint: opts.checkpoint || family.checkpoint,
        workflows: family.workflows,
        verified: family.verified,
      },
      /** Every family the service can drive, for pickers. */
      models: Object.values(MODEL_FAMILIES).map((f) => ({
        id: f.id,
        label: f.label,
        workflows: f.workflows,
        verified: f.verified,
        ...(f.heavy ? { heavy: true } : {}),
        // The ACTIVE family runs whatever COMFY_CHECKPOINT says (e.g. a GGUF
        // quant) — availability must test the file actually in play.
        available:
          comfyHealth.up &&
          installed.has(f.id === family.id ? opts.checkpoint || f.checkpoint : f.checkpoint),
      })),
      queueDepth: queue.depth(),
    };
  });

  app.get('/usage', async () => usage.snapshot());

  /** Recent jobs (newest first) — the recovery path for orphaned job ids. */
  app.get('/jobs', async () => ({ jobs: queue.list() }));

  app.post<{ Body: { type?: string; payload?: unknown } }>('/jobs', async (req, reply) => {
    const { type, payload } = req.body ?? {};
    if (!type || !(JOB_TYPES as readonly string[]).includes(type)) {
      reply.code(400);
      return { error: `type must be one of: ${JOB_TYPES.join(', ')}` };
    }
    // Per-job family override (the client's model select) — validated here so
    // an unknown family is a 400, not a mystery failed job.
    let jobDeps = deps;
    const requestedFamily = (payload as { family?: string } | undefined)?.family;
    if (requestedFamily) {
      try {
        jobDeps = { ...deps, family: getModelFamily(requestedFamily) };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
    // Payload validation happens NOW (400 with a reason), not inside the queue
    // where it would surface as a failed job with no obvious cause.
    const runner = makeRunner(type as JobType, jobDeps, payload);
    const job = queue.submit(type, runner);
    reply.code(202);
    return { jobId: job.id, state: job.state, queuePosition: job.queuePosition };
  });

  /** Cancel a job: dequeue it, or abort the running one and interrupt ComfyUI's render. */
  app.delete<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const result = queue.cancel(req.params.id);
    if (!result.ok) {
      reply.code(404);
      return { error: 'No such cancelable job' };
    }
    if (result.wasRunning) await comfy.interrupt();
    return { canceled: true };
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const job = queue.get(req.params.id);
    if (!job) {
      reply.code(404);
      return { error: 'No such job (results are kept for 10 minutes)' };
    }
    const { result, ...record } = job;
    return { ...record, hasResult: !!result };
  });

  app.get<{ Params: { id: string } }>('/jobs/:id/result', async (req, reply) => {
    const job = queue.get(req.params.id);
    if (!job) {
      reply.code(404);
      return { error: 'No such job' };
    }
    if (job.state === 'failed') {
      reply.code(502);
      return { error: job.error ?? 'job failed' };
    }
    if (job.state !== 'done' || !job.result) {
      reply.code(409);
      return { error: `Job is ${job.state}` };
    }
    reply.type('image/png');
    return job.result;
  });

  /**
   * Live progress as SSE: one `progress` event per change, then a final
   * `done`/`failed` event and the stream closes. The HUD's determinate bar
   * gets real stages from the source instead of guessing.
   */
  app.get<{ Params: { id: string } }>('/jobs/:id/events', async (req, reply) => {
    if (!queue.get(req.params.id)) {
      reply.code(404);
      return { error: 'No such job' };
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Subscribing fires immediately with the current state, so a late
    // subscriber still gets a first event before any change happens.
    const unsubscribe = queue.subscribe(req.params.id, (record) => {
      if (record.state === 'done' || record.state === 'failed') {
        raw.write(`event: ${record.state}\ndata: ${JSON.stringify(record)}\n\n`);
        raw.end();
      } else {
        raw.write(`event: progress\ndata: ${JSON.stringify(record)}\n\n`);
      }
    });
    if (unsubscribe) req.raw.on('close', unsubscribe);
  });

  /** Free skeleton preview, synchronous — the strip of poses that would condition a clip. */
  app.post<{ Body: unknown }>('/skeletons', async (req, reply) => {
    const p = SkeletonPayloadSchema.parse(req.body ?? {});
    const frames = clipSkeleton({ clip: p.clip, frames: p.frames, facing: p.facing ?? 'east' });
    reply.type('image/png');
    return skeletonStripPng(frames, { size: p.size ?? 256 });
  });

  return app;
}
