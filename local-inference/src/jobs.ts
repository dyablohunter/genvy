import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { StyleContractSchema } from '@genvy/shared';
import type { ComfyClient } from './comfy.js';
import type { JobRunner, ProgressReporter } from './queue.js';
import { loadWorkflow, parameterizeWorkflow, hasBinding, type WorkflowId, type WorkflowTemplate } from './workflows.js';
import { tryRemoveBackground } from './rembg.js';
import type { ModelFamily } from './models.js';
import { clipSkeleton, resolveClip, skeletonFramePng, skeletonStripPng, type Facing } from './skeleton/index.js';

/**
 * Job payloads and runners. Every runner narrates what it is doing through
 * `report()` — the SSE endpoint relays that to the HUD verbatim, so stage
 * text is written here in the user's terms. All of it is FREE (no credits);
 * the flag rides along so the HUD can say so.
 */

const FacingSchema = z.enum(['south', 'west', 'east', 'north']);

export const GeneratePayloadSchema = z.object({
  prompt: z.string().min(1),
  /** Per-job model family override (src/models.ts); default = the service's MODEL_FAMILY. */
  family: z.string().optional(),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
  seed: z.number().int().nonnegative().optional(),
  style: StyleContractSchema.optional(),
  /** false = keep the full canvas (tilesets, raw art) — no cutout. */
  transparent: z.boolean().optional(),
});

export const EditPayloadSchema = z.object({
  mode: z.enum(['directional', 'repair']),
  family: z.string().optional(),
  /** Square render canvas for this job; default = the service's renderSize. */
  renderSize: z.number().int().min(256).max(2048).optional(),
  /** Base64 PNG: the identity anchor (directional) or the frame to redraw (repair). */
  image: z.string().min(1),
  prompt: z.string().default(''),
  denoise: z.number().min(0.1).max(1).optional(),
  seed: z.number().int().nonnegative().optional(),
  style: StyleContractSchema.optional(),
});

export const AnimatePayloadSchema = z.object({
  /** Base64 PNG of the directional anchor — anchor-first is not negotiable. */
  anchor: z.string().min(1),
  family: z.string().optional(),
  /** Square render canvas per frame; default = the service's renderSize. */
  renderSize: z.number().int().min(256).max(2048).optional(),
  /**
   * The character's appearance text. For families with no identity adapter
   * (Z-Image) this IS the identity channel — without it the model invents a
   * character around the skeleton.
   */
  identityPrompt: z.string().optional(),
  action: z.string().min(1),
  frames: z.number().int().min(2).max(24),
  facing: FacingSchema.optional(),
  prompt: z.string().default(''),
  seed: z.number().int().nonnegative().optional(),
  style: StyleContractSchema.optional(),
});

export const SkeletonPayloadSchema = z.object({
  clip: z.string().min(1),
  frames: z.number().int().min(1).max(24),
  facing: FacingSchema.optional(),
  size: z.number().int().min(64).max(1024).optional(),
});

