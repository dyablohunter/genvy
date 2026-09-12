import {
  defineComponents,
  GenvyAssetCard,
  GenvyPanel,
  GenvyButton,
  forgeStatus,
  progressBar,
  escapeHtml,
  typeIcon,
} from './components.js';
import { slideIn, slideOut, glowPop } from './anim.js';
import { UISound } from './UISound.js';
import { collection } from '../state/collection.js';
import { expectedDuration, recordDuration } from './progress.js';
import { api, ApiError } from '../api/client.js';
import type { AssetIndexEntry } from '@genvy/shared';
import { getSubject } from '@genvy/shared';

/** The subject label of a forge session ("CHARACTER", "WEAPON", ...), if known. */
function subjectLabel(
  session: { subject?: string } | null,
  children: { subject?: string }[],
): string | null {
  const id = session?.subject ?? children.find((c) => c.subject)?.subject;
  return id ? getSubject(id).label.toUpperCase() : null;
}

/**
 * Character-family assets are reached through their session card's V-squares,
 * so only standalone asset types get their own row.
 */
const DRAWER_HIDDEN_TYPES = new Set(['animation', 'spritesheet', 'character']);

export type Dock = 'left' | 'right' | 'bottom' | 'center';

/** Lifecycle of one unit of work inside a busy operation. */
export type BusyStepState = 'pending' | 'active' | 'done' | 'failed';

/**
 * Logical creations, not raw index rows: a forged character's V1-V4 versions,
 * sheets, and animation clips all collapse into ONE asset; standalone types
 * (tilesets, worlds, ...) count individually.
 */
