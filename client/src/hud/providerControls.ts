import type { ImageProviderStatus } from '@genvy/shared';
import { field } from './components.js';
import { UISound } from './UISound.js';

/**
 * The provider / model / render-size / quality / candidates control set the
 * Sprite Forge grew, as one reusable unit.
 *
 * It exists because these controls are not decorative: they decide which
 * provider spends money, which local family can actually do the job, and how
 * long a render takes. Duplicating that logic per tool is how a hidden select
 * ends up silently billing gpt-image-2 (it happened) — one implementation
 * keeps every tool honest.
 */

export type Workflow = 'anchor-generate' | 'anchor-directional' | 'animation-frame' | 'repair';

export interface ProviderControlsOptions {
  /** The job these controls will run — model routing checks it can be done. */
  workflow: Workflow;
  /** Show the 1-4 candidates select (per-candidate providers only). */
  candidates?: boolean;
  /** Which providers are eligible at all (defaults to "can generate"). */
  eligible?: (p: ImageProviderStatus) => boolean;
}

const SIZE_LABELS: Record<number, string> = {
  512: '512 · DRAFT',
  640: '640 · BALANCED',
  768: '768 · QUALITY',
  1024: '1024 · MAX (SLOW)',
};

/**
 * Published gpt-image-2 prices in dollars per image, by canvas and quality.
 * Square is NOT cheaper than the tall/wide canvas — it costs more at every
 * tier — so this is a table rather than a ratio off one row. It mirrors
 * OPENAI_IMAGE_PRICE on the server: the preview must agree with what is
 * actually booked, or the header spend contradicts the button that spent it.
 *
 *              1024x1024   1024x1536 / 1536x1024
 *   low          $0.006            $0.005
 *   medium       $0.053            $0.041
 *   high         $0.211            $0.165
 */
const QUALITY_PRICE: Record<'square' | 'tall', Record<string, number>> = {
  square: { low: 0.006, medium: 0.053, high: 0.211 },
  tall: { low: 0.005, medium: 0.041, high: 0.165 },
};

export class ProviderControls {
  readonly providerSel = document.createElement('select');
  readonly modelSel = document.createElement('select');
  readonly sizeSel = document.createElement('select');
  readonly qualitySel = document.createElement('select');
  readonly candidateSel = document.createElement('select');

  private providers: ImageProviderStatus[] = [];
  private fields: HTMLElement[] = [];
  private modelField: HTMLElement;
  private sizeField: HTMLElement;
  private qualityField: HTMLElement;
  private candidateField: HTMLElement;
  /** Called whenever a selection changes (to refresh cost labels etc). */
  onChange: (() => void) | null = null;
  /** The canvas the caller will request — it changes what a render costs. */
  private canvas: 'portrait' | 'landscape' | 'square' = 'landscape';

  constructor(private opts: ProviderControlsOptions) {
    this.modelField = field('LOCAL MODEL', this.modelSel);
    this.sizeField = field('RENDER SIZE', this.sizeSel);
    this.qualityField = field('QUALITY', this.qualitySel);
    this.candidateField = field('CANDIDATES', this.candidateSel);

    for (const n of [512, 640, 768, 1024]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = SIZE_LABELS[n]!;
      if (n === 640) opt.selected = true;
      this.sizeSel.appendChild(opt);
    }
    for (const n of [1, 2, 3, 4]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = n === 1 ? '1 · FASTEST' : n === 4 ? '4 · FULL SET' : String(n);
      this.candidateSel.appendChild(opt);
    }
    for (const sel of [this.providerSel, this.modelSel, this.sizeSel, this.qualitySel, this.candidateSel]) {
      sel.addEventListener('change', () => {
        UISound.play('click');
        this.refreshVisibility();
        this.onChange?.();
      });
    }
  }

  /**
   * Tell the controls which canvas the job will use. A square costs less than
   * a tall or wide one, so the quality prices and the cost preview both move.
   */
  setCanvas(canvas: 'portrait' | 'landscape' | 'square') {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    this.fillQualityOptions(true);
    this.onChange?.();
  }

  /** Dollar price of one image at a quality, for the current canvas. */
  private price(quality: string | undefined): number {
    return QUALITY_PRICE[this.canvas === 'square' ? 'square' : 'tall'][quality ?? 'low'] ?? 0;
  }

  /** (Re)label the quality picker with prices for the current canvas. */
  private fillQualityOptions(force = false) {
    const levels = this.current()?.capabilities.qualityLevels ?? [];
    if (levels.length === 0) return;
    if (!force && this.qualitySel.options.length === levels.length) return;
    const previous = this.qualitySel.value;
    this.qualitySel.innerHTML = '';
    for (const l of levels) {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = `${l.toUpperCase()} · $${this.price(l).toFixed(3)}`;
      this.qualitySel.appendChild(opt);
    }
    this.qualitySel.value = levels.some((l) => l === previous) ? previous : 'low';
  }

  /** The rows to append into a panel, in order. */
  elements(): HTMLElement[] {
    if (this.fields.length === 0) {
      const providerField = field('PROVIDER', this.providerSel);
      // Provider + quality share a line; size + candidates share the next.
      const row1 = document.createElement('div');
      row1.style.display = 'flex';
      row1.style.gap = '8px';
      for (const f of [providerField, this.qualityField]) {
        f.style.flex = '1 1 50%';
        f.style.minWidth = '0';
      }
      row1.append(providerField, this.qualityField);

      const row2 = document.createElement('div');
      row2.style.display = 'flex';
      row2.style.gap = '8px';
      const row2Fields = this.opts.candidates
        ? [this.sizeField, this.candidateField]
        : [this.sizeField];
      for (const f of row2Fields) {
        f.style.flex = '1 1 50%';
        f.style.minWidth = '0';
      }
      row2.append(...row2Fields);

      this.fields = [row1, this.modelField, row2];
    }
    return this.fields;
  }

