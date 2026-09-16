import type { ImageOp, ImageProviderStatus, ImageQualityTier } from '@genvy/shared';
import { field } from './components.js';
import { UISound } from './UISound.js';
import {
  fillModelOptions,
  fillQualityOptions,
  formatPrice,
  modelInfo,
  modelTag,
  priceEntry,
  qualityTiersFor,
  splitRow,
  timingTag,
} from './imageModels.js';

/**
 * The provider / model / render-size / quality / candidates control set the
 * Sprite Forge grew, as one reusable unit.
 *
 * It exists because these controls are not decorative: they decide which
 * provider spends money, which local family can actually do the job, and how
 * long a render takes. Duplicating that logic per tool is how a hidden select
 * ends up silently billing gpt-image-2.5 (it happened) — one implementation
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
  /**
   * Whether these controls send a fresh generation or an edit of a reference —
   * it picks the default model and the prices shown. Inferred from `workflow`
   * when absent ('anchor-generate' generates, everything else edits).
   */
  op?: ImageOp;
}

const SIZE_LABELS: Record<number, string> = {
  512: '512 · DRAFT',
  640: '640 · BALANCED',
  768: '768 · QUALITY',
  1024: '1024 · MAX (SLOW)',
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
    this.modelField = field('MODEL', this.modelSel);
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

  /** What this control set's workflow sends: a fresh generation, or an edit of a reference. */
  private defaultOp(): ImageOp {
    return this.opts.op ?? (this.opts.workflow === 'anchor-generate' ? 'generate' : 'edit');
  }

  /**
   * Preselect a provider (e.g. seed a modal from its panel's pick) when it is
   * offered and live here; the pickers refill for it.
   */
  selectProvider(id: string | undefined) {
    const opt = Array.from(this.providerSel.options).find((o) => o.value === id && !o.disabled);
    if (!opt) return;
    this.providerSel.value = opt.value;
    this.refreshVisibility();
    this.onChange?.();
  }

  private priceCanvas(): 'square' | 'tall' {
    return this.canvas === 'square' ? 'square' : 'tall';
  }

  /**
   * (Re)fill the quality picker with the PICKED MODEL's tiers, each priced for
   * the current canvas from /api/health — the server learns those prices from
   * billed calls, so the preview and the booked spend come from ONE source.
   */
  private fillQualityOptions(_force = false) {
    fillQualityOptions(this.qualitySel, this.current(), this.modelFamily(), this.defaultOp(), this.priceCanvas());
  }

  /** The rows to append into a panel, in order. */
  elements(): HTMLElement[] {
    if (this.fields.length === 0) {
      const providerField = field('PROVIDER', this.providerSel);
      // Provider and quality share a line, 60/40; size + candidates the next.
      const row1 = splitRow(providerField, this.qualityField);

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
    // A fresh roster carries freshly learned prices — relabel even when the
    // tiers themselves did not change.
    this.fillQualityOptions(true);
    this.onChange?.();
  }

  private current(): ImageProviderStatus | undefined {
    return this.providers.find((p) => p.id === this.providerSel.value);
  }

  private refreshVisibility() {
    const p = this.current();
    // Every model the provider offers (OpenAI's three, local families), with
    // the ones that cannot do this job named and disabled; the default is the
    // provider's own model for this op.
    const hasModels = fillModelOptions(this.modelSel, p, this.opts.workflow, this.defaultOp());
    this.modelField.style.display = hasModels ? '' : 'none';
    this.sizeField.style.display = p?.capabilities.renderSize ? '' : 'none';
    this.candidateField.style.display =
      this.opts.candidates && p?.capabilities.gridSheets === false ? '' : 'none';
    // Tiers follow the model: gpt-image-2 has three, gpt-image-2.5 five.
    this.qualityField.style.display = qualityTiersFor(p, this.modelFamily()).length ? '' : 'none';
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
    return this.current()?.capabilities.renderSize ? Number(this.sizeSel.value) || undefined : undefined;
  }

  quality(): ImageQualityTier | undefined {
    return qualityTiersFor(this.current(), this.modelFamily()).length
      ? (this.qualitySel.value as ImageQualityTier)
      : undefined;
  }

  candidates(): number | undefined {
    const p = this.current();
    return this.opts.candidates && p?.capabilities.gridSheets === false
      ? Number(this.candidateSel.value) || undefined
      : undefined;
  }

  /** "FREE" or the picked model's price like "$0.005" ("~$0.006" while unlearned) for `imageCalls` images of `op`. */
  costPreview(imageCalls = 1, op: ImageOp = this.defaultOp()): string {
    const p = this.current();
    if (!p) return '';
    if (p.free) return 'FREE';
    const quality = this.quality();
    const entry = quality ? priceEntry(p, this.modelFamily(), op, this.priceCanvas(), quality) : undefined;
    const calls = p.capabilities.gridSheets === false ? (this.candidates() ?? 1) * imageCalls : imageCalls;
    return entry ? formatPrice(entry, calls) : '';
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
      return `NO MODEL CAN DO THIS JOB — PICK ANOTHER PROVIDER OR MODEL`;
    }
    return null;
  }

  /** Name of the model/provider that will run `op`, for busy labels. */
  tag(op: ImageOp = this.defaultOp()): string {
    const p = this.current();
    // Providers that split models per op (OpenAI) name the one that runs.
    const family = this.modelFamily();
    const named = modelTag(p?.id, op, family);
    if (named || !p) return named ?? 'GPT-IMAGE-2.5';
    const model = modelInfo(p, family);
    const name = model ? model.label.toUpperCase() : p.name.toUpperCase();
    return p.free ? `${name} (FREE)` : name;
  }

  /** Timing-bucket segment for `op`: the provider plus the model that runs it. */
  timingTag(op: ImageOp = this.defaultOp()): string {
    return timingTag(this.providerId(), op, this.modelFamily());
  }
}
