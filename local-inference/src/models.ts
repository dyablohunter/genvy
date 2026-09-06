import type { WorkflowId } from './workflows.js';

/**
 * Model families the service can drive. One family is active per service
 * instance (MODEL_FAMILY env); each brings its own workflow template set
 * under `workflows/<family>/` and declares which job shapes it supports —
 * the ecosystems differ (Z-Image has a pose ControlNet but no identity
 * adapter; HiDream edits natively but has no pose channel yet), and an
 * honest "unsupported" beats a template that renders garbage.
 *
 * `verified: false` = the templates were transcribed from the official
 * ComfyUI reference workflows (Comfy-Org/workflow_templates, fetched
 * 2026-09-05) but have NOT run on a GPU here yet. Exact node/input names
 * for unverified families may need touch-up on first contact.
 */

export interface ModelFamily {
  id: string;
  label: string;
  /** Job templates this family ships; anything else fails fast with a clear error. */
  workflows: WorkflowId[];
  /** Default checkpoint/diffusion-model file (COMFY_CHECKPOINT overrides). */
  checkpoint: string;
  /** Run on this box with usable output? Gates UI selectability. */
  verified: boolean;
  /**
   * Floor for reference-edit render size. HiDream-O1 is trained at ~4MP:
   * edits below ~2MP came back BLANK on GPU (2026-09-05) — the runner clamps
   * up to this, whatever the requested renderSize says.
   */
  minEditSize?: number;
  /**
   * Works, but needs far more VRAM than a consumer card to be practical —
   * pickers say so, because "verified" must not imply "usable tonight".
   */
  heavy?: boolean;
  /** Model files the ComfyUI install needs (README carries the full table). */
  notes: string;
}

// SDXL was the launch family and was REMOVED after live testing (2026-09-05):
// six tuning rounds got pose conditioning working, but at the VRAM this
// machine has, identity, prompt adherence and rendering quality never reached
// usable at once (garbage directional anchors, unusable walk cycles). The
// transferable lessons live in the README's tuning-history table; the
// replacement is Z-Image Turbo, which targets exactly those weaknesses.
export const MODEL_FAMILIES: Record<string, ModelFamily> = {
  'z-image-turbo': {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo (6B, 8-step)',
    // No identity adapter in its ecosystem yet: directional anchors are out;
    // animation frames run pose-only (identity rides on the prompt).
    workflows: ['anchor-generate', 'animation-frame', 'repair'],
    checkpoint: 'z_image_turbo_bf16.safetensors',
    // GPU-verified 2026-09-05 on a 4GB RTX 3050 Ti at 768px: exact prompt
    // adherence on the anchor test, and a 4-frame skeleton-conditioned walk
    // with STABLE identity from prompt+seed alone (~2.5 min/frame cold).
    verified: true,
    notes:
      'diffusion_models/z_image_turbo_bf16 (GGUF fits 6-8GB), text_encoders/qwen_3_4b, vae/ae, ' +
      'model_patches/Z-Image-Turbo-Fun-Controlnet-Union',
  },
  'hidream-o1': {
    id: 'hidream-o1',
    label: 'HiDream-O1 dev (8B pixel-native)',
    // Unified instruction editing + subject-driven reference — the anchor
    // chain's model. No pose ControlNet ecosystem yet: no animation frames.
    /**
     * GENERATE ONLY. The reference edit works in isolation (verified
     * 212s@1408 on a 4GB card, identity held through a facing turn) but
     * FAILED in the real pipeline: through genvy's directional prompt it
     * returned a washed-out figure that the alpha cutout reduced to a ghost.
     * Until that is diagnosed (suspect: paled output + rembg, or O1
     * disagreeing with the structured preserve/change prompt), turns are not
     * offered here — an unusable option that costs 3.5 minutes is worse than
     * no option, and the UI now refuses instead of silently billing a paid
     * provider for the job.
     */
    workflows: ['anchor-generate'],
    checkpoint: 'hidream_o1_image_dev_fp8_scaled.safetensors',
    verified: true,
    minEditSize: 1408,
    notes: 'checkpoints/hidream_o1_image_dev_fp8_scaled (8.1GB fp8, text encoder bundled)',
  },
  flux2: {
    id: 'flux2',
    label: 'FLUX.2 dev (32B)',
    // Multi-reference identity is native; pose ControlNets are still
    // FLUX.1-compat community work — no animation frames yet. Server-class
    // VRAM only, and mind the non-commercial dev license.
    workflows: ['anchor-generate', 'anchor-directional'],
    // Quantized set — fp8 is 35GB diffusion + 36GB encoder, which no
    // consumer card can hold. Q4 GGUF (20GB) + fp4 encoder (12GB) is the
    // only combination worth attempting outside a server.
    checkpoint: 'flux2_dev_q4.gguf',
    /**
     * GPU-verified 2026-09-06 (4GB card, Q4 + fp4 encoder, 640px): the best
     * anchor quality of any local family — but 1910s (~32 min) for ONE
     * image, nearly all of it streaming 20GB of weights. Correct, not
     * practical below ~24GB VRAM, hence `heavy`.
     */
    verified: true,
    heavy: true,
    notes:
      'diffusion_models/flux2_dev_q4.gguf (city96 Q4_K_M), ' +
      'text_encoders/mistral_3_small_flux2_fp4_mixed, vae/flux2-vae. ' +
      'Needs the ComfyUI-GGUF nodes; non-commercial dev license.',
  },
};

export function getModelFamily(id: string | undefined): ModelFamily {
  const family = MODEL_FAMILIES[id ?? 'z-image-turbo'];
  if (!family) {
    throw new Error(
      `Unknown MODEL_FAMILY "${id}" — valid: ${Object.keys(MODEL_FAMILIES).join(', ')}`,
    );
  }
  return family;
}
