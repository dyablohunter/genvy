import {
  defineComponents,
  GenvyAssetCard,
  GenvyPanel,
  GenvyButton,
  forgeStatus,
  progressBar,
} from './components.js';
import { slideIn, slideOut, glowPop } from './anim.js';
import { UISound } from './UISound.js';
import { collection } from '../state/collection.js';
import { api, ApiError } from '../api/client.js';
import type { AssetIndexEntry } from '@genvy/shared';

/**
 * Character-family assets are reached through their session card's V-squares,
 * so only standalone asset types get their own row.
 */
const DRAWER_HIDDEN_TYPES = new Set(['animation', 'spritesheet', 'character']);

export type Dock = 'left' | 'right' | 'bottom';

/**
 * Permanent DOM layer over the Phaser canvas. Owns the top bar, toast stack,
 * collection drawer, and per-tool panel layouts.
 */
class HudShellImpl {
  private root!: HTMLElement;
  private dockLeft!: HTMLElement;
  private dockRight!: HTMLElement;
  private layoutPanels: GenvyPanel[] = [];
  private topbar!: HTMLElement;
  private forgeCountEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private backBtn!: HTMLElement;
  private drawer: GenvyPanel | null = null;
  private drawerList: HTMLElement | null = null;
  onBackToHub: (() => void) | null = null;
  onOpenAsset: ((entry: AssetIndexEntry) => void) | null = null;
  onOpenRecovered: ((id: string) => void) | null = null;

  init() {
    defineComponents();
    UISound.attachUnlock();
    this.root = document.getElementById('hud-root')!;

    // Flex dock columns: panels flow and push each other when content grows.
    // pointer-events inline because `#hud-root > *` outweighs the class rule.
    this.dockLeft = document.createElement('div');
    this.dockLeft.className = 'g-dock g-dock-left';
    this.dockLeft.style.pointerEvents = 'none';
    this.dockRight = document.createElement('div');
    this.dockRight.className = 'g-dock g-dock-right';
    this.dockRight.style.pointerEvents = 'none';
    this.root.append(this.dockLeft, this.dockRight);

    this.topbar = document.createElement('div');
    this.topbar.id = 'genvy-topbar';
    this.topbar.innerHTML = `
      <div class="logo">GENVY</div>
      <div class="wipe-btn">WIPE ALL</div>
      <div class="status">SYSTEMS ONLINE</div>
      <div class="spacer"></div>
      <div class="forge-count">ASSETS FORGED: 0</div>
      <div class="back-btn" style="display:none">◄ COMMAND CENTER</div>
    `;
    this.root.appendChild(this.topbar);
    this.statusEl = this.topbar.querySelector('.status')!;
    this.forgeCountEl = this.topbar.querySelector('.forge-count')!;
    this.backBtn = this.topbar.querySelector('.back-btn')!;
    this.backBtn.addEventListener('mouseenter', () => UISound.play('hover'));
    this.backBtn.addEventListener('click', () => {
      UISound.play('click');
      this.onBackToHub?.();
    });

    // Dev/testing: two-step wipe of the entire collection.
    const wipeBtn = this.topbar.querySelector('.wipe-btn') as HTMLElement;
    let wipeArmed = false;
    let wipeTimer = 0;
    wipeBtn.addEventListener('mouseenter', () => UISound.play('hover'));
    wipeBtn.addEventListener('click', () => {
      UISound.play('click');
      if (!wipeArmed) {
        wipeArmed = true;
        wipeBtn.textContent = 'SURE? WIPES EVERYTHING';
        wipeBtn.classList.add('armed');
        wipeTimer = window.setTimeout(() => {
          wipeArmed = false;
          wipeBtn.textContent = 'WIPE ALL';
          wipeBtn.classList.remove('armed');
        }, 3000);
        return;
      }
      window.clearTimeout(wipeTimer);
      wipeArmed = false;
      wipeBtn.textContent = 'WIPE ALL';
      wipeBtn.classList.remove('armed');
      void (async () => {
        try {
          await api.wipeAll();
          UISound.play('error');
          this.toast('COLLECTION WIPED — FRESH START', 'success');
        } catch {
          this.toast('WIPE FAILED', 'error');
        }
        await collection.refresh();
      })();
    });

    const toasts = document.createElement('div');
    toasts.id = 'genvy-toasts';
    this.root.appendChild(toasts);

    collection.subscribe((entries) => {
      this.forgeCountEl.textContent = `ASSETS FORGED: ${entries.length}`;
      this.renderDrawer(entries);
    });
  }

