/**
 * Every model file each family needs, where it goes, and how big it is.
 *
 * This is the single source of truth for setup: `npm run fetch-models`
 * downloads from it, a test asserts it stays in step with MODEL_FAMILIES,
 * and docs/local-inference-setup.md points at it instead of repeating URLs
 * that would drift.
 */

export interface ModelFile {
  /** Direct download URL (HuggingFace resolve links). */
  url: string;
  /** Path under ComfyUI/models/, including the filename ComfyUI will show. */
  dest: string;
  /** Approximate download size, for the "this will take a while" warning. */
  gb: number;
  /** Why this file exists, in one line. */
  role: string;
}

export interface FamilyManifest {
  /** Extra ComfyUI custom nodes this family needs, as git URLs. */
  customNodes?: string[];
  files: ModelFile[];
}

const HF = 'https://huggingface.co';

export const MODEL_MANIFEST: Record<string, FamilyManifest> = {
  'z-image-turbo': {
    files: [
      {
        url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors`,
        dest: 'diffusion_models/z_image_turbo_bf16.safetensors',
        gb: 12.3,
        role: 'the renderer (full precision)',
      },
      {
        url: `${HF}/unsloth/Z-Image-Turbo-GGUF/resolve/main/z-image-turbo-Q4_K_S.gguf`,
        dest: 'diffusion_models/z_image_turbo_q4.gguf',
        gb: 4.7,
        role: 'quantized renderer — ~2x faster on small cards (COMFY_CHECKPOINT=z_image_turbo_q4.gguf)',
      },
      {
        url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`,
        dest: 'text_encoders/qwen_3_4b.safetensors',
        gb: 8.0,
        role: 'text encoder',
      },
      {
        url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors`,
        dest: 'vae/ae.safetensors',
        gb: 0.34,
        role: 'VAE',
      },
      {
        url: `${HF}/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union.safetensors`,
        dest: 'model_patches/Z-Image-Turbo-Fun-Controlnet-Union.safetensors',
        gb: 3.1,
        role: 'pose ControlNet — REQUIRED for skeleton-conditioned animation',
      },
    ],
  },
  'hidream-o1': {
    files: [
      {
        url: `${HF}/Comfy-Org/HiDream-O1-Image/resolve/main/checkpoints/hidream_o1_image_dev_fp8_scaled.safetensors`,
        dest: 'checkpoints/hidream_o1_image_dev_fp8_scaled.safetensors',
        gb: 8.1,
        role: 'everything in one file (text encoder + VAE bundled)',
      },
    ],
  },
  flux2: {
    files: [
      {
        url: `${HF}/city96/FLUX.2-dev-gguf/resolve/main/flux2-dev-Q4_K_M.gguf`,
        dest: 'diffusion_models/flux2_dev_q4.gguf',
        gb: 20.1,
        role: 'quantized renderer (the fp8 original is 35GB)',
      },
      {
        url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/text_encoders/mistral_3_small_flux2_fp4_mixed.safetensors`,
        dest: 'text_encoders/mistral_3_small_flux2_fp4_mixed.safetensors',
        gb: 12.3,
        role: 'Mistral text encoder (smallest published variant)',
      },
      {
        url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors`,
        dest: 'vae/flux2-vae.safetensors',
        gb: 0.34,
        role: 'VAE',
      },
    ],
  },
};

/** Custom ComfyUI nodes the service needs regardless of family. */
export const REQUIRED_CUSTOM_NODES = [
  {
    url: 'https://github.com/city96/ComfyUI-GGUF.git',
    why: 'loads .gguf quantized models (UnetLoaderGGUF)',
  },
];

export function familyDownloadSize(family: string): number {
  return (MODEL_MANIFEST[family]?.files ?? []).reduce((sum, f) => sum + f.gb, 0);
}
