import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StyleContract } from '@genvy/shared';

/**
 * ComfyUI workflow templates, checked into `workflows/`, parameterized by the
 * StyleContract and the request. A template is `{ meta, bindings, nodes }`:
 * `nodes` is the ComfyUI API-format graph that actually gets submitted, and
 * `bindings` names the input paths this code is allowed to write — so a
 * template edit that moves a node breaks loudly here, in a unit test, not
 * silently on a GPU box.
 */

export type WorkflowId = 'anchor-generate' | 'anchor-directional' | 'animation-frame' | 'repair';

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export type ComfyGraph = Record<string, ComfyNode>;

type BindingPath = [string, ...string[]];

interface LoraBinding {
  checkpoint: string;
  modelConsumers: BindingPath[];
  clipConsumers: BindingPath[];
  /** Where the chain taps model/clip; defaults to checkpoint slots 0/1 (families with separate UNET/CLIP loaders override). */
  modelSource?: [string, number];
  clipSource?: [string, number];
}

export interface WorkflowTemplate {
  meta: { id: string; description: string; models?: Record<string, string> };
  bindings: Record<string, BindingPath | LoraBinding> & { lora?: LoraBinding };
  nodes: ComfyGraph;
}

export interface WorkflowParams {
  /** The subject/motion prompt — style blocks and the chroma clause are appended here. */
  prompt: string;
  style?: StyleContract;
  seed?: number;
  steps?: number;
  cfg?: number;
  width?: number;
  height?: number;
  denoise?: number;
  /** Uploaded ComfyUI image names (from /upload/image), per role. */
  identityImage?: string;
  poseImage?: string;
  inputImage?: string;
  identityWeight?: number;
  poseStrength?: number;
  checkpointName?: string;
}

/** Base negative from the P6 research pass — every workflow starts from this. */
export const BASE_NEGATIVE =
  'multiple characters, duplicate, text, watermark, frame, border, blurry, cropped, ' +
  'close-up, zoomed in, partial figure, extra limbs, missing limbs, bad anatomy, deformed, ' +
  'facing left, facing backwards';

/**
 * SDXL has no transparent output; backgrounds are removed AFTER the render
 * (rembg segmentation when configured, chroma keying as the fallback). The
 * background ask is therefore plain WHITE, not a chroma color: four GPU
 * rounds showed that naming any background color bleeds it into the
 * character's palette (green round 1-2, magenta boots and poles round 3-4),
 * while segmentation separates a white studio background best of all.
 */
export const CHROMA_CLAUSE =
  'isolated on a plain empty solid white studio background, nothing else in the scene, ' +
  'no floor, no shadow on the background, no scenery, no props around the figure';

const CHROMA_NEGATIVE =
  'background scenery, detailed background, gradient background, textured background, ' +
  'floor shadow, colored background';

const workflowsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const cache = new Map<string, WorkflowTemplate>();