  setStatus(text: string) {
    this.statusEl.textContent = text;
  }

  setBackVisible(visible: boolean) {
    this.backBtn.style.display = visible ? '' : 'none';
  }

  // ---------- Panel layouts ----------

  makePanel(title: string, dock: Dock): GenvyPanel {
    const panel = document.createElement('genvy-panel') as GenvyPanel;
    panel.setAttribute('title', title);
    panel.dataset.dock = dock;
    return panel;
  }

  private mountPanel(panel: GenvyPanel, delay = 0) {
    const dock = (panel.dataset.dock ?? 'left') as Dock;
    if (dock === 'left') {
      this.dockLeft.appendChild(panel);
    } else if (dock === 'right') {
      this.dockRight.appendChild(panel);
    } else {
      panel.style.position = 'absolute';
      panel.style.bottom = '12px';
      panel.style.left = '50%';
      panel.style.transform = 'translateX(-50%)';
      panel.style.minWidth = '420px';
      this.root.appendChild(panel);
    }
    void slideIn(panel, dock === 'bottom' ? 'bottom' : dock, delay);
  }

  /** Mounts panels with staggered slide-in; replaces the previous layout. */
  async setLayout(panels: GenvyPanel[]) {
    await this.clearLayout();
    this.layoutPanels = panels;
    panels.forEach((panel, i) => this.mountPanel(panel, i * 90));
  }

  /** Mount one more panel into the current layout (flows below its dock siblings). */
  addPanel(panel: GenvyPanel) {
    this.layoutPanels.push(panel);
    this.mountPanel(panel);
  }

  /** Show a panel in a specific dock column, re-parenting it if needed. */
  showPanel(panel: GenvyPanel, dock: Dock) {
    panel.style.display = '';
    const parent = dock === 'left' ? this.dockLeft : dock === 'right' ? this.dockRight : this.root;
    if (panel.dataset.dock !== dock || panel.parentElement !== parent) {
      panel.dataset.dock = dock;
      panel.style.position = '';
      panel.style.top = '';
      panel.style.left = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.transform = '';
      parent.appendChild(panel);
    }
    if (!this.layoutPanels.includes(panel)) this.layoutPanels.push(panel);
  }

  hidePanel(panel: GenvyPanel | null) {
    if (panel) panel.style.display = 'none';
  }

  async clearLayout() {
    const panels = this.layoutPanels;
    this.layoutPanels = [];
    await Promise.all(
      panels.map((p, i) => {
        const dock = (p.dataset.dock ?? 'left') as Dock;
        return slideOut(p, dock === 'bottom' ? 'bottom' : dock, i * 50).then(() => p.remove());
      }),
    );
  }

  // ---------- Collection drawer ----------

  showDrawer() {
    if (this.drawer) return;
    this.drawer = this.makePanel('COLLECTION', 'right');
    this.drawer.id = 'collection-drawer';
    this.root.appendChild(this.drawer);
    this.drawerList = document.createElement('div');
    this.drawerList.className = 'g-asset-list';
    this.drawer.bodyEl.appendChild(this.drawerList);
    this.renderDrawer(collection.entries);
    void slideIn(this.drawer, 'right');
  }

  hideDrawer() {
    if (!this.drawer) return;
    const d = this.drawer;
    this.drawer = null;
    this.drawerList = null;
    void slideOut(d, 'right').then(() => d.remove());
  }

