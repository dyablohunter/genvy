import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.LOCAL_INFERENCE_PORT ?? 3021),
  /** ComfyUI's HTTP API; the service is the only thing that talks to it. */
  comfyUrl: (process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, ''),
  /** Which model family drives the workflows (see src/models.ts): z-image-turbo | hidream-o1 | flux2. */
  modelFamily: process.env.MODEL_FAMILY ?? 'z-image-turbo',
  /** Checkpoint override; empty = the family's default (models.ts). */
  checkpoint: process.env.COMFY_CHECKPOINT ?? '',
  /** 768 fits ~12GB VRAM; drop to 640 for 8GB tiers. */
  renderSize: Number(process.env.COMFY_RENDER_SIZE ?? 768),
  /**
   * How long ONE ComfyUI render may take. 300s suits 8-step models; a big
   * model streaming tens of GB through a small card spends most of that
   * budget just loading weights (FLUX.2 Q4 blew past it on a 4GB card), so
   * this is configurable rather than a constant.
   */
  comfyJobTimeoutMs: Number(process.env.COMFY_JOB_TIMEOUT_MS ?? 900_000),
  /**
   * Python executable with `rembg` installed (segmentation background
   * removal — the ComfyUI venv is the natural host). Empty = disabled; the
   * provider's chroma keying then remains the only background path.
   */
  rembgPython: process.env.REMBG_PYTHON ?? '',
  dataDir: process.env.LOCAL_INFERENCE_DATA ?? path.join(workspaceRoot, '.data'),
};
