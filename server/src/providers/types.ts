import type { ImageOrientation, StyleContract } from '@genvy/shared';

/**
 * Sprite Pipeline v2 — provider abstraction (docs/sprite-pipeline-v2.md §A).
 * One interface, N implementations: API providers gated by .env keys today,
 * local inference providers in P6. Everything above this layer talks in
 * requests + Buffers and never sees provider SDKs or endpoints.
 */

/**
 * What a call actually cost, when the provider says so. Reported figures beat
 * our per-call estimates — see CLAUDE.md on the spend readout.
 */
export interface ProviderBilling {
  /** Exact cost of this call, in cents. */
  cents?: number;
  /** Account balance left afterwards, in cents. */
  balanceCents?: number;
}

export interface ImageGenerateRequest {
  prompt: string;
  orientation: ImageOrientation;
  /** Caller wants a real alpha channel; honored only when capabilities.nativeAlpha. */
  transparent?: boolean;
  style?: StyleContract;
  /** Model family for providers that host several (the local service); others ignore it. */
  modelFamily?: string;
  /** Square render-canvas side for providers with a choosable one (local); speed<->detail dial. */
  renderSize?: number;
  /** Quality tier for providers that price/render by it (capabilities.qualityLevels). */
  quality?: 'low' | 'medium' | 'high';
  /** Called when the provider reports real cost/balance for this request. */
  onBilled?: (info: ProviderBilling) => void;
}

export type ReferenceRole = 'identity' | 'layout';

export interface ImageReference {
  image: Buffer;
  /** Role the prompt annotates this image with (identity anchor vs layout guide). */
  role: ReferenceRole;
}

export interface ImageEditRequest extends ImageGenerateRequest {
  /** Role-annotated reference images, in prompt order (Image 1, Image 2, ...). */
  references: ImageReference[];
  /** What the edit IS: a full re-imagining ('edit', default) or an in-place frame redraw ('repair', img2img) — providers with distinct pipelines route on it. */
  purpose?: 'edit' | 'repair';
}

export interface ImageAnimateRequest {
  /** Directional anchor frame the animation derives from. */
  anchor: Buffer;
  /** Semantic action ('idle' | 'walk' | 'attack' | ...). */
  action: string;
  frames: number;
  /** The clip's facing — pose-conditioned providers build their skeletons from it. */
  facing?: 'south' | 'west' | 'east' | 'north';
  /** Extra motion notes appended to the provider's animation request. */
  prompt?: string;
  /** Appearance text — the identity channel for models with no reference-image adapter. */
  identityPrompt?: string;
  style?: StyleContract;
  /** Model family for providers that host several (the local service); others ignore it. */
  modelFamily?: string;
  /** Square render-canvas side per frame for providers with a choosable one (local). */
  renderSize?: number;
  /** Called when the provider reports real cost/balance for this request. */
  onBilled?: (info: ProviderBilling) => void;
}

export type ProviderRequest = ImageGenerateRequest | ImageEditRequest | ImageAnimateRequest;

export interface ProviderCapabilities {
  /** text -> image */
  generate: boolean;
  /** reference image(s) + instruction -> image */
  edit: boolean;
  /** >1 input image with distinct roles */
  multiReference: boolean;
  /** real transparent background; false means the chroma workflow is mandatory */
  nativeAlpha: boolean;
  /** purpose-built animation endpoint (Retro Diffusion, PixelLab) */
  animation: boolean;
  /**
   * Can draw a multi-candidate 2x2 grid in ONE call (gpt-image-2). Providers
   * without it get variants/anchors as four single-figure renders the route
   * composes itself — SDXL draws layout instructions as noise, not grids.
   */
  gridSheets: boolean;
  /**
   * Animation strips are composed from INDEPENDENT per-frame renders (the
   * local service): figure scale drifts between frames, so the route
   * equalizes heights and re-registers the strip before gating/saving.
   */
  independentFrames?: boolean;
  /** longest supported output side in pixels */
  maxSize: number;
  /** Quality tiers the provider prices/renders by; pickers show a select when present. */
  qualityLevels?: ('low' | 'medium' | 'high')[];
  /** rough cost in cents, before spending */
  costEstimate(req: ProviderRequest): number;
}

/** One selectable model behind a multi-model provider (the local service's families). */
export interface ProviderModelInfo {
  id: string;
  label: string;
  /** Ran on real hardware here — pickers disable unverified entries. */
  verified: boolean;
  /** Verified but impractically slow without a big GPU; pickers warn. */
  heavy?: boolean;
  /** Its weights are installed in the backing ComfyUI right now. */
  available: boolean;
  workflows: string[];
}

export interface ImageProvider {
  id: string; // 'openai' | 'retrodiffusion' | 'pixellab' | 'local-comfy' | ...
  name: string;
  /** Selectable models, for providers hosting several (refreshed with health). */
  models?: ProviderModelInfo[];
  /** Whether the required .env key / service is present. Offline providers stay registered so the HUD can list them dimmed. */
  live: boolean;
  /** What the user should do when this provider is offline (defaults to the API-key hint). */
  offlineHint?: string;
  capabilities: ProviderCapabilities;
  generate(req: ImageGenerateRequest): Promise<Buffer>;
  edit(req: ImageEditRequest): Promise<Buffer>;
  animate?(req: ImageAnimateRequest): Promise<Buffer>;
  /** Abort this provider's in-flight work, when it can (local renders). */
  cancelCurrent?(): Promise<boolean>;
}

/** Providers throw this shape; 422 marks moderation (triggers sanitize-and-retry). */
export function providerError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function offlineError(id: string): Error {
  return providerError(503, `Image provider "${id}" is not configured (missing API key)`);
}