  private actionRow: HTMLElement | null = null;
  private actionRowFor: string | null = null;
  /** Bumped on every drawer render so stale async appends can bail out. */
  private drawerRender = 0;

  private renderDrawer(entries: AssetIndexEntry[]) {
    if (!this.drawerList) return;
    const render = ++this.drawerRender;
    this.drawerList.innerHTML = '';
    this.actionRow = null;
    this.actionRowFor = null;
    this.closeCharDetail();

    // Characters render as a compact icon grid, filled asynchronously.
    const gridHost = document.createElement('div');
    this.drawerList.appendChild(gridHost);
    void this.buildCharacterGrid(render, gridHost);

    const visible = entries.filter((e) => !DRAWER_HIDDEN_TYPES.has(e.type));
    if (visible.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'g-divider';
      const heading = document.createElement('div');
      heading.className = 'g-hint';
      heading.textContent = 'OTHER ASSETS';
      this.drawerList.append(divider, heading);
    }
    for (const entry of visible.slice(0, 40)) {
      const card = (document.createElement('genvy-asset-card') as GenvyAssetCard).render(entry);
      card.addEventListener('click', () => {
        UISound.play('click');
        this.toggleActions(card, entry);
      });
      this.drawerList.appendChild(card);
    }
  }

  /** Characters as a 5-column icon grid; clicking one opens its detail panel. */
  private async buildCharacterGrid(render: number, host: HTMLElement) {
    let workspaces: import('@genvy/shared').WorkspaceInfo[] = [];
    try {
      workspaces = await api.listWorkspaces();
    } catch {
      return;
    }
    if (render !== this.drawerRender) return;

    const sessions = workspaces.filter((w) => w.files.includes('variants.png'));
    const groups: {
      session: import('@genvy/shared').WorkspaceInfo | null;
      children: import('@genvy/shared').WorkspaceInfo[];
    }[] = sessions.map((session) => ({
      session,
      children: workspaces.filter((w) => w.source?.sessionId === session.id),
    }));
    // Workspaces whose session grid was discarded still deserve an icon.
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const kid of workspaces) {
      if (!kid.files.includes('variant.png')) continue;
      if (sessionIds.has(kid.source?.sessionId ?? '')) continue;
      groups.push({ session: null, children: [kid] });
    }

    host.innerHTML = '';
    if (groups.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'g-hint';
      hint.textContent = 'NO CHARACTERS YET. FORGE ONE.';
      host.appendChild(hint);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'g-char-grid';
    for (const group of groups) {
      const slots = this.variantSlots(group.session, group.children);
      const lead = slots.find((s) => s?.character) ?? slots.find((s) => s?.sheet) ?? slots.find(Boolean);
      const name = lead?.character?.name?.replace(/\s+V\d+$/i, '') ?? 'UNSAVED';
      const icon = document.createElement('div');
      icon.className = `g-char-icon${lead?.character ? ' saved' : ''}`;
      icon.title = name;
      if (lead) {
        const img = document.createElement('img');
        img.src = `/library/files/${lead.id}/variant.png`;
        icon.appendChild(img);
      } else {
        icon.innerHTML = '<div class="g-thumb-fallback">🛠️</div>';
      }
      icon.addEventListener('mouseenter', () => UISound.play('hover'));
      icon.addEventListener('click', (ev) => {
        ev.stopPropagation();
        UISound.play('click');
        this.openCharDetail(group.session, group.children, slots, icon);
      });
      grid.appendChild(icon);
    }
    host.appendChild(grid);
  }

