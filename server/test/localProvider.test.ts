import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import { createLocalInferenceProvider, type LocalInferenceProvider } from '../src/providers/localInference.js';
import * as pipe from '../src/services/imagePipeline.js';

/**
 * The local provider against a fake local-inference service: health-backed
 * `live`, the submit -> poll -> result round trip, chroma keying to real
 * alpha, zero billing, and honest offline behavior. No GPU, no ComfyUI —
 * the wire contract is what is under test.
 */

/** 24x24 chroma-green PNG with an opaque red figure in the middle. */
async function chromaFrame(): Promise<Buffer> {
  const size = 24;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 1] = 255; // green
    data[i * 4 + 3] = 255;
  }
  for (let y = 8; y < 16; y++) {
    for (let x = 8; x < 16; x++) {
      const i = (y * size + x) * 4;
      data[i] = 200;
      data[i + 1] = 30;
      data[i + 2] = 30;
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

let server: http.Server;
let baseUrl: string;
let provider: LocalInferenceProvider;
const jobs = new Map<string, { type: string; payload: Record<string, unknown> }>();
let nextJob = 1;
let comfyUp = true;

beforeAll(async () => {
  const png = await chromaFrame();
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/health') return send(200, { ok: true, comfy: { up: comfyUp }, queueDepth: 0 });
    if (url === '/jobs' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
        const id = `job-${nextJob++}`;
        jobs.set(id, body);
        send(202, { jobId: id, state: 'queued', queuePosition: 1 });
      });
      return;
    }
    const status = /^\/jobs\/([^/]+)$/.exec(url);
    if (status) {
      const job = jobs.get(status[1]!);
      if (!job) return send(404, { error: 'no such job' });
      if (job.payload?.prompt === 'EXPLODE') {
        return send(200, { state: 'failed', error: 'ComfyUI is not reachable' });
      }
      return send(200, { state: 'done', hasResult: true });
    }
    if (/^\/jobs\/[^/]+\/result$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    send(404, { error: 'nope' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  provider = createLocalInferenceProvider(baseUrl, { pollIntervalMs: 10 });
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('local inference provider', () => {
  it('goes live once the service AND its ComfyUI answer, offline when ComfyUI is down', async () => {
    expect(await provider.refreshHealth()).toBe(true);
    expect(provider.live).toBe(true);
    comfyUp = false;
    expect(await provider.refreshHealth()).toBe(false);
    expect(provider.live).toBe(false);
    comfyUp = true;
    await provider.refreshHealth();
  });

  it('animate: submits anchor-first with facing, keys the chroma to real alpha, bills zero', async () => {
    const billed: { cents?: number }[] = [];
    const strip = await provider.animate!({
      anchor: await chromaFrame(),
      action: 'walk',
      frames: 4,
      facing: 'west',
      prompt: 'confident stride',
      onBilled: (i) => billed.push(i),
    });
    const submitted = [...jobs.values()].find((j) => j.type === 'animate')!;
    expect(submitted.payload.action).toBe('walk');
    expect(submitted.payload.facing).toBe('west');
    expect(submitted.payload.frames).toBe(4);
    expect(typeof submitted.payload.anchor).toBe('string'); // base64, anchor-first
    // The green background was keyed out into a real alpha channel.
    const raw = await pipe.loadRaw(strip);
    expect(pipe.hasTransparency(raw)).toBe(true);
    expect(raw.data[3]).toBe(0); // corner transparent
    const centre = ((raw.height / 2) * raw.width + raw.width / 2) * 4;
    expect(raw.data[centre + 3]).toBe(255); // figure kept
    // FREE: exact zero cents reported, nothing estimated.
    expect(billed).toEqual([{ cents: 0 }]);
  });

  it('edit: sends the identity reference as the input image', async () => {
    const out = await provider.edit({
      prompt: 'turn to face west',
      orientation: 'portrait',
      references: [{ image: await chromaFrame(), role: 'identity' }],
    });
    const submitted = [...jobs.values()].find((j) => j.type === 'edit')!;
    expect(submitted.payload.mode).toBe('directional');
    expect(typeof submitted.payload.image).toBe('string');
    expect(pipe.hasTransparency(await pipe.loadRaw(out))).toBe(true);
  });

  it('surfaces a failed job as a 502 with the service reason', async () => {
    await expect(
      provider.generate({ prompt: 'EXPLODE', orientation: 'portrait' }),
    ).rejects.toMatchObject({ statusCode: 502, message: /ComfyUI is not reachable/ });
  });

  it('an absent service means 503 LINK OFFLINE, exactly like a missing API key', async () => {
    const gone = createLocalInferenceProvider('http://127.0.0.1:59997', { pollIntervalMs: 10 });
    await expect(gone.generate({ prompt: 'x', orientation: 'portrait' })).rejects.toMatchObject({
      statusCode: 503,
      message: /LINK OFFLINE/,
    });
    expect(gone.live).toBe(false);
  });
});