  /** Feed the live provider roster (from /api/health) and refill the pickers. */
  setProviders(providers: ImageProviderStatus[]) {
    this.providers = providers;
    const eligible = providers.filter(this.opts.eligible ?? ((p) => p.capabilities.generate));
    const previous = this.providerSel.value;
    this.providerSel.innerHTML = '';
    for (const p of eligible) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = !p.live
        ? `${p.name.toUpperCase()} · OFFLINE`
        : p.free
          ? `${p.name.toUpperCase()} · FREE`
          : p.name.toUpperCase();
      opt.disabled = !p.live;
      this.providerSel.appendChild(opt);
    }
    const live = eligible.filter((p) => p.live);
    this.providerSel.value =
      previous && live.some((p) => p.id === previous)
        ? previous
        : (live.find((p) => p.id === 'openai') ?? live[0])?.id ?? '';
    this.refreshVisibility();
    this.onChange?.();
  }

  private current(): ImageProviderStatus | undefined {
    return this.providers.find((p) => p.id === this.providerSel.value);
  }

  private refreshVisibility() {
    const p = this.current();
    const models = p?.models ?? [];
    // Local families: list them all, but name what each cannot do and refuse
    // the ones that are untested or missing their weights.
    if (models.length > 0) {
      const previous = this.modelSel.value;
      this.modelSel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        const can = m.workflows.includes(this.opts.workflow);
        const tags = [
          ...(m.heavy ? ['VERY SLOW'] : []),
          ...(can ? [] : ['CANNOT DO THIS JOB']),
        ];
        opt.textContent = !m.verified
          ? `${m.label.toUpperCase()} · UNTESTED`
          : !m.available
            ? `${m.label.toUpperCase()} · MODELS MISSING`
            : tags.length
              ? `${m.label.toUpperCase()} · ${tags.join(' · ')}`
              : m.label.toUpperCase();
        opt.disabled = !m.verified || !m.available || !can;
        this.modelSel.appendChild(opt);
      }
      const usable = models.filter(
        (m) => m.verified && m.available && m.workflows.includes(this.opts.workflow),
      );
      this.modelSel.value = usable.some((m) => m.id === previous) ? previous : usable[0]?.id ?? '';
    }
    this.modelField.style.display = models.length > 0 ? '' : 'none';
    this.sizeField.style.display = models.length > 0 ? '' : 'none';
    this.qualityField.style.display = p?.capabilities.qualityLevels?.length ? '' : 'none';
    this.candidateField.style.display =
      this.opts.candidates && p?.capabilities.gridSheets === false ? '' : 'none';

    this.fillQualityOptions();
  }

  providerId(): string | undefined {
    return this.providerSel.value || undefined;
  }

  /** The family that will run this workflow, or undefined for single-model providers. */
  modelFamily(): string | undefined {
    const p = this.current();
    if (!p?.models?.length) return undefined;
    const usable = p.models.filter((m) => m.verified && m.available);
    const picked = usable.find((m) => m.id === this.modelSel.value);
    if (picked?.workflows.includes(this.opts.workflow)) return picked.id;
    return usable.find((m) => m.workflows.includes(this.opts.workflow))?.id;
  }

  renderSize(): number | undefined {
    return this.current()?.models?.length ? Number(this.sizeSel.value) || undefined : undefined;
  }

  quality(): 'low' | 'medium' | 'high' | undefined {
    return this.current()?.capabilities.qualityLevels?.length
      ? (this.qualitySel.value as 'low' | 'medium' | 'high')
      : undefined;
  }

  candidates(): number | undefined {
    const p = this.current();
    return this.opts.candidates && p?.capabilities.gridSheets === false
      ? Number(this.candidateSel.value) || undefined
      : undefined;
  }

  /** "FREE" or an estimate like "$0.005" for `imageCalls` images. */
  costPreview(imageCalls = 1): string {
    const p = this.current();
    if (!p) return '';
    if (p.free) return 'FREE';
    const per = this.price(this.quality());
    const calls = p.capabilities.gridSheets === false ? (this.candidates() ?? 1) * imageCalls : imageCalls;
    return per ? `$${(per * calls).toFixed(3)}` : '';
  }

  /**
   * Whether the chosen provider can actually run this job. Returns the reason
   * when it cannot — callers show it and STOP rather than falling back to a
   * paid provider the user did not pick.
   */
  blockedReason(): string | null {
    const p = this.current();
    if (!p) return null;
    if (!p.live) return `${p.name.toUpperCase()} IS OFFLINE — PICK ANOTHER PROVIDER`;
    if (p.models?.length && !this.modelFamily()) {
      return `NO LOCAL MODEL CAN DO THIS JOB — PICK ANOTHER PROVIDER OR MODEL`;
    }
    return null;
  }

  /** Name of the model/provider that will run, for busy labels. */
  tag(): string {
    const p = this.current();
    if (!p || p.id === 'openai') return 'GPT-IMAGE-2';
    const family = this.modelFamily();
    const model = family ? p.models?.find((m) => m.id === family) : undefined;
    const name = model ? model.label.toUpperCase() : p.name.toUpperCase();
    return p.free ? `${name} (FREE)` : name;
  }
}