  /** One workspace per variant slot: prefer saved, else the newest. */
  private variantSlots(
    session: import('@genvy/shared').WorkspaceInfo | null,
    children: import('@genvy/shared').WorkspaceInfo[],
  ) {
    const slots: (import('@genvy/shared').WorkspaceInfo | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      const candidates = children.filter((c) => c.source?.variantIndex === i);
      slots[i] =
        candidates.find((c) => c.character) ??
        candidates.find((c) => c.sheet) ??
        [...candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    }
    if (!session && children.length === 1) slots[0] = children[0];
    return slots;
  }

  /** Slide the character's detail panel out from under the drawer. */
  private openCharDetail(
    session: import('@genvy/shared').WorkspaceInfo | null,
    children: import('@genvy/shared').WorkspaceInfo[],
    slots: (import('@genvy/shared').WorkspaceInfo | undefined)[],
    anchor: HTMLElement,
  ) {
    this.closeCharDetail();
    const detail = this.sessionCard(session, children, slots);
    detail.id = 'genvy-char-detail';
    const rect = anchor.getBoundingClientRect();
    detail.style.top = `${Math.min(rect.top, window.innerHeight - 260)}px`;
    this.root.appendChild(detail);
    this.charDetail = detail;
    void slideIn(detail, 'right');

    // Any click outside the panel (or on another icon) dismisses it.
    this.charDetailDismiss = (ev: PointerEvent) => {
      if (detail.contains(ev.target as Node)) return;
      this.closeCharDetail();
    };
    setTimeout(() => {
      if (this.charDetailDismiss) window.addEventListener('pointerdown', this.charDetailDismiss);
    }, 0);
  }

  private charDetail: HTMLElement | null = null;
  private charDetailDismiss: ((ev: PointerEvent) => void) | null = null;

  private closeCharDetail() {
    if (this.charDetailDismiss) {
      window.removeEventListener('pointerdown', this.charDetailDismiss);
      this.charDetailDismiss = null;
    }
    this.charDetail?.remove();
    this.charDetail = null;
  }

  /**
   * One card per forge session: a grid-icon square + V1–V4 squares. Saved
   * variants show their character name; unsaved ones are resumable work.
   */
  private sessionCard(
    session: import('@genvy/shared').WorkspaceInfo | null,
    children: import('@genvy/shared').WorkspaceInfo[],
    slots: (import('@genvy/shared').WorkspaceInfo | undefined)[],
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'g-recovered-card';

    const used = slots.filter((s): s is import('@genvy/shared').WorkspaceInfo => !!s);
    const saved = used.filter((c) => c.character || c.sheet);
    const drafts = used.filter((c) => !c.character && !c.sheet);

    // Title row: name left, icon stats right.
    const header = document.createElement('div');
    header.className = 'g-session-header';
    const title = document.createElement('div');
    title.className = 'g-session-title';
    title.textContent = saved[0]?.character?.name?.replace(/\s+V\d+$/i, '') ?? 'UNSAVED SESSION';
    const sub = document.createElement('div');
    sub.className = 'g-session-stats';
    const stat = (icon: string, n: number, tip: string) => {
      const el = document.createElement('span');
      el.className = 'g-stat';
      el.title = tip;
      el.innerHTML = `<span class="g-stat-icon">${icon}</span>${n}`;
      return el;
    };
    sub.append(
      stat('💾', saved.length, 'saved variants'),
      stat('⚒', drafts.length, 'unsaved drafts'),
      stat(
        '🎞',
        used.reduce((n, c) => n + c.files.filter((f) => f.endsWith('_sheet.png')).length, 0),
        'animation clips',
      ),
    );
    header.append(title, sub);

    const squares = document.createElement('div');
    squares.className = 'g-recover-squares';

    // Square 1: the 4-variant grid.
    const gridSq = document.createElement('div');
    gridSq.className = `g-recover-sq${session ? '' : ' empty'}`;
    gridSq.title = session ? 'OPEN VARIANT GRID' : 'VARIANT GRID DISCARDED';
    const icon = document.createElement('div');
    icon.className = 'g-grid-icon';
    for (let i = 0; i < 16; i++) icon.appendChild(document.createElement('span'));
    gridSq.appendChild(icon);
    if (session) {
      gridSq.addEventListener('mouseenter', () => UISound.play('hover'));
      gridSq.addEventListener('click', () => {
        UISound.play('click');
        this.closeCharDetail();
        this.onOpenRecovered?.(session.id);
      });
    }
    squares.appendChild(gridSq);

    // Squares 2-5: V1..V4.
    for (let i = 0; i < 4; i++) {
      const child = slots[i];
      const isSaved = !!child?.character || !!child?.sheet;
      const sq = document.createElement('div');
      sq.className = `g-recover-sq${child ? '' : ' empty'}${isSaved ? ' saved' : ''}`;
      if (child) {
        const img = document.createElement('img');
        img.src = `/library/files/${child.id}/variant.png`;
        sq.appendChild(img);
        sq.title = isSaved ? `OPEN ${child.character?.name ?? 'SAVED'}` : `RESUME V${i + 1}`;
      } else {
        sq.title = `V${i + 1} NOT STARTED`;
      }
      const tag = document.createElement('div');
      tag.className = 'g-variant-tag';
      tag.textContent = `V${i + 1}`;
      sq.appendChild(tag);
      sq.addEventListener('mouseenter', () => UISound.play('hover'));
      sq.addEventListener('click', () => {
        UISound.play('click');
        this.closeCharDetail();
        if (!child) {
          if (session) this.onOpenRecovered?.(session.id);
          return;
        }
        if (child.character) this.onOpenAsset?.(child.character);
        else if (child.sheet) this.onOpenAsset?.(child.sheet);
        else this.onOpenRecovered?.(child.id);
      });
      squares.appendChild(sq);
    }

    // Two-step delete for the whole session (assets cascade, then file dirs).
    let armed = false;
    const discard = document.createElement('genvy-button') as GenvyButton;
    discard.setAttribute('variant', 'danger');
    discard.setAttribute('label', 'DELETE CHARACTER');
    discard.onClick(() => {
      if (!armed) {
        armed = true;
        discard.setLabel('SURE? DELETES ALL VARIANTS');
        return;
      }
      // Confirmed: dismiss the widget immediately, delete in the background.
      this.closeCharDetail();
      void (async () => {
        try {
          for (const c of children) {
            if (c.character) await api.deleteAsset(c.character.id, { cascade: true });
            if (c.sheet) await api.deleteAsset(c.sheet.id, { cascade: true }).catch(() => {});
            await api.deleteOrphan(c.id).catch(() => {});
          }
          if (session) await api.deleteOrphan(session.id).catch(() => {});
          this.toast('CHARACTER DELETED', 'success');
        } catch {
          this.toast('DELETE FAILED', 'error');
        }
        await collection.refresh();
      })();
    });

    card.append(header, squares, discard);
    return card;
  }

  private toggleRecoveredActions(card: HTMLElement, id: string) {
    if (this.actionRowFor === id) {
      this.actionRow?.remove();
      this.actionRow = null;
      this.actionRowFor = null;
      return;
    }
    this.actionRow?.remove();
    const row = document.createElement('div');
    row.className = 'g-row g-card-actions';

    const resume = document.createElement('genvy-button') as GenvyButton;
    resume.setAttribute('label', 'RESUME');
    resume.onClick(() => this.onOpenRecovered?.(id));
    let armed = false;
    const discard = document.createElement('genvy-button') as GenvyButton;
    discard.setAttribute('variant', 'danger');
    discard.setAttribute('label', 'DISCARD');
    discard.onClick(() => {
      if (!armed) {
        armed = true;
        discard.setLabel('SURE?');
        return;
      }
      void (async () => {
        try {
          await api.deleteOrphan(id);
          this.toast('RECOVERED FILES DISCARDED', 'success');
        } catch {
          this.toast('DISCARD FAILED', 'error');
        }
        await collection.refresh();
      })();
    });
    row.append(resume, discard);
    card.after(row);
    this.actionRow = row;
    this.actionRowFor = id;
  }

  /** Expand OPEN / RENAME / DELETE under the clicked card. */
  private toggleActions(card: HTMLElement, entry: AssetIndexEntry) {
    if (this.actionRowFor === entry.id) {
      this.actionRow?.remove();
      this.actionRow = null;
      this.actionRowFor = null;
      return;
    }
    this.actionRow?.remove();

    const row = document.createElement('div');
    row.className = 'g-row g-card-actions';
    const mk = (label: string, variant: string, fn: () => void) => {
      const b = document.createElement('genvy-button') as GenvyButton;
      b.setAttribute('label', label);
      if (variant) b.setAttribute('variant', variant);
      b.onClick(fn);
      return b;
    };

    row.appendChild(mk('OPEN', '', () => this.onOpenAsset?.(entry)));
    row.appendChild(mk('RENAME', '', () => this.startRename(card, entry)));
    let armed = false;
    const del = mk('DELETE', 'danger', () => {
      if (!armed) {
        armed = true;
        del.setLabel('SURE?');
        return;
      }
      void (async () => {
        try {
          // Cascade: dependents (animations, characters using the sheet) go too.
          await api.deleteAsset(entry.id, { cascade: true });
          UISound.play('confirm');
          this.toast('ASSET & DEPENDENTS DELETED', 'success');
        } catch (err) {
          this.toast(err instanceof ApiError ? err.message.toUpperCase() : 'DELETE FAILED', 'error');
        }
        await collection.refresh();
      })();
    });
    row.appendChild(del);

    card.after(row);
    this.actionRow = row;
    this.actionRowFor = entry.id;
  }

  private startRename(card: HTMLElement, entry: AssetIndexEntry) {
    const nameEl = card.querySelector('.g-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = entry.name;
    input.className = 'g-rename';
    input.addEventListener('click', (e) => e.stopPropagation());
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = async (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== entry.name) {
        try {
          const asset = await api.getAsset(entry.id);
          await api.updateAsset(entry.id, { ...asset, name: value });
          UISound.play('confirm');
        } catch {
          this.toast('RENAME FAILED', 'error');
        }
      }
      await collection.refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void commit(true);
      if (e.key === 'Escape') void commit(false);
    });
    input.addEventListener('blur', () => void commit(true));
  }

