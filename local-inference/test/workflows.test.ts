import { describe, it, expect } from 'vitest';
import { stylePresets } from '@genvy/shared';
import {
  loadWorkflow,
  parameterizeWorkflow,
  buildPrompts,
  hasBinding,
  BASE_NEGATIVE,
} from '../src/workflows.js';
import { MODEL_FAMILIES, getModelFamily } from '../src/models.js';

describe('workflow templates — every family', () => {
  it('every declared workflow of every family loads, with meta ids matching filenames', async () => {
    for (const family of Object.values(MODEL_FAMILIES)) {
      for (const id of family.workflows) {
        const t = await loadWorkflow(family.id, id);
        expect(t.meta.id, `${family.id}/${id}`).toBe(id);
        expect(Object.keys(t.nodes).length, `${family.id}/${id}`).toBeGreaterThan(4);
      }
    }
  });

  it('every binding of every family points at an input that exists in its graph', async () => {
    for (const family of Object.values(MODEL_FAMILIES)) {
      for (const id of family.workflows) {
        const t = await loadWorkflow(family.id, id);
        for (const [name, binding] of Object.entries(t.bindings)) {
          if (!Array.isArray(binding)) continue; // lora binding checked separately
          const [nodeId, ...path] = binding;
          let target: unknown = t.nodes[nodeId!];
          expect(target, `${family.id}/${id}: binding "${name}" names missing node ${nodeId}`).toBeDefined();
          for (const key of path.slice(0, -1)) target = (target as Record<string, unknown>)[key];
          expect(
            Object.prototype.hasOwnProperty.call(target, path[path.length - 1]!),
            `${family.id}/${id}: binding "${name}" -> ${binding.join('.')}`,
          ).toBe(true);
        }
      }
    }
  });

  it('lora bindings of every family point at real nodes and consumers', async () => {
    for (const family of Object.values(MODEL_FAMILIES)) {
      for (const id of family.workflows) {
        const t = await loadWorkflow(family.id, id);
        const lora = t.bindings.lora;
        if (!lora) continue;
        expect(t.nodes[lora.checkpoint], `${family.id}/${id}: lora.checkpoint`).toBeDefined();
        for (const src of [lora.modelSource, lora.clipSource]) {
          if (src) expect(t.nodes[src[0]], `${family.id}/${id}: lora source ${src[0]}`).toBeDefined();
        }
        for (const consumer of [...lora.modelConsumers, ...lora.clipConsumers]) {
          expect(t.nodes[consumer[0]!], `${family.id}/${id}: lora consumer ${consumer[0]}`).toBeDefined();
        }
      }
    }
  });

  it('every family has a download manifest that provides its checkpoint', async () => {
    const { MODEL_MANIFEST } = await import('../src/modelManifest.js');
    for (const family of Object.values(MODEL_FAMILIES)) {
      const manifest = MODEL_MANIFEST[family.id];
      expect(manifest, `${family.id} has no manifest — setup would be guesswork`).toBeDefined();
      const files = manifest!.files.map((f) => f.dest.split('/').pop());
      // The family's default checkpoint must be one of the files we fetch.
      expect(files, `${family.id}: manifest lacks ${family.checkpoint}`).toContain(family.checkpoint);
      for (const f of manifest!.files) {
        expect(f.url.startsWith('https://huggingface.co/'), f.dest).toBe(true);
        expect(f.gb).toBeGreaterThan(0);
      }
    }
  });

  it('family registry: z-image-turbo is the default; sdxl is gone; unknown ids are refused', () => {
    expect(getModelFamily(undefined).id).toBe('z-image-turbo');
    // SDXL was removed after live testing (see models.ts) — it must not come back silently.
    expect(MODEL_FAMILIES.sdxl).toBeUndefined();
    expect(() => getModelFamily('sdxl')).toThrowError(/Unknown MODEL_FAMILY/);
    expect(() => getModelFamily('sd3.5')).toThrowError(/Unknown MODEL_FAMILY/);
    // Every family can at least generate — the anchor chain starts there.
    for (const f of Object.values(MODEL_FAMILIES)) {
      expect(f.workflows, f.id).toContain('anchor-generate');
    }
    // All three are GPU-verified now. flux2 is flagged `heavy`: it renders
    // beautifully but took ~32 min for one 640px image on a 4GB card, so
    // "verified" must not be read as "usable on any GPU".
    expect(Object.values(MODEL_FAMILIES).filter((f) => f.verified).map((f) => f.id)).toEqual([
      'z-image-turbo',
      'hidream-o1',
      'flux2',
    ]);
    expect(getModelFamily('hidream-o1').minEditSize).toBe(1408);
    expect(getModelFamily('flux2').heavy).toBe(true);
    expect(getModelFamily('z-image-turbo').heavy).toBeUndefined();
  });

  it('z-image animation: pose via ControlNet, identity via the anchor as INIT LATENT', async () => {
    const anim = await loadWorkflow('z-image-turbo', 'animation-frame');
    expect(hasBinding(anim, 'poseImage')).toBe(true);
    // No identity ADAPTER exists for Z-Image — instead the anchor seeds the
    // latent (img2img) and high denoise + pose ControlNet reshape the pose.
    expect(hasBinding(anim, 'identityImage')).toBe(true);
    expect(anim.nodes['32']!.class_type).toBe('VAEEncode');
    expect((anim.nodes['44']!.inputs.latent_image as [string, number])[0]).toBe('32');
    expect(anim.nodes['44']!.inputs.denoise).toBe(0.8);
    expect(anim.nodes['44']!.inputs.steps).toBe(8);
    expect(anim.nodes['44']!.inputs.cfg).toBe(1);
    // LoRA chain taps the separate UNET/CLIP loaders, not checkpoint slots.
    const style = { ...stylePresets['pixel-16bit']!, loraStack: [{ name: 'pixel-z.safetensors', strength: 1 }] };
    const graph = parameterizeWorkflow(anim, {
      prompt: 'x',
      style,
      poseImage: 'pose-1.png',
      identityImage: 'anchor.png',
    });
    expect(graph.lora_1!.inputs.model).toEqual(['46', 0]);
    expect(graph.lora_1!.inputs.clip).toEqual(['39', 0]);
    expect(graph['60']!.inputs.model).toEqual(['lora_1', 0]);
  });

  it('hidream: the reference-edit template is kept but NOT offered as a workflow', async () => {
    // Live evidence (2026-09-05): through genvy's directional prompt the edit
    // returned a washed-out figure the cutout reduced to a ghost. The template
    // stays on disk for a future diagnosis; the family no longer claims turns.
    expect(getModelFamily('hidream-o1').workflows).toEqual(['anchor-generate']);
    const t = await loadWorkflow('hidream-o1', 'anchor-directional');
    expect(hasBinding(t, 'identityImage')).toBe(true);
    expect(t.nodes['104']!.class_type).toBe('HiDreamO1ReferenceImages');
    // The sampler's conditioning comes THROUGH the reference node.
    expect((t.nodes['108']!.inputs.positive as [string, number])[0]).toBe('104');
    // The dotted autogrow key is the only form ComfyUI accepts — hard-won.
    expect(t.nodes['104']!.inputs['images.image_1']).toEqual(['213', 0]);
  });

  it('flux2: reference latent carries identity; no negative channel exists', async () => {
    const t = await loadWorkflow('flux2', 'anchor-directional');
    expect(hasBinding(t, 'identityImage')).toBe(true);
    expect(hasBinding(t, 'negative')).toBe(false);
    expect(t.nodes['32']!.class_type).toBe('ReferenceLatent');
    // Prompt still parameterizes fine with no negative binding to write.
    const graph = parameterizeWorkflow(t, { prompt: 'a knight', identityImage: 'id.png' });
    expect(graph['6']!.inputs.text).toContain('a knight');
  });

  it('z-image repair denoises at 0.75 by default — img2img, not a fresh render', async () => {
    const t = await loadWorkflow('z-image-turbo', 'repair');
    expect(t.nodes['3']!.inputs.denoise).toBe(0.75);
    // Latent comes from the encoded input image, not an empty latent.
    expect(t.nodes['41']!.class_type).toBe('VAEEncode');
    expect((t.nodes['3']!.inputs.latent_image as [string, number])[0]).toBe('41');
  });
});

