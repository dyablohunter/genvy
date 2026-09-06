import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

/**
 * The whole service contract, exercised without a GPU: health honestly
 * reports the missing ComfyUI, skeleton jobs run the full queue/SSE/result
 * machinery, ComfyUI-backed jobs fail cleanly instead of hanging, and usage
 * is metered either way.
 */

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'genvy-local-'));
  app = await buildServer({
    comfyUrl: 'http://127.0.0.1:59999', // deliberately nothing there
    checkpoint: 'sd_xl_base_1.0.safetensors',
    renderSize: 768,
    dataDir,
  });
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const untilDone = async (id: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/jobs/${id}` });
    const body = res.json() as { state: string };
    if (body.state === 'done' || body.state === 'failed') return body;
    if (Date.now() > deadline) throw new Error('job never finished');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('health & validation', () => {
  it('health says the service is up and ComfyUI is not', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; comfy: { up: boolean }; queueDepth: number };
    expect(body.ok).toBe(true);
    expect(body.comfy.up).toBe(false);
    expect(typeof body.queueDepth).toBe('number');
  });

  it('lists every model family with verified/available flags; z-image-turbo is the default', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as {
      model: { family: string };
      models: { id: string; verified: boolean; available: boolean }[];
    };
    expect(body.model.family).toBe('z-image-turbo');
    expect(body.models.map((m) => m.id).sort()).toEqual(['flux2', 'hidream-o1', 'z-image-turbo']);
    // ComfyUI is down in this suite — nothing can claim its models are installed.
    expect(body.models.every((m) => !m.available)).toBe(true);
  });

  it('per-job family override: unknown families 400, unsupported jobs fail with the family named', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { type: 'generate', payload: { prompt: 'x', family: 'sd3.5' } },
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { error: string }).error).toMatch(/Unknown MODEL_FAMILY/);

    // hidream-o1 has no pose channel: an animate job must refuse BEFORE any
    // ComfyUI contact, naming the family — not hide behind "ComfyUI is down".
    const anchor = Buffer.from('89504e47', 'hex').toString('base64');
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'animate',
        payload: { anchor, action: 'walk', frames: 4, family: 'hidream-o1' },
      },
    });
    expect(submit.statusCode).toBe(202);
    const { jobId } = submit.json() as { jobId: string };
    const finished = await untilDone(jobId);
    expect(finished.state).toBe('failed');
    const status = (await app.inject({ method: 'GET', url: `/jobs/${jobId}` })).json() as { error: string };
    expect(status.error).toMatch(/"hidream-o1" does not support "animation-frame"/);
  });

  it('rejects unknown job types and invalid payloads with a 400 and a reason', async () => {
    const bad = await app.inject({ method: 'POST', url: '/jobs', payload: { type: 'summon' } });
    expect(bad.statusCode).toBe(400);
    const invalid = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { type: 'animate', payload: { action: 'walk' } }, // no anchor: anchor-first
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: string }).error).toMatch(/anchor/);
  });

  it('lists recent jobs newest-first so an orphaned id can be recovered', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { type: 'skeleton', payload: { clip: 'idle', frames: 1, size: 64 } },
    });
    const { jobId } = submit.json() as { jobId: string };
    const res = await app.inject({ method: 'GET', url: '/jobs' });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: { id: string; type: string }[] };
    expect(jobs.some((j) => j.id === jobId && j.type === 'skeleton')).toBe(true);
  });

  it('404s status, result and events for unknown jobs', async () => {
    for (const url of ['/jobs/nope', '/jobs/nope/result', '/jobs/nope/events']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('skeleton jobs — the queue machinery end to end, GPU-free', () => {
  it('runs a skeleton job through queue -> progress -> PNG result', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { type: 'skeleton', payload: { clip: 'walk', frames: 4, facing: 'east', size: 96 } },
    });
    expect(submit.statusCode).toBe(202);
    const { jobId } = submit.json() as { jobId: string };
    const finished = await untilDone(jobId);
    expect(finished.state).toBe('done');

    const status = await app.inject({ method: 'GET', url: `/jobs/${jobId}` });
    const record = status.json() as { hasResult: boolean; progress: { free: boolean; steps: number } };
    expect(record.hasResult).toBe(true);
    expect(record.progress.free).toBe(true); // FREE is reported by the service itself

    const result = await app.inject({ method: 'GET', url: `/jobs/${jobId}/result` });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('image/png');
    const meta = await sharp(result.rawPayload).metadata();
    expect(meta.width).toBe(96 * 4);
    expect(meta.height).toBe(96);
  });

  it('POST /skeletons returns the preview strip synchronously', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/skeletons',
      payload: { clip: 'run', frames: 6, facing: 'south', size: 64 },
    });
    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(64 * 6);
  });
});

describe('ComfyUI-backed jobs without a GPU', () => {
  it('an animate job fails fast with an actionable error instead of hanging', async () => {
    const anchor = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'animate',
        payload: { anchor: anchor.toString('base64'), action: 'walk', frames: 4 },
      },
    });
    expect(submit.statusCode).toBe(202);
    const { jobId } = submit.json() as { jobId: string };
    const finished = await untilDone(jobId);
    expect(finished.state).toBe('failed');
    const status = (await app.inject({ method: 'GET', url: `/jobs/${jobId}` })).json() as {
      error: string;
    };
    expect(status.error).toMatch(/ComfyUI is not reachable/);
    const result = await app.inject({ method: 'GET', url: `/jobs/${jobId}/result` });
    expect(result.statusCode).toBe(502);
  });
});

describe('usage metering', () => {
  it('books jobs, outcomes and wall time per job type', async () => {
    const res = await app.inject({ method: 'GET', url: '/usage' });
    const body = res.json() as {
      types: Record<string, { jobs: number; failed: number; images: number }>;
      totalJobs: number;
    };
    // The suites above ran at least one skeleton job (succeeded, 1 image)
    // and one animate job (failed, 0 images).
    expect(body.types.skeleton?.jobs).toBeGreaterThanOrEqual(1);
    expect(body.types.skeleton?.images).toBeGreaterThanOrEqual(1);
    expect(body.types.animate?.failed).toBeGreaterThanOrEqual(1);
    expect(body.totalJobs).toBeGreaterThanOrEqual(2);
  });
});

describe('SSE progress', () => {
  it('streams progress events and closes with a terminal event', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { type: 'skeleton', payload: { clip: 'idle', frames: 2, size: 64 } },
    });
    const { jobId } = submit.json() as { jobId: string };
    await untilDone(jobId);
    // Late subscription still replays the terminal state — the HUD can
    // reconnect after a hiccup without losing the ending.
    const res = await app.inject({ method: 'GET', url: `/jobs/${jobId}/events` });
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.payload).toMatch(/event: done/);
    expect(res.payload).toMatch(/"state":"done"/);
  });
});