  /** Loot-drop celebration: pop the newest card + chime. */
  async lootDrop() {
    UISound.play('loot');
    await collection.refresh();
    const first = this.drawerList?.firstElementChild as HTMLElement | null;
    if (first) void glowPop(first);
  }

  // ---------- Busy overlay ----------

  private busyEl: HTMLElement | null = null;

  /** Centered work indicator above the toast area — one at a time. */
  showBusy(label: string) {
    if (!this.busyEl) {
      this.busyEl = document.createElement('div');
      this.busyEl.id = 'genvy-busy';
      this.root.appendChild(this.busyEl);
    }
    this.busyEl.innerHTML = '';
    this.busyEl.append(forgeStatus(label), progressBar());
    this.busyEl.style.display = '';
  }

  hideBusy() {
    if (this.busyEl) this.busyEl.style.display = 'none';
  }

  // ---------- Toasts ----------

  toast(message: string, kind: 'info' | 'error' | 'success' = 'info') {
    // Only one toast at a time: drop any existing ones instantly, no exit animation.
    const host = document.getElementById('genvy-toasts')!;
    host.replaceChildren();
    const el = document.createElement('div');
    el.className = `g-toast ${kind === 'info' ? '' : kind}`;
    el.textContent = message;
    host.appendChild(el);
    if (kind === 'error') UISound.play('error');
    void slideIn(el, 'bottom');
    setTimeout(() => {
      if (el.isConnected) void slideOut(el, 'bottom').then(() => el.remove());
    }, 3600);
  }
}

export const HudShell = new HudShellImpl();