describe('parameterization', () => {
  it('injects prompt, seed, size and image names into the bound inputs', async () => {
    const t = await loadWorkflow('z-image-turbo', 'animation-frame');
    const graph = parameterizeWorkflow(t, {
      prompt: 'a cactus knight walking',
      seed: 42,
      width: 640,
      height: 640,
      poseImage: 'pose-3.png',
      identityImage: 'anchor-7.png',
      checkpointName: 'z_image_turbo_custom.safetensors',
    });
    expect(graph['45']!.inputs.text).toContain('a cactus knight walking');
    expect(graph['44']!.inputs.seed).toBe(42);
    // Width/height land on the anchor's ImageScale — it feeds the init latent.
    expect(graph['31']!.inputs.width).toBe(640);
    expect(graph['20']!.inputs.image).toBe('pose-3.png');
    expect(graph['30']!.inputs.image).toBe('anchor-7.png');
    expect(graph['46']!.inputs.unet_name).toBe('z_image_turbo_custom.safetensors');
    // The template itself is untouched — parameterization clones.
    expect(t.nodes['44']!.inputs.seed).toBe(0);
  });

  it('folds the StyleContract into the positive prompt (turbo has no usable negative)', async () => {
    const style = stylePresets['pixel-16bit']!;
    const t = await loadWorkflow('z-image-turbo', 'anchor-generate');
    const graph = parameterizeWorkflow(t, { prompt: 'a robot', style });
    expect(graph['27']!.inputs.text).toContain('16-bit era pixel art');
    expect(graph['27']!.inputs.text).toContain('white studio background');
    // cfg 1 + ConditioningZeroOut: the negative channel is inert by design.
    expect(t.nodes['33']!.class_type).toBe('ConditioningZeroOut');
  });

  it('splices a LoRA chain between the separate UNET/CLIP loaders and their consumers', async () => {
    const t = await loadWorkflow('z-image-turbo', 'anchor-generate');
    const style = {
      ...stylePresets['pixel-16bit']!,
      loraStack: [
        { name: 'pixel-art-z.safetensors', strength: 1.2 },
        { name: 'style-z.safetensors', strength: 1.0 },
      ],
    };
    const graph = parameterizeWorkflow(t, { prompt: 'a robot', style });
    expect(graph.lora_1!.class_type).toBe('LoraLoader');
    expect(graph.lora_1!.inputs.strength_model).toBe(1.2);
    // Chain: UNETLoader/CLIPLoader -> lora_1 -> lora_2 -> consumers.
    expect(graph.lora_1!.inputs.model).toEqual(['28', 0]);
    expect(graph.lora_1!.inputs.clip).toEqual(['30', 0]);
    expect(graph.lora_2!.inputs.model).toEqual(['lora_1', 0]);
    expect(graph['11']!.inputs.model).toEqual(['lora_2', 0]);
    expect(graph['27']!.inputs.clip).toEqual(['lora_2', 1]);
    // No LoRA stack -> untouched wiring.
    const plain = parameterizeWorkflow(t, { prompt: 'a robot' });
    expect(plain['11']!.inputs.model).toEqual(['28', 0]);
    expect(plain.lora_1).toBeUndefined();
  });

  it('refuses missing required images and images the workflow cannot take', async () => {
    const anim = await loadWorkflow('z-image-turbo', 'animation-frame');
    // Anchor-first, mechanically: a frame without its pose OR its anchor is refused.
    expect(() => parameterizeWorkflow(anim, { prompt: 'x', identityImage: 'a.png' })).toThrowError(
      /requires poseImage/,
    );
    expect(() => parameterizeWorkflow(anim, { prompt: 'x', poseImage: 'p.png' })).toThrowError(
      /requires identityImage/,
    );
    const gen = await loadWorkflow('z-image-turbo', 'anchor-generate');
    expect(() => parameterizeWorkflow(gen, { prompt: 'x', poseImage: 'p.png' })).toThrowError(
      /no binding for poseImage/,
    );
  });

  it('a .gguf checkpoint swaps the stock UNET loader for the ComfyUI-GGUF one', async () => {
    const t = await loadWorkflow('z-image-turbo', 'anchor-generate');
    const graph = parameterizeWorkflow(t, { prompt: 'x', checkpointName: 'z_image_turbo_q4.gguf' });
    expect(graph['28']!.class_type).toBe('UnetLoaderGGUF');
    expect(graph['28']!.inputs.unet_name).toBe('z_image_turbo_q4.gguf');
    expect(graph['28']!.inputs.weight_dtype).toBeUndefined(); // GGUF loader has no dtype input
    // Non-gguf checkpoints keep the stock loader untouched.
    const plain = parameterizeWorkflow(t, { prompt: 'x', checkpointName: 'z_image_turbo_bf16.safetensors' });
    expect(plain['28']!.class_type).toBe('UNETLoader');
  });

  it('buildPrompts: user text first, style deferred, base negative always present', () => {
    const { positive, negative } = buildPrompts('a knight', undefined);
    expect(positive.startsWith('a knight')).toBe(true);
    // White, not a chroma color: named background colors bleed into the
    // character palette (proven on GPU with green AND magenta).
    expect(positive).toContain('white studio background');
    expect(negative).toContain('multiple characters');
    // Empty default style adds nothing.
    const styled = buildPrompts('a knight', stylePresets['default']);
    expect(styled.positive).toBe(positive);
  });
});