export const JOB_TYPES = ['generate', 'edit', 'animate', 'skeleton'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface RunnerDeps {
  comfy: ComfyClient;
  renderSize: number;
  /** '' = use the family's default checkpoint. */
  checkpoint: string;
  /** Active model family — owns the template set and the supported-jobs list. */
  family: ModelFamily;
  /** The family COMFY_CHECKPOINT was configured for — the override must never leak into per-job family switches (a Z-Image GGUF once landed in HiDream's loader). */
  configFamilyId: string;
  /** Python with rembg for segmentation cutouts ('' = chroma keying only). */
  rembgPython?: string;
  /** Scratch dir for rembg temp files. */
  dataDir?: string;
}

/** The family's template for a workflow, or a clear refusal when the family cannot do the job. */
async function familyWorkflow(deps: RunnerDeps, id: WorkflowId): Promise<WorkflowTemplate> {
  if (!deps.family.workflows.includes(id)) {
    throw new Error(
      `Model family "${deps.family.id}" does not support "${id}" yet ` +
        `(supported: ${deps.family.workflows.join(', ')}) — set MODEL_FAMILY to one that does`,
    );
  }
  return loadWorkflow(deps.family.id, id);
}

const checkpointOf = (deps: RunnerDeps) =>
  deps.family.id === deps.configFamilyId && deps.checkpoint
    ? deps.checkpoint
    : deps.family.checkpoint;

/** Segmentation cutout when configured; the original when not (fail-open). */
async function cutout(deps: RunnerDeps, png: Buffer): Promise<Buffer> {
  if (!deps.rembgPython || !deps.dataDir) return png;
  return tryRemoveBackground(png, deps.rembgPython, deps.dataDir);
}

async function requireComfy(deps: RunnerDeps, report: ProgressReporter, steps: number) {
  report({ stage: 'CHECKING THE COMFYUI LINK (FREE)', step: 1, steps, free: true });
  const health = await deps.comfy.health();
  if (!health.up) {
    throw new Error(`ComfyUI is not reachable (${health.error ?? 'down'}) — start ComfyUI or fix COMFYUI_URL`);
  }
}

export function makeGenerateRunner(deps: RunnerDeps, raw: unknown): JobRunner {
  const p = GeneratePayloadSchema.parse(raw);
  return async (report) => {
    const steps = 2;
    // Family support is validated BEFORE the ComfyUI check: "this family
    // cannot do that job" must never hide behind "ComfyUI is down".
    const template = await familyWorkflow(deps, 'anchor-generate');
    await requireComfy(deps, report, steps);
    report({ stage: `LOCAL ${deps.family.label.toUpperCase()} · DRAWING THE ANCHOR`, step: 2, steps, free: true });
    const graph = parameterizeWorkflow(template, {
      prompt: p.prompt,
      style: p.style,
      seed: p.seed ?? randomInt(2 ** 31),
      width: p.width ?? deps.renderSize,
      height: p.height ?? deps.renderSize,
      checkpointName: checkpointOf(deps),
    });
    const out = await deps.comfy.run(graph);
    // A tileset or raw canvas must keep every pixel — cutouts are for figures.
    return p.transparent === false ? out : cutout(deps, out);
  };
}

export function makeEditRunner(deps: RunnerDeps, raw: unknown): JobRunner {
  const p = EditPayloadSchema.parse(raw);
  return async (report) => {
    const steps = 3;
    const template = await familyWorkflow(deps, p.mode === 'repair' ? 'repair' : 'anchor-directional');
    await requireComfy(deps, report, steps);
    report({ stage: 'UPLOADING THE REFERENCE (FREE)', step: 2, steps, free: true });
    // Clamp UP to the family's edit floor: below it, reference edits go
    // off-distribution and can return blank canvases (HiDream, ~4MP model).
    const size = Math.max(p.renderSize ?? deps.renderSize, deps.family.minEditSize ?? 0);
    const image = Buffer.from(p.image, 'base64');
    const name = await deps.comfy.uploadImage(image, `genvy-${p.mode}-input.png`);
    const doing = p.mode === 'repair' ? 'REDRAWING THE FRAME' : 'TURNING THE ANCHOR';
    report({ stage: `LOCAL ${deps.family.label.toUpperCase()} · ${doing}`, step: 3, steps, free: true });
    if (p.mode === 'repair') {
      const out = await deps.comfy.run(
        parameterizeWorkflow(template, {
          prompt: p.prompt,
          style: p.style,
          seed: p.seed ?? randomInt(2 ** 31),
          denoise: p.denoise ?? 0.75,
          inputImage: name,
          checkpointName: checkpointOf(deps),
        }),
      );
      return cutout(deps, out);
    }
    const out = await deps.comfy.run(
      parameterizeWorkflow(template, {
        prompt: p.prompt,
        style: p.style,
        seed: p.seed ?? randomInt(2 ** 31),
        width: size,
        height: size,
        identityImage: name,
        checkpointName: checkpointOf(deps),
      }),
    );
    return cutout(deps, out);
  };
}

/**
 * The P6 core: anchor + procedural skeletons -> one OpenPose-conditioned
 * frame per pose -> horizontal strip. The skeleton conditions the MOTION,
 * the anchor conditions the IDENTITY, and one shared seed keeps the
 * rendering coherent across frames.
 */
export function makeAnimateRunner(deps: RunnerDeps, raw: unknown): JobRunner {
  const p = AnimatePayloadSchema.parse(raw);
  return async (report, signal) => {
    const steps = p.frames + 3; // health + skeletons + N frames + compose
    const template = await familyWorkflow(deps, 'animation-frame');
    await requireComfy(deps, report, steps);

    const { clip, exact } = resolveClip(p.action);
    report({
      stage: `SKELETONS · COMPUTING ${p.frames} ${clip.toUpperCase()} POSES (FREE)`,
      step: 2,
      steps,
      free: true,
    });
    const facing: Facing = p.facing ?? 'east';
    // One size for skeleton AND render: the pose PNG must map 1:1 onto the
    // canvas ControlNet conditions, or keypoints land in the wrong place.
    const size = p.renderSize ?? deps.renderSize;
    const skeletons = clipSkeleton({ clip: p.action, frames: p.frames, facing });
    // Anchor-first still holds — the job REQUIRES an anchor — but a family
    // without an identity adapter (Z-Image today) cannot consume it in the
    // graph: there identity rides on the prompt until a per-character LoRA
    // exists, and the animation gate still scores against the anchor.
    const anchorName = hasBinding(template, 'identityImage')
      ? await deps.comfy.uploadImage(Buffer.from(p.anchor, 'base64'), 'genvy-anchor.png')
      : undefined;
    const seed = p.seed ?? randomInt(2 ** 31);
    // The text prompt must carry the SUBJECT, not just the motion: with no
    // identity words, SDXL invented generic pedestrians around the skeleton
    // and IP-Adapter alone could not hold the character (gate 0/100 on the
    // first GPU run). Never say "frame" or "animation" here — SDXL draws
    // those words literally as border bars and film-strip props (GPU rounds
    // 1 and 4); the skeleton and the shared seed carry the sequencing. When
    // the action has no purpose-built cycle the skeleton is a neutral
    // stand-in and the text carries the motion instead.
    // Identity phrasing depends on whether this family can actually SEE the
    // anchor: with an identity binding the text defers to the reference;
    // without one (Z-Image today) the prompt IS the identity, so the
    // character description must ride in p.prompt and never mention a
    // reference the model was not given.
    const seesAnchor = hasBinding(template, 'identityImage');
    const identityClause = seesAnchor
      ? 'the exact same single character as the reference image'
      : 'the exact same single character in every image';
    // "solo ... alone, empty space everywhere else" is POSITIVE phrasing on
    // purpose: turbo models run cfg 1, so negatives are inert — and a narrow
    // frontal skeleton leaves canvas space the model otherwise fills with
    // bonus figures (seen live: a trio per frame on a south-facing walk).
    const motion = [
      `${identityClause}, solo, exactly one figure standing alone with empty space everywhere ` +
        `else, full body from head to feet entirely visible with empty margin around the ` +
        `figure, mid-${p.action} pose matching the pose skeleton`,
      // The appearance text rides along in BOTH modes: without an anchor
      // slot it is the only identity channel; with the anchor as the init
      // latent (denoise 0.8) it reinforces what the pixels already say.
      p.identityPrompt ?? '',
      exact ? '' : `the pose should express: ${p.action}`,
      p.prompt,
    ]
      .filter(Boolean)
      .join('. ');

    const frames: Buffer[] = [];
    for (let i = 0; i < p.frames; i++) {
      // Cancellation checkpoint: the red CANCEL button aborts between frames
      // (the in-flight ComfyUI render is interrupted by the DELETE handler).
      if (signal?.aborted) throw new Error('canceled by user');
      report({
        stage: `LOCAL ${deps.family.label.toUpperCase()} · RENDERING ${p.action.toUpperCase()} FRAME ${i + 1}/${p.frames}`,
        step: i + 3,
        steps,
        free: true,
      });
      const poseName = await deps.comfy.uploadImage(
        await skeletonFramePng(skeletons[i]!, { size }),
        `genvy-pose-${i}.png`,
      );
      const graph = parameterizeWorkflow(template, {
        prompt: motion,
        style: p.style,
        seed,
        width: size,
        height: size,
        ...(anchorName ? { identityImage: anchorName } : {}),
        poseImage: poseName,
        checkpointName: checkpointOf(deps),
      });
      // Segmentation cutout per frame BEFORE composing: keying the composed
      // strip by corner color can never beat a per-frame cutout, and the
      // slicer downstream needs clean per-frame alpha to find the cells.
      frames.push(await cutout(deps, await deps.comfy.run(graph)));
    }

    report({ stage: 'COMPOSING THE STRIP (FREE)', step: steps, steps, free: true });
    return composeStrip(frames);
  };
}

/** Free, GPU-less: render the clip's skeletons themselves as a strip — the debug/preview view of what will condition the diffusion pass. */
export function makeSkeletonRunner(_deps: RunnerDeps, raw: unknown): JobRunner {
  const p = SkeletonPayloadSchema.parse(raw);
  return async (report) => {
    report({ stage: `SKELETONS · RENDERING ${p.frames} ${p.clip.toUpperCase()} POSES (FREE)`, step: 1, steps: 1, free: true });
    const frames = clipSkeleton({ clip: p.clip, frames: p.frames, facing: p.facing ?? 'east' });
    return skeletonStripPng(frames, { size: p.size ?? 256 });
  };
}

/** Horizontal strip from equally sized frame PNGs. */
export async function composeStrip(frames: Buffer[]): Promise<Buffer> {
  if (frames.length === 1) return sharp(frames[0]!).png().toBuffer();
  const metas = await Promise.all(frames.map((f) => sharp(f).metadata()));
  const w = metas[0]!.width ?? 0;
  const h = metas[0]!.height ?? 0;
  if (metas.some((m) => m.width !== w || m.height !== h)) {
    throw new Error('animation frames came back in different sizes');
  }
  return sharp({
    create: { width: w * frames.length, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(frames.map((input, i) => ({ input, left: i * w, top: 0 })))
    .png()
    .toBuffer();
}

export function makeRunner(type: JobType, deps: RunnerDeps, payload: unknown): JobRunner {
  switch (type) {
    case 'generate':
      return makeGenerateRunner(deps, payload);
    case 'edit':
      return makeEditRunner(deps, payload);
    case 'animate':
      return makeAnimateRunner(deps, payload);
    case 'skeleton':
      return makeSkeletonRunner(deps, payload);
  }
}
