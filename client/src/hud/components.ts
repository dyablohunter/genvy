import { UISound } from './UISound.js';
import type { AssetIndexEntry } from '@genvy/shared';

/** Sci-fi framed panel. Attributes: title, dock (used by HudShell for placement). */
export class GenvyPanel extends HTMLElement {
  private titleEl!: HTMLElement;
  bodyEl!: HTMLElement;

  connectedCallback() {
    if (this.bodyEl) return;
    const existing = [...this.childNodes];
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'gp-title';
    this.titleEl.textContent = this.getAttribute('title') ?? 'PANEL';
    this.removeAttribute('title'); // avoid native tooltip
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'gp-body';
    for (const node of existing) this.bodyEl.appendChild(node);
    this.append(this.titleEl, this.bodyEl);
  }

  setTitle(text: string) {
    if (this.titleEl) this.titleEl.textContent = text;
  }
}

/**
 * Button with built-in hover/click sfx. Attributes: label, variant (accent|danger).
 * onClick/disabled/setLabel may be called before the element is mounted — the
 * inner <button> only exists after connectedCallback, so state is queued.
 */
export class GenvyButton extends HTMLElement {
  btn: HTMLButtonElement | null = null;
  private pendingHandlers: (() => void)[] = [];
  private pendingDisabled: boolean | null = null;
  private pendingLabel: string | null = null;

  connectedCallback() {
    if (this.btn) return;
    this.btn = document.createElement('button');
    this.btn.textContent = this.pendingLabel ?? this.getAttribute('label') ?? this.textContent ?? 'OK';
    this.textContent = '';
    this.appendChild(this.btn);
    this.btn.addEventListener('mouseenter', () => UISound.play('hover'));
    this.btn.addEventListener('click', () => UISound.play('click'));
    for (const fn of this.pendingHandlers) this.btn.addEventListener('click', fn);
    this.pendingHandlers = [];
    if (this.pendingDisabled !== null) this.btn.disabled = this.pendingDisabled;
  }

  set disabled(v: boolean) {
    if (this.btn) this.btn.disabled = v;
    else this.pendingDisabled = v;
  }

  setLabel(text: string) {
    if (this.btn) this.btn.textContent = text;
    else this.pendingLabel = text;
  }

  onClick(fn: () => void) {
    if (this.btn) this.btn.addEventListener('click', fn);
    else this.pendingHandlers.push(fn);
    return this;
  }
}

/** Asset card for the collection drawer. */
export class GenvyAssetCard extends HTMLElement {
  render(entry: AssetIndexEntry) {
    const thumb = entry.thumbnail
      ? `<img src="/library/files/${entry.thumbnail}" alt="" />`
      : `<div class="g-thumb-fallback">${typeIcon(entry.type)}</div>`;
    this.innerHTML = `${thumb}<div class="g-meta"><div class="g-name">${escapeHtml(entry.name)}</div><div class="g-type">${entry.type}</div></div>`;
    this.addEventListener('mouseenter', () => UISound.play('hover'));
    return this;
  }
}

function typeIcon(type: string): string {
  const icons: Record<string, string> = {
    spritesheet: '🧬',
    animation: '🎞️',
    character: '🧑‍🚀',
    tileset: '🧱',
    world: '🗺️',
  };
  return icons[type] ?? '📦';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Labeled input field helper (not a custom element — simpler for forms). */
export function field(
  label: string,
  input: HTMLElement,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'g-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  wrap.append(lab, input);
  return wrap;
}

export function textInput(value = '', placeholder = ''): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

export function textArea(value = '', placeholder = ''): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

export function numberInput(value: number, min?: number, max?: number): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'number';
  el.value = String(value);
  if (min !== undefined) el.min = String(min);
  if (max !== undefined) el.max = String(max);
  return el;
}

export function rangeInput(value: number, min: number, max: number, step = 1): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'range';
  el.value = String(value);
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  return el;
}

export function progressBar(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'g-progress';
  wrap.innerHTML = '<div class="bar"></div>';
  return wrap;
}

export function forgeStatus(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'g-forge-status';
  el.textContent = text;
  return el;
}

let defined = false;
export function defineComponents() {
  if (defined) return;
  defined = true;
  customElements.define('genvy-panel', GenvyPanel);
  customElements.define('genvy-button', GenvyButton);
  customElements.define('genvy-asset-card', GenvyAssetCard);
}