function logicalAssetCount(entries: AssetIndexEntry[]): number {
  const characterBases = new Set<string>();
  let others = 0;
  for (const e of entries) {
    if (e.type === 'character') {
      characterBases.add(e.name.replace(/\s+V\d+$/i, '').toLowerCase());
    } else if (e.type === 'spritesheet') {
      // "Name V2 — sheet" belongs to the same creation as "Name V2".
      characterBases.add(
        e.name.replace(/\s*—\s*sheet$/i, '').replace(/\s+V\d+$/i, '').toLowerCase(),
      );
    } else if (e.type !== 'animation') {
      others++;
    }
  }
  return characterBases.size + others;
}

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
  private spendEl!: HTMLElement;
  private invBtn!: HTMLElement;
  private drawerDismiss: ((ev: PointerEvent) => void) | null = null;
  private backBtn!: HTMLElement;
  private drawer: GenvyPanel | null = null;
  private drawerList: HTMLElement | null = null;
  private keyHintTimer: ReturnType<typeof setTimeout> | null = null;
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
      <div class="spend" title="Estimated API spend (from published pricing, not billing)"></div>
      <div class="spacer"></div>
      <div class="forge-count">ASSETS FORGED: 0</div>
      <div class="back-btn" style="display:none">◄ COMMAND CENTER</div>
      <div class="inv-btn" title="INVENTORY">▦ INVENTORY</div>
    `;
    this.root.appendChild(this.topbar);
    this.invBtn = this.topbar.querySelector('.inv-btn')!;
    this.invBtn.addEventListener('mouseenter', () => UISound.play('hover'));
    this.invBtn.addEventListener('click', () => {
      UISound.play('click');
      this.toggleDrawer();
    });
    this.statusEl = this.topbar.querySelector('.status')!;
    this.spendEl = this.topbar.querySelector('.spend')!;
    this.forgeCountEl = this.topbar.querySelector('.forge-count')!;
    // Estimated spend: refresh after every AI call plus a slow heartbeat.
    window.addEventListener('genvy-usage-changed', () => void this.refreshSpend());
    window.setInterval(() => void this.refreshSpend(), 60_000);
    void this.refreshSpend();
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

    // Selects have the same disease as buttons: focus lingers after a
    // choice, and then the ARROW keys keep changing the select while the
    // user thinks they are steering the dummy or aiming the triangle.
    document.addEventListener('change', (ev) => {
      if (ev.target instanceof HTMLSelectElement) ev.target.blur();
    });

    const toasts = document.createElement('div');
    toasts.id = 'genvy-toasts';
    this.root.appendChild(toasts);
    this.listenForAiWork();

    collection.subscribe((entries) => {
      this.forgeCountEl.textContent = `ASSETS FORGED: ${logicalAssetCount(entries)}`;
      // Assets changed, so the workspaces behind them may have too.
      this.workspaceCache = null;
      this.renderDrawer(entries);
    });
  }

  setStatus(text: string) {
    this.statusEl.textContent = text;
  }

  /** Center-header readout of per-API spend and reported balances. */
  async refreshSpend() {
    const LABELS: Record<string, string> = {
      deepseek: 'DEEPSEEK',
      openai: 'GPT-IMG',
      retrodiffusion: 'RETRO',
    };
    try {
      const u = await api.usage();
      const active = u.providers.filter((p) => p.calls > 0);
      const part = (text: string, cls: string) => {
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        return el;
      };
      const item = (...nodes: HTMLElement[]) => {
        const el = document.createElement('span');
        el.className = 'g-spend-item';
        el.append(...nodes);
        return el;
      };

      const items = active.map((p) =>
        item(
          part(LABELS[p.id] ?? p.id.toUpperCase(), 'k'),
          // "~" marks an estimate; providers reporting real figures drop it.
          part(`${p.exact ? '' : '~'}$${(p.cents / 100).toFixed(3)}`, 'v'),
          ...(p.balanceCents === undefined
            ? []
            : [
                part('LEFT', 'k'),
                part(
                  `$${(p.balanceCents / 100).toFixed(2)}`,
                  `v bal${p.balanceCents < 100 ? ' low' : ''}`,
                ),
              ]),
        ),
      );
      if (active.length > 1) {
        items.push(item(part('TOTAL', 'k'), part(`~$${(u.totalCents / 100).toFixed(3)}`, 'v total')));
      }
      this.spendEl.replaceChildren(...items);
      this.spendRetries = 0;
    } catch {
      // Server not up yet (dev-startup race): retry a few times, briefly,
      // instead of waiting for the 60s heartbeat.
      if (this.spendRetries < 5) {
        this.spendRetries++;
        setTimeout(() => void this.refreshSpend(), 1500);
      }
    }
  }

  private spendRetries = 0;

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

  private mountPanel(panel: GenvyPanel, delay = 0, animate = true) {
    const dock = (panel.dataset.dock ?? 'left') as Dock;
    if (dock === 'left') {
      this.dockLeft.appendChild(panel);
    } else if (dock === 'right') {
      this.dockRight.appendChild(panel);
    } else if (dock === 'center') {
      // Centered on the whole viewport: for a step that IS the screen.
      panel.style.position = 'absolute';
      panel.style.left = '50%';
      panel.style.top = '50%';
      panel.style.bottom = '';
      panel.style.right = '';
      panel.style.transform = 'translate(-50%, -50%)';
      panel.style.width = 'min(560px, 80vw)';
      this.root.appendChild(panel);
    } else {
      panel.style.position = 'absolute';
      panel.style.bottom = '12px';
      panel.style.left = '50%';
      panel.style.transform = 'translateX(-50%)';
      panel.style.minWidth = '420px';
      this.root.appendChild(panel);
    }
    if (animate) void slideIn(panel, dock === 'left' || dock === 'right' ? dock : 'bottom', delay);
  }

  /**
   * Mounts panels with staggered slide-in; replaces the previous layout.
   * Panels already hidden are mounted WITHOUT an entrance: a multi-step tool
   * hands over every step's panel at once, and animating them all would flash
   * each one for a frame before the current step hides the rest.
   */
  async setLayout(panels: GenvyPanel[]) {
    await this.clearLayout();
    this.layoutPanels = panels;
    let visibleIndex = 0;
    for (const panel of panels) {
      const hidden = panel.style.display === 'none';
      this.mountPanel(panel, hidden ? 0 : visibleIndex++ * 90, !hidden);
    }
  }

  /** Mount one more panel into the current layout (flows below its dock siblings). */
  addPanel(panel: GenvyPanel) {
    this.layoutPanels.push(panel);
    this.mountPanel(panel);
  }

  /** Show a panel in a specific dock, re-parenting and re-styling if needed. */
  showPanel(panel: GenvyPanel, dock: Dock) {
    // A panel revealed from hidden still deserves its entrance; without this
    // it would pop in, since the dock/parent may already be correct.
    const wasHidden = panel.style.display === 'none';
    panel.style.display = '';
    const parent = dock === 'left' ? this.dockLeft : dock === 'right' ? this.dockRight : this.root;
    if (wasHidden && panel.dataset.dock === dock && panel.parentElement === parent) {
      void slideIn(panel, dock === 'left' || dock === 'right' ? dock : 'bottom');
    }
    if (panel.dataset.dock !== dock || panel.parentElement !== parent) {
      panel.dataset.dock = dock;
      // Clear any placement the previous dock applied before taking the new one.
      panel.style.position = '';
      panel.style.top = '';
      panel.style.left = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.transform = '';
      panel.style.width = '';
      panel.style.minWidth = '';
      parent.appendChild(panel);
      if (dock === 'center' || dock === 'bottom') this.mountPanel(panel);
    }
    if (!this.layoutPanels.includes(panel)) this.layoutPanels.push(panel);
  }

  hidePanel(panel: GenvyPanel | null) {
    if (panel) panel.style.display = 'none';
  }

  async clearLayout() {
    // The detail card is mounted on the root, not in the layout, so a scene
    // change left it behind — hanging over the next module.
    this.closeCharDetail();
    this.actionRowFor = null;
    const panels = this.layoutPanels;
    this.layoutPanels = [];
    await Promise.all(
      panels.map((p, i) => {
        const dock = (p.dataset.dock ?? 'left') as Dock;
        const from = dock === 'left' || dock === 'right' ? dock : 'bottom';
        return slideOut(p, from, i * 50).then(() => p.remove());
      }),
    );
  }

  // ---------- Collection drawer ----------

  showDrawer() {
    if (this.drawer) return;
    const drawer = this.makePanel('INVENTORY', 'right');
    this.drawer = drawer;
    drawer.id = 'collection-drawer';
    this.root.appendChild(drawer);
    this.drawerList = document.createElement('div');
    this.drawerList.className = 'g-asset-list';
    drawer.bodyEl.appendChild(this.drawerList);
    this.renderDrawer(collection.entries);
    void slideIn(drawer, 'top');
    // Clicking anywhere outside the inventory (or its detail flyout) closes it.
    this.drawerDismiss = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (drawer.contains(t) || this.charDetail?.contains(t) || this.invBtn.contains(t)) return;
      this.hideDrawer();
    };
    setTimeout(() => {
      if (this.drawerDismiss) window.addEventListener('pointerdown', this.drawerDismiss, true);
    }, 0);
  }

  hideDrawer() {
    if (this.drawerDismiss) {
      window.removeEventListener('pointerdown', this.drawerDismiss, true);
      this.drawerDismiss = null;
    }
    this.closeCharDetail();
    if (!this.drawer) return;
    const d = this.drawer;
    this.drawer = null;
    this.drawerList = null;
    void slideOut(d, 'top').then(() => d.remove());
  }

  toggleDrawer() {
    if (this.drawer) this.hideDrawer();
    else this.showDrawer();
  }

  private actionRow: HTMLElement | null = null;
  private actionRowFor: string | null = null;
  /** Bumped on every drawer render so stale async appends can bail out. */
  private drawerRender = 0;
  /** Workspaces as last fetched; dropped whenever the collection changes. */
  private workspaceCache: import('@genvy/shared').WorkspaceInfo[] | null = null;

  private renderDrawer(entries: AssetIndexEntry[]) {
    if (!this.drawerList) return;
    const render = ++this.drawerRender;
    this.drawerList.innerHTML = '';
    this.actionRow = null;
    this.actionRowFor = null;
    this.closeCharDetail();

    // Characters render as a compact icon grid, filled asynchronously.
    const spritesHeading = document.createElement('div');
    spritesHeading.className = 'g-hint';
    spritesHeading.textContent = 'SPRITES';
    const gridHost = document.createElement('div');
    this.drawerList.append(spritesHeading, gridHost);
    void this.buildCharacterGrid(render, gridHost);

    const visible = entries.filter((e) => !DRAWER_HIDDEN_TYPES.has(e.type));
    if (visible.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'g-divider';
      const heading = document.createElement('div');
      heading.className = 'g-hint';
      // Name what is actually there. "OTHER ASSETS" was a category for
      // things we can list precisely.
      const kinds = [...new Set(visible.map((e) => e.type))];
      const LABELS: Record<string, string> = {
        level: 'LEVELS',
        world: 'LEVELS',
        scene: 'BACKDROPS',
        tileset: 'TILESETS',
      };
      const named = [...new Set(kinds.map((k) => LABELS[k] ?? `${k.toUpperCase()}S`))];
      heading.textContent = named.join(' · ');
      this.drawerList.append(divider, heading);
    }
    // Same shape as the characters above: a grid of square icons, with the
    // name and actions on click. A column of wide cards made five tilesets
    // fill the drawer and pushed everything else out of reach.
    const grid = document.createElement('div');
    grid.className = 'g-char-grid';
    for (const entry of visible.slice(0, 60)) {
      const icon = document.createElement('div');
      icon.className = 'g-char-icon';
      icon.title = `${entry.name} · ${entry.type.toUpperCase()}`;
      if (entry.thumbnail) {
        const img = document.createElement('img');
        img.src = `/library/files/${entry.thumbnail}`;
        icon.appendChild(img);
      } else {
        icon.innerHTML = `<div class="g-thumb-fallback">${typeIcon(entry.type)}</div>`;
      }
      icon.addEventListener('mouseenter', () => UISound.play('hover'));
      icon.addEventListener('click', () => {
        UISound.play('click');
        this.toggleActions(icon, entry);
      });
      grid.appendChild(icon);
    }
    this.drawerList.appendChild(grid);
  }

  /** Characters as a 5-column icon grid; clicking one opens its detail panel. */
  private async buildCharacterGrid(render: number, host: HTMLElement) {
    let workspaces: import('@genvy/shared').WorkspaceInfo[] = [];
    try {
      // Cached between opens: the drawer re-renders on every collection
      // change, and re-fetching the whole workspace list each time made
      // opening the inventory feel slower than it is.
      workspaces = this.workspaceCache ?? (await api.listWorkspaces());
      this.workspaceCache = workspaces;
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
      hint.textContent = 'NO SPRITES YET. FORGE ONE.';
      host.appendChild(hint);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'g-char-grid';
    for (const group of groups) {
      const slots = this.variantSlots(group.session, group.children);
      // The ICON is the first version — V1, or the only one when a session
      // produced a single anchor. Preferring "whichever slot has a saved
      // character" put a later version's art on the tile, and the NAME is a
      // separate question from the picture.
      const face = slots.find(Boolean);
      const named = slots.find((s) => s?.character) ?? face;
      const name = named?.character?.name?.replace(/\s+V\d+$/i, '') ?? 'UNSAVED';
      const icon = document.createElement('div');
      icon.className = `g-char-icon${named?.character ? ' saved' : ''}`;
      const kind = subjectLabel(group.session, group.children);
      icon.title = kind ? `${name} · ${kind}` : name;
      if (face) {
        const img = document.createElement('img');
        // Icons are ~70px on screen; a variant.png is ~550KB, and 33 of them
        // is 17MB fetched to draw postage stamps — which is why this grid
        // lagged while the level list, which has real 64px thumbnails, was
        // instant. So a small `icon.png` is cut once and reused.
        //
        // NOT `thumb.png`: in a workspace that has been through the sheet
        // pipeline that name already holds a thumbnail of the SHEET, and
        // using it put a strip of frames on the tile instead of a sprite.
        const hasIcon = face.files.includes('icon.png');
        img.src = `/library/files/${face.id}/${hasIcon ? 'icon.png' : 'variant.png'}`;
        img.loading = 'lazy';
        img.decoding = 'async';
        if (!hasIcon) {
          void api
            .makeThumbnail({
              assetId: face.id,
              sourceFile: 'variant.png',
              size: 96,
              outName: 'icon.png',
            })
            .catch(() => {
              // No icon cut this time; the full image is already showing.
            });
        }
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

    // Header: the name gets its own full-width line (no more truncation by
    // the stats), then the kind and each stat stack row by row beneath it.
    const header = document.createElement('div');
    header.className = 'g-session-header';
    const title = document.createElement('div');
    title.className = 'g-session-title';
    title.textContent = saved[0]?.character?.name?.replace(/\s+V\d+$/i, '') ?? 'UNSAVED SESSION';
    const sub = document.createElement('div');
    sub.className = 'g-session-stats';
    // Rows have horizontal room, so the label rides along instead of hiding
    // in a tooltip.
    const stat = (icon: string, n: number, label: string) => {
      const el = document.createElement('span');
      el.className = 'g-stat';
      el.innerHTML = `<span class="g-stat-icon">${icon}</span>${label.toUpperCase()}: ${n}`;
      return el;
    };
    const kind = subjectLabel(session, children);
    if (kind) {
      const chip = document.createElement('span');
      chip.className = 'g-stat';
      chip.title = 'what kind of sprite this is';
      chip.textContent = kind;
      sub.appendChild(chip);
    }
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
        this.hideDrawer();
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
        this.hideDrawer();
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
    discard.setAttribute('label', 'DELETE SPRITE');
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
          this.toast('SPRITE DELETED', 'success');
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
    resume.onClick(() => {
      this.hideDrawer();
      this.onOpenRecovered?.(id);
    });
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
    this.actionRow = row;
    this.actionRowFor = id;
  }

  /** Expand OPEN / RENAME / DELETE under the clicked card. */
  /**
   * Open an asset's detail beside the inventory, the way a character's does.
   * The actions used to append a title and a row INTO the list, which piled
   * up one stack of text per asset clicked and buried the grid.
   */
  private toggleActions(card: HTMLElement, entry: AssetIndexEntry) {
    if (this.actionRowFor === entry.id) {
      this.closeCharDetail();
      this.actionRowFor = null;
      return;
    }
    this.closeCharDetail();

    const detail = this.makePanel(entry.type.toUpperCase(), 'right');
    detail.id = 'genvy-char-detail';

    const name = document.createElement('div');
    name.className = 'g-detail-name';
    name.textContent = entry.name;

    const preview = document.createElement('div');
    preview.className = 'g-detail-preview';
    if (entry.thumbnail) {
      const img = document.createElement('img');
      // Show the 64px icon at once — it is already cached — then swap in a
      // preview cut for THIS panel's width. The icon blown up to 300px is
      // the blur; a 384px cut is sharp even on a HiDPI screen.
      img.src = `/library/files/${entry.thumbnail}`;
      preview.appendChild(img);
      void api
        .assetPreview(entry.id, 384)
        .then(({ preview: file }) => {
          if (this.actionRowFor === entry.id) img.src = `/library/files/${file}`;
        })
        .catch(() => {
          // No bigger source than the icon; the icon is already showing.
        });
    } else {
      preview.innerHTML = `<div class="g-thumb-fallback">${typeIcon(entry.type)}</div>`;
    }

    const mk = (label: string, variant: string, fn: () => void) => {
      const b = document.createElement('genvy-button') as GenvyButton;
      b.setAttribute('label', label);
      if (variant) b.setAttribute('variant', variant);
      b.onClick(fn);
      return b;
    };
    const open = mk('OPEN', 'accent', () => {
      this.closeCharDetail();
      this.hideDrawer();
      this.onOpenAsset?.(entry);
    });
    const rename = mk('RENAME', '', () => this.startRename(name, entry));
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
        this.closeCharDetail();
        await collection.refresh();
      })();
    });
    detail.append(name, preview, open, rename, del);

    const rect = card.getBoundingClientRect();
    detail.style.top = `${Math.min(rect.top, window.innerHeight - 320)}px`;
    this.root.appendChild(detail);
    this.charDetail = detail;
    this.actionRowFor = entry.id;
    void slideIn(detail, 'right');

    this.charDetailDismiss = (ev: PointerEvent) => {
      if (detail.contains(ev.target as Node)) return;
      this.closeCharDetail();
      this.actionRowFor = null;
    };
    setTimeout(() => {
      if (this.charDetailDismiss) window.addEventListener('pointerdown', this.charDetailDismiss);
    }, 0);
  }

  /**
   * Turn a name element into an input, in place. The caller passes the
   * element that shows the name — looking one up by class tied this to a
   * card layout that no longer exists.
   */
  private startRename(nameEl: HTMLElement, entry: AssetIndexEntry) {
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
      // Put the heading back, showing whatever the name now is, so the
      // panel does not sit there with a stray input in it.
      const restored = nameEl.cloneNode(false) as HTMLElement;
      restored.textContent = save && value ? value : entry.name;
      input.replaceWith(restored);
      await collection.refresh();
    };
    input.addEventListener('keydown', (e) => {
      // The drawer listens for keys too; a rename must not double as a
      // shortcut while it is being typed.
      e.stopPropagation();
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
  private busyRaf = 0;
  /** True while the bar is filling against an expected duration. */
  private busyDeterminate = false;
  /** Set when an AI request (not its call site) opened the indicator. */
  private busyAuto: { key: string; startedAt: number } | null = null;

  /**
   * Centered work indicator above the toast area — one at a time. With
   * `expectedMs`, the bar fills to 90% over that duration, then creeps
   * asymptotically toward 100% until hideBusy() snaps it full.
   */
  showBusy(label: string, expectedMs?: number) {
    if (!this.busyEl) {
      this.busyEl = document.createElement('div');
      this.busyEl.id = 'genvy-busy';
      this.root.appendChild(this.busyEl);
    }
    cancelAnimationFrame(this.busyRaf);
    this.busyEl.innerHTML = ''; // also clears any step chips from a prior run
    this.busyEl.append(forgeStatus(label), progressBar());
    this.busyEl.style.display = '';
    this.busyDeterminate = false;
    if (expectedMs && expectedMs > 0) this.driveBar(expectedMs);
  }

  /** Fill the bar to 90% over expectedMs, then creep toward 100%. */
  private driveBar(expectedMs: number, elapsedMs = 0) {
    const bar = this.busyEl?.querySelector('.g-progress .bar') as HTMLElement | null;
    if (!bar) return;
    cancelAnimationFrame(this.busyRaf);
    this.busyDeterminate = true;
    bar.style.animation = 'none'; // determinate mode: no scanner sweep
    bar.style.transform = 'none';
    bar.style.width = '0%';
    const start = performance.now() - elapsedMs;
    const tick = (now: number) => {
      const t = now - start;
      const pct =
        t <= expectedMs
          ? (t / expectedMs) * 90
          : 90 + 9.5 * (1 - Math.exp(-(t - expectedMs) / (expectedMs * 0.8)));
      bar.style.width = `${Math.min(99.5, pct).toFixed(2)}%`;
      this.busyRaf = requestAnimationFrame(tick);
    };
    this.busyRaf = requestAnimationFrame(tick);
  }

  /**
   * Every AI generation gets a determinate bar, whatever its call site did:
   * open the indicator if nothing is showing, or upgrade an indeterminate
   * scanner in place. See CLAUDE.md "Progress feedback".
   */
  private listenForAiWork() {
    window.addEventListener('genvy-ai-start', (ev) => {
      const { key, fallbackMs, label } = (ev as CustomEvent<{
        key: string;
        fallbackMs: number;
        label: string;
      }>).detail;
      const expected = expectedDuration(key, fallbackMs);
      const visible = !!this.busyEl && this.busyEl.style.display !== 'none';
      if (!visible) {
        this.showBusy(label, expected);
        this.busyAuto = { key, startedAt: Date.now() };
      } else if (!this.busyDeterminate) {
        this.driveBar(expected);
      }
    });
    window.addEventListener('genvy-ai-end', () => {
      if (!this.busyAuto) return;
      recordDuration(this.busyAuto.key, Date.now() - this.busyAuto.startedAt);
      this.busyAuto = null;
      this.hideBusy();
    });
  }

  /** Update the busy label mid-operation without resetting the progress bar. */
  setBusyLabel(text: string) {
    const status = this.busyEl?.querySelector('.g-forge-status');
    if (status) status.textContent = text;
  }

  /**
   * Server-truth progress: the bar lives inside the CURRENT step's band —
   * it jumps to just past the previous step's boundary, then creeps
   * asymptotically toward this step's boundary while the step runs, so it
   * always moves but can never claim work that hasn't happened. (The old
   * static pin froze for minutes inside a long local render.)
   */
  setBusyProgress(fraction: number, nextFraction: number) {
    const bar = this.busyEl?.querySelector('.g-progress .bar') as HTMLElement | null;
    if (!bar || !(nextFraction > 0)) return;
    cancelAnimationFrame(this.busyRaf); // the time-based estimate stops; truth drives now
    this.busyDeterminate = true;
    bar.style.animation = 'none';
    bar.style.transform = 'none';
    const floor = Math.max(2, fraction * 100 + 0.5);
    const ceiling = Math.min(99, nextFraction * 100 - 0.5);
    const current = parseFloat(bar.style.width) || 0;
    let pct = Math.max(floor, Math.min(Math.max(current, floor), ceiling));
    bar.style.width = `${pct.toFixed(1)}%`;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // Approach the step boundary with a ~45s time constant: visibly alive
      // on a minutes-long render, honest about not being done.
      pct += (ceiling - pct) * Math.min(1, dt / 45);
      bar.style.width = `${pct.toFixed(2)}%`;
      this.busyRaf = requestAnimationFrame(tick);
    };
    this.busyRaf = requestAnimationFrame(tick);
  }

  private busyCancelBtn: HTMLElement | null = null;

  /**
   * A red CANCEL above the busy card for abortable work (local renders).
   * Pass null to remove it; hideBusy clears it with the card.
   */
  setBusyCancel(onCancel: (() => void) | null) {
    if (!onCancel) {
      this.busyCancelBtn?.remove();
      this.busyCancelBtn = null;
      return;
    }
    if (!this.busyEl || this.busyCancelBtn) return;
    const btn = document.createElement('button');
    btn.className = 'g-busy-cancel';
    btn.textContent = '✕ CANCEL';
    btn.addEventListener('click', () => {
      UISound.play('click');
      btn.textContent = 'CANCELLING...';
      (btn as HTMLButtonElement).disabled = true;
      onCancel();
    });
    this.busyEl.appendChild(btn); // last thing on the card, below bar and chips
    this.busyCancelBtn = btn;
  }

  /**
   * Per-unit progress inside one operation: a row of square chips, one per
   * frame/anchor/step, each showing whether it is waiting, being worked on
   * (blinking), finished or failed. A long multi-part job then reads as
   * visible progress instead of one opaque wait (see the progress-feedback
   * skill).
   */
  setBusySteps(steps: { label: string; state?: BusyStepState }[]) {
    if (!this.busyEl) return;
    let row = this.busyEl.querySelector('.g-busy-steps');
    if (!row) {
      row = document.createElement('div');
      row.className = 'g-busy-steps';
      this.busyEl.appendChild(row);
      // The cancel button stays the LAST element on the card.
      if (this.busyCancelBtn) this.busyEl.appendChild(this.busyCancelBtn);
    }
    row.replaceChildren(
      ...steps.map((s) => {
        const chip = document.createElement('span');
        chip.className = `g-step ${s.state ?? 'pending'}`;
        chip.textContent = s.label;
        return chip;
      }),
    );
  }

  hideBusy() {
    cancelAnimationFrame(this.busyRaf);
    this.busyCancelBtn = null; // removed with the card's content
    const el = this.busyEl;
    if (!el) return;
    const bar = el.querySelector('.g-progress .bar') as HTMLElement | null;
    if (bar && bar.style.animation === 'none') {
      // Snap to 100%, let it register for a beat, then remove.
      bar.style.width = '100%';
      setTimeout(() => {
        // A newer showBusy() may have replaced the content meanwhile.
        if (el.contains(bar)) el.style.display = 'none';
      }, 160);
    } else {
      el.style.display = 'none';
    }
  }

  // ---------- Toasts ----------

  /**
   * A transient key-hint card over the middle-top of the stage: an
   * illustration of the keys plus one line saying what they do.
   *
   * Separate from toasts on purpose — a toast is news ("saved", "failed"),
   * this is a control the user is expected to reach for RIGHT NOW, so it sits
   * where their eyes already are and shows which key is currently chosen.
   *
   * Calling it again replaces the card and restarts its life, so holding an
   * arrow key keeps it up instead of flickering.
   */
  keyHint(html: string, message: string, ms = 3500) {
    let host = document.getElementById('genvy-keyhint');
    if (!host) {
      host = document.createElement('div');
      host.id = 'genvy-keyhint';
      host.style.pointerEvents = 'none';
      this.root.appendChild(host);
    }
    host.innerHTML = `<div class="g-keyhint-art">${html}</div><div class="g-keyhint-msg">${escapeHtml(message)}</div>`;
    host.classList.add('visible');
    if (this.keyHintTimer) clearTimeout(this.keyHintTimer);
    this.keyHintTimer = setTimeout(() => {
      host?.classList.remove('visible');
    }, ms);
  }

  /** Drop the key hint now (tool changed, mode changed, work finished). */
  hideKeyHint() {
    if (this.keyHintTimer) clearTimeout(this.keyHintTimer);
    this.keyHintTimer = null;
    document.getElementById('genvy-keyhint')?.classList.remove('visible');
  }

  toast(message: string, kind: 'info' | 'error' | 'success' | 'warn' = 'info') {
    // Only one toast at a time: drop any existing ones instantly, no exit animation.
    const host = document.getElementById('genvy-toasts')!;
    host.replaceChildren();
    const el = document.createElement('div');
    el.className = `g-toast ${kind === 'info' ? '' : kind}`;
    el.textContent = message;
    host.appendChild(el);
    if (kind === 'error') UISound.play('error');
    else if (kind === 'warn') UISound.play('warn');
    void slideIn(el, 'bottom');
    // Errors, warnings and long messages stay up long enough to actually read.
    const lifetime = Math.min(
      10000,
      Math.max(kind === 'error' || kind === 'warn' ? 6500 : 3600, message.length * 55),
    );
    setTimeout(() => {
      if (el.isConnected) void slideOut(el, 'bottom').then(() => el.remove());
    }, lifetime);
  }
}

export const HudShell = new HudShellImpl();