/** Load one family's template for a workflow (templates live at workflows/<family>/<id>.json). */
export async function loadWorkflow(family: string, id: WorkflowId): Promise<WorkflowTemplate> {
  const key = `${family}/${id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const raw = await fs.readFile(path.join(workflowsDir, family, `${id}.json`), 'utf8');
  const template = JSON.parse(raw) as WorkflowTemplate;
  if (template.meta?.id !== id) throw new Error(`Workflow ${key}: meta.id mismatch (${template.meta?.id})`);
  if (!template.nodes || !template.bindings) throw new Error(`Workflow ${key}: missing nodes/bindings`);
  cache.set(key, template);
  return template;
}

/** Whether the template can take this parameter — runners use it to skip inputs a family cannot express (e.g. Z-Image has no identity slot). */
export function hasBinding(template: WorkflowTemplate, name: string): boolean {
  return Array.isArray(template.bindings[name]);
}

/** Compose the final positive/negative prompt pair from user text + StyleContract. */
export function buildPrompts(prompt: string, style?: StyleContract): { positive: string; negative: string } {
  const positive = [prompt.trim(), style?.promptBlock?.trim(), CHROMA_CLAUSE]
    .filter(Boolean)
    .join('. ');
  const negative = [BASE_NEGATIVE, CHROMA_NEGATIVE, style?.negativeBlock?.trim()]
    .filter(Boolean)
    .join(', ');
  return { positive, negative };
}

function setPath(nodes: ComfyGraph, bindingName: string, bindingPath: BindingPath, value: unknown) {
  const [nodeId, ...keys] = bindingPath;
  let target: Record<string, unknown> | undefined = nodes[nodeId] as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    target = target?.[key] as Record<string, unknown> | undefined;
  }
  const leaf = keys[keys.length - 1];
  if (!target || leaf === undefined || !(leaf in target)) {
    throw new Error(`Workflow binding "${bindingName}" points at a missing input: ${bindingPath.join('.')}`);
  }
  target[leaf] = value;
}

/**
 * Splice the StyleContract's LoRA stack between the checkpoint and its
 * consumers: each LoraLoader chains off the previous one's model/clip, and
 * every consumer named by the binding is rewired to the end of the chain.
 */
function applyLoraStack(
  nodes: ComfyGraph,
  binding: LoraBinding,
  stack: NonNullable<StyleContract['loraStack']>,
) {
  let model: [string, number] = binding.modelSource ?? [binding.checkpoint, 0];
  let clip: [string, number] = binding.clipSource ?? [binding.checkpoint, 1];
  stack.forEach((lora, i) => {
    const id = `lora_${i + 1}`;
    if (nodes[id]) throw new Error(`LoRA node id collision: ${id}`);
    nodes[id] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength,
        strength_clip: lora.strength,
        model,
        clip,
      },
    };
    model = [id, 0];
    clip = [id, 1];
  });
  for (const consumer of binding.modelConsumers) setPath(nodes, 'lora.model', consumer, model);
  for (const consumer of binding.clipConsumers) setPath(nodes, 'lora.clip', consumer, clip);
}

/**
 * Produce the submittable graph. Every param that has a binding is written
 * in; a param the template cannot express throws (the caller picked the
 * wrong workflow), and image roles the template requires must be provided.
 */
export function parameterizeWorkflow(template: WorkflowTemplate, params: WorkflowParams): ComfyGraph {
  const nodes = structuredClone(template.nodes);
  const bindings = template.bindings;
  const { positive, negative } = buildPrompts(params.prompt, params.style);

  const values: Record<string, unknown> = {
    positive,
    negative,
    seed: params.seed ?? 0,
    steps: params.steps,
    cfg: params.cfg,
    width: params.width,
    height: params.height,
    denoise: params.denoise,
    identityImage: params.identityImage,
    poseImage: params.poseImage,
    inputImage: params.inputImage,
    identityWeight: params.identityWeight,
    poseStrength: params.poseStrength,
    checkpointName: params.checkpointName,
  };

  for (const [name, value] of Object.entries(values)) {
    const binding = bindings[name];
    if (!binding || !Array.isArray(binding)) {
      // A concrete image handed to a workflow that has no slot for it is a
      // routing bug, not a default to ignore.
      if (value !== undefined && ['identityImage', 'poseImage', 'inputImage'].includes(name)) {
        throw new Error(`Workflow "${template.meta.id}" has no binding for ${name}`);
      }
      continue;
    }
    if (value === undefined) {
      if (['identityImage', 'poseImage', 'inputImage'].includes(name)) {
        throw new Error(`Workflow "${template.meta.id}" requires ${name}`);
      }
      continue; // keep the template default (steps, cfg, ...)
    }
    setPath(nodes, name, binding, value);
    // A .gguf checkpoint needs the ComfyUI-GGUF loader instead of the stock
    // one — swap the class in place so ONE env var (COMFY_CHECKPOINT=*.gguf)
    // flips the whole family to quantized weights. That's the speed lever on
    // small-VRAM cards: a Q4 model fits on-GPU instead of streaming.
    if (name === 'checkpointName' && typeof value === 'string' && value.endsWith('.gguf')) {
      const loader = nodes[binding[0]]!;
      if (loader.class_type === 'UNETLoader') {
        loader.class_type = 'UnetLoaderGGUF';
        delete loader.inputs.weight_dtype; // the GGUF loader has no dtype input
      }
    }
  }

  const loraStack = params.style?.loraStack;
  if (loraStack && loraStack.length > 0) {
    if (!bindings.lora) throw new Error(`Workflow "${template.meta.id}" cannot take a LoRA stack`);
    applyLoraStack(nodes, bindings.lora, loraStack);
  }
  return nodes;
}
