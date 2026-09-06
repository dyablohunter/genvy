import type { ImageProviderStatus } from '@genvy/shared';
import { config } from '../config.js';
import type { ImageProvider } from './types.js';
import { providerError } from './types.js';
import { createOpenAiProvider } from './openai.js';
import { createRetroDiffusionProvider } from './retrodiffusion.js';
import { createLocalInferenceProvider } from './localInference.js';

export * from './types.js';

export interface ProviderRegistryConfig {
  openaiApiKey: string;
  retroDiffusionApiKey: string;
  /** P6: base URL of the local-inference service ('' disables registration health polling). */
  localInferenceUrl?: string;
}

export class ProviderRegistry {
  private providers = new Map<string, ImageProvider>();

  constructor(cfg: ProviderRegistryConfig) {
    for (const p of [
      createOpenAiProvider(cfg.openaiApiKey),
      createRetroDiffusionProvider(cfg.retroDiffusionApiKey),
      createLocalInferenceProvider(cfg.localInferenceUrl ?? 'http://127.0.0.1:3021'),
    ]) {
      this.providers.set(p.id, p);
    }
  }

  /** Resolve a provider or throw (400 unknown, 503 offline). */
  resolve(id: string | undefined): ImageProvider {
    const provider = this.providers.get(id ?? 'openai');
    if (!provider) throw providerError(400, `Unknown image provider: ${id}`);
    if (!provider.live) {
      throw providerError(
        503,
        `Image provider "${provider.id}" LINK OFFLINE — ${provider.offlineHint ?? 'add its API key to .env'}`,
      );
    }
    return provider;
  }

  get(id: string): ImageProvider | undefined {
    return this.providers.get(id);
  }

  all(): ImageProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Per-step default (docs §A): anchors/sheets -> gpt-image-2; pixel-style
   * animation -> Retro Diffusion when its key is present. Advisory only in P1 —
   * routes honor an explicit `provider` override and otherwise stay on
   * 'openai' so existing flows keep their exact behavior and cost.
   */
  recommendFor(step: 'anchor' | 'sheet' | 'animation' | 'tileset', styleId?: string): string {
    if (step === 'animation' && styleId?.startsWith('pixel')) {
      const rd = this.providers.get('retrodiffusion');
      if (rd?.live) return rd.id;
    }
    return 'openai';
  }

  /** LIVE/OFFLINE roster for /api/health, so the HUD can dim offline providers. */
  status(): ImageProviderStatus[] {
    return this.all().map((p) => ({
      id: p.id,
      name: p.name,
      live: p.live,
      // Free providers get labelled in the picker — cost is a capability fact.
      free: p.capabilities.costEstimate({ prompt: 'x', orientation: 'portrait' }) === 0,
      ...(p.models ? { models: p.models } : {}),
      capabilities: {
        generate: p.capabilities.generate,
        edit: p.capabilities.edit,
        multiReference: p.capabilities.multiReference,
        nativeAlpha: p.capabilities.nativeAlpha,
        animation: p.capabilities.animation,
        gridSheets: p.capabilities.gridSheets,
        maxSize: p.capabilities.maxSize,
        ...(p.capabilities.qualityLevels ? { qualityLevels: p.capabilities.qualityLevels } : {}),
      },
    }));
  }
}

/** Default registry built from .env-backed config. */
export const providerRegistry = new ProviderRegistry(config);
