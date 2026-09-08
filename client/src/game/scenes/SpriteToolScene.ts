import Phaser from 'phaser';
import type {
  CharacterConcept,
  Spritesheet,
  Character,
  AnimationAsset,
  SpriteBox,
  AssetIndexEntry,
  ImageProviderStatus,
} from '@genvy/shared';
import {
  newAssetId,
  SPRITE_SUBJECTS,
  DEFAULT_SUBJECT_ID,
  getSubject,
  mirrorView,
  deriveOp,
  stylePresets,
  styleGroups,
} from '@genvy/shared';
import { HudShell, type BusyStepState } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { expectedDuration, recordDuration } from '../../hud/progress.js';
import { goToScene, enterScene, registerAssetOpenHandlers } from '../../hud/transitions.js';
import { attachBackdrop } from '../backdrop.js';
import { api, fileUrl, ApiError } from '../../api/client.js';
import { collection } from '../../state/collection.js';
import { saveDraft, loadDraft, clearDraft } from '../../state/drafts.js';
import {
  field,
  textInput,
  textArea,
  autoGrow,
  rangeInput,
  GenvyButton,
  type GenvyPanel,
} from '../../hud/components.js';

// Pose, view and angle belong to the anchor chain now (neutral pose, canonical
// facing per subject) — the user describes WHO/WHAT, never how it is framed.
const DESCRIBE_PLACEHOLDER =
  'e.g. a tiny rocket-powered axolotl knight — describe looks, outfit, colors & vibe; pose and view are handled automatically';
const IMAGE_PROMPT_PLACEHOLDER =
  'visual appearance only — species/build, outfit, colors, materials, distinguishing details. ' +
  'No pose or camera angle (the forge sets those); this text also keeps the character consistent across animations';
const NOTES_PLACEHOLDER =
  "your motion & camera directions, e.g. 'side view facing right, big anticipation on frame 1, exaggerated squash on landing'";

interface SpriteToolData {
  assetId?: string;
  assetType?: string;
  recoveredId?: string;
}

const RESOLUTIONS = [32, 48, 64, 96, 128, 192, 256];

/** Frame-count presets with their grid layout on the 1536x1024 (3:2) canvas. */
const FRAME_PRESETS = [
  { n: 4, cols: 2, rows: 2 },
  { n: 6, cols: 3, rows: 2 },
  { n: 8, cols: 4, rows: 2 },
  { n: 12, cols: 4, rows: 3 },
];
const STRIP_ROW = 9999; // auto-slice column override that forces a single-row strip

/** Sprite Pipeline v2 anchor chain: east is a computed flip of west, never generated. */
const ANCHOR_DIRS = ['south', 'west', 'east', 'north'] as const;
type AnchorDir = (typeof ANCHOR_DIRS)[number];

/** Side-view locomotion prefers a side anchor; everything else the base view. */
function defaultDirFor(cat: string, primary: AnchorDir = 'south'): AnchorDir {
  return /walk|run|dash|slide|roll|climb|swim/.test(cat) ? 'west' : primary;
}

/**
 * A clip is identified by NAME + DIRECTION ("idle_west"), so the same
 * animation can exist once per facing instead of overwriting itself.
 */
const DIR_SUFFIX = /_(south|west|east|north)$/;

function baseName(cat: string): string {
  return cat.replace(DIR_SUFFIX, '');
}

function dirFromCat(cat: string): AnchorDir | null {
  const m = DIR_SUFFIX.exec(cat);
  return m ? (m[1] as AnchorDir) : null;
}

function clipName(name: string, dir: AnchorDir): string {
  return `${baseName(name)}_${dir}`;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** What kind of thing this sprite is — drives prompts, presets and anchors. */
function subjectSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  for (const s of SPRITE_SUBJECTS) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label.toUpperCase();
    sel.appendChild(opt);
  }
  sel.value = DEFAULT_SUBJECT_ID;
  return sel;
}

/**
 * StyleContract picker — DeepSeek proposes a preset in the concept, this lets
 * the user override it. The id drives prompt blocks AND the deterministic
 * postSteps (quantize/pixelSnap/outlineClean) at slice time.
 */
function styleSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  // Grouped: a flat list of ~20 styles is unreadable.
  for (const group of styleGroups) {
    const og = document.createElement('optgroup');
    og.label = group.label.toUpperCase();
    for (const id of group.ids) {
      const preset = stylePresets[id];
      if (!preset) continue;
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name.toUpperCase();
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  return sel;
}

function directionSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  for (const d of ANCHOR_DIRS) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d.toUpperCase();
    sel.appendChild(opt);
  }
  return sel;
}

const CLIP_RATES: Record<string, number> = {
  idle: 5, walk: 9, run: 12, jump: 8, fall: 8, land: 10,
  crouch: 8, climb: 8, swim: 8, dash: 14, roll: 14, slide: 12,
  attack: 12, attack2: 12, shoot: 12, cast: 10, block: 10,
  hurt: 8, death: 7, spawn: 8, victory: 7, taunt: 8,
};

function resolutionSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  // ORIGINAL first and default: never lose pixels on the way in — downscaling
  // is a free local re-slice at any time.
  const orig = document.createElement('option');
  orig.value = '0';
  orig.textContent = 'ORIGINAL';
  orig.selected = true;
  sel.appendChild(orig);
  for (const v of RESOLUTIONS) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = `${v} PX`;
    sel.appendChild(opt);
  }
  return sel;
}

/** One forged-and-kept animation strip (files live in its variant's workspace). */
interface Clip {
  wsId: string;
  cat: string;
  rate: number;
  count: number;
  sheetFile: string;
  rawFile: string;
  frameWidth: number;
  frameHeight: number;
  order: number[];
  /** One frame per rect group (union-masked); kept so re-slicing never re-prompts. */
  groups?: SpriteBox[][];
  /** Motion notes last used to forge this animation. */
  notes?: string;
  /** Anchor direction this clip was forged from (P2 anchor chain). */
  dir?: AnchorDir;
  /**
   * Removed frames kept as restorable ghosts (raw-image boxes). Persisted in
   * clips.json so ghosts survive edit-session switches and reloads.
   */
  removed?: { idx: number; box: SpriteBox }[];
  /** Frame indexes the validation gate flagged on the LAST forge (P3). */
  gateFails?: number[];
}

/**
 * Rasterize a freehand lasso polygon into thin horizontal rects (2px rows in
 * image coords) — these feed the same union-mask slicer as drawn rectangles.
 */
function polygonToRects(points: { x: number; y: number }[], step = 2): SpriteBox[] {
  if (points.length < 3) return [];
  const minY = Math.floor(Math.min(...points.map((p) => p.y)));
  const maxY = Math.ceil(Math.max(...points.map((p) => p.y)));
  const rects: SpriteBox[] = [];
  for (let y = minY; y < maxY; y += step) {
    const scan = y + step / 2;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a.y === b.y) continue;
      if (scan >= Math.min(a.y, b.y) && scan < Math.max(a.y, b.y)) {
        xs.push(a.x + ((scan - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x = Math.round(xs[i]!);
      const w = Math.round(xs[i + 1]! - xs[i]!);
      if (w >= 1) rects.push({ x, y, w, h: step });
    }
  }
  return rects;
}

/** One of the four generated variants: its own workspace, clips and saves. */
interface VariantWs {
  box: SpriteBox;
  wsId: string | null;
  kept: Clip[];
}

export class SpriteToolScene extends Phaser.Scene {
  /** Session dir: variants.png lives here. */
  private sessionId = '';
  /** True when sessionId belongs to an already-saved asset (opened from the collection). */
  private sessionIsSaved = false;
  /**
   * Concept + forge are only for a NEW sprite: anything opened from the
   * inventory works on what already exists.
   */
  private canForgeNew = true;
  private concept: CharacterConcept | null = null;
  private variants: VariantWs[] = [];
  private active = -1;
  private strip: Clip | null = null;
  /** Which directional anchors exist in the active workspace's file dir. */
  private anchors: Record<AnchorDir, boolean> = { south: false, west: false, east: false, north: false };
  /** Anchor currently shown on the stage (and highlighted in the grid). */
  private anchorView: AnchorDir = 'south';
  /** Bumped whenever an anchor file is written, to bust thumbnail caches. */
  private anchorStamp = 0;
  /**
   * Where each view turns from, normalized 0..1 of that anchor image — a
   * weapon's grip, a creature's feet. Rotation and the engine's sprite origin
   * both use it.
   */
  private pivots: Partial<Record<AnchorDir, { x: number; y: number }>> = {};
  /**
   * Previous drawings of each anchor, newest first (file names in the
   * workspace). Every re-forge snapshots what it is about to overwrite, so a
   * worse result is never a dead end — the modal lists them as thumbnails.
   */
  private anchorHistory: Partial<Record<AnchorDir, string[]>> = {};
  /** Click-to-place mode for the pivot marker on the stage. */
  private pivotMode = false;
  /** Opt in to all four views for a subject whose default set is smaller. */
  private allViews = false;
  /**
   * Views built from a base anchor that has since been regenerated. Free
   * derivations are rebuilt immediately; generated ones can only be flagged,
   * because rebuilding them costs money.
   */
  private staleViews = new Set<AnchorDir>();
  /** Variant indices whose anchor failed the lock gate (re-click = override). */
  private gateFailed = new Set<number>();
  /** Invalidates in-flight preview image loads so the last request wins. */
  private previewToken = 0;

  private previewImage: Phaser.GameObjects.Image | null = null;
  /** Centered re-forge popup (one at a time) + last notes used per view. */
  private anchorModal: HTMLElement | null = null;
  /** A modal stacked ABOVE another one — the modal beneath ignores Escape while it is open. */
  private stackedModal: HTMLElement | null = null;
  private anchorRegenNotes: Partial<Record<AnchorDir, string>> = {};
  /** Measured anchor body height per workspace+view+resolution (§C5). */
  private anchorBodyCache = new Map<string, number>();
  /** Active scroll-wheel zoom listener for the stage image (one at a time). */
  private zoomHandler:
    | ((p: Phaser.Input.Pointer, o: unknown, dx: number, dy: number) => void)
    | null = null;
  private overlayGfx: Phaser.GameObjects.Graphics | null = null;
  private pivotGfx: Phaser.GameObjects.Graphics | null = null;
  private hitZones: Phaser.GameObjects.Zone[] = [];
  private captionText: Phaser.GameObjects.Text | null = null;
  private labelLayer: HTMLDivElement | null = null;
  /** Image placement in WORLD space (camera-independent). */
  private worldGeom: { x0: number; y0: number; s: number; w: number; h: number } | null = null;
  /** Image placement in SCREEN space (recomputed on pan/zoom for the DOM). */
  private stripGeom: { x0: number; y0: number; s: number; w: number; h: number } | null = null;
  private stripGroups: SpriteBox[][] | null = null;
  private activeGroup = 0;
  /** Union boxes the CURRENT sheet was cut from (sheet frame k ↔ sheetBoxes[k]). */
  private sheetBoxes: SpriteBox[] = [];
  /** Each group's sheet-frame index (-1 when unknown). */
  private groupSheetIdx: number[] = [];
  /** Shape-level edits pending (as opposed to pure frame removals). */
  private shapesDirty = false;
  /** Selections changed since the last slice: hides reorder, demands RE-SLICE. */
  private selectionsDirty = false;
  /** Shape-editing mode: drawing/handles/delete active, reorder halves hidden. */
  private editMode = false;
  private modShift = false;
  private modPan = false;
  private keyDownHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
  private wheelHandler: ((e: WheelEvent) => void) | null = null;
  private repositionQueued = false;
  /** Snapshots of stripGroups for Ctrl+Z (newest last, capped). */
  private undoStack: SpriteBox[][][] = [];

  // form fields
  private describeIn = textArea('', DESCRIBE_PLACEHOLDER);
  private nameIn = textInput('', 'unnamed');
  private descIn = textArea('', 'description');
  private imagePromptIn = textArea('', IMAGE_PROMPT_PLACEHOLDER);
  private frameSizeSel = resolutionSelect();
  private animNameIn = textInput('idle', 'animation name');
  private subjectSel = subjectSelect();
  private styleSel = styleSelect();
  private dirSel = directionSelect();
  private dirField = field('DIRECTION (ANCHOR)', this.dirSel);
  private deriveClipBtn: GenvyButton | null = null;
  /** Live provider roster from /api/health (drives the two provider pickers). */
  private providers: ImageProviderStatus[] = [];
  private genProviderSel = document.createElement('select');
  private animProviderSel = document.createElement('select');
  // Model pickers for multi-model providers (local ComfyUI families) —
  // hidden while the chosen provider hosts only one model.
  private genModelSel = document.createElement('select');
  private animModelSel = document.createElement('select');
  private genModelField: HTMLElement | null = null;
  private animModelField: HTMLElement | null = null;
  // How many candidates a grid-incapable provider renders (each is a full
  // generation, so fewer = proportionally faster). Hidden for grid providers.
  private candidateCountSel = document.createElement('select');
  private candidateCountField: HTMLElement | null = null;
  // Render-canvas side for local generations: pure speed<->detail dial (the
  // sprite's OUTPUT size stays the RESOLUTION dropdown's job).
  private genSizeSel = document.createElement('select');
  private animSizeSel = document.createElement('select');
  private genSizeField: HTMLElement | null = null;
  private animSizeField: HTMLElement | null = null;
  /** Re-syncs the forge button's promised count after async provider loads. */
  private updateForgeLabel: (() => void) | null = null;
  // Quality tier for providers that price by it (gpt-image-2). LOW is the
  // default on purpose — the higher tiers cost 4x/15x per image.
  private genQualitySel = document.createElement('select');
  private genQualityField: HTMLElement | null = null;
  private framePreset = FRAME_PRESETS[2]!; // 8 · 4x2 default
  private notesIn = textArea('', NOTES_PLACEHOLDER);
  private styleIn = rangeInput(30, 0, 100);
  private creativityIn = rangeInput(60, 0, 100);
  private selectedClipCat: string | null = null;

  // panels
  private conceptPanel: GenvyPanel | null = null;
  private variantInfoPanel: GenvyPanel | null = null;
  /** Variants-stage mirrors of the concept text (own elements: one DOM home each). */
  private vName = textInput('', 'unnamed');
  private vLore = autoGrow(textArea('', 'description'));
  private vImagePrompt = autoGrow(textArea('', IMAGE_PROMPT_PLACEHOLDER));
  private blueprintPanel: GenvyPanel | null = null;
  private genConceptBtn: GenvyButton | null = null;
  private forgeVariantsBtn: GenvyButton | null = null;
  private anchorPanel: GenvyPanel | null = null;
  private anchorGrid: HTMLElement | null = null;
  private forgeViewsBtn: GenvyButton | null = null;
  private allViewsBtn: GenvyButton | null = null;
  private pivotBtn: GenvyButton | null = null;
  private anchorHint: HTMLElement | null = null;
  private animPanel: GenvyPanel | null = null;
  private previewPanel: GenvyPanel | null = null;
  private resliceBtn: GenvyButton | null = null;
  private editShapesBtn: GenvyButton | null = null;
  private saveBtn: GenvyButton | null = null;
  private exportBtn: GenvyButton | null = null;
  private clipListEl: HTMLElement | null = null;

  // preview animator
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewTimer = 0;

  constructor() {
    super('spriteTool');
  }

  create(data: SpriteToolData) {
    // Leaving the forge must never strand the page in scroll mode.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      document.body.classList.remove('g-page-scroll'),
    );
    enterScene(this);
    this.resetState();
    this.drawBackdrop();

    HudShell.setBackVisible(true);
    HudShell.setStatus('SPRITE FORGE');
    HudShell.hideDrawer();
    HudShell.onBackToHub = () => void goToScene(this, 'hub');
    registerAssetOpenHandlers(this);

    const fresh = !data?.recoveredId && !data?.assetId;
    // Stage only after the layout has mounted, or setLayout would re-dock the
    // panel this stage just centered.
    // Every step's panel is handed over at once, so hide them all up front and
    // let setStage reveal exactly one — otherwise each flashes for a frame
    // while the layout mounts.
    const wizard = [
      this.buildConceptPanel(),
      this.buildBlueprintPanel(),
      this.buildVariantInfoPanel(),
    ];
    for (const panel of wizard) HudShell.hidePanel(panel);
    void HudShell.setLayout(wizard).then(() => {
      if (fresh) {
        this.setStage('concept');
        // Everything AFTER the first forge persists server-side with the
        // session (concept.json); the one thing a crash could still eat is
        // the text typed BEFORE any session exists. Park it locally.
        this.restoreConceptDraft();
      }
    });
    void this.loadProviders();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.removeLabelLayer();
      window.clearInterval(this.previewTimer);
    });

    if (data?.recoveredId) {
      this.lockConceptControls();
      void this.loadRecovered(data.recoveredId);
    } else if (data?.assetId) {
      this.lockConceptControls();
      void this.loadExisting(data.assetId, data.assetType ?? '');
    }
  }

  private resetState() {
    this.sessionId = '';
    this.sessionIsSaved = false;
    this.canForgeNew = true;
    this.concept = null;
    this.variants = [];
    this.active = -1;
    this.strip = null;
    this.previewImage = null;
    this.overlayGfx = null;
    this.pivotGfx = null;
    this.hitZones = [];
    this.captionText = null;
    this.stripGeom = null;
    this.worldGeom = null;
    this.stripGroups = null;
    this.activeGroup = 0;
    this.sheetBoxes = [];
    this.groupSheetIdx = [];
    this.shapesDirty = false;
    this.selectionsDirty = false;
    this.editMode = false;
    this.detachReviewKeys();
    this.removeLabelLayer();
    // These fields hold anything from a line to a paragraph, so they size to
    // their content rather than scrolling inside a fixed box.
    this.describeIn = autoGrow(textArea('', DESCRIBE_PLACEHOLDER));
    this.describeIn.style.minHeight = '84px';
    this.nameIn = textInput('', 'unnamed');
    this.descIn = autoGrow(textArea('', 'description'));
    this.descIn.style.minHeight = '84px';
    this.imagePromptIn = autoGrow(textArea('', IMAGE_PROMPT_PLACEHOLDER));
    this.imagePromptIn.style.minHeight = '96px';
    this.frameSizeSel = resolutionSelect();
    this.animNameIn = textInput('idle', 'animation name');
    this.framePreset = FRAME_PRESETS[2]!;
    this.notesIn = textArea('', NOTES_PLACEHOLDER);
    this.styleIn = rangeInput(30, 0, 100);
    this.creativityIn = rangeInput(60, 0, 100);
    this.subjectSel = subjectSelect();
    this.styleSel = styleSelect();
    this.dirSel = directionSelect();
    this.dirField = field('DIRECTION (ANCHOR)', this.dirSel);
    this.deriveClipBtn = null;
    this.genProviderSel = document.createElement('select');
    this.animProviderSel = document.createElement('select');
    this.genModelSel = document.createElement('select');
    this.animModelSel = document.createElement('select');
    this.genModelField = null;
    this.animModelField = null;
    this.candidateCountSel = document.createElement('select');
    this.candidateCountField = null;
    this.genSizeSel = document.createElement('select');
    this.animSizeSel = document.createElement('select');
    this.genSizeField = null;
    this.animSizeField = null;
    this.genQualitySel = document.createElement('select');
    this.genQualityField = null;
    this.anchors = { south: false, west: false, east: false, north: false };
    this.anchorModal?.remove();
    this.anchorModal = null;
    this.anchorRegenNotes = {};
    this.anchorView = 'south';
    this.allViews = false;
    this.staleViews = new Set();
    this.pivots = {};
    this.anchorHistory = {};
    this.pivotMode = false;
    this.gateFailed = new Set();
    this.previewToken++;
    this.selectedClipCat = null;
    this.conceptPanel = null;
    this.blueprintPanel = null;
    this.variantInfoPanel = null;
    this.vName = textInput('', 'unnamed');
    this.vLore = autoGrow(textArea('', 'description'));
    this.vLore.style.minHeight = '84px';
    this.vImagePrompt = autoGrow(textArea('', IMAGE_PROMPT_PLACEHOLDER));
    this.vImagePrompt.style.minHeight = '96px';
    this.genConceptBtn = null;
    this.forgeVariantsBtn = null;
    this.anchorPanel = null;
    this.anchorGrid = null;
    this.forgeViewsBtn = null;
    this.allViewsBtn = null;
    this.pivotBtn = null;
    this.anchorHint = null;
    this.animPanel = null;
    this.previewPanel = null;
    this.resliceBtn = null;
    this.editShapesBtn = null;
    this.saveBtn = null;
    this.exportBtn = null;
    this.clipListEl = null;
    this.previewCanvas = null;
    window.clearInterval(this.previewTimer);
  }

  /** An existing sprite can be worked on, but never re-conceived. */
  private lockConceptControls() {
    this.canForgeNew = false;
    if (this.genConceptBtn) this.genConceptBtn.disabled = true;
    if (this.forgeVariantsBtn) this.forgeVariantsBtn.disabled = true;
  }

  /** The subject being made — decides prompts, presets and which views exist. */
  private subject() {
    return getSubject(this.subjectSel.value);
  }

  /** The effective StyleContract id: the concept's, else the picker's. */
  private styleId(): string {
    const raw = this.concept?.styleId;
    return raw && stylePresets[raw] ? raw : this.styleSel.value;
  }

  /** "CREATURE · PIXEL 8-BIT" — what this sprite is and how it is drawn. */
  private subjectStyleLabel(): string {
    const style = stylePresets[this.styleId()];
    return `${this.subject().label.toUpperCase()}${style ? ` · ${style.name.toUpperCase()}` : ''}`;
  }

  /** Reflect the concept's style in the picker; heal an unknown/missing id. */
  private syncStyleSel() {
    const raw = this.concept?.styleId;
    const id = raw && stylePresets[raw] ? raw : 'default';
    this.styleSel.value = id;
    if (this.concept && this.concept.styleId !== id) this.concept.styleId = id;
  }

  /**
   * Views worth having: the subject's own set, everything when the user opts
   * in, plus any view already on disk (so a session made under an older
   * default keeps showing its anchors).
   */
  private subjectViews(): AnchorDir[] {
    const own = this.subject().views as AnchorDir[];
    const wanted = this.allViews ? [...ANCHOR_DIRS] : own;
    const existing = ANCHOR_DIRS.filter((d) => this.anchors[d] && !wanted.includes(d));
    return [...wanted, ...existing];
  }

  private activeWs(): VariantWs | null {
    return this.variants[this.active] ?? null;
  }

  // ---------------- Providers (docs §A: per-step choice, live-gated) ----------------

  /** Read the provider roster once, then fill both pickers. */
  private async loadProviders() {
    try {
      this.providers = (await api.health()).ai.providers ?? [];
    } catch {
      this.providers = [];
    }
    this.fillProviderSelect(this.genProviderSel, (p) => p.capabilities.generate);
    // Multi-frame sheets need a real alpha channel: chroma-route providers
    // can't hold one background across N cells (a single frame that comes back
    // white breaks keying for the whole clip), so they stay on single images.
    this.fillProviderSelect(
      this.animProviderSel,
      (p) => (p.capabilities.edit && p.capabilities.nativeAlpha) || p.capabilities.animation,
    );
    this.refreshModelSelects();
  }

  /** 512 draft -> 1024 max; shared option set for both render-size selects. */
  private static fillSizeSelect(sel: HTMLSelectElement) {
    if (sel.options.length > 0) return;
    const labels: Record<number, string> = {
      512: '512 · DRAFT',
      640: '640 · BALANCED',
      768: '768 · QUALITY',
      1024: '1024 · MAX (SLOW)',
    };
    for (const n of [512, 640, 768, 1024]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = labels[n]!;
      if (n === 640) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  /** The chosen render size, only for providers that expose one (the local service). */
  private renderSizeFor(providerSel: HTMLSelectElement, sizeSel: HTMLSelectElement): number | undefined {
    const p = this.providers.find((x) => x.id === providerSel.value);
    return p?.models?.length ? Number(sizeSel.value) || undefined : undefined;
  }

  /**
   * ONE provider preference for the whole forge. The blueprint and animation
   * panels each show a select, but they are never both visible — and anchor
   * work reads the blueprint's. Letting them diverge meant a user who set
   * LOCAL on the visible panel had anchor edits billed to the hidden panel's
   * gpt-image-2. Mirroring a change into the other select (when it offers
   * that provider) keeps "what I picked" and "what runs" identical.
   */
  private syncProviderSelection(from: HTMLSelectElement, to: HTMLSelectElement) {
    const wanted = from.value;
    if (!wanted || to.value === wanted) return;
    const opt = Array.from(to.options).find((o) => o.value === wanted && !o.disabled);
    if (!opt) return; // that provider can't do the other panel's job — leave it
    to.value = wanted;
  }

  /** Model pickers track their provider pickers: shown only for multi-model providers. */
  private refreshModelSelects() {
    this.fillModelSelect(this.genModelSel, this.genModelField, this.genProviderSel);
    this.fillModelSelect(this.animModelSel, this.animModelField, this.animProviderSel);
    // Render size rides with the model field: same providers, same visibility.
    if (this.genSizeField) this.genSizeField.style.display = this.genModelField?.style.display ?? 'none';
    if (this.animSizeField) this.animSizeField.style.display = this.animModelField?.style.display ?? 'none';
    this.fillQualitySelect();
    // Candidate count applies only where candidates are rendered one by one
    // (capability, not provider id): grid providers always draw all four in
    // one call, so the choice would be a lie there.
    const gen = this.providers.find((x) => x.id === this.genProviderSel.value);
    const perCandidate = !!gen && gen.capabilities.gridSheets === false;
    if (this.candidateCountField) this.candidateCountField.style.display = perCandidate ? '' : 'none';
    this.updateForgeLabel?.();
  }

  /** Quality select tracks the gen provider: shown only when it prices by tier, LOW first and default. */
  private fillQualitySelect() {
    const p = this.providers.find((x) => x.id === this.genProviderSel.value);
    const levels = p?.capabilities.qualityLevels ?? [];
    if (this.genQualityField) this.genQualityField.style.display = levels.length > 0 ? '' : 'none';
    if (levels.length === 0) return;
    const previous = this.genQualitySel.value;
    this.genQualitySel.innerHTML = '';
    // Real published per-image prices at genvy's render sizes — the tiers
    // differ by 33x, so the picker states the cost instead of hinting at it.
    const labels: Record<string, string> = {
      low: 'LOW · $0.005',
      medium: 'MID · $0.041',
      high: 'HIGH · $0.165',
    };
    for (const l of levels) {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = labels[l] ?? l.toUpperCase();
      this.genQualitySel.appendChild(opt);
    }
    this.genQualitySel.value = (levels as string[]).includes(previous) ? previous : 'low';
  }

  /** The chosen quality tier, only when the gen provider actually prices by one. */
  private qualityFor(): 'low' | 'medium' | 'high' | undefined {
    const p = this.providers.find((x) => x.id === this.genProviderSel.value);
    if (!p?.capabilities.qualityLevels?.length) return undefined;
    return (this.genQualitySel.value as 'low' | 'medium' | 'high') || undefined;
  }

  /** Chosen candidate count (1-4), only when the provider renders per-candidate. */
  private candidateCount(): number | undefined {
    const p = this.providers.find((x) => x.id === this.genProviderSel.value);
    if (!p || p.capabilities.gridSheets !== false) return undefined;
    return Number(this.candidateCountSel.value) || undefined;
  }

  /**
   * Untested families are LISTED but DISABLED (like offline providers): the
   * roster is visible so the roadmap reads in the UI, and nothing unverified
   * can be picked until it has run on real hardware.
   */
  private fillModelSelect(
    sel: HTMLSelectElement,
    fieldEl: HTMLElement | null,
    providerSel: HTMLSelectElement,
  ) {
    const provider = this.providers.find((p) => p.id === providerSel.value);
    const show = !!provider?.models?.length;
    if (fieldEl) fieldEl.style.display = show ? '' : 'none';
    if (!show) return;
    const previous = sel.value;
    sel.innerHTML = '';
    // Families cover different jobs (Z-Image draws & animates, HiDream turns
    // anchors). A family is still selectable when it misses one — the route
    // hands that job to a family that has it — but the gap is named here so
    // "why did my pick not run this?" is answered in the picker itself.
    const SKILL: { workflow: string; tag: string }[] = [
      { workflow: 'animation-frame', tag: 'ANIM' },
      { workflow: 'anchor-directional', tag: 'TURNS' },
    ];
    for (const m of provider!.models!) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const missing = SKILL.filter((s) => !m.workflows.includes(s.workflow)).map((s) => s.tag);
      const tags = [
        ...(m.heavy ? ['VERY SLOW'] : []),
        ...(missing.length > 0 ? [`NO ${missing.join('/')}`] : []),
      ];
      opt.textContent = !m.verified
        ? `${m.label.toUpperCase()} · UNTESTED`
        : !m.available
          ? `${m.label.toUpperCase()} · MODELS MISSING`
          : tags.length > 0
            ? `${m.label.toUpperCase()} · ${tags.join(' · ')}`
            : m.label.toUpperCase();
      opt.disabled = !m.verified || !m.available;
      sel.appendChild(opt);
    }
    const usable = provider!.models!.filter((m) => m.verified && m.available);
    sel.value = usable.some((m) => m.id === previous) ? previous : usable[0]?.id ?? '';
  }

  /**
   * The model family to use for one operation: the picked model when it
   * supports that workflow, otherwise the first verified+available family
   * that does — local families split the jobs (Z-Image animates, HiDream
   * edits), and sending a job to a family that can't do it is a guaranteed
   * 502, not a choice.
   */
  private modelFamilyFor(
    providerSel: HTMLSelectElement,
    modelSel: HTMLSelectElement,
    workflow: 'anchor-generate' | 'anchor-directional' | 'animation-frame' | 'repair',
  ): string | undefined {
    const provider = this.providers.find((p) => p.id === providerSel.value);
    if (!provider?.models?.length) return undefined;
    const usable = provider.models.filter((m) => m.verified && m.available);
    const picked = usable.find((m) => m.id === modelSel.value);
    if (picked?.workflows.includes(workflow)) return picked.id;
    return usable.find((m) => m.workflows.includes(workflow))?.id ?? (modelSel.value || undefined);
  }

  /**
   * Offline providers stay listed but disabled, so a missing key reads as
   * "add the key" rather than "this doesn't exist".
   */
  private fillProviderSelect(sel: HTMLSelectElement, ok: (p: ImageProviderStatus) => boolean) {
    const previous = sel.value;
    sel.innerHTML = '';
    const usable = this.providers.filter(ok);
    for (const p of usable) {
      const opt = document.createElement('option');
      opt.value = p.id;
      // FREE is worth a label: it changes how expensive iteration feels.
      opt.textContent = !p.live
        ? `${p.name.toUpperCase()} · OFFLINE`
        : p.free
          ? `${p.name.toUpperCase()} · FREE`
          : p.name.toUpperCase();
      opt.disabled = !p.live;
      sel.appendChild(opt);
    }
    const live = usable.filter((p) => p.live);
    sel.value =
      previous && live.some((p) => p.id === previous)
        ? previous
        : (live.find((p) => p.id === 'openai') ?? live[0])?.id ?? '';
    sel.addEventListener('change', () => UISound.play('click'), { once: true });
  }

  /** True once this workspace has any anchor — i.e. it went through the v2 chain. */
  private hasAnyAnchor(): boolean {
    return this.subjectViews().some((d) => this.anchors[d]);
  }

  /**
   * Anchor-first (docs §C2): a direction can only be animated once its anchor
   * exists. Directions without one are listed but disabled, so the gap is
   * visible instead of silently falling back to a different pose.
   */
  private fillDirectionSelect() {
    const sel = this.dirSel;
    const previous = sel.value as AnchorDir;
    const gated = this.hasAnyAnchor();
    sel.innerHTML = '';
    for (const d of this.subjectViews()) {
      const ready = !gated || this.anchors[d];
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = ready ? d.toUpperCase() : `${d.toUpperCase()} · NO ANCHOR`;
      opt.disabled = !ready;
      sel.appendChild(opt);
    }
    sel.value = this.availableDir(previous || (this.subject().primaryView as AnchorDir));
  }

  /** The nearest usable direction: the wanted one, else south, else any anchor. */
  private availableDir(preferred: AnchorDir): AnchorDir {
    const views = this.subjectViews();
    if (!this.hasAnyAnchor() || (views.includes(preferred) && this.anchors[preferred])) return preferred;
    const primary = this.subject().primaryView as AnchorDir;
    if (this.anchors[primary]) return primary;
    return views.find((d) => this.anchors[d]) ?? primary;
  }

  /** Selected provider id, or undefined to let the server default. */
  private providerFor(sel: HTMLSelectElement): string | undefined {
    return sel.value || undefined;
  }

  /**
   * Anchor edits (directional, neutral reset) need a provider that can edit —
   * fall back to the server default when the chosen one only generates.
   */
  private editProvider(): string | undefined {
    return this.genProviderSel.value || undefined;
  }

  /**
   * Guard every anchor edit: the CHOSEN provider does the work or nothing
   * does. Silently falling back to the paid default spends money the user
   * never agreed to spend (it happened: local picks were billed to
   * gpt-image-2), so an incapable choice is an error, not a substitution.
   * Returns true when the caller may proceed.
   */
  private canEditHere(providerId?: string): boolean {
    const id = providerId ?? this.genProviderSel.value;
    const p = this.providers.find((x) => x.id === id);
    if (!p) return true; // nothing selected yet — the server default applies
    if (!p.live) {
      HudShell.toast(`${p.name.toUpperCase()} IS OFFLINE — PICK ANOTHER PROVIDER`, 'error');
      return false;
    }
    if (!p.capabilities.edit) {
      HudShell.toast(`${p.name.toUpperCase()} CANNOT EDIT ANCHORS — PICK ANOTHER PROVIDER`, 'error');
      return false;
    }
    if (
      p.models?.length &&
      !p.models.some((m) => m.verified && m.available && m.workflows.includes('anchor-directional'))
    ) {
      HudShell.toast(
        `NO LOCAL MODEL CAN TURN ANCHORS — INSTALL/ENABLE ONE (E.G. HIDREAM-O1) OR SWITCH PROVIDER`,
        'error',
      );
      return false;
    }
    // Last line of defence for the wallet: anchor work is driven by the
    // blueprint select, which is NOT on screen during the animation stage.
    // If that resolves to a paid provider while a free one is available,
    // say so out loud instead of quietly spending.
    if (!p.free && this.providers.some((x) => x.live && x.free && x.capabilities.edit)) {
      // A caution, not a failure: the edit IS allowed to run, it just costs.
      HudShell.toast(
        `USING PAID ${p.name.toUpperCase()} FOR THIS EDIT — SWITCH THE PROVIDER TO LOCAL TO KEEP IT FREE`,
        'warn',
      );
    }
    return true;
  }

  /**
   * The name a busy label should call this provider — stage text must say
   * what is working and whether it costs anything (see Progress feedback).
   * `undefined` means the server default, which is gpt-image-2.
   */
  private providerTag(id?: string, family?: string): string {
    const p = id ? this.providers.find((x) => x.id === id) : undefined;
    if (!p || p.id === 'openai') return 'GPT-IMAGE-2';
    // Name the MODEL that will actually run, not just the provider — the
    // family can differ from the picker's selection (capability routing).
    const model = family ? p.models?.find((m) => m.id === family) : undefined;
    const name = model ? model.label.toUpperCase() : p.name.toUpperCase();
    return p.free ? `${name} (FREE)` : name;
  }

  private drawBackdrop() {
    attachBackdrop(this, 'SPRITE FORGE');
  }

  // ---------------- Stage 1: concept + variants ----------------

  /** Maps the two sliders to art-direction text appended to image prompts. */
  private styleHint(): string {
    const s = Number(this.styleIn.value);
    const c = Number(this.creativityIn.value);
    const style =
      s < 20 ? 'flat, bold, highly stylized cartoon with simple shapes'
      : s < 40 ? 'stylized 2D game art with clean lines'
      : s < 60 ? 'semi-stylized with balanced detail'
      : s < 80 ? 'detailed painterly, semi-realistic rendering'
      : 'highly detailed realistic rendering with lifelike materials and lighting';
    const creativity =
      c < 25 ? 'stay strictly faithful to the description'
      : c < 60 ? 'modest creative interpretation of the description'
      : c < 85 ? 'take creative liberties with the details'
      : 'take bold creative liberties and add surprising, imaginative details';
    return `${style}; ${creativity}`;
  }

  /** Step 1: describe + GENERATE CONCEPT, kept apart from the blueprint fields. */
  private buildConceptPanel() {
    const panel = HudShell.makePanel('01 · CONCEPT', 'left');
    this.conceptPanel = panel;
    const prompt = this.describeIn;
    const genBtn = document.createElement('genvy-button') as GenvyButton;
    genBtn.setAttribute('label', 'GENERATE CONCEPT');
    this.genConceptBtn = genBtn;

    // Manual mode: skip DeepSeek entirely — the user writes name, lore and
    // image prompt themselves in the blueprint. Free, instant, no AI call.
    const manualBtn = document.createElement('genvy-button') as GenvyButton;
    manualBtn.setAttribute('label', 'MANUAL EDIT');
    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    for (const b of [genBtn, manualBtn]) {
      b.style.flex = '1 1 50%';
      b.style.minWidth = '0';
    }
    btnRow.append(genBtn, manualBtn);

    // Style is decided HERE, before the concept: the writer must know it, or
    // it invents its own art direction in the image prompt and fights the
    // style contract chosen later.
    panel.append(
      field('WHAT ARE YOU MAKING?', this.subjectSel),
      field('ART STYLE', this.styleSel),
      field('DESCRIBE YOUR SPRITE', prompt),
      field('CREATIVITY · FAITHFUL ◄─► WILD', this.creativityIn),
      btnRow,
    );

    manualBtn.onClick(() => {
      if (!this.canForgeNew) {
        return HudShell.toast('OPEN SPRITE FORGE FROM THE HUB TO CREATE A NEW SPRITE', 'error');
      }
      UISound.play('click');
      // No DeepSeek call — but PRESERVE whatever is already written: coming
      // back from the blueprint and clicking MANUAL EDIT again must never
      // wipe the name/lore the user typed. Only the empty image prompt gets
      // seeded from the description, so typed work is never thrown away.
      if (prompt.value.trim() && !this.imagePromptIn.value.trim()) {
        this.imagePromptIn.value = prompt.value.trim();
      }
      autoGrow.refresh(this.descIn);
      autoGrow.refresh(this.imagePromptIn);
      if (this.sessionId) this.persistConcept(this.sessionId);
      this.setStage('blueprint');
      HudShell.toast('MANUAL MODE — WRITE NAME, LORE & IMAGE PROMPT, THEN FORGE', 'success');
    });

    genBtn.onClick(async () => {
      if (!this.canForgeNew) {
        return HudShell.toast('OPEN SPRITE FORGE FROM THE HUB TO CREATE A NEW SPRITE', 'error');
      }
      if (!prompt.value.trim()) return HudShell.toast('DESCRIBE THE SPRITE FIRST', 'error');
      await this.busy('CONSULTING THE DESIGN CORE...', async () => {
        UISound.play('generate');
        HudShell.setBusyLabel('DEEPSEEK · WRITING NAME, LORE, IMAGE PROMPT & ANIMATION PLAN...');
        const subject = getSubject(this.subjectSel.value);
        const style = stylePresets[this.styleSel.value];
        const res = await api.aiText<CharacterConcept>({
          tool: 'sprite',
          prompt: prompt.value,
          schemaName: 'characterConcept',
          temperature: (Number(this.creativityIn.value) / 100) * 1.5,
          context: {
            subject: subject.id,
            subjectLabel: subject.label,
            neutralAnchor: subject.anchorPose,
            animationSlots: subject.animations,
            // The chosen style, for awareness only — the writer must not put
            // style language into imagePrompt.
            styleId: style?.id,
            styleName: style?.name,
          },
        });
        this.concept = res.result;
        // The user's pick always wins over whatever the writer echoed back.
        this.concept.styleId = this.styleSel.value;
        this.nameIn.value = this.concept.name;
        this.descIn.value = this.concept.description;
        this.imagePromptIn.value = this.concept.imagePrompt;
        autoGrow.refresh(this.descIn);
        autoGrow.refresh(this.imagePromptIn);
        this.syncStyleSel();
        if (this.sessionId) this.persistConcept(this.sessionId);
        UISound.play('confirm');
        this.setStage('blueprint');
        HudShell.toast(`CONCEPT ACQUIRED: ${this.concept.name.toUpperCase()} — REVIEW & FORGE`, 'success');
      }, { key: 'concept', fallbackMs: 14000 });
    });

    return panel;
  }

  /** Step 2: the editable character blueprint + the credit-spending forge. */
  private buildBlueprintPanel() {
    const panel = HudShell.makePanel('02 · BLUEPRINT', 'left');
    this.blueprintPanel = panel;
    const backBtn = document.createElement('genvy-button') as GenvyButton;
    backBtn.setAttribute('label', '◄ BACK TO CONCEPT');
    backBtn.onClick(() => {
      UISound.play('click');
      this.setStage('concept');
    });
    const forgeBtn = document.createElement('genvy-button') as GenvyButton;
    forgeBtn.setAttribute('variant', 'accent');
    forgeBtn.setAttribute('label', 'FORGE 4 VARIANTS');
    // The button promises a count — keep it honest with the CANDIDATES pick
    // (and reset when the provider switches to a fixed-grid one).
    const updateForgeLabel = () => {
      const n = this.candidateCount() ?? 4;
      // Cost preview on the button itself (progress-feedback skill): tiers
      // differ 33x and a grid provider bills ONE call for all candidates,
      // while per-candidate providers bill each one. Free providers say FREE.
      const provider = this.providers.find((x) => x.id === this.genProviderSel.value);
      const perImage = { low: 0.005, medium: 0.041, high: 0.165 }[this.qualityFor() ?? 'low'] ?? 0;
      const calls = provider?.capabilities.gridSheets === false ? n : 1;
      const cost = provider?.free ? 'FREE' : perImage ? `$${(perImage * calls).toFixed(3)}` : '';
      // setLabel, not setAttribute: GenvyButton reads the label attribute
      // only at mount — attribute writes after that are silently ignored.
      forgeBtn.setLabel(
        `FORGE ${n} VARIANT${n > 1 ? 'S' : ''}${cost ? ` · ${cost}` : ''}`,
      );
    };
    this.candidateCountSel.addEventListener('change', updateForgeLabel);
    this.genProviderSel.addEventListener('change', updateForgeLabel);
    this.genModelSel.addEventListener('change', updateForgeLabel);
    this.genQualitySel.addEventListener('change', updateForgeLabel);
    this.updateForgeLabel = updateForgeLabel;
    this.forgeVariantsBtn = forgeBtn;

    // Blueprint text is the character's source of truth — persist it the
    // moment it changes (when a session exists on disk), not only when a
    // forge happens to run; manually written name/lore was silently lost
    // before the first forge otherwise.
    for (const el of [this.nameIn, this.descIn, this.imagePromptIn]) {
      el.addEventListener('change', () => {
        if (this.sessionId) this.persistConcept(this.sessionId);
      });
    }

    panel.append(
      backBtn,
      field('NAME', this.nameIn),
      field('LORE', this.descIn),
      field('IMAGE PROMPT', this.imagePromptIn),
      field('STYLE · STYLIZED ◄─► REALISTIC', this.styleIn),
      (() => {
        // Provider + quality share the line 50/50; quality hides for
        // providers without tiers and the provider takes the full width.
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '8px';
        const providerField = field('PROVIDER', this.genProviderSel);
        this.genQualityField = field('QUALITY', this.genQualitySel);
        for (const f of [providerField, this.genQualityField]) {
          f.style.flex = '1 1 50%';
          f.style.minWidth = '0';
        }
        this.genQualityField.style.display = 'none';
        row.append(providerField, this.genQualityField);
        return row;
      })(),
      (this.genModelField = field('LOCAL MODEL', this.genModelSel)),
      (() => {
        // Render size + candidates share one line, 50/50; each keeps its own
        // visibility (RD shows candidates but no size), and a lone visible
        // field simply takes the full width.
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '8px';
        this.genSizeField = field('RENDER SIZE', this.genSizeSel);
        this.candidateCountField = field('CANDIDATES', this.candidateCountSel);
        for (const f of [this.genSizeField, this.candidateCountField]) {
          f.style.flex = '1 1 50%';
          f.style.minWidth = '0';
        }
        row.append(this.genSizeField, this.candidateCountField);
        return row;
      })(),
      forgeBtn,
    );
    this.genModelField.style.display = 'none';
    this.genSizeField!.style.display = 'none';
    this.candidateCountField!.style.display = 'none';
    SpriteToolScene.fillSizeSelect(this.genSizeSel);
    if (this.candidateCountSel.options.length === 0) {
      // Fastest first and default: on a local GPU each candidate is a full
      // generation, so 1 is the sane starting point.
      for (const n of [1, 2, 3, 4]) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = n === 1 ? '1 · FASTEST' : n === 4 ? '4 · FULL SET' : String(n);
        this.candidateCountSel.appendChild(opt);
      }
    }
    this.genProviderSel.addEventListener('change', () => {
      this.syncProviderSelection(this.genProviderSel, this.animProviderSel);
      this.syncProviderSelection(this.genModelSel, this.animModelSel);
      this.refreshModelSelects();
    });

    // The concept proposes a style; the pick here overrides it everywhere —
    // prompt blocks and the deterministic postSteps at slice time.
    this.styleSel.addEventListener('change', () => {
      UISound.play('click');
      if (this.concept) {
        this.concept.styleId = this.styleSel.value;
        if (this.sessionId) this.persistConcept(this.sessionId);
      }
    });

    forgeBtn.onClick(async () => {
      if (!this.canForgeNew) {
        return HudShell.toast('OPEN SPRITE FORGE FROM THE HUB TO CREATE A NEW SPRITE', 'error');
      }
      const appearance = this.imagePromptIn.value.trim();
      if (!appearance) return HudShell.toast('GENERATE OR WRITE AN IMAGE PROMPT FIRST', 'error');
      const count = this.candidateCount() ?? 4;
      // Per-candidate providers get a chip per candidate (like the animation
      // forge's DRAW/GATE/SLICE row): each V lights up as the server's
      // activity feed reports it rendering, then lands green.
      const perCandidate = this.candidateCount() !== undefined;
      const chips: { label: string; state: BusyStepState }[] = perCandidate
        ? [
            ...Array.from({ length: count }, (_, i) => ({
              label: `V${i + 1}`,
              state: (i === 0 ? 'active' : 'pending') as BusyStepState,
            })),
            { label: 'DETECT', state: 'pending' as BusyStepState },
          ]
        : [];
      await this.busy(`FORGING ${count} VARIANT${count > 1 ? 'S' : ''} · THIS TAKES A MINUTE...`, async () => {
        UISound.play('generate');
        HudShell.setBusyLabel(
          `${this.providerTag(this.providerFor(this.genProviderSel), this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-generate'))} · DRAWING ${count} NEUTRAL SOUTH-ANCHOR CANDIDATE${count > 1 ? 'S' : ''}...`,
        );
        if (chips.length > 0) HudShell.setBusySteps(chips);
        // Never write into an opened asset's folder — that work would be
        // invisible to the collection. Forging from a saved asset starts fresh.
        // v2 anchor chain: the candidates are neutral SOUTH anchors of the
        // same design (pipeline v2 §C2.1) — the pick becomes the identity anchor.
        const res = await api.aiImage({
          prompt: appearance,
          orientation: 'portrait',
          kind: 'anchor',
          assetId: this.sessionIsSaved ? undefined : this.sessionId || undefined,
          outName: 'variants.png',
          styleHint: this.styleHint(),
          styleId: this.styleId(),
          characterName: this.nameIn.value.trim() || this.concept?.name,
          provider: this.providerFor(this.genProviderSel),
          modelFamily: this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-generate'),
          quality: this.qualityFor(),
          variantCount: this.candidateCount(),
          renderSize: this.renderSizeFor(this.genProviderSel, this.genSizeSel),
          subject: this.subjectSel.value,
        });
        this.sessionId = res.assetId;
        this.sessionIsSaved = false;
        this.gateFailed.clear();
        this.persistConcept(this.sessionId);
        if (chips.length > 0) {
          for (let i = 0; i < count; i++) chips[i]!.state = 'done';
          chips[count]!.state = 'active';
          HudShell.setBusySteps(chips);
        }
        HudShell.setBusyLabel(`DETECTING THE CANDIDATE${count > 1 ? 'S' : ''}...`);
        const det = await api.detect({ assetId: this.sessionId, sourceFile: 'variants.png' });
        if (chips.length > 0) {
          chips[count]!.state = 'done';
          HudShell.setBusySteps(chips);
        }
        this.variants = det.boxes.map((box) => ({ box, wsId: null, kept: [] }));
        this.active = -1;
        this.setStage('variants');
        await this.showVariantPicker();
        // The session (variants.png + concept.json) is already on disk; refresh
        // so it shows up in the inventory without waiting for a save.
        await collection.refresh();
        UISound.play('complete');
        HudShell.toast(
          count > 1
            ? `SAVED TO INVENTORY — PICK A VARIANT (V1–V${count}) TO START ANIMATING`
            : 'SAVED TO INVENTORY — PICK V1 TO START ANIMATING',
          'success',
        );
      }, {
        // Per provider AND count: one gpt-image-2 grid call vs N composed
        // local renders differ by an order of magnitude — never share averages.
        key: `anchor:candidates:${this.genProviderSel.value || 'openai'}:${count}:${this.renderSizeFor(this.genProviderSel, this.genSizeSel) ?? 'std'}`,
        fallbackMs: 12000 * count,
      }, {
        // The server's op layer says which candidate is rendering — light
        // the chips from truth, not from guesses.
        onActivity: (a) => {
          if (chips.length === 0 || !a.step || a.steps !== count) return;
          for (let i = 0; i < count; i++) {
            chips[i]!.state = i < a.step - 1 ? 'done' : i === a.step - 1 ? 'active' : 'pending';
          }
          HudShell.setBusySteps(chips);
        },
      });
    });

    return panel;
  }

  /**
   * Variants stage: the four candidates fill the stage as large as the free
   * space allows (only the concept/blueprint dock is open), each clickable.
   */
  private async showVariantPicker() {
    if (this.variants.length === 0) return;
    const key = this.textureKey('variants.png');
    await this.loadTexture(key, `${fileUrl(`${this.sessionId}/variants.png`)}?t=${Date.now()}`);
    this.clearStage();

    // The blueprint panel is docked left here, so the candidates get the space
    // beside it — minus the top bar and the caption band at the bottom.
    const { width, height } = this.scale;
    const TOP = 86;
    const CAPTION_BAND = 64;
    const LEFT_DOCK = 340; // blueprint panel + gutter
    const availW = Math.max(240, width - LEFT_DOCK - 80);
    const availH = Math.max(160, height - TOP - CAPTION_BAND);
    const img = this.add.image(LEFT_DOCK + availW / 2, TOP + availH / 2, key);
    // Fit the stage but never inflate past 1:1 — upscaling is what blurs.
    const s = Math.min(availH / img.height, availW / img.width, 1);
    img.setScale(s);
    this.previewImage = img;

    const x0 = img.x - img.displayWidth / 2;
    const y0 = img.y - img.displayHeight / 2;
    const g = this.add.graphics();
    this.overlayGfx = g;

    const drawOutline = (i: number, hot: boolean) => {
      const b = this.variants[i]!.box;
      g.lineStyle(hot ? 3 : 1, hot ? 0xff9d1d : 0x1de9ff, hot ? 1 : 0.55);
      g.strokeRect(x0 + b.x * s, y0 + b.y * s, b.w * s, b.h * s);
    };

    this.variants.forEach((v, i) => {
      const b = v.box;
      drawOutline(i, i === this.active);
      const label = this.add.text(x0 + b.x * s + 6, y0 + b.y * s + 6, `V${i + 1}`, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: `${Math.max(13, Math.round(16 * s))}px`,
        color: i === this.active ? '#ff9d1d' : '#1de9ff',
        backgroundColor: '#00000099',
        padding: { x: 6, y: 3 },
      });
      this.hitZones.push(label as unknown as Phaser.GameObjects.Zone);

      const zone = this.add
        .zone(x0 + (b.x + b.w / 2) * s, y0 + (b.y + b.h / 2) * s, b.w * s, b.h * s)
        .setInteractive({ useHandCursor: true });
      zone.on('pointerover', () => {
        UISound.play('hover');
        drawOutline(i, true);
      });
      zone.on('pointerout', () => {
        g.clear();
        this.variants.forEach((_, k) => drawOutline(k, k === this.active));
      });
      zone.on('pointerdown', () => void this.selectVariant(i));
      this.hitZones.push(zone);
    });

    // Both caption lines live inside the reserved band, never off-screen.
    const captionY = Math.min(height - CAPTION_BAND + 16, y0 + img.displayHeight + 18);
    this.captionText = this.add
      .text(img.x, captionY, `${this.subjectStyleLabel()} — CLICK A VARIANT TO LOCK IT IN`, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '12px',
        color: '#12475c',
      })
      .setOrigin(0.5);

    // A new sprite can go back and re-forge; an opened one has no concept step.
    if (this.canForgeNew) {
      const back = this.add
        .text(img.x, captionY + 22, '◄ EDIT PROMPT & RE-FORGE', {
          fontFamily: '"Orbitron", sans-serif',
          fontSize: '11px',
          color: '#1de9ff',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      back.on('pointerover', () => {
        UISound.play('hover');
        back.setColor('#ff9d1d');
      });
      back.on('pointerout', () => back.setColor('#1de9ff'));
      back.on('pointerdown', () => {
        UISound.play('click');
        this.clearStage();
        this.setStage('blueprint');
      });
      this.hitZones.push(back as unknown as Phaser.GameObjects.Zone);
    }
  }

  private async selectVariant(index: number) {
    const ws = this.variants[index];
    if (!ws) return;
    await this.busy(`LOCKING IN V${index + 1}...`, async () => {
      if (!ws.wsId) {
        ws.wsId = newAssetId('spritesheet');
        await api.crop({
          assetId: ws.wsId,
          sourceAssetId: this.sessionId,
          sourceFile: 'variants.png',
          box: ws.box,
          outName: 'variant.png',
          variantIndex: index,
        });
        // South anchor = the same pick, padded so the lock gate can verify real
        // margins. The padding must never reach a neighbouring candidate, or
        // its sliver lands in the crop and reads as a cut-off figure.
        await api.crop({
          assetId: ws.wsId,
          sourceAssetId: this.sessionId,
          sourceFile: 'variants.png',
          box: ws.box,
          outName: this.anchorFile(this.subject().primaryView as AnchorDir),
          variantIndex: index,
          pad: this.safePad(index),
        });
        this.persistConcept(ws.wsId);
        // Free views (mirror/rotate) land immediately — nothing to ask for.
        await this.deriveFreeViews(ws.wsId);
        // Anchor lock gate (BLOCKING): a weak anchor poisons every animation.
        const gate = await api.anchorGate({
          assetId: ws.wsId,
          sourceFile: this.anchorFile(this.subject().primaryView as AnchorDir),
        });
        if (!gate.pass && !this.gateFailed.has(index)) {
          this.gateFailed.add(index);
          const reasons = gate.checks.filter((c) => !c.pass).map((c) => c.detail).join(' · ');
          HudShell.toast(
            `V${index + 1} FAILED THE ANCHOR GATE: ${reasons.toUpperCase()} — PICK ANOTHER, OR CLICK AGAIN TO OVERRIDE`,
            'error',
          );
          return;
        }
      } else if (ws.kept.length === 0) {
        await this.restoreClips(ws);
      }
      this.active = index;
      this.anchorView = this.subject().primaryView as AnchorDir;
      this.anchorStamp++;
      this.strip = null;
      this.stripGroups = null;
      this.selectedClipCat = null;
      this.removeLabelLayer();
      this.clearPreviewCanvas();
      this.editMode = false;
      this.updateModeButtons();
      UISound.play('confirm');
      this.ensureAnimPanels();
      this.setStage('editing');
      await this.refreshAnchors();
      // Bring this variant's clips to the currently selected quality.
      await this.resampleClips(Number(this.frameSizeSel.value));
      this.refreshClipList();
      const ws2 = this.activeWs();
      if (ws2?.kept[0]) this.previewClip(ws2.kept[0]);
      await this.showVariantConfirmed();
      HudShell.toast(`V${index + 1} ACTIVE — EACH VARIANT KEEPS ITS OWN ANIMATIONS`, 'success');
    });
  }

  /**
   * Padding fraction for a candidate crop that cannot touch another candidate:
   * half the smallest gap to any neighbouring box, capped at 8%.
   */
  private safePad(index: number): number {
    const box = this.variants[index]?.box;
    if (!box) return 0;
    const longest = Math.max(box.w, box.h);
    let gap = longest * 0.08;
    for (let i = 0; i < this.variants.length; i++) {
      if (i === index) continue;
      const o = this.variants[i]?.box;
      if (!o) continue;
      const dx = Math.max(o.x - (box.x + box.w), box.x - (o.x + o.w));
      const dy = Math.max(o.y - (box.y + box.h), box.y - (o.y + o.h));
      // Overlapping on an axis means the neighbour is beside/above us: the
      // usable room is the gap on the separating axis.
      const room = Math.max(dx, dy);
      if (room >= 0) gap = Math.min(gap, room / 2);
    }
    return Math.max(0, gap / longest);
  }

  private async showVariantConfirmed() {
    const ws = this.activeWs();
    if (!ws?.wsId) return;
    const key = this.textureKey(`variant:${ws.wsId}`);
    await this.loadTexture(key, `${fileUrl(`${ws.wsId}/variant.png`)}?t=${Date.now()}`);
    this.clearStage();
    // Centered between the two dock columns (they're symmetrical, so screen center).
    const { width, height } = this.scale;
    const img = this.add.image(width / 2, height / 2 + 10, key);
    // True-to-size: only ever scale DOWN. Blowing a crop up past 1:1 just
    // renders the same pixels softer (same rule as the clip preview).
    // Virtual-square fit: scale by the largest dimension so oversized art fits
    // the stage, but never above 1:1 (capped at 100%). Wheel adjusts in 10% steps.
    img.setScale(this.stageFit(img, width - 680, height - 220));
    this.pixelAlign(img);
    this.previewImage = img;
    this.captionText = this.add
      .text(img.x, img.y + img.displayHeight / 2 + 20, `V${this.active + 1} · ${this.subjectStyleLabel()}`, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '13px',
        color: '#1de9ff',
      })
      .setOrigin(0.5);
    this.enableWheelZoom(img);
  }

  // ---------------- Stage 2: one animation at a time ----------------

  /**
   * Two stages: the variant grid (concept left, variants right) and the
   * editing stage (animation forge left, clips & preview right).
   */
  /**
   * The tool is a sequence, so each stage owns the screen:
   *   concept   → describe it (centered, alone)
   *   blueprint → the AI's answer, editable (centered, alone)
   *   variants  → the four candidates fill the stage, no panels
   *   editing   → anchors + animation forge + clips
   * Sessions opened from the inventory never enter concept/blueprint: you
   * cannot re-generate an existing sprite's concept, only work on it.
   */
  private setStage(stage: 'concept' | 'blueprint' | 'variants' | 'editing') {
    // Steps 1/2: the panel must never scroll internally — the PAGE scrolls
    // (body-level scrollbar), with the canvas and top bar pinned behind it.
    document.body.classList.toggle('g-page-scroll', stage !== 'editing');
    const show = (panel: GenvyPanel | null, dock: 'left' | 'right' | 'center') => {
      if (panel) HudShell.showPanel(panel, dock);
    };
    HudShell.hidePanel(this.conceptPanel);
    HudShell.hidePanel(this.blueprintPanel);
    HudShell.hidePanel(this.variantInfoPanel);
    HudShell.hidePanel(this.anchorPanel);
    HudShell.hidePanel(this.animPanel);
    HudShell.hidePanel(this.previewPanel);

    if (stage === 'concept') {
      show(this.conceptPanel, 'center');
    } else if (stage === 'blueprint') {
      show(this.blueprintPanel, 'center');
    } else if (stage === 'variants') {
      // The candidates own the stage, with the blueprint text alongside for
      // reference — readable and editable, but nothing that spends credits.
      // Fill AFTER showing: a display:none textarea measures 0, so auto-grow
      // would leave every field at its minimum height.
      show(this.variantInfoPanel, 'left');
      this.syncVariantInfo();
    } else if (stage === 'editing') {
      show(this.anchorPanel, 'left');
      show(this.animPanel, 'left');
      show(this.previewPanel, 'right');
    }
  }

  /**
   * Variants stage panel: the concept's text, editable, with a single UPDATE
   * that saves it. No generate/forge buttons — the pick is the next step.
   */
  private buildVariantInfoPanel() {
    const panel = HudShell.makePanel('02 · BLUEPRINT', 'left');
    this.variantInfoPanel = panel;

    const updateBtn = document.createElement('genvy-button') as GenvyButton;
    updateBtn.setAttribute('label', 'UPDATE TEXTS');
    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent =
      'EDITS APPLY TO THE SAVED SPRITE AND TO EVERY ANIMATION FORGED FROM HERE. ' +
      'THE FOUR CANDIDATES ARE ALREADY DRAWN — CHANGING THE TEXT DOES NOT REDRAW THEM.';

    panel.append(
      field('NAME', this.vName),
      field('LORE', this.vLore),
      field('IMAGE PROMPT', this.vImagePrompt),
      updateBtn,
      hint,
    );

    updateBtn.onClick(() => {
      UISound.play('click');
      // Write back into the canonical inputs, the concept and disk.
      this.nameIn.value = this.vName.value;
      this.descIn.value = this.vLore.value;
      this.imagePromptIn.value = this.vImagePrompt.value;
      if (this.concept) {
        this.concept.name = this.vName.value;
        this.concept.description = this.vLore.value;
        this.concept.imagePrompt = this.vImagePrompt.value;
      }
      if (this.sessionId) this.persistConcept(this.sessionId);
      const ws = this.activeWs();
      if (ws?.wsId) this.persistConcept(ws.wsId);
      HudShell.toast('BLUEPRINT UPDATED', 'success');
    });
    return panel;
  }

  /** Mirror the canonical concept fields into the variants-stage panel. */
  private syncVariantInfo() {
    this.vName.value = this.nameIn.value;
    this.vLore.value = this.descIn.value;
    this.vImagePrompt.value = this.imagePromptIn.value;
    // Assigning .value fires no input event, so re-measure explicitly.
    autoGrow.refresh(this.vLore);
    autoGrow.refresh(this.vImagePrompt);
  }

  private ensureAnimPanels() {
    if (this.animPanel) return;
    this.anchorPanel = this.buildAnchorPanel();
    this.animPanel = this.buildAnimPanel();
    this.previewPanel = this.buildPreviewPanel();
    this.anchorPanel.dataset.dock = 'left';
    this.animPanel.dataset.dock = 'left';
    this.previewPanel.dataset.dock = 'right';
    HudShell.addPanel(this.anchorPanel);
    HudShell.addPanel(this.animPanel);
    HudShell.addPanel(this.previewPanel);
    this.refreshClipList();
  }

  /** Preset animation names: the AI's plan for this character first, then the standards. */
  private animationPresets(): string[] {
    const planned = (this.concept?.suggestedAnimations ?? []).map((c) => c.slot);
    // The AI's plan first, then the slots that suit this kind of subject.
    return [...new Set([...planned, ...getSubject(this.subjectSel.value).animations])];
  }

  private currentAnimName(): string {
    return (this.animNameIn.value.trim().toLowerCase() || 'idle').replace(/[^\w-]+/g, '_');
  }

  // ---------------- Anchor chain (Sprite Pipeline v2, P2) ----------------

  private anchorFile(dir: AnchorDir): string {
    return `anchor-${dir}.png`;
  }

  private buildAnchorPanel() {
    const panel = HudShell.makePanel('03 · ANCHOR CHAIN', 'left');
    const grid = document.createElement('div');
    grid.className = 'g-variant-grid';
    this.anchorGrid = grid;

    const forgeBtn = document.createElement('genvy-button') as GenvyButton;
    forgeBtn.setAttribute('variant', 'accent');
    forgeBtn.setAttribute('label', 'FORGE REMAINING VIEWS');
    this.forgeViewsBtn = forgeBtn;
    const resetBtn = document.createElement('genvy-button') as GenvyButton;
    resetBtn.setAttribute('label', 'STRIP PROPS/FX');
    const pivotBtn = document.createElement('genvy-button') as GenvyButton;
    pivotBtn.setAttribute('label', '◎ PLACE PIVOT');
    this.pivotBtn = pivotBtn;
    pivotBtn.onClick(() => {
      UISound.play('click');
      this.pivotMode = !this.pivotMode;
      pivotBtn.setLabel(this.pivotMode ? '◎ CLICK THE SPRITE…' : '◎ PLACE PIVOT');
      if (this.anchors[this.anchorView]) void this.showAnchor(this.anchorView);
    });
    const viewsBtn = document.createElement('genvy-button') as GenvyButton;
    viewsBtn.setAttribute('label', '+ ALL 4 VIEWS');
    this.allViewsBtn = viewsBtn;
    viewsBtn.onClick(() => {
      UISound.play('click');
      this.allViews = !this.allViews;
      this.anchorStamp++; // force the grid to rebuild for the new view set
      void this.refreshAnchors();
    });

    const hint = document.createElement('div');
    hint.className = 'g-hint';
    this.anchorHint = hint;

    panel.append(grid, forgeBtn, resetBtn, pivotBtn, viewsBtn, hint);
    forgeBtn.onClick(() => void this.forgeDirectionalAnchors());
    resetBtn.onClick(() => void this.stripAnchorFx());
    return panel;
  }

  /** Re-read which anchors exist, then repaint the grid. */
  private async refreshAnchors() {
    const ws = this.activeWs();
    if (!ws?.wsId || !this.anchorGrid) return;
    const wsId = ws.wsId;
    // Ask the library which files exist — HEAD-probing each anchor spams the
    // console with 404s for the ones not forged yet.
    try {
      const files = new Set(
        (await api.listWorkspaces()).find((w) => w.id === wsId)?.files ?? [],
      );
      for (const d of ANCHOR_DIRS) this.anchors[d] = files.has(this.anchorFile(d));

      // A session made when this subject's primary view was different still
      // holds the right picture under the wrong name — re-file it (free copy)
      // instead of asking the user to pay for a view they already have.
      const primary = this.subject().primaryView as AnchorDir;
      const stray = ANCHOR_DIRS.find((d) => this.anchors[d]);
      if (!this.anchors[primary] && stray) {
        await api.flip({
          assetId: wsId,
          sourceFile: this.anchorFile(stray),
          outName: this.anchorFile(primary),
          mirror: false,
        });
        this.anchors[primary] = true;
        this.anchorStamp++;
        if (!this.anchors[this.anchorView]) this.anchorView = primary;
      }
    } catch {
      /* listing unavailable — keep what we know */
    }
    this.paintAnchorGrid();
  }

  /** Repaint the S/W/E/N thumbnails from known state (no server round trip). */
  private paintAnchorGrid() {
    const ws = this.activeWs();
    const grid = this.anchorGrid;
    if (!ws?.wsId || !grid) return;
    const wsId = ws.wsId;

    // Rebuilding the cells re-downloads every thumbnail and makes the grid
    // flash, so only do it when the anchor set (or a regenerated file)
    // actually changed — otherwise just move the highlight.
    const views = this.subjectViews();
    const sig = `${wsId}:${views.join('')}:${views.map((d) => (this.anchors[d] ? '1' : '0')).join('')}:${this.anchorStamp}`;
    if (grid.dataset.sig === sig) {
      for (const el of Array.from(grid.children)) {
        const cell = el as HTMLElement;
        cell.classList.toggle('selected', cell.dataset.dir === this.anchorView);
      }
      return;
    }
    grid.dataset.sig = sig;
    this.fillDirectionSelect(); // forging follows whatever anchors exist
    this.describeAnchorWork(views);
    grid.innerHTML = '';
    for (const d of views) {
      const cell = document.createElement('div');
      const live = this.anchors[d];
      const stale = this.staleViews.has(d);
      cell.dataset.dir = d;
      cell.className =
        `g-variant-cell${live && d === this.anchorView ? ' selected' : ''}${stale ? ' stale' : ''}`;
      if (live) {
        const img = document.createElement('img');
        // Stamped, not timestamped: stable across repaints, busted on regen.
        img.src = `${fileUrl(`${wsId}/${this.anchorFile(d)}`)}?v=${this.anchorStamp}`;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        cell.appendChild(img);
        // Clicking an anchor opens it on the stage and makes it the direction
        // the next animation forges from.
        cell.addEventListener('mouseenter', () => UISound.play('hover'));
        cell.addEventListener('click', () => void this.showAnchor(d));
        // Non-primary AI-generated views can be re-forged with extra notes;
        // the primary is the identity itself and derive-type views are free
        // transforms of it, so neither gets the button.
        if (d !== (this.subject().primaryView as AnchorDir) && this.subject().derivation === 'generate') {
          const regen = document.createElement('div');
          regen.className = 'g-anchor-regen';
          regen.textContent = '↻';
          regen.title = `RE-FORGE THE ${d.toUpperCase()} VIEW WITH EXTRA NOTES`;
          regen.addEventListener('click', (ev) => {
            ev.stopPropagation();
            UISound.play('click');
            this.openAnchorRegenModal(d);
          });
          cell.appendChild(regen);
        }
      } else {
        cell.style.opacity = '0.35';
      }
      // W<->E are handedness twins: either can be made from the other for
      // free. Offered on both the empty cell (create it) and the drawn one
      // (replace a bad turn with a clean mirror), whenever the twin exists.
      const twin = mirrorView(d);
      if (twin && this.anchors[twin]) {
        const mirrorBtn = document.createElement('div');
        mirrorBtn.className = 'g-anchor-mirror';
        mirrorBtn.textContent = '⇄';
        mirrorBtn.title = `${live ? 'REPLACE' : 'CREATE'} ${d.toUpperCase()} BY MIRRORING ${twin.toUpperCase()} · FREE`;
        mirrorBtn.addEventListener('mouseenter', () => UISound.play('hover'));
        mirrorBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          UISound.play('click');
          void this.mirrorAnchorFromTwin(d, twin);
        });
        cell.appendChild(mirrorBtn);
      }
      const tag = document.createElement('div');
      tag.className = 'g-variant-tag';
      tag.textContent = d[0]!.toUpperCase(); // S / W / E / N
      cell.title = stale
        ? `${d.toUpperCase()} — MADE FROM THE OLD BASE, RE-FORGE IT`
        : live
          ? `VIEW THE ${d.toUpperCase()} ANCHOR`
          : `${d.toUpperCase()} — NOT FORGED YET`;
      cell.appendChild(tag);
      grid.appendChild(cell);
    }
  }

  /**
   * Second-level modal over the re-forge one: shows the picked version big
   * and asks what to do with it. Overlaying (rather than inline buttons)
   * keeps a destructive DELETE a deliberate two-step, and lets the preview
   * be large enough to actually judge the version by.
   */
  private openAnchorVersionModal(
    dir: AnchorDir,
    file: string,
    onDeleted: () => void,
    onRestore: () => void,
  ) {
    const wsId = this.activeWs()?.wsId;
    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop g-modal-stacked';
    const modal = document.createElement('div');
    modal.className = 'g-modal g-modal-narrow';

    // Title row with a corner dismiss — CANCEL is not a peer of the two
    // actions that actually do something, so it does not take their space.
    const titleRow = document.createElement('div');
    titleRow.className = 'g-modal-titlerow';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = `${dir.toUpperCase()} ANCHOR · SAVED VERSION`;
    const closeX = document.createElement('div');
    closeX.className = 'g-modal-close';
    closeX.textContent = '✕';
    closeX.title = 'CLOSE (ESC)';
    titleRow.append(title, closeX);

    const preview = document.createElement('div');
    preview.className = 'g-version-preview';
    const img = document.createElement('img');
    img.src = fileUrl(`${wsId}/${file}`);
    preview.appendChild(img);

    const row = document.createElement('div');
    row.className = 'g-modal-row';
    const restore = document.createElement('genvy-button') as GenvyButton;
    restore.setAttribute('variant', 'accent');
    restore.setAttribute('label', '↺ RESTORE');
    const del = document.createElement('genvy-button') as GenvyButton;
    del.setAttribute('variant', 'danger');
    del.setAttribute('label', '✕ DELETE');
    for (const b of [restore, del]) {
      b.style.flex = '1 1 50%';
      b.style.minWidth = '0';
    }
    row.append(restore, del);

    modal.append(titleRow, preview, row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    // The parent modal's Escape handler stands down while this is open.
    this.stackedModal = backdrop;

    const close = () => {
      backdrop.remove();
      if (this.stackedModal === backdrop) this.stackedModal = null;
      window.removeEventListener('keydown', onKey);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopImmediatePropagation(); // close THIS one, not the modal beneath
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop) close();
    });

    closeX.addEventListener('mouseenter', () => UISound.play('hover'));
    closeX.addEventListener('click', () => {
      UISound.play('click');
      close();
    });
    restore.onClick(() => {
      UISound.play('click');
      close();
      onRestore();
    });
    del.onClick(() => {
      UISound.play('click');
      this.anchorHistory[dir] = (this.anchorHistory[dir] ?? []).filter((f) => f !== file);
      if (wsId) {
        void api.deleteFile(wsId, file).catch(() => {
          /* the entry is gone from history either way */
        });
        this.persistConcept(wsId);
      }
      close();
      onDeleted();
      HudShell.toast('VERSION DELETED', 'success');
    });
  }

  /**
   * Make one profile from its opposite (west <-> east) with a free mirror —
   * no model, no credits. deriveOp owns the law that a facing is a turn plus
   * a handedness, so the transform comes from there rather than a hardcoded
   * flip.
   */
  private async mirrorAnchorFromTwin(view: AnchorDir, from: AnchorDir) {
    const ws = this.activeWs();
    if (!ws?.wsId || !this.anchors[from]) return;
    const wsId = ws.wsId;
    const op = deriveOp(from, view);
    if (!op) return;
    await this.busy(`MIRRORING ${from.toUpperCase()} INTO ${view.toUpperCase()}...`, async () => {
      HudShell.setBusyLabel(`MIRRORING THE ${from.toUpperCase()} ANCHOR INTO ${view.toUpperCase()} (FREE)...`);
      await this.snapshotAnchor(wsId, view); // whatever was there stays recoverable
      await this.deriveAnchorView(wsId, view, from, op);
      this.anchorStamp++;
      this.paintAnchorGrid();
      await this.showAnchor(view);
      this.persistConcept(wsId);
      UISound.play('confirm');
      HudShell.toast(`${view.toUpperCase()} MIRRORED FROM ${from.toUpperCase()} · FREE`, 'success');
    });
  }

  /** Keep the version we are about to overwrite — a re-forge is never a one-way door. */
  private async snapshotAnchor(wsId: string, dir: AnchorDir) {
    if (!this.anchors[dir]) return;
    const name = `anchor_${dir}_h${Date.now()}.png`;
    try {
      // mirror:false with no rotation is a server-side copy.
      await api.flip({ assetId: wsId, sourceFile: this.anchorFile(dir), outName: name, mirror: false });
      const list = [name, ...(this.anchorHistory[dir] ?? [])].slice(0, 8);
      this.anchorHistory[dir] = list;
      this.persistConcept(wsId);
    } catch {
      /* history is best-effort — never block the re-forge itself */
    }
  }

  /** Put a previous drawing back in place (snapshotting the current one first). */
  private async restoreAnchor(dir: AnchorDir, file: string) {
    const ws = this.activeWs();
    if (!ws?.wsId) return;
    const wsId = ws.wsId;
    await this.busy(`RESTORING THE ${dir.toUpperCase()} ANCHOR...`, async () => {
      HudShell.setBusyLabel('SWAPPING IN THE SAVED ANCHOR (FREE)...');
      await this.snapshotAnchor(wsId, dir); // the replaced one stays recoverable
      await api.flip({ assetId: wsId, sourceFile: file, outName: this.anchorFile(dir), mirror: false });
      this.anchors[dir] = true;
      this.anchorStamp++;
      this.staleViews.delete(dir);
      this.paintAnchorGrid();
      await this.showAnchor(dir);
      UISound.play('confirm');
      HudShell.toast(`${dir.toUpperCase()} ANCHOR RESTORED`, 'success');
    });
  }

  /** Fill a model select for one provider id (modal copies of the panel pickers). */
  private fillModelSelectFor(sel: HTMLSelectElement, providerId: string, workflow: string) {
    const provider = this.providers.find((p) => p.id === providerId);
    sel.innerHTML = '';
    const models = provider?.models ?? [];
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const can = m.workflows.includes(workflow);
      opt.textContent = !m.verified
        ? `${m.label.toUpperCase()} · UNTESTED`
        : !m.available
          ? `${m.label.toUpperCase()} · MODELS MISSING`
          : can
            ? m.label.toUpperCase()
            : `${m.label.toUpperCase()} · CANNOT TURN ANCHORS`;
      opt.disabled = !m.verified || !m.available || !can;
      sel.appendChild(opt);
    }
    const usable = models.filter((m) => m.verified && m.available && m.workflows.includes(workflow));
    sel.value = usable[0]?.id ?? '';
    return models.length > 0;
  }

  /**
   * Centered popup: everything one anchor re-forge needs — art-direction
   * notes, what it is drawn FROM, which provider/model/size/quality does the
   * work, and the view's own history to roll back to.
   */
  private openAnchorRegenModal(dir: AnchorDir) {
    this.anchorModal?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop';
    this.anchorModal = backdrop;

    const modal = document.createElement('div');
    modal.className = 'g-modal';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = `RE-FORGE ${dir.toUpperCase()} ANCHOR`;
    const notes = textArea(
      this.anchorRegenNotes[dir] ?? '',
      `what should change, e.g. 'wings folded tighter, beak angled ${dir}, keep the chest gem visible'`,
    );
    notes.style.minHeight = '96px';

    const primary = this.subject().primaryView as AnchorDir;

    // What the edit is drawn FROM: this view (keep what is already right) or
    // the primary anchor (start the turn over from the identity).
    const baseSel = document.createElement('select');
    for (const [value, label] of [
      ['current', `THIS ${dir.toUpperCase()} VIEW (REFINE)`],
      ['primary', `THE ${primary.toUpperCase()} ANCHOR (RE-TURN)`],
    ]) {
      const opt = document.createElement('option');
      opt.value = value!;
      opt.textContent = label!;
      baseSel.appendChild(opt);
    }

    // Provider/model/size/quality for THIS edit, seeded from the panels.
    const providerSel = this.genProviderSel.cloneNode(true) as HTMLSelectElement;
    providerSel.value = this.genProviderSel.value;
    const modelSel = document.createElement('select');
    const sizeSel = this.genSizeSel.cloneNode(true) as HTMLSelectElement;
    sizeSel.value = this.genSizeSel.value;
    const qualitySel = this.genQualitySel.cloneNode(true) as HTMLSelectElement;
    qualitySel.value = this.genQualitySel.value;
    const modelField = field('LOCAL MODEL', modelSel);
    const sizeField = field('RENDER SIZE', sizeSel);
    const qualityField = field('QUALITY', qualitySel);
    const syncModalProvider = () => {
      const p = this.providers.find((x) => x.id === providerSel.value);
      const hasModels = this.fillModelSelectFor(modelSel, providerSel.value, 'anchor-directional');
      modelField.style.display = hasModels ? '' : 'none';
      sizeField.style.display = hasModels ? '' : 'none';
      qualityField.style.display = p?.capabilities.qualityLevels?.length ? '' : 'none';
    };
    providerSel.addEventListener('change', syncModalProvider);
    syncModalProvider();

    const optionsRow = document.createElement('div');
    optionsRow.style.display = 'flex';
    optionsRow.style.gap = '8px';
    for (const f of [sizeField, qualityField]) {
      f.style.flex = '1 1 50%';
      f.style.minWidth = '0';
    }
    optionsRow.append(sizeField, qualityField);

    // History: click a previous drawing to put it back.
    const history = this.anchorHistory[dir] ?? [];
    const historyField = (() => {
      const strip = document.createElement('div');
      strip.className = 'g-anchor-history';
      // Clicking a version opens a second modal on top (preview + RESTORE /
      // DELETE / CANCEL) — a stray click can neither overwrite nor destroy.
      const paint = () => {
        strip.replaceChildren();
        const list = this.anchorHistory[dir] ?? [];
        for (const file of list) {
          const thumb = document.createElement('div');
          thumb.className = 'g-anchor-history-thumb';
          thumb.title = 'OPEN THIS VERSION';
          const img = document.createElement('img');
          img.src = fileUrl(`${this.activeWs()?.wsId}/${file}`);
          thumb.appendChild(img);
          thumb.addEventListener('mouseenter', () => UISound.play('hover'));
          thumb.addEventListener('click', () => {
            UISound.play('click');
            this.openAnchorVersionModal(
              dir,
              file,
              () => paint(), // deleted: refresh the strip in place
              () => {
                close(); // restoring: the re-forge modal has served its purpose
                void this.restoreAnchor(dir, file);
              },
            );
          });
          strip.appendChild(thumb);
        }
        if (list.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'g-hint';
          empty.textContent = 'NO SAVED VERSIONS YET';
          strip.appendChild(empty);
        }
      };
      paint();
      return field(`PREVIOUS VERSIONS · CLICK ONE (${history.length})`, strip);
    })();

    const row = document.createElement('div');
    row.className = 'g-modal-row';
    const cancel = document.createElement('genvy-button') as GenvyButton;
    cancel.setAttribute('label', 'CANCEL');
    const go = document.createElement('genvy-button') as GenvyButton;
    go.setAttribute('variant', 'accent');
    go.setAttribute('label', 'RE-FORGE VIEW');
    row.append(cancel, go);
    modal.append(
      title,
      field('EXTRA INDICATIONS', notes),
      field('BASED ON', baseSel),
      field('PROVIDER', providerSel),
      modelField,
      optionsRow,
      ...(history.length > 0 ? [historyField] : []),
      row,
    );
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    notes.focus();

    const close = () => {
      backdrop.remove();
      if (this.anchorModal === backdrop) this.anchorModal = null;
    };
    backdrop.addEventListener('pointerdown', (ev) => {
      // A click on the dimmed area behind a STACKED modal must not reach here.
      if (ev.target === backdrop && !this.stackedModal) close();
    });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        if (this.stackedModal) return; // the modal on top owns Escape first
        close();
        window.removeEventListener('keydown', onKey);
      }
    };
    window.addEventListener('keydown', onKey);

    cancel.onClick(() => {
      UISound.play('click');
      close();
    });
    go.onClick(() => {
      this.anchorRegenNotes[dir] = notes.value;
      const opts = {
        base: baseSel.value as 'current' | 'primary',
        provider: providerSel.value || undefined,
        modelFamily: modelSel.value || undefined,
        renderSize: modelField.style.display === 'none' ? undefined : Number(sizeSel.value) || undefined,
        quality:
          qualityField.style.display === 'none'
            ? undefined
            : (qualitySel.value as 'low' | 'medium' | 'high'),
      };
      close();
      void this.regenerateAnchorView(dir, notes.value.trim(), opts);
    });
  }

  /**
   * Refine one directional anchor IN PLACE: the view's own current drawing is
   * the reference, and the notes are corrections to it. (Forging from the
   * primary would discard everything already right about this view.)
   */
  private async regenerateAnchorView(
    dir: AnchorDir,
    notes: string,
    opts: {
      /** 'current' refines this view; 'primary' re-turns from the identity anchor. */
      base?: 'current' | 'primary';
      provider?: string;
      modelFamily?: string;
      renderSize?: number;
      quality?: 'low' | 'medium' | 'high';
    } = {},
  ) {
    const ws = this.activeWs();
    if (!ws?.wsId || !this.anchors[dir]) return;
    if (!this.canEditHere(opts.provider)) return; // chosen provider or nothing
    const wsId = ws.wsId;
    const primary = this.subject().primaryView as AnchorDir;
    const fromPrimary = opts.base === 'primary';
    const provider = opts.provider ?? this.editProvider();
    const family =
      opts.modelFamily ?? this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-directional');
    await this.busy(`RE-FORGING THE ${dir.toUpperCase()} ANCHOR...`, async () => {
      UISound.play('generate');
      HudShell.setBusyLabel(
        `${this.providerTag(provider, family)} · ${fromPrimary ? `TURNING THE ${primary.toUpperCase()} ANCHOR INTO ${dir.toUpperCase()}` : `REDRAWING THE ${dir.toUpperCase()} ANCHOR`}` +
          `${notes ? ' WITH YOUR CORRECTIONS' : ''}...`,
      );
      // Keep the drawing we are about to replace (the modal restores it).
      await this.snapshotAnchor(wsId, dir);
      await api.aiImage({
        prompt: notes,
        orientation: 'portrait',
        kind: 'anchorDirectional',
        // Refining edits THIS view in place; re-turning starts from the
        // primary anchor, so the reference and the flag move together.
        refine: !fromPrimary,
        modelFamily: family,
        quality: opts.quality ?? this.qualityFor(),
        renderSize: opts.renderSize,
        assetId: wsId,
        referenceFile: `${wsId}/${this.anchorFile(fromPrimary ? primary : dir)}`,
        direction: dir,
        outName: this.anchorFile(dir),
        styleHint: this.styleHint(),
        styleId: this.styleId(),
        characterName: this.nameIn.value.trim() || this.concept?.name,
        provider,
        subject: this.subjectSel.value,
      });
      this.anchors[dir] = true;
      this.staleViews.delete(dir);
      this.anchorStamp++;
      this.paintAnchorGrid();
      // If that view is on the stage, swap in the fresh drawing.
      if (this.anchorView === dir) await this.showAnchor(dir);
      void HudShell.refreshSpend();
      UISound.play('complete');
      HudShell.toast(`${dir.toUpperCase()} ANCHOR RE-FORGED — ITS CLIPS STILL USE THE OLD POSE UNTIL REMADE`, 'success');
    }, { key: 'anchor:regen', fallbackMs: 38000 });
  }

  /**
   * Say what the anchor step will actually do for THIS subject: a character
   * needs two generated views, a weapon only a free mirror, a coin nothing.
   */
  /**
   * The free-derive button only where it means something: derive-type subjects
   * derive any view from any other, but a character's only free counterpart is
   * the opposite PROFILE — so for generate subjects it shows only while the
   * WEST or EAST anchor is selected (mirroring a front view is nonsense).
   */
  private updateDeriveClipBtn() {
    const btn = this.deriveClipBtn;
    if (!btn) return;
    const derives = this.subject().derivation === 'derive';
    const views = this.subjectViews();
    const show =
      views.length > 1 && (derives || this.anchorView === 'west' || this.anchorView === 'east');
    btn.style.display = show ? '' : 'none';
    btn.setLabel(derives ? '⇄ DERIVE TO ALL VIEWS · FREE' : '⇄ MIRROR CLIP · FREE');
  }

  private describeAnchorWork(views: AnchorDir[]) {
    const btn = this.forgeViewsBtn;
    const hint = this.anchorHint;
    const primary = this.subject().primaryView as AnchorDir;
    const missing = views.filter((d) => !this.anchors[d] || this.staleViews.has(d));
    const derives = this.subject().derivation === 'derive';
    const willExist = new Set(ANCHOR_DIRS.filter((d) => this.anchors[d]));
    const paid = missing.filter((d) => {
      const op = derives ? deriveOp(primary, d) : null;
      const opposite = mirrorView(d) as AnchorDir | null;
      const free =
        (!!op && willExist.has(op.from as AnchorDir)) || (!!opposite && willExist.has(opposite));
      willExist.add(d);
      return !free;
    });

    if (btn) {
      const single = views.length <= 1;
      btn.style.display = single || missing.length === 0 ? 'none' : '';
      btn.setLabel(
        paid.length === 0
          ? `⇄ DERIVE ${missing.map((d) => d.toUpperCase()).join(' + ')} · FREE`
          : `FORGE ${missing.map((d) => d.toUpperCase()).join(' + ')}`,
      );
    }
    if (hint) {
      hint.textContent =
        views.length <= 1
          ? 'THIS SUBJECT HAS ONE CANONICAL VIEW — ANIMATIONS ALL USE IT.'
          : 'OPPOSITE SIDES ARE FREE MIRRORS. ANIMATIONS USE THE ANCHOR MATCHING THEIR DIRECTION.';
    }
    // Subjects whose facings are transforms of one drawing animate ONCE: the
    // direction picker is noise there, and the other views come for free.
    this.dirField.style.display = derives || views.length <= 1 ? 'none' : '';
    this.updateDeriveClipBtn();
    if (this.pivotBtn) {
      // Only rotation cares about a pivot; a mirror does not.
      this.pivotBtn.style.display = derives && views.length > 1 ? '' : 'none';
    }
    if (this.allViewsBtn) {
      const own = this.subject().views.length;
      // Only offered when the subject's default set is smaller than the compass.
      this.allViewsBtn.style.display = own >= ANCHOR_DIRS.length ? 'none' : '';
      this.allViewsBtn.setLabel(this.allViews ? '− DEFAULT VIEWS' : '+ ALL 4 VIEWS');
    }
  }

  /**
   * Make one view out of another with a free local transform: the opposite
   * side is a mirror, a perpendicular view is a quarter rotation (a gun aiming
   * up is the side view turned, not a new drawing).
   */
  private async deriveAnchorView(wsId: string, view: AnchorDir, from: AnchorDir, op: {
    mirror: boolean;
    degrees: number;
  }) {
    const res = await api.flip({
      assetId: wsId,
      sourceFile: this.anchorFile(from),
      outName: this.anchorFile(view),
      mirror: op.mirror,
      ...(op.degrees ? { rotate: op.degrees } : {}),
      // Turn about the source's pivot, and keep where it landed.
      ...(this.pivots[from] ? { pivot: this.pivots[from] } : {}),
    });
    if (res.pivot) this.pivots[view] = res.pivot;
    this.anchors[view] = true;
    this.staleViews.delete(view);
  }

  /**
   * Subjects whose facings are just orientations get every view for free the
   * moment their anchor is picked — no button, no credits.
   */
  private async deriveFreeViews(wsId: string, opts: { force?: boolean } = {}) {
    const subject = this.subject();
    if (subject.derivation !== 'derive') return;
    const primary = subject.primaryView as AnchorDir;
    if (!this.anchors[primary]) return;
    for (const view of subject.views as AnchorDir[]) {
      if (view === primary) continue;
      if (this.anchors[view] && !opts.force && !this.staleViews.has(view)) continue;
      const op = deriveOp(primary, view);
      if (op) {
        await this.deriveAnchorView(wsId, view, op.from as AnchorDir, op);
        // Show each derived view in the anchor chain as it completes.
        this.anchorStamp++;
        this.paintAnchorGrid();
      }
    }
    this.anchorStamp++;
  }

  /**
   * Which views are built from this one. Only the primary is a source (every
   * other view is a transform of it), so a pivot edit anywhere else is local.
   */
  private viewsDerivedFrom(view: AnchorDir): AnchorDir[] {
    const subject = this.subject();
    if (subject.derivation !== 'derive') return [];
    if (view !== (subject.primaryView as AnchorDir)) return [];
    return (this.subjectViews() as AnchorDir[]).filter((d) => d !== view && this.anchors[d]);
  }

  /** Open one directional anchor on the stage and animate from it next. */
  private async showAnchor(dir: AnchorDir) {
    const ws = this.activeWs();
    if (!ws?.wsId || !this.anchors[dir]) return;
    UISound.play('click');
    this.anchorView = dir;
    this.dirSel.value = dir;
    // Keep the S/W/E/N grid highlight in lockstep with the dropdown — this
    // runs from BOTH sides (panel click and select change), so the two can
    // never disagree about which anchor is active.
    this.paintAnchorGrid();
    const key = this.textureKey(`anchor:${ws.wsId}:${dir}`);
    await this.loadTexture(key, `${fileUrl(`${ws.wsId}/${this.anchorFile(dir)}`)}?t=${Date.now()}`);
    this.clearStage();
    const { width, height } = this.scale;
    const img = this.add.image(width / 2, height / 2 + 10, key);
    // Same virtual-square fit as the confirmed variant, capped at 100%.
    img.setScale(this.stageFit(img, width - 680, height - 220));
    this.pixelAlign(img);
    this.previewImage = img;
    this.captionText = this.add
      .text(img.x, img.y + img.displayHeight / 2 + 20, `${dir.toUpperCase()} ANCHOR · ${this.subjectStyleLabel()}`, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '13px',
        color: '#1de9ff',
      })
      .setOrigin(0.5);

    // Pivot marker: where this view turns from. Click anywhere on the sprite
    // to move it while PLACE PIVOT is armed.
    const drawPivot = () => {
      this.pivotGfx?.destroy();
      const p = this.pivots[dir];
      if (!p) return;
      const g = this.add.graphics();
      const cx = img.x - img.displayWidth / 2 + p.x * img.displayWidth;
      const cy = img.y - img.displayHeight / 2 + p.y * img.displayHeight;
      g.lineStyle(2, this.pivotMode ? 0xff9d1d : 0x1de9ff, 0.9);
      g.strokeCircle(cx, cy, 9);
      g.lineBetween(cx - 15, cy, cx + 15, cy);
      g.lineBetween(cx, cy - 15, cx, cy + 15);
      this.pivotGfx = g;
    };
    img.setInteractive({ useHandCursor: this.pivotMode });
    img.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.pivotMode) return;
      const x = (pointer.worldX - (img.x - img.displayWidth / 2)) / img.displayWidth;
      const y = (pointer.worldY - (img.y - img.displayHeight / 2)) / img.displayHeight;
      this.pivots[dir] = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      if (ws.wsId) this.persistConcept(ws.wsId);
      UISound.play('click');
      drawPivot();

      // A pivot only changes views rotated FROM this one. Editing the source
      // view invalidates its derivations; editing a derived view changes
      // nothing downstream — it is just that sprite's origin.
      const dependents = this.viewsDerivedFrom(dir);
      for (const d of dependents) this.staleViews.add(d);
      this.paintAnchorGrid();
      HudShell.toast(
        dependents.length > 0
          ? `${dir.toUpperCase()} PIVOT SET — RE-DERIVE ${dependents.map((d) => d.toUpperCase()).join(' + ')} TO USE IT`
          : `${dir.toUpperCase()} PIVOT SET — NOTHING IS DERIVED FROM THIS VIEW, SO NOTHING TO REBUILD`,
      );
    });
    drawPivot();
    // Pivot marker and click mapping read displayWidth live, so they stay
    // correct at any zoom — only the marker needs a redraw.
    this.enableWheelZoom(img, drawPivot);

    this.paintAnchorGrid(); // move the selected highlight
    this.updateDeriveClipBtn(); // mirror-clip only makes sense on some views
    this.refreshClipList(); // the clip list is scoped to this view
    // Play this view's first clip instead of leaving the previous one running.
    const first = ws.kept.find(
      (c) => (c.dir ?? dirFromCat(c.cat) ?? defaultDirFor(c.cat)) === dir,
    );
    if (first) {
      this.selectedClipCat = first.cat;
      this.previewClip(first);
      this.refreshClipList();
    } else {
      this.clearPreviewCanvas();
    }
  }

  /**
   * Fill in the views this subject is missing. A view whose opposite already
   * exists is MIRRORED for free; only genuinely new views (a character's back)
   * cost a generation. A subject with a single view has nothing to do here.
   */
  private async forgeDirectionalAnchors() {
    const ws = this.activeWs();
    if (!ws?.wsId) return;
    const subject = this.subject();
    const primary = subject.primaryView as AnchorDir;
    if (!this.canEditHere()) return; // chosen provider or nothing — never a silent paid swap
    if (!this.anchors[primary]) {
      return HudShell.toast(`PICK A VARIANT FIRST — THE ${primary.toUpperCase()} ANCHOR IS THE BASE`, 'error');
    }
    const wsId = ws.wsId;

    // Plan the work: mirrors are free, the rest are edits off the base anchor.
    const missing = this.subjectViews().filter((d) => !this.anchors[d] || this.staleViews.has(d));
    // A mirror needs a source that actually exists — either already, or from
    // an earlier step of this same run.
    const derives = subject.derivation === 'derive';
    const willExist = new Set(ANCHOR_DIRS.filter((d) => this.anchors[d]));
    const plan = missing.map((view) => {
      // Rotations are only meaningful for subjects whose facing is an
      // orientation; a character rotated 90° is lying on the floor.
      const op = derives ? deriveOp(primary, view) : null;
      const opposite = mirrorView(view) as AnchorDir | null;
      const free =
        op && willExist.has(op.from as AnchorDir)
          ? { from: op.from as AnchorDir, mirror: op.mirror, degrees: op.degrees }
          : opposite && willExist.has(opposite)
            ? { from: opposite, mirror: true, degrees: 0 }
            : null;
      willExist.add(view);
      return { view, free };
    });
    if (plan.length === 0) return HudShell.toast('EVERY VIEW FOR THIS SUBJECT ALREADY EXISTS');

    const paid = plan.filter((p) => !p.free).length;
    // Say exactly what is being rebuilt and why, so a 3-chip loader after a
    // pivot edit doesn't look like it is redoing untouched work.
    const rebuilds = plan.filter((p) => this.staleViews.has(p.view)).length;
    await this.busy(
      paid > 0
        ? `FORGING ${paid} ANCHOR VIEW(S)...`
        : rebuilds === plan.length
          ? `REBUILDING ${rebuilds} VIEW(S) FROM THE NEW PIVOT (FREE)...`
          : 'DERIVING THE REMAINING VIEWS (FREE)...',
      async () => {
        UISound.play('generate');
        const steps: { label: string; state: BusyStepState }[] = plan.map((p) => ({
          label: p.free ? `${p.view.toUpperCase()} · FREE` : p.view.toUpperCase(),
          state: 'pending',
        }));
        HudShell.setBusySteps(steps);

        for (let i = 0; i < plan.length; i++) {
          const { view, free } = plan[i]!;
          steps[i]!.state = 'active';
          HudShell.setBusySteps(steps);
          if (free) {
            HudShell.setBusyLabel(
              `${i + 1}/${plan.length} ${free.degrees ? 'ROTATING' : 'MIRRORING'} ` +
                `${free.from.toUpperCase()} INTO ${view.toUpperCase()} (FREE)...`,
            );
            await this.deriveAnchorView(wsId, view, free.from, free);
          } else {
            HudShell.setBusyLabel(
              `${i + 1}/${plan.length} ${this.providerTag(this.editProvider(), this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-directional'))} · EDITING THE ${primary.toUpperCase()} ANCHOR INTO THE ${view.toUpperCase()} VIEW...`,
            );
            await api.aiImage({
              prompt: '',
              orientation: 'portrait',
              kind: 'anchorDirectional',
              assetId: wsId,
              modelFamily: this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-directional'),
              quality: this.qualityFor(),
              referenceFile: `${wsId}/${this.anchorFile(primary)}`,
              direction: view,
              outName: this.anchorFile(view),
              styleHint: this.styleHint(),
              styleId: this.styleId(),
              characterName: this.nameIn.value.trim() || this.concept?.name,
              provider: this.editProvider(),
              subject: this.subjectSel.value,
            });
          }
          this.anchors[view] = true;
          steps[i]!.state = 'done';
          HudShell.setBusySteps(steps);
          // Each finished view lands in the anchor chain immediately — the
          // stamp busts the thumb cache so the new file shows right away.
          this.anchorStamp++;
          this.paintAnchorGrid();
        }

        this.anchorStamp++;
        await this.refreshAnchors();
        void HudShell.refreshSpend();
        UISound.play('complete');
        HudShell.toast('ANCHOR CHAIN COMPLETE — ANIMATIONS FORGE FROM THE MATCHING VIEW', 'success');
      },
      { key: `anchor:views:${paid}`, fallbackMs: Math.max(4000, 38000 * paid) },
    );
  }

  /** Neutral reset: preserve/change edit that strips props & effects off the south anchor. */
  private async stripAnchorFx() {
    const ws = this.activeWs();
    const primary = this.subject().primaryView as AnchorDir;
    if (!ws?.wsId || !this.anchors[primary]) {
      return HudShell.toast(`NO ${primary.toUpperCase()} ANCHOR TO RESET YET`, 'error');
    }
    if (!this.canEditHere()) return; // chosen provider or nothing — never a silent paid swap
    const wsId = ws.wsId;
    const props = this.concept?.signatureProps ?? [];
    await this.busy(`STRIPPING PROPS & FX FROM THE ${primary.toUpperCase()} ANCHOR...`, async () => {
      UISound.play('generate');
      HudShell.setBusyLabel(
        `${this.providerTag(this.editProvider(), this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-directional'))} · REMOVING PROPS, GLOWS & EFFECTS FROM THE ANCHOR...`,
      );
      await api.aiImage({
        prompt: '',
        orientation: 'portrait',
        kind: 'neutralReset',
        modelFamily: this.modelFamilyFor(this.genProviderSel, this.genModelSel, 'anchor-directional'),
        quality: this.qualityFor(),
        assetId: wsId,
        referenceFile: `${wsId}/${this.anchorFile(primary)}`,
        effect: props.length > 0 ? props.join(', ') : undefined,
        outName: this.anchorFile(primary),
        styleHint: this.styleHint(),
        styleId: this.styleId(),
        subject: this.subjectSel.value,
        provider: this.editProvider(),
      });
      // The base changed, so every view built from it is out of date.
      const derived = (this.subjectViews()).filter((d) => d !== primary && this.anchors[d]);
      if (this.subject().derivation === 'derive') {
        HudShell.setBusyLabel('RE-DERIVING THE OTHER VIEWS (FREE)...');
        await this.deriveFreeViews(wsId, { force: true });
      } else {
        for (const d of derived) this.staleViews.add(d);
      }
      HudShell.setBusyLabel('RUNNING THE ANCHOR LOCK GATE...');
      const gate = await api.anchorGate({ assetId: wsId, sourceFile: this.anchorFile(primary) });
      this.anchorStamp++;
      await this.refreshAnchors();
      UISound.play('complete');
      const stale = this.staleViews.size;
      HudShell.toast(
        !gate.pass
          ? 'RESET DONE, BUT THE GATE STILL FAILS — CONSIDER ANOTHER VARIANT'
          : stale > 0
            ? `ANCHOR RESET — ${stale} VIEW(S) STILL SHOW THE OLD PROPS, RE-FORGE THEM`
            : 'ANCHOR RESET & GATE PASSED — ALL VIEWS REBUILT',
        gate.pass && stale === 0 ? 'success' : 'error',
      );
    }, { key: 'anchor:reset', fallbackMs: 38000 });
  }

  private buildAnimPanel() {
    const panel = HudShell.makePanel('04 · ANIMATION FORGE', 'right');

    // Always-visible preset picker: choosing one fills the name input.
    const presetSel = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— PRESETS —';
    presetSel.appendChild(placeholder);
    for (const cat of this.animationPresets()) {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat.toUpperCase();
      presetSel.appendChild(opt);
    }
    presetSel.addEventListener('change', () => {
      if (presetSel.value) {
        this.animNameIn.value = presetSel.value;
        this.dirSel.value = this.availableDir(
          defaultDirFor(presetSel.value, this.subject().primaryView as AnchorDir),
        );
        this.restoreNotesFor(presetSel.value);
        UISound.play('click');
      }
    });
    this.animNameIn.addEventListener('change', () => {
      this.dirSel.value = this.availableDir(
        defaultDirFor(this.currentAnimName(), this.subject().primaryView as AnchorDir),
      );
      this.restoreNotesFor(this.currentAnimName());
    });
    // Switching direction targets a DIFFERENT clip, so pull up its notes.
    this.dirSel.addEventListener('change', () => {
      UISound.play('click');
      this.restoreNotesFor(this.currentAnimName());
    });
    this.animNameIn.value = this.animationPresets()[0] ?? 'idle';

    // Frame presets as chips with skeleton grid icons of each layout.
    const chipRow = document.createElement('div');
    chipRow.className = 'g-chip-row';
    const renderChips = () => {
      chipRow.innerHTML = '';
      for (const p of FRAME_PRESETS) {
        const chip = document.createElement('div');
        chip.className = `g-chip${p === this.framePreset ? ' selected' : ''}`;
        const num = document.createElement('div');
        num.className = 'g-chip-n';
        num.textContent = String(p.n);
        const icon = document.createElement('div');
        icon.className = 'g-chip-grid';
        icon.style.gridTemplateColumns = `repeat(${p.cols}, 1fr)`;
        for (let i = 0; i < p.n; i++) icon.appendChild(document.createElement('span'));
        const sub = document.createElement('div');
        sub.className = 'g-chip-sub';
        sub.textContent = `${p.cols}×${p.rows}`;
        chip.append(num, icon, sub);
        chip.addEventListener('mouseenter', () => UISound.play('hover'));
        chip.addEventListener('click', () => {
          this.framePreset = p;
          UISound.play('click');
          renderChips();
        });
        chipRow.appendChild(chip);
      }
    };
    renderChips();

    const backBtn = document.createElement('genvy-button') as GenvyButton;
    backBtn.setAttribute('label', '◄ VARIANTS');
    const forgeBtn = document.createElement('genvy-button') as GenvyButton;
    forgeBtn.setAttribute('variant', 'accent');
    forgeBtn.setAttribute('label', 'FORGE ANIMATION');
    // These two live in the floating action bar centered under the strip
    // (renderStripLabels mounts them), not in the panel.
    const editShapesBtn = document.createElement('genvy-button') as GenvyButton;
    editShapesBtn.setAttribute('label', 'EDIT FRAMES');
    editShapesBtn.style.display = 'none';
    this.editShapesBtn = editShapesBtn;
    const resliceBtn = document.createElement('genvy-button') as GenvyButton;
    resliceBtn.setAttribute('label', 'MANUAL SLICING');
    resliceBtn.style.display = 'none';
    this.resliceBtn = resliceBtn;

    // Computed clip: no provider call, no credits (Sprite Pipeline v2 §C3).
    const mirrorBtn = document.createElement('genvy-button') as GenvyButton;
    mirrorBtn.setAttribute('label', '⇄ MIRROR CLIP · FREE');
    this.deriveClipBtn = mirrorBtn;
    const freeRow = document.createElement('div');
    freeRow.className = 'g-clip-actions g-free-row';
    freeRow.append(mirrorBtn);
    const freeHint = document.createElement('div');
    freeHint.className = 'g-hint';
    freeHint.textContent =
      'DERIVING TURNS ONE CLIP INTO THE OTHER FACINGS (MIRROR / ROTATE) — NO CREDITS.';

    panel.append(
      backBtn,
      field('PRESETS', presetSel),
      field('ANIMATION NAME', this.animNameIn),
      this.dirField,
      field('FRAMES', chipRow),
      field('MOTION NOTES', this.notesIn),
      field('PROVIDER', this.animProviderSel),
      (this.animModelField = field('LOCAL MODEL', this.animModelSel)),
      (this.animSizeField = field('RENDER SIZE', this.animSizeSel)),
      forgeBtn,
      freeRow,
      freeHint,
    );
    this.animModelField.style.display = 'none';
    this.animSizeField.style.display = 'none';
    SpriteToolScene.fillSizeSelect(this.animSizeSel);
    this.animProviderSel.addEventListener('change', () => {
      // Anchor work reads the blueprint select — mirror the visible choice
      // into it so a LOCAL pick here can never bill the hidden default.
      this.syncProviderSelection(this.animProviderSel, this.genProviderSel);
      this.syncProviderSelection(this.animModelSel, this.genModelSel);
      this.refreshModelSelects();
    });
    mirrorBtn.onClick(() => void this.deriveSelectedClip());
    // Changing the direction dropdown selects that anchor, so the chain, the
    // dropdown and the forged clip's facing can never disagree.
    this.dirSel.addEventListener('change', () => {
      const d = this.dirSel.value as AnchorDir;
      if (this.anchors[d] && d !== this.anchorView) void this.showAnchor(d);
    });

    backBtn.onClick(() => void this.backToVariants());
    forgeBtn.onClick(() => void this.forgeAnimation());
    editShapesBtn.onClick(() => {
      this.editMode = true;
      this.updateModeButtons();
      this.renderStripLabels();
      HudShell.toast('EDIT MODE — DRAW, LASSO (SHIFT), DELETE FRAMES; MANUAL SLICING APPLIES');
    });
    resliceBtn.onClick(() => void this.resliceStrip());
    return panel;
  }

  /** Add or replace the current strip in the active variant's kept clips and persist. */
  private upsertStrip(ws: VariantWs) {
    if (!this.strip) return;
    const existing = ws.kept.findIndex((k) => k.cat === this.strip!.cat);
    if (existing >= 0) ws.kept[existing] = this.strip;
    else ws.kept.push(this.strip);
    this.persistClips(ws);
    this.refreshClipList();
  }

  /** Back to the variant grid stage (concept left, variants right). */
  private async backToVariants() {
    if (!this.sessionId) return;
    this.strip = null;
    this.stripGroups = null;
    this.editMode = false;
    this.updateModeButtons();
    this.removeLabelLayer();
    this.clearPreviewCanvas();
    await this.busy('OPENING VARIANTS...', async () => {
      if (this.variants.length <= 1 || this.variants.every((v) => v.box.w === 0)) {
        const det = await api.detect({ assetId: this.sessionId, sourceFile: 'variants.png' });
        const workspaces = await api.listWorkspaces().catch(() => []);
        this.variants = det.boxes.map((box, i) => {
          const prior = this.variants.find((v) => v.box.w > 0 && v.box.x === box.x);
          const linked = workspaces.find(
            (w) => w.source?.sessionId === this.sessionId && w.source?.variantIndex === i,
          );
          return prior ?? { box, wsId: linked?.id ?? null, kept: [] };
        });
      }
      this.setStage('variants');
      await this.showVariantPicker();
    });
  }

  /** Re-cut the strip using the user's rect groups (union-masked, local, free). */
  private async resliceStrip(opts: { keepEditMode?: boolean } = {}) {
    const ws = this.activeWs();
    if (!ws?.wsId || !this.strip || !this.stripGroups) return;
    // Fade the frame bars while slicing runs (the rebuilt layer clears this).
    this.labelLayer?.classList.add('g-drawing');
    await this.busy('RE-SLICING WITH YOUR SELECTIONS...', async () => {
      const sliced = await api.autoSlice({
        assetId: ws.wsId!,
        sourceFile: this.strip!.rawFile,
        targetFrameSize: Number(this.frameSizeSel.value),
        outName: this.strip!.sheetFile,
        columns: STRIP_ROW,
        groups: this.stripGroups!,
        styleId: this.styleId(),
      });
      this.strip = {
        ...this.strip!,
        count: sliced.frameCount,
        frameWidth: sliced.frameWidth,
        frameHeight: sliced.frameHeight,
        order: Array.from({ length: sliced.frameCount }, (_, i) => i),
        groups: this.stripGroups!,
        // Frame indexes changed — the old gate flags no longer map.
        gateFails: undefined,
      };
      this.sheetBoxes = sliced.boxes;
      this.groupSheetIdx = sliced.boxes.map((_, i) => i);
      this.shapesDirty = false;
      this.selectionsDirty = false;
      if (!opts.keepEditMode) this.editMode = false;
      this.updateModeButtons();
      if (this.activeGroup >= sliced.frameCount) this.activeGroup = 0;
      this.upsertStrip(ws);
      await this.showStripReview();
      this.previewClip(this.strip);
      UISound.play('complete');
      HudShell.toast(`RE-SLICED & SAVED: ${sliced.frameCount} FRAMES FROM YOUR SELECTIONS`, 'success');
    });
  }

  /**
   * Re-slice every kept clip from its ORIGINAL raw at the given frame size
   * (0 = original). Purely local — regenerates each individual animation
   * sprite so they all share one quality. No AI calls.
   */
  private async resampleClips(target: number) {
    const ws = this.activeWs();
    if (!ws?.wsId || ws.kept.length === 0) return;

    const sliceOne = async (clip: Clip, bodyHeightPx?: number) => {
      const res = await api.autoSlice({
        assetId: clip.wsId,
        sourceFile: clip.rawFile,
        targetFrameSize: target,
        outName: clip.sheetFile,
        columns: STRIP_ROW,
        groups: clip.groups && clip.groups.length > 0 ? clip.groups : undefined,
        expectedFrames: clip.groups ? undefined : clip.count,
        styleId: this.styleId(),
        ...(bodyHeightPx ? { bodyHeightPx } : {}),
      });
      clip.frameWidth = res.frameWidth;
      clip.frameHeight = res.frameHeight;
      if (res.frameCount !== clip.count) {
        clip.count = res.frameCount;
        clip.order = Array.from({ length: res.frameCount }, (_, i) => i);
      }
      return res.bodyHeight ?? res.frameHeight;
    };

    const heights: number[] = [];
    for (const clip of ws.kept) heights.push(await sliceOne(clip));

    // Cross-clip height matching (§C5): frame counts differ per clip, so the
    // model draws the character at different sizes per sheet (a 2x2 sheet has
    // far bigger cells than a 4x2 one). Rescale every clip to ONE body height.
    if (ws.kept.length > 1) {
      // Prefer the ANCHOR as the reference: it is the identity, so adding a
      // new clip never rescales the existing ones. The median is the fallback
      // when no anchor measurement is available (e.g. ORIGINAL resolution,
      // where the anchor crop's own scale is unrelated to the sheets').
      const reference = (await this.anchorBodyHeight(target)) ?? medianOf(heights);
      if (reference > 0) {
        for (let i = 0; i < ws.kept.length; i++) {
          if (Math.abs(heights[i]! - reference) / reference <= 0.02) continue;
          await sliceOne(ws.kept[i]!, reference);
        }
      }
    }
    this.persistClips(ws);
  }

  /**
   * Body height the anchor would have at this resolution, in the same units as
   * a sliced clip: the anchor's content box scaled so its longest side is
   * `target`. Undefined at ORIGINAL (0), where the anchor crop and the
   * animation sheets have unrelated native scales.
   */
  private async anchorBodyHeight(target: number): Promise<number | undefined> {
    const ws = this.activeWs();
    const dir = this.subject().primaryView as AnchorDir;
    if (!ws?.wsId || target <= 0 || !this.anchors[dir]) return undefined;
    const key = `${ws.wsId}:${dir}:${target}`;
    const cached = this.anchorBodyCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const det = await api.detect({ assetId: ws.wsId, sourceFile: this.anchorFile(dir) });
      // The anchor crop holds one figure; take the largest box if it split.
      const box = det.boxes.sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (!box) return undefined;
      const height = Math.round((target * box.h) / Math.max(box.w, box.h));
      this.anchorBodyCache.set(key, height);
      return height;
    } catch {
      return undefined; // detection unavailable — median fallback
    }
  }

  /** Resolution change: resample every clip and refresh the preview. */
  private async applyResolution() {
    const ws = this.activeWs();
    if (!ws?.wsId || ws.kept.length === 0) return;
    await this.busy('RESAMPLING CLIPS FROM ORIGINALS...', async () => {
      await this.resampleClips(Number(this.frameSizeSel.value));
      this.refreshClipList();
      // Honor whichever clip the user has selected (they may have clicked a
      // different row while the resample was running) — never snap back.
      const current =
        ws.kept.find((k) => k.cat === this.selectedClipCat) ?? this.strip ?? ws.kept[0];
      if (current) this.previewClip(current);
      UISound.play('confirm');
      HudShell.toast(`ALL CLIPS RESAMPLED · NO CREDITS SPENT`, 'success');
    });
  }

  /**
   * The concept stage before any session exists is the only work with no
   * asset behind it — a long description closed with the tab was simply
   * gone. It drafts to localStorage on every keystroke and clears the moment
   * a session takes over (persistConcept owns it from there).
   */
  private conceptDraftWired = false;

  private wireConceptDraft() {
    if (this.conceptDraftWired) return;
    this.conceptDraftWired = true;
    const save = () => {
      if (this.sessionId) return; // the session's concept.json owns it now
      saveDraft('sprite:concept', {
        describe: this.describeIn.value,
        name: this.nameIn.value,
        lore: this.descIn.value,
        imagePrompt: this.imagePromptIn.value,
        subject: this.subjectSel.value,
        style: this.styleIn.value,
        creativity: this.creativityIn.value,
      });
    };
    for (const el of [this.describeIn, this.nameIn, this.descIn, this.imagePromptIn]) {
      el.addEventListener('input', save);
    }
    for (const el of [this.subjectSel, this.styleIn, this.creativityIn]) {
      el.addEventListener('change', save);
    }
  }

  private restoreConceptDraft() {
    this.wireConceptDraft();
    const draft = loadDraft<{
      describe: string;
      name: string;
      lore: string;
      imagePrompt: string;
      subject: string;
      style: string;
      creativity: string;
    }>('sprite:concept');
    if (!draft) return;
    const d = draft.data;
    if (!d.describe && !d.name && !d.lore && !d.imagePrompt) return;
    if (d.describe) this.describeIn.value = d.describe;
    if (d.name) this.nameIn.value = d.name;
    if (d.lore) this.descIn.value = d.lore;
    if (d.imagePrompt) this.imagePromptIn.value = d.imagePrompt;
    if (d.subject) this.subjectSel.value = d.subject;
    if (d.style) this.styleIn.value = d.style;
    if (d.creativity) this.creativityIn.value = d.creativity;
    for (const el of [this.describeIn, this.descIn, this.imagePromptIn]) autoGrow.refresh(el);
    HudShell.toast('UNSAVED CONCEPT TEXT RESTORED', 'warn');
  }

  /** Persist the character prompt + concept + sliders so any resume restores them. */
  private persistConcept(targetId: string) {
    // A session owns the state from here; the pre-session draft has done its job.
    clearDraft('sprite:concept');
    const data = {
      describe: this.describeIn.value,
      name: this.nameIn.value,
      lore: this.descIn.value,
      imagePrompt: this.imagePromptIn.value,
      style: Number(this.styleIn.value),
      creativity: Number(this.creativityIn.value),
      subject: this.subjectSel.value,
      pivots: this.pivots,
      anchorHistory: this.anchorHistory,
      concept: this.concept,
    };
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), 'concept.json');
    void fetch(`/api/files/${targetId}`, { method: 'POST', body: form });
  }

  private async restoreConcept(targetId: string) {
    try {
      const res = await fetch(`${fileUrl(`${targetId}/concept.json`)}?t=${Date.now()}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        describe?: string;
        name?: string;
        lore?: string;
        imagePrompt?: string;
        style?: number;
        creativity?: number;
        subject?: string;
        pivots?: Partial<Record<AnchorDir, { x: number; y: number }>>;
        anchorHistory?: Partial<Record<AnchorDir, string[]>>;
        pose?: string;
        concept?: CharacterConcept | null;
      };
      if (data.describe) this.describeIn.value = data.describe;
      if (data.name) this.nameIn.value = data.name;
      if (data.lore) this.descIn.value = data.lore;
      if (data.imagePrompt) this.imagePromptIn.value = data.imagePrompt;
      for (const el of [this.describeIn, this.descIn, this.imagePromptIn]) autoGrow.refresh(el);
      if (data.style !== undefined) this.styleIn.value = String(data.style);
      if (data.creativity !== undefined) this.creativityIn.value = String(data.creativity);
      if (data.subject) this.subjectSel.value = data.subject;
      if (data.pivots) this.pivots = data.pivots;
      if (data.anchorHistory) this.anchorHistory = data.anchorHistory;
      if (data.concept) {
        this.concept = data.concept;
        this.syncStyleSel();
      }
    } catch {
      /* no concept.json yet */
    }
  }

  /** Recall the motion notes last used for this exact clip (name + direction). */
  private restoreNotesFor(name: string) {
    const ws = this.activeWs();
    const dir = (this.dirSel.value || 'south') as AnchorDir;
    const clip =
      ws?.kept.find((k) => k.cat === clipName(name, dir)) ??
      ws?.kept.find((k) => baseName(k.cat) === baseName(name));
    if (clip?.notes !== undefined) this.notesIn.value = clip.notes;
  }

  private async forgeAnimation() {
    const ws = this.activeWs();
    if (!ws?.wsId) return HudShell.toast('SELECT A VARIANT FIRST', 'error');
    // Direction is part of the clip's identity, so "idle" facing west becomes
    // idle_west and never overwrites idle_south.
    const subject = this.subject();
    // The SELECTED ANCHOR in the chain is the source of truth for direction —
    // the dropdown only mirrors it. (A dropdown rebuild once silently reset to
    // south and forged a south clip while the west anchor was selected.)
    const dir =
      subject.derivation === 'derive'
        ? (subject.primaryView as AnchorDir) // one drawing: animate it, derive the rest
        : this.anchors[this.anchorView]
          ? this.anchorView
          : ((this.dirSel.value || 'south') as AnchorDir);
    this.dirSel.value = dir;
    // Anchor-first (docs §C2): animating a direction with no anchor would fall
    // back to a different pose and poison the clip's identity. Legacy sessions
    // with no anchors at all still use their variant crop.
    if (this.hasAnyAnchor() && !this.anchors[dir]) {
      return HudShell.toast(
        `NO ${dir.toUpperCase()} ANCHOR YET — FORGE IT IN 03 · ANCHOR CHAIN FIRST`,
        'error',
      );
    }
    const base = this.currentAnimName();
    const cat = clipName(base, dir);
    const preset = this.framePreset;
    const count = preset.n;
    const planned = this.concept?.suggestedAnimations?.find((c) => c.slot === base);
    await this.busy(
      `FORGING ${cat.toUpperCase()} FOR V${this.active + 1}...`,
      async () => {
      UISound.play('generate');
      const steps: { label: string; state: BusyStepState }[] = [
        { label: 'DRAW', state: 'active' },
        { label: 'GATE', state: 'pending' },
        { label: 'SLICE', state: 'pending' },
      ];
      HudShell.setBusySteps(steps);
      HudShell.setBusyLabel(
        `${this.providerTag(this.providerFor(this.animProviderSel), this.modelFamilyFor(this.animProviderSel, this.animModelSel, 'animation-frame'))} · GENERATING ${cat.toUpperCase()} SHEET — VALIDATION GATE & RETRY MAY RUN...`,
      );
      const rawFile = `anim_${cat}_raw.png`;
      const sheetFile = `anim_${cat}_sheet.png`;
      // The clip's direction decides its identity reference; only pre-anchor
      // sessions (no anchors at all) fall back to the plain variant crop.
      const refFile = this.anchors[dir] ? this.anchorFile(dir) : 'variant.png';
      const forged = await api.aiImage({
        prompt: this.notesIn.value,
        orientation: 'landscape',
        kind: 'animation',
        assetId: ws.wsId!,
        referenceFile: `${ws.wsId}/${refFile}`,
        direction: dir,
        category: base, // the motion the prompt describes, not the clip id
        frames: count,
        gridCols: preset.cols,
        gridRows: preset.rows,
        outName: rawFile,
        styleHint: this.styleHint(),
        styleId: this.styleId(),
        subject: this.subjectSel.value,
        provider: this.providerFor(this.animProviderSel),
        modelFamily: this.modelFamilyFor(this.animProviderSel, this.animModelSel, 'animation-frame'),
        renderSize: this.renderSizeFor(this.animProviderSel, this.animSizeSel),
        // Identity for prompt-borne models (Z-Image): the blueprint's
        // appearance text rides along; adapter-based providers ignore it.
        identityPrompt: this.imagePromptIn.value.trim() || undefined,
        // P3 gate + bounded retry: one repair attempt, keep the best sheet.
        // Dedicated animation endpoints cost ~30x a sheet edit, so they get
        // one shot and the user decides whether to spend again.
        attempts: this.animProviderSel.value === 'retrodiffusion' ? 1 : 2,
      });
      steps[0]!.state = 'done';
      steps[1]!.state = forged.gate ? (forged.gate.pass ? 'done' : 'failed') : 'done';
      steps[2]!.state = 'active';
      HudShell.setBusySteps(steps);
      HudShell.setBusyLabel('SLICING FRAMES & PACKING THE STRIP...');
      const sliced = await api.autoSlice({
        assetId: ws.wsId!,
        sourceFile: rawFile,
        targetFrameSize: Number(this.frameSizeSel.value),
        outName: sheetFile,
        columns: STRIP_ROW,
        expectedFrames: count,
        styleId: this.styleId(),
      });
      const groups = sliced.boxes.map((b) => [b]);
      this.strip = {
        wsId: ws.wsId!,
        cat,
        rate: planned?.frameRate ?? CLIP_RATES[base] ?? 8,
        count: sliced.frameCount,
        sheetFile,
        rawFile,
        frameWidth: sliced.frameWidth,
        frameHeight: sliced.frameHeight,
        order: Array.from({ length: sliced.frameCount }, (_, i) => i),
        groups,
        notes: this.notesIn.value,
        dir,
        gateFails: forged.gate?.failedFrames,
      };
      this.stripGroups = groups;
      this.activeGroup = 0;
      this.sheetBoxes = sliced.boxes;
      this.groupSheetIdx = sliced.boxes.map((_, i) => i);
      this.shapesDirty = false;
      this.selectionsDirty = false;
      this.editMode = false;
      this.undoStack = [];
      this.updateModeButtons();
      // The clip you just forged becomes the selected one, so the list, the
      // preview and ✎ EDIT all point at it instead of the previous clip — and
      // the list is scoped by anchor, so follow the clip's direction too.
      this.selectedClipCat = cat;
      if (this.anchors[dir]) this.anchorView = dir;
      this.upsertStrip(ws);
      // A new clip is drawn at its own scale — harmonize it with the others.
      if (ws.kept.length > 1) {
        HudShell.setBusyLabel('MATCHING BODY HEIGHT ACROSS CLIPS...');
        await this.resampleClips(Number(this.frameSizeSel.value));
      }
      steps[2]!.state = 'done';
      HudShell.setBusySteps(steps);
      await this.showStripReview();
      this.previewClip(this.strip);
      this.refreshClipList();
      void HudShell.refreshSpend();
      UISound.play('complete');
      const gate = forged.gate;
      if (gate) {
        // Full report for post-mortems — toasts are transient, this isn't.
        console.log(
          `[genvy] ${cat} gate: ${gate.score}/100 after ${forged.attemptsUsed ?? 1} attempt(s)`,
          '\nframes:', `${gate.frameCount}/${gate.expectedFrames}`,
          '\nfailed frames:', gate.failedFrames,
          '\nhints:', gate.hints,
        );
      }
      if (gate && !gate.pass) {
        HudShell.toast(
          `${cat.toUpperCase()} SAVED · GATE ${gate.score}/100 AFTER ${forged.attemptsUsed ?? 1} ` +
            `ATTEMPT(S) — ${gate.failedFrames.length} FRAME(S) FLAGGED IN RED`,
          'error',
        );
        if (gate.anchorCascade) {
          HudShell.toast('MOST FRAMES DRIFT FROM THE ANCHOR — CONSIDER PICKING/RESETTING THE ANCHOR', 'error');
        }
      } else {
        HudShell.toast(
          `${cat.toUpperCase()} AUTO-SAVED · ${sliced.frameCount} FRAMES` +
            `${sliced.frameCount !== count ? ` (ASKED FOR ${count})` : ''}` +
            `${gate ? ` · GATE ${gate.score}/100` : ''}`,
          'success',
        );
      }
      },
      // Keyed by provider + frame count: gpt-image-2 draws one sheet, Retro
      // Diffusion queues a dedicated render, local ComfyUI renders per frame —
      // their durations have nothing in common, so they must not share a
      // learned average (progress-feedback: per-provider buckets).
      {
        key: `anim:${this.animProviderSel.value || 'openai'}:${count}:${this.renderSizeFor(this.animProviderSel, this.animSizeSel) ?? 'std'}`,
        fallbackMs: 30000 + count * 2500,
      },
    );
  }

  /**
   * Adopt a freshly sliced strip as the active clip (shared by forging and by
   * the mirrored clip, which differs only in how its raw sheet was made).
   */
  private async adoptStrip(
    ws: VariantWs,
    clip: Clip,
    boxes: SpriteBox[],
    opts: { review?: boolean } = {},
  ) {
    this.strip = clip;
    this.selectedClipCat = clip.cat;
    const facing = clip.dir ?? dirFromCat(clip.cat);
    if (facing && this.anchors[facing]) this.anchorView = facing;
    this.stripGroups = clip.groups ?? boxes.map((b) => [b]);
    this.activeGroup = 0;
    this.sheetBoxes = boxes;
    this.groupSheetIdx = boxes.map((_, i) => i);
    this.shapesDirty = false;
    this.selectionsDirty = false;
    this.editMode = false;
    this.undoStack = [];
    this.updateModeButtons();
    this.upsertStrip(ws);
    if (ws.kept.length > 1) {
      HudShell.setBusyLabel('MATCHING BODY HEIGHT ACROSS CLIPS...');
      await this.resampleClips(Number(this.frameSizeSel.value));
    }
    if (opts.review !== false) await this.showStripReview();
    this.previewClip(clip);
  }

  /**
   * Make this clip's counterpart in another facing WITHOUT generating: flip or
   * rotate its raw sheet and carry the frame boxes through the same transform,
   * so the derived clip re-slices, edits and resamples like any other.
   */
  private async deriveClipTo(clip: Clip, view: AnchorDir, op: { mirror: boolean; degrees: number }) {
    const ws = this.activeWs();
    if (!ws?.wsId) return null;
    const wsId = ws.wsId;
    const cat = clipName(clip.cat, view);
    const rawFile = `anim_${cat}_raw.png`;
    const sheetFile = `anim_${cat}_sheet.png`;

    // EVERY shape of every frame travels through the transform — collapsing a
    // multi-shape frame to its union box would lose the extra rectangles and
    // their exact placement. Flatten, flip, then reassemble by group size.
    const srcGroups = clip.groups ?? [];
    const flat: SpriteBox[] = [];
    const counts: number[] = [];
    for (const g of srcGroups) {
      counts.push(g.length);
      flat.push(...g);
    }
    const flipped = await api.flip({
      assetId: wsId,
      sourceFile: clip.rawFile,
      outName: rawFile,
      mirror: op.mirror,
      ...(op.degrees ? { rotate: op.degrees } : {}),
      boxes: flat,
    });
    let groups: SpriteBox[][] = [];
    if (flipped.boxes && flipped.boxes.length === flat.length) {
      let k = 0;
      groups = counts.map((n) => flipped.boxes!.slice(k, (k += n)));
    } else if (flipped.boxes) {
      // Server returned a different shape count (shouldn't happen) — degrade
      // to one box per frame rather than mispairing shapes.
      groups = flipped.boxes.map((b) => [b]);
    }

    const sliced = await api.autoSlice({
      assetId: wsId,
      sourceFile: rawFile,
      targetFrameSize: Number(this.frameSizeSel.value),
      outName: sheetFile,
      columns: STRIP_ROW,
      groups: groups.length > 0 ? groups : undefined,
      expectedFrames: groups.length > 0 ? undefined : clip.count,
      styleId: this.styleId(),
    });

    const derived: Clip = {
      ...clip,
      cat,
      rawFile,
      sheetFile,
      groups: groups.length > 0 ? groups : undefined,
      dir: view,
      count: sliced.frameCount,
      frameWidth: sliced.frameWidth,
      frameHeight: sliced.frameHeight,
      order:
        sliced.frameCount === clip.count
          ? [...clip.order]
          : Array.from({ length: sliced.frameCount }, (_, i) => i),
      removed: undefined,
      gateFails: undefined,
    };
    const existing = ws.kept.findIndex((k) => k.cat === cat);
    if (existing >= 0) ws.kept[existing] = derived;
    else ws.kept.push(derived);
    return { clip: derived, boxes: sliced.boxes };
  }

  /**
   * Derive the selected clip into the facings it does not have yet. For a
   * subject whose views are transforms of one drawing that means ALL of them;
   * for a character it means the opposite side, which is a valid mirror.
   */
  private async deriveSelectedClip() {
    const ws = this.activeWs();
    const clip = ws?.kept.find((k) => k.cat === this.selectedClipCat) ?? ws?.kept[0];
    if (!ws?.wsId || !clip) return HudShell.toast('NO CLIP SELECTED', 'error');

    const subject = this.subject();
    const from = clip.dir ?? dirFromCat(clip.cat) ?? defaultDirFor(clip.cat);
    const targets: { view: AnchorDir; op: { mirror: boolean; degrees: number } }[] = [];
    for (const view of this.subjectViews() as AnchorDir[]) {
      if (view === from) continue;
      if (subject.derivation === 'derive') {
        const op = deriveOp(from, view);
        if (op) targets.push({ view, op: { mirror: op.mirror, degrees: op.degrees } });
      } else if (mirrorView(from) === view) {
        // A character's opposite side is still a valid free mirror.
        targets.push({ view, op: { mirror: true, degrees: 0 } });
      }
    }

    if (targets.length === 0) {
      return HudShell.toast('THIS CLIP HAS NO FREE COUNTERPART — FORGE THE OTHER FACING', 'error');
    }

    await this.busy(
      `DERIVING ${baseName(clip.cat).toUpperCase()} INTO ${targets.length} VIEW(S)...`,
      async () => {
        const steps: { label: string; state: BusyStepState }[] = targets.map((t) => ({
          label: `${t.view.toUpperCase()} · FREE`,
          state: 'pending',
        }));
        HudShell.setBusySteps(steps);
        let last: { clip: Clip; boxes: SpriteBox[] } | null = null;
        for (let i = 0; i < targets.length; i++) {
          const { view, op } = targets[i]!;
          steps[i]!.state = 'active';
          HudShell.setBusySteps(steps);
          HudShell.setBusyLabel(
            `${i + 1}/${targets.length} ${op.mirror ? 'MIRRORING' : 'ROTATING'} INTO ${view.toUpperCase()} (FREE)...`,
          );
          last = await this.deriveClipTo(clip, view, op);
          steps[i]!.state = 'done';
          HudShell.setBusySteps(steps);
        }
        this.persistClips(ws);
        if (last) await this.adoptStrip(ws, last.clip, last.boxes);
        this.refreshClipList();
        UISound.play('complete');
        HudShell.toast(
          `${baseName(clip.cat).toUpperCase()} NOW EXISTS IN ${targets.length + 1} VIEW(S) · NO CREDITS SPENT`,
          'success',
        );
      },
      { key: 'compute:derive', fallbackMs: 2500 * targets.length },
    );
  }

  /**
   * §C4 targeted repair: redraw only the gate-flagged frames and patch them
   * into the raw sheet, instead of re-rolling poses that were already fine.
   */
  private async repairFlaggedFrames() {
    const ws = this.activeWs();
    const clip = this.strip;
    const flagged = clip?.gateFails ?? [];
    if (!ws?.wsId || !clip || flagged.length === 0) return;
    const dir = clip.dir ?? dirFromCat(clip.cat) ?? defaultDirFor(clip.cat);
    const refFile = this.anchors[dir] ? this.anchorFile(dir) : 'variant.png';
    const boxes = (clip.groups ?? this.stripGroups ?? []).map((g) => this.unionOf(g));
    if (boxes.length === 0) return HudShell.toast('NO FRAME BOXES TO REPAIR', 'error');

    await this.busy(
      `REPAIRING ${flagged.length} FLAGGED FRAME${flagged.length > 1 ? 'S' : ''}...`,
      async () => {
        UISound.play('generate');
        // One request per frame: each chip lights up and each fix lands on the
        // sheet as it finishes, instead of one long silence.
        const steps: { label: string; state: BusyStepState }[] = flagged.map((i) => ({
          label: `F${i + 1}`,
          state: 'pending' as BusyStepState,
        }));
        HudShell.setBusySteps(steps);
        const repaired: number[] = [];
        const failures: string[] = [];

        for (let k = 0; k < flagged.length; k++) {
          const index = flagged[k]!;
          steps[k]!.state = 'active';
          HudShell.setBusySteps(steps);
          HudShell.setBusyLabel(
            `${k + 1}/${flagged.length} REDRAWING FRAME ${index + 1} AGAINST THE ${dir.toUpperCase()} ANCHOR...`,
          );
          try {
            const res = await api.repairFrames({
              assetId: ws.wsId!,
              rawFile: clip.rawFile,
              referenceFile: `${ws.wsId}/${refFile}`,
              modelFamily: this.modelFamilyFor(this.animProviderSel, this.animModelSel, 'repair'),
              boxes,
              frameIndexes: [index],
              category: baseName(clip.cat),
              prompt: clip.notes ?? '',
              direction: dir,
              styleId: this.styleId(),
              styleHint: this.styleHint(),
              subject: this.subjectSel.value,
              provider: this.providerFor(this.animProviderSel),
            });
            if (res.repaired.includes(index)) {
              repaired.push(index);
              steps[k]!.state = 'done';
            } else {
              steps[k]!.state = 'failed';
              failures.push(res.failed[0]?.reason ?? 'not repaired');
            }
          } catch (err) {
            steps[k]!.state = 'failed';
            failures.push(err instanceof ApiError ? err.message : 'request failed');
          }
          HudShell.setBusySteps(steps);

          HudShell.setBusyLabel(`${k + 1}/${flagged.length} RE-SLICING THE PATCHED SHEET...`);
          const sliced = await api.autoSlice({
            assetId: ws.wsId!,
            sourceFile: clip.rawFile,
            targetFrameSize: Number(this.frameSizeSel.value),
            outName: clip.sheetFile,
            columns: STRIP_ROW,
            groups: clip.groups && clip.groups.length > 0 ? clip.groups : undefined,
            expectedFrames: clip.groups ? undefined : clip.count,
            styleId: this.styleId(),
          });
          clip.frameWidth = sliced.frameWidth;
          clip.frameHeight = sliced.frameHeight;
          this.sheetBoxes = sliced.boxes;
          clip.gateFails = (clip.gateFails ?? []).filter((i) => !repaired.includes(i));
          await this.showStripReview();
          this.previewClip(clip);
        }

        this.persistClips(ws);
        this.refreshClipList();
        void HudShell.refreshSpend();
        UISound.play('complete');
        HudShell.toast(
          failures.length === 0
            ? `${repaired.length} FRAME${repaired.length > 1 ? 'S' : ''} REDRAWN & PATCHED INTO THE SHEET`
            : `${repaired.length} REPAIRED · ${failures.length} FAILED: ${failures[0]!.toUpperCase()}`,
          failures.length === 0 ? 'success' : 'error',
        );
      },
      { key: 'repair:frame', fallbackMs: 22000 * flagged.length },
    );
  }

  /** Strip review: raw strip + per-frame selections (rects / lasso), reorder, dimming. */
  private async showStripReview() {
    if (!this.strip || !this.stripGroups) return;
    const key = this.textureKey(this.strip.rawFile);
    await this.loadTexture(key, `${fileUrl(`${this.strip.wsId}/${this.strip.rawFile}`)}?t=${Date.now()}`);
    this.clearStage();
    const { width, height } = this.scale;
    const img = this.add.image((width - 600) / 2 + 300, height / 2 + 10, key);
    const s = Math.min((height - 200) / img.height, (width - 960) / img.width, 1);
    img.setScale(s);
    this.previewImage = img;

    this.overlayGfx = this.add.graphics();
    this.worldGeom = {
      x0: img.x - img.displayWidth / 2,
      y0: img.y - img.displayHeight / 2,
      s,
      w: img.displayWidth,
      h: img.displayHeight,
    };
    this.stripGeom = this.computeScreenGeom();
    this.attachReviewKeys();
    this.drawStripBoxes();
    this.renderStripLabels();
  }

  /** Project the image's world placement into screen space through the camera. */
  private computeScreenGeom() {
    const g = this.worldGeom!;
    const cam = this.cameras.main;
    const zoom = cam.zoom;
    const wvx = cam.scrollX + (cam.width * (1 - 1 / zoom)) / 2;
    const wvy = cam.scrollY + (cam.height * (1 - 1 / zoom)) / 2;
    return {
      x0: (g.x0 - wvx) * zoom,
      y0: (g.y0 - wvy) * zoom,
      s: g.s * zoom,
      w: g.w * zoom,
      h: g.h * zoom,
    };
  }

  /** Rebuild DOM overlays after camera changes (throttled to one per frame). */
  private queueReposition() {
    if (this.repositionQueued) return;
    this.repositionQueued = true;
    requestAnimationFrame(() => {
      this.repositionQueued = false;
      if (!this.worldGeom || !this.strip) return;
      this.stripGeom = this.computeScreenGeom();
      this.renderStripLabels();
    });
  }

  private attachReviewKeys() {
    this.detachReviewKeys();
    this.keyDownHandler = (e: KeyboardEvent) => {
      const inField = document.activeElement instanceof HTMLInputElement
        || document.activeElement instanceof HTMLTextAreaElement;
      if (e.key === 'Shift') this.modShift = true;
      if (e.key === ' ' && !inField) {
        this.modPan = true;
        e.preventDefault();
      }
      if (e.key === 'Control') this.modPan = true;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inField && this.editMode) {
        this.removeFrame(this.activeGroup);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) {
        e.preventDefault();
        this.undoSelection();
      }
      this.updateDrawCursor();
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.modShift = false;
      if (e.key === ' ') this.modPan = false;
      if (e.key === 'Control') this.modPan = false;
      this.updateDrawCursor();
    };
    window.addEventListener('keydown', this.keyDownHandler);
    window.addEventListener('keyup', this.keyUpHandler);

    // Window-level so Ctrl+wheel can never reach browser zoom during review;
    // HUD panels keep their native scrolling.
    this.wheelHandler = (e: WheelEvent) => {
      if (!this.strip || !this.worldGeom) return;
      if ((e.target as HTMLElement | null)?.closest?.('genvy-panel, #genvy-topbar')) return;
      e.preventDefault();
      const cam = this.cameras.main;
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (e.deltaY > 0 ? 0.88 : 1.14), 0.5, 6));
      this.queueReposition();
    };
    window.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  private detachReviewKeys() {
    if (this.keyDownHandler) window.removeEventListener('keydown', this.keyDownHandler);
    if (this.keyUpHandler) window.removeEventListener('keyup', this.keyUpHandler);
    if (this.wheelHandler) window.removeEventListener('wheel', this.wheelHandler);
    this.keyDownHandler = null;
    this.keyUpHandler = null;
    this.wheelHandler = null;
    this.modShift = false;
    this.modPan = false;
  }

  private updateDrawCursor() {
    const layer = this.labelLayer?.querySelector('.g-draw-layer') as HTMLElement | null;
    if (!layer) return;
    layer.classList.toggle('mode-order', !this.editMode);
    layer.classList.toggle('mode-lasso', this.editMode && this.modShift && !this.modPan);
    layer.classList.toggle('mode-pan', this.modPan);
  }

  /** EDIT SHAPES is offered in order mode; MANUAL SLICING only while editing. */
  private updateModeButtons() {
    const hasStrip = !!this.strip;
    if (this.editShapesBtn) this.editShapesBtn.style.display = hasStrip && !this.editMode ? '' : 'none';
    // Also offered in order mode once an edge drag desynced the boxes.
    if (this.resliceBtn) {
      this.resliceBtn.style.display = hasStrip && (this.editMode || this.selectionsDirty) ? '' : 'none';
    }
    // Keep the ✎ marker on the clip rows in sync with the edit state.
    this.refreshClipList();
  }

  /** Snapshot the current selections so Ctrl+Z can restore them. */
  private pushUndo() {
    if (!this.stripGroups) return;
    this.undoStack.push(this.stripGroups.map((g) => g.map((r) => ({ ...r }))));
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  private undoSelection() {
    if (!this.strip || this.undoStack.length === 0) {
      return HudShell.toast('NOTHING TO UNDO');
    }
    this.stripGroups = this.undoStack.pop()!;
    this.strip.groups = this.stripGroups;
    if (this.activeGroup >= this.stripGroups.length) this.activeGroup = this.stripGroups.length - 1;
    this.selectionsDirty = true;
    this.shapesDirty = true;
    const ws = this.activeWs();
    if (ws) this.persistClips(ws);
    UISound.play('click');
    this.drawStripBoxes();
    this.renderStripLabels();
    HudShell.toast('UNDONE — MANUAL SLICING TO APPLY');
  }

  /** Delete a whole frame (its shape group). Applies on the next MANUAL SLICING. */
  private removeFrame(index: number) {
    if (!this.stripGroups || this.stripGroups.length <= 1) {
      return HudShell.toast('AT LEAST ONE FRAME MUST REMAIN', 'error');
    }
    this.pushUndo();
    // Drop it from playback now and keep a restorable ghost (persisted on the
    // clip, so it survives switching clips, reloads, and recovery).
    const sheetIdx = this.groupSheetIdx[index] ?? -1;
    if (this.strip) {
      if (sheetIdx >= 0) this.strip.order = this.strip.order.filter((f) => f !== sheetIdx);
      const box = this.unionOf(this.stripGroups[index]!);
      (this.strip.removed ??= []).push({ idx: sheetIdx, box });
    }
    this.stripGroups.splice(index, 1);
    this.groupSheetIdx.splice(index, 1);
    if (this.activeGroup >= this.stripGroups.length) this.activeGroup = this.stripGroups.length - 1;
    this.selectionsDirty = true;
    const ws = this.activeWs();
    if (ws) this.persistClips(ws);
    UISound.play('click');
    this.drawStripBoxes();
    this.renderStripLabels();
    if (this.strip) this.previewClip(this.strip);
    HudShell.toast('FRAME REMOVED — CLICK ITS GHOST TO RESTORE, MANUAL SLICING TO APPLY');
  }

  /** Bring a removed frame back from its ghost; MANUAL SLICING re-cuts it from the raw. */
  private restoreFrame(entry: { idx: number; box: SpriteBox }) {
    if (!this.strip || !this.stripGroups) return;
    this.pushUndo();
    // Insert at its reading-order position (by the ghost box's x).
    let insertAt = this.stripGroups.findIndex((g) => this.unionOf(g).x > entry.box.x);
    if (insertAt < 0) insertAt = this.stripGroups.length;
    this.stripGroups.splice(insertAt, 0, [{ ...entry.box }]);
    this.groupSheetIdx.splice(insertAt, 0, -1);
    this.strip.removed = (this.strip.removed ?? []).filter((r) => r !== entry);
    this.shapesDirty = true;
    this.selectionsDirty = true;
    const ws = this.activeWs();
    if (ws) this.persistClips(ws);
    UISound.play('confirm');
    this.drawStripBoxes();
    this.renderStripLabels();
    HudShell.toast(`${this.strip.cat.toUpperCase()} FRAME RESTORED — MANUAL SLICING TO APPLY`, 'success');
  }

  /** Filled member rects (active frame amber, others faint) + union outlines. World-space. */
  private drawStripBoxes() {
    const g = this.overlayGfx;
    const geo = this.worldGeom;
    if (!g || !geo || !this.stripGroups) return;
    g.clear();
    this.stripGroups.forEach((group, i) => {
      const activeFrame = i === this.activeGroup;
      g.fillStyle(activeFrame ? 0xff9d1d : 0x1de9ff, activeFrame ? 0.16 : 0.05);
      for (const r of group) {
        g.fillRect(geo.x0 + r.x * geo.s, geo.y0 + r.y * geo.s, r.w * geo.s, r.h * geo.s);
      }
      const u = this.unionOf(group);
      g.lineStyle(1, activeFrame ? 0xff9d1d : 0x1de9ff, activeFrame ? 1 : 0.35);
      g.strokeRect(geo.x0 + u.x * geo.s, geo.y0 + u.y * geo.s, u.w * geo.s, u.h * geo.s);
    });
  }

  private unionOf(group: SpriteBox[]): SpriteBox {
    const x0 = Math.min(...group.map((r) => r.x));
    const y0 = Math.min(...group.map((r) => r.y));
    return {
      x: x0,
      y: y0,
      w: Math.max(...group.map((r) => r.x + r.w)) - x0,
      h: Math.max(...group.map((r) => r.y + r.h)) - y0,
    };
  }

  private renderStripLabels() {
    this.removeLabelLayer();
    if (!this.strip || !this.stripGroups || !this.stripGeom) return;
    const { x0, y0, s } = this.stripGeom;
    const layer = document.createElement('div');
    layer.className = `g-label-layer${this.editMode ? ' g-editing' : ''}`;
    // Inline: the `#hud-root > *` rule outweighs the class and would re-enable
    // pointer events, making the layer swallow every click.
    layer.style.pointerEvents = 'none';
    document.getElementById('hud-root')!.appendChild(layer);
    this.labelLayer = layer;

    // Draw surface over the whole image: drag = add rectangle to the selected
    // frame; SHIFT+drag = lasso around the pose (rasterized to mask rects).
    const drawLayer = document.createElement('div');
    drawLayer.className = 'g-draw-layer';
    drawLayer.style.left = `${Math.round(x0)}px`;
    drawLayer.style.top = `${Math.round(y0)}px`;
    drawLayer.style.width = `${Math.round(this.stripGeom.w)}px`;
    drawLayer.style.height = `${Math.round(this.stripGeom.h)}px`;
    drawLayer.addEventListener('pointerdown', (ev) => this.startDrawSelection(ev, drawLayer));
    layer.appendChild(drawLayer);
    this.updateDrawCursor();

    // Action bar centered under the frames (EDIT FRAMES / MANUAL SLICING).
    const actions = document.createElement('div');
    actions.className = 'g-strip-actions';
    actions.style.pointerEvents = 'auto';
    actions.style.left = `${Math.round(x0 + this.stripGeom.w / 2)}px`;
    actions.style.top = `${Math.round(y0 + this.stripGeom.h + 14)}px`;
    if (this.editShapesBtn) actions.appendChild(this.editShapesBtn);
    if (this.resliceBtn) actions.appendChild(this.resliceBtn);
    // Only offered when the gate actually rejected frames — it costs one image
    // call per frame, so it never appears speculatively.
    const flagged = this.strip.gateFails ?? [];
    if (flagged.length > 0 && !this.editMode) {
      const repair = document.createElement('genvy-button') as GenvyButton;
      repair.setAttribute('variant', 'danger');
      repair.setAttribute('label', `⟳ REDRAW ${flagged.length} FLAGGED FRAME${flagged.length > 1 ? 'S' : ''}`);
      repair.onClick(() => void this.repairFlaggedFrames());
      actions.appendChild(repair);
    }
    layer.appendChild(actions);

    this.stripGroups.forEach((group, i) => {
      const activeFrame = i === this.activeGroup;
      const u = this.unionOf(group);
      const pos = this.strip!.order.indexOf(i);

      const bar = document.createElement('div');
      // Order mode: every frame name at full opacity, same color. Edit mode
      // dims the non-active ones so the draw target is unambiguous (and all
      // bars fade while drawing/re-slicing via the g-drawing layer class).
      const gateFail = this.strip!.gateFails?.includes(i) ?? false;
      bar.className =
        `g-frame-bar${!this.editMode || activeFrame ? '' : ' g-dim'}` +
        `${gateFail ? ' g-gate-fail' : ''}`;
      if (gateFail) bar.title = 'THE VALIDATION GATE FLAGGED THIS FRAME (IDENTITY/VALIDITY)';
      bar.style.left = `${Math.round(x0 + u.x * s)}px`;
      bar.style.top = `${Math.round(y0 + u.y * s - 22)}px`;
      const badge = document.createElement('span');
      badge.className = 'g-frame-ord';
      badge.textContent = `${this.strip!.cat} · ${pos >= 0 ? pos : i}${group.length > 1 ? ` · ${group.length} SHAPES` : ''}`;
      bar.appendChild(badge);
      if (activeFrame && this.editMode) {
        const del = document.createElement('span');
        del.className = 'g-frame-del';
        del.textContent = '✕';
        del.title = 'REMOVE THIS FRAME (DELETE)';
        del.addEventListener('click', () => this.removeFrame(i));
        bar.appendChild(del);
      }
      layer.appendChild(bar);

      const rect = document.createElement('div');
      rect.className = `g-frame-rect${activeFrame ? ' g-active' : ' g-dim'}`;
      rect.style.left = `${Math.round(x0 + u.x * s)}px`;
      rect.style.top = `${Math.round(y0 + u.y * s)}px`;
      rect.style.width = `${Math.round(u.w * s)}px`;
      rect.style.height = `${Math.round(u.h * s)}px`;

      const selectFrame = (ev: Event) => {
        ev.stopPropagation();
        if (this.activeGroup !== i) {
          this.activeGroup = i;
          UISound.play('click');
          this.drawStripBoxes();
          this.renderStripLabels();
        }
      };
      // Right-click: undo the last added shape of this frame.
      const undoLastShape = (ev: Event) => {
        ev.preventDefault();
        if (group.length > 1) {
          this.pushUndo();
          group.pop();
          this.selectionsDirty = true;
          this.shapesDirty = true;
          const ws = this.activeWs();
          if (ws) this.persistClips(ws);
          this.drawStripBoxes();
          this.renderStripLabels();
          HudShell.toast('LAST SHAPE REMOVED — MANUAL SLICING TO APPLY');
        } else {
          HudShell.toast('FRAMES KEEP AT LEAST ONE SHAPE');
        }
      };
      if (this.editMode) {
        // Edit mode: drawing must pass THROUGH other frames' rectangles, so
        // the rect is display-only and the NAME CHIP is the only selector —
        // otherwise a drag over a neighbouring frame selects it instead of
        // drawing.
        rect.style.pointerEvents = 'none';
        bar.style.cursor = 'pointer';
        bar.title = bar.title || 'CLICK TO SELECT THIS FRAME';
        bar.addEventListener('pointerdown', selectFrame);
        bar.addEventListener('contextmenu', undoLastShape);
      } else {
        rect.addEventListener('pointerdown', selectFrame);
        rect.addEventListener('contextmenu', undoLastShape);
      }

      // Reorder halves only in order mode with selections matching the sliced sheet.
      if (!this.editMode && !this.selectionsDirty) {
        const symbolSize = `${Math.max(22, Math.round(u.h * s * 0.3))}px`;
        const minus = document.createElement('div');
        minus.className = 'g-half minus';
        minus.textContent = '−';
        minus.style.fontSize = symbolSize;
        // pointerdown + stopPropagation: the rect's own pointerdown re-renders
        // the layer on selection, which would destroy this element before its
        // 'click' could ever fire (the old need-to-click-twice bug).
        minus.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          this.bumpOrder(i, -1);
        });
        const plus = document.createElement('div');
        plus.className = 'g-half plus';
        plus.textContent = '+';
        plus.style.fontSize = symbolSize;
        plus.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          this.bumpOrder(i, 1);
        });
        rect.append(minus, plus);
      }

      // Edge handles live in ORDER mode (manual slicing needs the whole
      // surface for drawing). Multi-shape frames resize their MAIN (largest)
      // rectangle; the extra shapes stay put.
      if (!this.editMode) {
        const main = group.reduce((a, r) => (r.w * r.h > a.w * a.h ? r : a), group[0]!);
        for (const edge of ['n', 's', 'e', 'w'] as const) {
          const handle = document.createElement('div');
          handle.className = `g-handle g-handle-${edge}`;
          handle.addEventListener('pointerdown', (ev) =>
            this.startEdgeDrag(ev, main, edge, rect, bar, group),
          );
          rect.appendChild(handle);
        }
      }
      layer.appendChild(rect);
    });

    // Ghosts of removed frames (persisted on the clip): click one to restore
    // it. Shown in both modes — removal happens in edit mode, so the ghost
    // must be reachable there too.
    for (const entry of this.strip.removed ?? []) {
      const box = entry.box;
      const ghost = document.createElement('div');
      ghost.className = 'g-ghost-rect';
      ghost.style.left = `${Math.round(x0 + box.x * s)}px`;
      ghost.style.top = `${Math.round(y0 + box.y * s)}px`;
      ghost.style.width = `${Math.round(box.w * s)}px`;
      ghost.style.height = `${Math.round(box.h * s)}px`;
      const label = `RESTORE ${this.strip.cat.toUpperCase()} FRAME`;
      ghost.title = label;
      const tag = document.createElement('div');
      tag.className = 'g-ghost-label';
      tag.textContent = label;
      ghost.appendChild(tag);
      ghost.addEventListener('mouseenter', () => UISound.play('hover'));
      ghost.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.restoreFrame(entry);
      });
      layer.appendChild(ghost);
    }
  }

  /** Rubber-band a rectangle, SHIFT-lasso around a pose, or SPACE/CTRL-pan the camera. */
  private startDrawSelection(ev: PointerEvent, surface: HTMLElement) {
    ev.preventDefault();
    const geo = this.stripGeom;
    if (!geo || !this.stripGroups || this.stripGroups.length === 0) return;

    // Pan mode: drag moves the camera; overlays follow.
    if (this.modPan) {
      surface.classList.add('mode-panning');
      const cam = this.cameras.main;
      const startScroll = { x: cam.scrollX, y: cam.scrollY };
      const startPt = { x: ev.clientX, y: ev.clientY };
      const move = (e: PointerEvent) => {
        cam.scrollX = startScroll.x - (e.clientX - startPt.x) / cam.zoom;
        cam.scrollY = startScroll.y - (e.clientY - startPt.y) / cam.zoom;
        this.queueReposition();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        surface.classList.remove('mode-panning');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
      return;
    }

    // Drawing only in edit mode (order mode keeps pan/zoom and selection).
    if (!this.editMode) return;

    // Frame-name bars fade only WHILE drawing, so they don't cover the art.
    this.labelLayer?.classList.add('g-drawing');
    const lasso = ev.shiftKey;
    const surfRect = surface.getBoundingClientRect();
    const toImg = (e: PointerEvent) => ({
      x: Math.max(0, (e.clientX - surfRect.left) / geo.s),
      y: Math.max(0, (e.clientY - surfRect.top) / geo.s),
    });
    const start = toImg(ev);
    const points: { x: number; y: number }[] = [start];

    // Rect preview is a box; lasso preview is the actual drawn outline (SVG).
    let previewBox: HTMLDivElement | null = null;
    let previewSvg: SVGSVGElement | null = null;
    let previewLine: SVGPolylineElement | null = null;
    if (lasso) {
      previewSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      previewSvg.setAttribute('class', 'g-lasso-preview');
      previewSvg.setAttribute('width', '100%');
      previewSvg.setAttribute('height', '100%');
      previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      previewSvg.appendChild(previewLine);
      surface.appendChild(previewSvg);
    } else {
      previewBox = document.createElement('div');
      previewBox.className = 'g-draw-preview';
      surface.appendChild(previewBox);
    }

    const move = (e: PointerEvent) => {
      const p = toImg(e);
      if (lasso && previewLine) {
        points.push(p);
        previewLine.setAttribute(
          'points',
          points.map((q) => `${q.x * geo.s},${q.y * geo.s}`).join(' '),
        );
      } else if (previewBox) {
        previewBox.style.left = `${Math.min(start.x, p.x) * geo.s}px`;
        previewBox.style.top = `${Math.min(start.y, p.y) * geo.s}px`;
        previewBox.style.width = `${Math.abs(p.x - start.x) * geo.s}px`;
        previewBox.style.height = `${Math.abs(p.y - start.y) * geo.s}px`;
      }
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      this.labelLayer?.classList.remove('g-drawing');
      previewBox?.remove();
      previewSvg?.remove();
      const group = this.stripGroups![this.activeGroup];
      if (!group) return;
      let added = 0;
      if (lasso) {
        const rects = polygonToRects(points);
        if (rects.length > 0) {
          this.pushUndo();
          group.push(...rects);
          added = rects.length;
        }
      } else {
        const end = toImg(e);
        const r: SpriteBox = {
          x: Math.round(Math.min(start.x, end.x)),
          y: Math.round(Math.min(start.y, end.y)),
          w: Math.round(Math.abs(end.x - start.x)),
          h: Math.round(Math.abs(end.y - start.y)),
        };
        if (r.w >= 6 && r.h >= 6) {
          this.pushUndo();
          group.push(r);
          added = 1;
        }
      }
      if (added > 0) {
        this.selectionsDirty = true;
        this.shapesDirty = true;
        UISound.play('confirm');
        const ws = this.activeWs();
        if (ws) this.persistClips(ws);
        this.drawStripBoxes();
        this.renderStripLabels();
        HudShell.toast(
          lasso ? 'LASSO ADDED — MANUAL SLICING TO APPLY' : 'SHAPE ADDED — MANUAL SLICING TO APPLY',
        );
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  /** Drag one edge of a box; live-updates the DOM rect and the canvas outline. */
  private startEdgeDrag(
    ev: PointerEvent,
    b: SpriteBox,
    edge: 'n' | 's' | 'e' | 'w',
    rect: HTMLElement,
    bar: HTMLElement,
    group?: SpriteBox[],
  ) {
    ev.preventDefault();
    ev.stopPropagation();
    const geo = this.stripGeom;
    if (!geo) return;
    this.labelLayer?.classList.add('g-drawing');
    this.pushUndo();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const orig = { ...b };
    const MIN = 8;

    const move = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / geo.s;
      const dy = (e.clientY - startY) / geo.s;
      if (edge === 'w') {
        const nx = Math.max(0, Math.min(orig.x + dx, orig.x + orig.w - MIN));
        b.w = orig.w + (orig.x - nx);
        b.x = nx;
      } else if (edge === 'e') {
        b.w = Math.max(MIN, orig.w + dx);
      } else if (edge === 'n') {
        const ny = Math.max(0, Math.min(orig.y + dy, orig.y + orig.h - MIN));
        b.h = orig.h + (orig.y - ny);
        b.y = ny;
      } else {
        b.h = Math.max(MIN, orig.h + dy);
      }
      // The DOM rect shows the frame's UNION, so extra shapes stay covered
      // while the main rectangle is being resized.
      const u = group && group.length > 1 ? this.unionOf(group) : b;
      rect.style.left = `${Math.round(geo.x0 + u.x * geo.s)}px`;
      rect.style.top = `${Math.round(geo.y0 + u.y * geo.s)}px`;
      rect.style.width = `${Math.round(u.w * geo.s)}px`;
      rect.style.height = `${Math.round(u.h * geo.s)}px`;
      bar.style.left = `${Math.round(geo.x0 + u.x * geo.s)}px`;
      bar.style.top = `${Math.round(geo.y0 + u.y * geo.s - 22)}px`;
      this.drawStripBoxes();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      this.labelLayer?.classList.remove('g-drawing');
      // The boxes no longer match the sliced sheet: surface MANUAL SLICING to
      // apply, and hide the reorder halves until it runs.
      this.selectionsDirty = true;
      this.shapesDirty = true;
      const ws = this.activeWs();
      if (ws) this.persistClips(ws);
      this.updateModeButtons();
      this.renderStripLabels();
      UISound.play('click');
      HudShell.toast('FRAME RESIZED — MANUAL SLICING TO APPLY');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  private bumpOrder(cellIndex: number, delta: number) {
    if (!this.strip) return;
    const order = this.strip.order;
    const pos = order.indexOf(cellIndex);
    const target = pos + delta;
    if (pos < 0 || target < 0 || target >= order.length) return;
    [order[pos], order[target]] = [order[target]!, order[pos]!];
    UISound.play('click');
    // Order changes persist immediately — the strip object lives in kept.
    const ws = this.activeWs();
    if (ws) this.persistClips(ws);
    this.renderStripLabels();
    this.previewClip(this.strip);
  }

  /** Persist the kept-clips list next to the strips so resume restores it. */
  private persistClips(ws: VariantWs) {
    if (!ws.wsId) return;
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(ws.kept)], { type: 'application/json' }), 'clips.json');
    void fetch(`/api/files/${ws.wsId}`, { method: 'POST', body: form });
  }

  private async restoreClips(ws: VariantWs) {
    if (!ws.wsId) return;
    try {
      const res = await fetch(`${fileUrl(`${ws.wsId}/clips.json`)}?t=${Date.now()}`);
      if (!res.ok) return;
      const clips = (await res.json()) as Clip[];
      if (Array.isArray(clips)) {
        ws.kept = clips.map((c) => ({ ...c, wsId: ws.wsId! }));
      }
    } catch {
      /* no clips.json yet */
    }
  }

  // ---------------- Stage 3: clips + save (per variant) ----------------

  private buildPreviewPanel() {
    const panel = HudShell.makePanel('05 · CLIPS & PREVIEW', 'right');
    const canvas = document.createElement('canvas');
    canvas.className = 'g-preview-canvas';
    canvas.width = 256;
    canvas.height = 256;
    this.previewCanvas = canvas;

    const list = document.createElement('div');
    list.className = 'g-asset-list';
    this.clipListEl = list;

    // Lives in the clip list's action row (next to EDIT), not in the panel body.
    const saveBtn = document.createElement('genvy-button') as GenvyButton;
    saveBtn.setAttribute('variant', 'accent');
    saveBtn.setAttribute('label', 'SAVE');
    saveBtn.style.display = 'none';
    this.saveBtn = saveBtn;
    saveBtn.onClick(() => void this.saveCharacter());

    // Forging always works from the original raws; the resolution here only
    // re-derives the clips locally (free) for preview and save.
    this.frameSizeSel.addEventListener('change', () => void this.applyResolution());

    // Engine export sits above RESOLUTION: sheet + frame rects + pivots +
    // animation definitions, for the selected clip or the whole sprite.
    const exportBtn = document.createElement('genvy-button') as GenvyButton;
    exportBtn.setAttribute('label', '⤓ EXPORT FOR ENGINE');
    exportBtn.style.display = 'none';
    this.exportBtn = exportBtn;
    exportBtn.onClick(() => this.openExportModal());

    panel.append(exportBtn, field('RESOLUTION', this.frameSizeSel), canvas, list);
    return panel;
  }

  /** Centered popup: export the selected clip, or the whole sprite. Free. */
  private openExportModal() {
    const ws = this.activeWs();
    if (!ws?.wsId || ws.kept.length === 0) return HudShell.toast('NOTHING TO EXPORT YET', 'error');
    const selected = ws.kept.find((k) => k.cat === this.selectedClipCat) ?? ws.kept[0]!;
    this.anchorModal?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop';
    this.anchorModal = backdrop;
    const modal = document.createElement('div');
    modal.className = 'g-modal';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = 'EXPORT FOR ENGINE';
    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent =
      'WRITES PNG + FRAME RECTS + PIVOTS + ANIMATION DEFINITIONS (PLUS A PHASER ATLAS) ' +
      'TO LIBRARY/EXPORTS. LOCAL & FREE — NO AI CALL, NO CREDITS.';

    const clipBtn = document.createElement('genvy-button') as GenvyButton;
    clipBtn.setAttribute('label', `THIS ANIMATION · ${baseName(selected.cat).toUpperCase()}`);
    const fullBtn = document.createElement('genvy-button') as GenvyButton;
    fullBtn.setAttribute('variant', 'accent');
    fullBtn.setAttribute('label', `FULL SPRITE · ${ws.kept.length} CLIP(S)`);
    const cancel = document.createElement('genvy-button') as GenvyButton;
    cancel.setAttribute('label', 'CANCEL');
    const row = document.createElement('div');
    row.className = 'g-modal-row';
    row.append(cancel);
    modal.append(title, hint, clipBtn, fullBtn, row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => {
      backdrop.remove();
      if (this.anchorModal === backdrop) this.anchorModal = null;
    };
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop) close();
    });
    cancel.onClick(() => {
      UISound.play('click');
      close();
    });
    clipBtn.onClick(() => {
      close();
      void this.exportSprite('clip', selected);
    });
    fullBtn.onClick(() => {
      close();
      void this.exportSprite('full');
    });
  }

  /**
   * Write an engine-ready bundle. 'clip' exports the selected animation's own
   * strip; 'full' composes every clip into the master sheet first (both are
   * local, deterministic operations — no credits).
   */
  private async exportSprite(scope: 'clip' | 'full', clip?: Clip) {
    const ws = this.activeWs();
    if (!ws?.wsId) return;
    const wsId = ws.wsId;
    const baseNm = (this.nameIn.value.trim() || 'Unnamed Sprite').replace(/\s+V\d+$/i, '');
    const name = scope === 'clip' && clip ? `${baseNm} ${clip.cat}` : `${baseNm} V${this.active + 1}`;
    const anchors = Object.fromEntries(
      this.subjectViews()
        .filter((d) => this.anchors[d])
        .map((d) => [d, this.anchorFile(d)]),
    );

    await this.busy(
      `EXPORTING ${scope === 'clip' ? 'CLIP' : 'FULL SPRITE'}...`,
      async () => {
        let body: Parameters<typeof api.exportSprite>[0];
        if (scope === 'clip' && clip) {
          HudShell.setBusyLabel('WRITING SHEET, FRAME RECTS & MANIFESTS (FREE)...');
          const facing = clip.dir ?? dirFromCat(clip.cat) ?? defaultDirFor(clip.cat);
          body = {
            assetId: wsId,
            sheetFile: clip.sheetFile,
            name,
            description: this.descIn.value,
            scope,
            frameWidth: clip.frameWidth,
            frameHeight: clip.frameHeight,
            // Clip strips are packed as a single row.
            columns: clip.count,
            subject: this.subjectSel.value,
            styleId: this.styleId(),
            pivots: this.pivots,
            anchors,
            animations: [
              {
                name: clip.cat,
                direction: facing,
                frameRate: clip.rate,
                repeat: -1,
                // Playback order into the strip; fall back to natural order.
                frames:
                  clip.order.length > 0
                    ? [...clip.order]
                    : Array.from({ length: clip.count }, (_, i) => i),
              },
            ],
          };
        } else {
          HudShell.setBusyLabel('COMPOSING THE MASTER SHEET (FREE)...');
          const composed = await api.composeSheet({
            assetId: wsId,
            styleId: this.styleId(),
            parts: ws.kept.map((k) => ({
              file: k.sheetFile,
              frameWidth: k.frameWidth,
              frameHeight: k.frameHeight,
              count: k.count,
              frames: k.order,
            })),
          });
          HudShell.setBusyLabel('WRITING SHEET, FRAME RECTS & MANIFESTS (FREE)...');
          body = {
            assetId: wsId,
            sheetFile: composed.sheet.path.split('/').pop()!,
            name,
            description: this.descIn.value,
            scope,
            frameWidth: composed.frameWidth,
            frameHeight: composed.frameHeight,
            columns: composed.columns,
            subject: this.subjectSel.value,
            styleId: this.styleId(),
            pivots: this.pivots,
            anchors,
            animations: ws.kept.map((k, r) => {
              const range = composed.ranges[r]!;
              return {
                name: k.cat,
                direction: k.dir ?? dirFromCat(k.cat) ?? defaultDirFor(k.cat),
                frameRate: k.rate,
                repeat: -1,
                frames: Array.from({ length: range.count }, (_, pos) => range.start + pos),
              };
            }),
          };
        }

        const res = await api.exportSprite(body);
        UISound.play('complete');
        HudShell.toast(
          `EXPORTED ${res.frameCount} FRAMES · ${res.animationCount} ANIMATION(S) → LIBRARY/EXPORTS/${res.dir.toUpperCase()}`,
          'success',
        );
        this.showExportResult(res.diskPath, res.bundle, res.files);
      },
      { key: `export:${scope}`, fallbackMs: 3000 },
    );
  }

  /** Where it landed + the zip bundle, with the loose files as a fallback. */
  private showExportResult(
    diskPath: string,
    bundle: { name: string; url: string; bytes: number; fileCount: number },
    files: { name: string; url: string }[],
  ) {
    this.anchorModal?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop';
    this.anchorModal = backdrop;
    const modal = document.createElement('div');
    modal.className = 'g-modal';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = 'EXPORT COMPLETE';
    const where = document.createElement('div');
    where.className = 'g-hint';
    where.textContent = diskPath;
    // The archive is the normal way out; individual files stay one click away.
    const zip = document.createElement('a');
    zip.className = 'g-export-file g-export-bundle';
    zip.href = bundle.url;
    zip.download = bundle.name;
    const kb = Math.max(1, Math.round(bundle.bytes / 1024));
    zip.textContent = `⤓ ${bundle.name} · ${bundle.fileCount} FILES · ${kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}`;

    const list = document.createElement('div');
    list.className = 'g-export-files';
    for (const f of files) {
      const a = document.createElement('a');
      a.className = 'g-export-file';
      a.href = f.url;
      a.download = f.name;
      a.textContent = `⤓ ${f.name}`;
      list.appendChild(a);
    }
    const loose = document.createElement('div');
    loose.className = 'g-hint';
    loose.textContent = 'OR TAKE THEM SEPARATELY:';

    const done = document.createElement('genvy-button') as GenvyButton;
    done.setAttribute('label', 'DONE');
    const row = document.createElement('div');
    row.className = 'g-modal-row';
    row.append(done);
    modal.append(title, where, zip, loose, list, row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const close = () => {
      backdrop.remove();
      if (this.anchorModal === backdrop) this.anchorModal = null;
    };
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop) close();
    });
    done.onClick(() => {
      UISound.play('click');
      close();
    });
  }

  private refreshClipList() {
    if (!this.clipListEl) return;
    const ws = this.activeWs();
    this.clipListEl.innerHTML = '';
    const all = ws?.kept ?? [];
    // The list follows the anchor you are looking at: a sprite with four
    // facings has four sets of clips, and mixing them in one list is noise.
    const facingOf = (c: Clip) => c.dir ?? dirFromCat(c.cat) ?? defaultDirFor(c.cat);
    const perView = this.subjectViews().length > 1;
    const kept = perView ? all.filter((c) => facingOf(c) === this.anchorView) : all;

    if (all.length > 0 && perView) {
      const scope = document.createElement('div');
      scope.className = 'g-hint';
      scope.textContent = `${this.anchorView.toUpperCase()} CLIPS · ${kept.length}/${all.length} TOTAL`;
      this.clipListEl.appendChild(scope);
    }

    if (kept.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'g-hint';
      hint.textContent =
        all.length > 0
          ? `NO ${this.anchorView.toUpperCase()} CLIPS YET — FORGE ONE, OR PICK ANOTHER ANCHOR.`
          : this.active >= 0
            ? `NO CLIPS KEPT FOR V${this.active + 1} YET.`
            : 'NO CLIPS KEPT YET.';
      this.clipListEl.appendChild(hint);
      // Saving still composes EVERY clip, so it stays available.
      if (this.saveBtn) this.saveBtn.style.display = all.length > 0 ? '' : 'none';
      if (this.exportBtn) this.exportBtn.style.display = all.length > 0 ? '' : 'none';
      if (all.length > 0) this.appendClipActions(undefined);
      return;
    }

    const selected = kept.find((k) => k.cat === this.selectedClipCat) ?? kept[0]!;
    this.selectedClipCat = selected.cat;
    if (this.exportBtn) this.exportBtn.style.display = '';

    for (const clip of kept) {
      const line = document.createElement('div');
      line.className = 'g-clip-line';
      const row = document.createElement('div');
      row.className = `g-clip-row${clip === selected ? ' selected' : ''}`;
      const editingThis = this.editMode && this.strip?.cat === clip.cat;
      const facing = clip.dir ?? dirFromCat(clip.cat);
      row.textContent =
        `${editingThis ? '✎ ' : ''}${baseName(clip.cat).toUpperCase()}` +
        `${facing ? ` · ${facing[0]!.toUpperCase()}` : ''} · ${clip.count}F`;
      row.addEventListener('mouseenter', () => UISound.play('hover'));
      row.addEventListener('click', () => {
        UISound.play('click');
        this.selectedClipCat = clip.cat;
        // While editing, switching rows hands the edit session to that clip.
        if (this.editMode && this.strip?.cat !== clip.cat) {
          void this.editClip(clip);
          return;
        }
        this.previewClip(clip);
        this.refreshClipList();
      });
      // Standalone square delete button beside the row, not inside it.
      const del = document.createElement('div');
      del.className = 'g-clip-del';
      del.textContent = '✕';
      del.title = 'DELETE THIS ANIMATION';
      del.addEventListener('mouseenter', () => UISound.play('hover'));
      del.addEventListener('click', () => {
        UISound.play('click');
        this.deleteClip(clip);
      });
      line.append(row, del);
      this.clipListEl.appendChild(line);
    }

    this.appendClipActions(selected);
  }

  /** EDIT (for the selected clip) and SAVE share one full-size action row. */
  private appendClipActions(selected?: Clip) {
    if (!this.clipListEl) return;
    const actions = document.createElement('div');
    actions.className = 'g-clip-actions';
    if (selected) {
      const edit = document.createElement('genvy-button') as GenvyButton;
      edit.setAttribute('label', '✎ EDIT');
      edit.onClick(() => void this.editClip(selected));
      actions.appendChild(edit);
    }
    if (this.saveBtn) {
      actions.appendChild(this.saveBtn);
      this.saveBtn.style.display = '';
    }
    this.clipListEl.appendChild(actions);
  }

  /** Remove one clip; if it was being edited or previewed, clean that up too. */
  private deleteClip(clip: Clip) {
    const ws = this.activeWs();
    if (!ws) return;
    ws.kept = ws.kept.filter((k) => k !== clip);
    if (this.selectedClipCat === clip.cat) this.selectedClipCat = null;

    if (this.strip?.cat === clip.cat) {
      // The deleted clip owned the stage — tear its review down.
      this.strip = null;
      this.stripGroups = null;
      this.editMode = false;
      this.removeLabelLayer();
      this.clearPreviewCanvas();
    }
    if (!this.strip) {
      // Nothing is under review, so the stage is showing either the sprite or
      // a MASTER SHEET that still has the deleted animation's row in it (that
      // file is only rebuilt on SAVE). Put the live sprite up instead of
      // leaving a stale picture on screen.
      void (this.anchors[this.anchorView]
        ? this.showAnchor(this.anchorView)
        : this.showVariantConfirmed());
    }

    // Whatever is selected next takes over the preview; an empty list clears it.
    const next = ws.kept.find((k) => k.cat === this.selectedClipCat) ?? ws.kept[0];
    if (next) {
      this.selectedClipCat = next.cat;
      this.previewClip(next);
    } else {
      this.clearPreviewCanvas();
    }

    this.persistClips(ws);
    this.updateModeButtons(); // also refreshes the clip list
    HudShell.toast(
      this.sessionIsSaved
        ? `${baseName(clip.cat).toUpperCase()} REMOVED — SAVE TO REBUILD THE SPRITE SHEET`
        : `${baseName(clip.cat).toUpperCase()} REMOVED`,
    );
  }

  /** Reopen a kept clip in the strip review for selection/order editing. */
  private async editClip(clip: Clip) {
    await this.busy(`OPENING ${clip.cat.toUpperCase()} FOR EDITING...`, async () => {
      this.strip = clip;
      this.selectedClipCat = clip.cat;
      let groups = clip.groups;
      if (!groups || groups.length === 0) {
        // Older clips predate stored selections — rebuild them via detection.
        const det = await api.detect({ assetId: clip.wsId, sourceFile: clip.rawFile });
        groups = det.boxes.map((b) => [b]);
        clip.groups = groups;
      }
      this.stripGroups = groups;
      this.activeGroup = 0;
      this.sheetBoxes = groups.map((g) => this.unionOf(g));
      this.groupSheetIdx = groups.map((_, i) => i);
      this.shapesDirty = false;
      this.selectionsDirty = false;
      this.editMode = true;
      this.undoStack = [];
      this.updateModeButtons();
      this.animNameIn.value = baseName(clip.cat);
      this.dirSel.value = clip.dir ?? dirFromCat(clip.cat) ?? defaultDirFor(clip.cat);
      if (clip.notes !== undefined) this.notesIn.value = clip.notes;
      await this.showStripReview();
      this.previewClip(clip);
      HudShell.toast(`EDITING ${clip.cat.toUpperCase()} — MANUAL SLICING APPLIES CHANGES`);
    });
  }

  /** Stop and blank the 1:1 preview (e.g. when switching variants). */
  private clearPreviewCanvas() {
    this.previewToken++; // invalidate in-flight preview loads
    window.clearInterval(this.previewTimer);
    const canvas = this.previewCanvas;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Play a clip in the square canvas from its packed single-row strip. */
  private previewClip(clip: Clip) {
    const canvas = this.previewCanvas;
    if (!canvas || clip.order.length === 0) return;
    // Image loads are async: only the most recent preview request may take the
    // canvas (fixes stale repaints when clicking clips during a resample).
    const token = ++this.previewToken;
    const img = new Image();
    img.src = `${fileUrl(`${clip.wsId}/${clip.sheetFile}`)}?t=${Date.now()}`;
    img.onload = () => {
      if (token !== this.previewToken) return;
      window.clearInterval(this.previewTimer);
      // Derive frame size from the actual sheet (single row of `count` frames)
      // so a stale clip record can never stretch or mis-crop the preview.
      const fw = Math.floor(img.width / Math.max(1, clip.count));
      const fh = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      // True-to-size: render at the chosen resolution's native scale, centered;
      // only scale DOWN when the frame is bigger than the box. Never inflate.
      const scale = Math.min(1, canvas.width / fw, canvas.height / fh);
      const dw = fw * scale;
      const dh = fh * scale;
      const dx = (canvas.width - dw) / 2;
      const dy = (canvas.height - dh) / 2;
      let i = 0;
      const draw = () => {
        const local = clip.order[i++ % clip.order.length]!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, local * fw, 0, fw, fh, dx, dy, dw, dh);
      };
      draw();
      this.previewTimer = window.setInterval(draw, 1000 / clip.rate);
    };
  }

  private async assetExists(id: string): Promise<boolean> {
    try {
      await api.getAsset(id);
      return true;
    } catch {
      return false;
    }
  }

  private async saveCharacter() {
    const ws = this.activeWs();
    if (!ws?.wsId || ws.kept.length === 0) return;
    const wsId = ws.wsId;
    const variantTag = `V${this.active + 1}`;
    const target = Number(this.frameSizeSel.value);
    const qualityLabel = target > 0 ? `${target} PX` : 'ORIGINAL';
    await this.busy(`REBUILDING ${variantTag} AT ${qualityLabel} & SAVING...`, async () => {
      // Regenerate every individual animation sprite at the selected quality,
      // so the master sheet and the clips always agree.
      await this.resampleClips(target);

      // Only the frames each clip actually plays go into the master sheet.
      const composed = await api.composeSheet({
        assetId: wsId,
        styleId: this.styleId(),
        parts: ws.kept.map((k) => ({
          file: k.sheetFile,
          frameWidth: k.frameWidth,
          frameHeight: k.frameHeight,
          count: k.count,
          frames: k.order,
        })),
      });

      // Don't re-append the tag to a name that already carries one.
      const base = (this.nameIn.value.trim() || 'Unnamed Sprite').replace(/\s+V\d+$/i, '');
      const name = `${base} ${variantTag}`;
      this.nameIn.value = name;

      // Composed rows hold the selected frames already in playback order.
      const frames: { index: number; name: string }[] = [];
      ws.kept.forEach((k, r) => {
        const range = composed.ranges[r]!;
        for (let pos = 0; pos < range.count; pos++) {
          frames.push({ index: range.start + pos, name: `${k.cat}_${pos}` });
        }
      });

      // What already exists for this workspace? (sheet id == workspace id)
      const existing = await api
        .assetRefs(wsId)
        .catch(() => ({ inbound: [], outbound: [] }) as { inbound: AssetIndexEntry[]; outbound: AssetIndexEntry[] });
      const existingChar = existing.inbound.find((e) => e.type === 'character');
      const existingAnims = existing.inbound.filter((e) => e.type === 'animation');

      // Record which directional anchors exist so later phases can walk them.
      const anchorRefs = Object.fromEntries(
        this.subjectViews().filter((d) => this.anchors[d]).map((d) => [
          d,
          { path: `${wsId}/${this.anchorFile(d)}` },
        ]),
      );
      const sheetPayload = {
        name: `${name} — sheet`,
        description: this.descIn.value,
        tags: this.concept?.tags ?? [],
        image: composed.sheet,
        sourceImage: { path: `${wsId}/variant.png` },
        ...(Object.keys(anchorRefs).length > 0 ? { anchors: anchorRefs } : {}),
        frameWidth: composed.frameWidth,
        frameHeight: composed.frameHeight,
        frames,
        thumbnail: composed.thumbnail,
      };
      const sheet = existing.inbound.length > 0 || (await this.assetExists(wsId))
        ? await api.updateAsset<Spritesheet>(wsId, sheetPayload)
        : await api.createAsset<Spritesheet>('spritesheet', { id: wsId, ...sheetPayload });

      // Upsert one animation per kept clip, matching existing ones by name.
      const animRefs: Record<string, { id: string; type: 'animation' }> = {};
      const usedAnimIds = new Set<string>();
      for (let r = 0; r < ws.kept.length; r++) {
        const k = ws.kept[r]!;
        const range = composed.ranges[r]!;
        const payload = {
          name: `${name} — ${k.cat}`,
          spritesheet: { id: sheet.id, type: 'spritesheet' },
          frames: Array.from({ length: range.count }, (_, pos) => range.start + pos),
          frameRate: k.rate,
          repeat: -1,
          thumbnail: composed.thumbnail,
        };
        const prior = existingAnims.find((e) => e.name.endsWith(`— ${k.cat}`));
        const anim = prior
          ? await api.updateAsset(prior.id, payload)
          : await api.createAsset('animation', payload);
        animRefs[k.cat] = { id: anim.id as string, type: 'animation' };
        usedAnimIds.add(anim.id as string);
      }

      const charPayload = {
        name,
        description: this.descIn.value,
        tags: this.concept?.tags ?? [],
        sheet: { id: sheet.id, type: 'spritesheet' },
        animations: animRefs,
        stats: this.concept?.stats ?? { speed: 160, jumpPower: 400, health: 3 },
        controls: 'platformer',
        thumbnail: composed.thumbnail,
      };
      if (existingChar) await api.updateAsset<Character>(existingChar.id, charPayload);
      else await api.createAsset<Character>('character', charPayload);

      // Drop animations for clips that no longer exist (now unreferenced).
      for (const stale of existingAnims) {
        if (!usedAnimIds.has(stale.id)) await api.deleteAsset(stale.id, { cascade: true });
      }

      this.sessionIsSaved = true;
      this.refreshClipList();
      // Keep previewing whichever clip the user had selected, not the first.
      const current = ws.kept.find((k) => k.cat === this.selectedClipCat) ?? ws.kept[0];
      if (current) this.previewClip(current);
      await HudShell.lootDrop();
      HudShell.toast(
        `${variantTag} SPRITE ${existingChar ? 'UPDATED' : 'SAVED'} AT ${qualityLabel}`,
        'success',
      );
    });
  }

  // ---------------- Loading ----------------

  private async loadExisting(assetId: string, assetType: string) {
    try {
      let sheet: Spritesheet;
      if (assetType === 'character') {
        const chr = await api.getAsset<Character>(assetId);
        this.nameIn.value = chr.name;
        this.descIn.value = chr.description ?? '';
        sheet = await api.getAsset<Spritesheet>(chr.sheet.id);
      } else if (assetType === 'animation') {
        const anim = await api.getAsset<AnimationAsset>(assetId);
        sheet = await api.getAsset<Spritesheet>(anim.spritesheet.id);
        this.nameIn.value = sheet.name;
      } else {
        sheet = await api.getAsset<Spritesheet>(assetId);
        this.nameIn.value = sheet.name;
        this.descIn.value = sheet.description ?? '';
      }
      this.sessionId = sheet.id;
      this.sessionIsSaved = true;
      // Editing an existing asset: no concept/generation panels.
      if (this.conceptPanel) this.conceptPanel.style.display = 'none';
      if (this.blueprintPanel) this.blueprintPanel.style.display = 'none';

      // Re-attach this asset to its forge session so all 4 variants stay
      // switchable on the left while editing.
      let ws: VariantWs = { box: { x: 0, y: 0, w: 0, h: 0 }, wsId: sheet.id, kept: [] };
      this.variants = [ws];
      this.active = 0;
      try {
        const workspaces = await api.listWorkspaces();
        const mine = workspaces.find((w) => w.id === sheet.id);
        const sessionId = mine?.source?.sessionId;
        if (sessionId) {
          this.sessionId = sessionId;
          const det = await api.detect({ assetId: sessionId, sourceFile: 'variants.png' });
          this.variants = det.boxes.map((box) => ({ box, wsId: null, kept: [] }));
          for (const w of workspaces) {
            const idx = w.source?.variantIndex;
            if (w.source?.sessionId !== sessionId || idx === null || idx === undefined) continue;
            const slot = this.variants[idx];
            if (slot) slot.wsId = w.id;
          }
          this.active = Math.max(0, this.variants.findIndex((v) => v.wsId === sheet.id));
          ws = this.variants[this.active]!;
          ws.wsId = sheet.id;
          // No version widget while editing a saved asset — versions are
          // switched through the header inventory (▦) instead.
        }
      } catch {
        /* session link unavailable — single-variant view */
      }

      // Refill the concept panel (describe/lore/image prompt/sliders) from the
      // forge session's concept.json so ◄ VARIANTS doesn't come back blank.
      // Fall back to the workspace copy when the session link is unavailable.
      await this.restoreConcept(this.sessionId);
      if (this.sessionId !== sheet.id && !this.imagePromptIn.value) {
        await this.restoreConcept(sheet.id);
      }

      await this.restoreClips(ws);
      this.ensureAnimPanels();
      this.setStage('editing');
      await this.refreshAnchors();
      // Opened assets start at ORIGINAL size; the dropdown re-samples from there.
      this.frameSizeSel.value = '0';
      this.refreshClipList();

      const key = this.textureKey('master');
      await this.loadTexture(key, `${fileUrl(sheet.image)}?t=${Date.now()}`);
      this.clearStage();
      // The dock columns are symmetrical, so screen center == visual center.
      const { width, height } = this.scale;
      const img = this.add.image(width / 2, height / 2 + 10, key);
      // Natural size, never upscaled — the wheel zooms in crisply on demand.
      const s = Math.min((height - 180) / img.height, (width - 680) / img.width, 1);
      img.setScale(s);
      this.previewImage = img;
      this.captionText = this.add
        .text(img.x, img.y, `FULL SPRITE · ${this.subjectStyleLabel()}`, {
          fontFamily: '"Orbitron", sans-serif',
          fontSize: '13px',
          color: '#1de9ff',
        })
        .setOrigin(0.5);
      this.enableWheelZoom(img);

      // Restored clips get resampled to ORIGINAL from their raws (local, free);
      // the static master sheet is only the fallback when no strips survived.
      if (ws.kept[0]) {
        await this.resampleClips(0);
        this.refreshClipList();
        this.previewClip(ws.kept[0]!);
      } else {
        const refs = await api.listAssets({ type: 'animation' });
        const cols = sheet.image.width ? Math.floor(sheet.image.width / sheet.frameWidth) : 4;
        for (const ref of refs) {
          const anim = await api.getAsset<AnimationAsset>(ref.id);
          if (anim.spritesheet.id !== sheet.id) continue;
          this.playMasterClip(sheet, anim, cols);
          break;
        }
      }
      HudShell.toast(`LOADED: ${sheet.name.toUpperCase()}`);
    } catch {
      HudShell.toast('FAILED TO LOAD ASSET', 'error');
    }
  }

  private playMasterClip(sheet: Spritesheet, anim: AnimationAsset, cols: number) {
    const canvas = this.previewCanvas;
    if (!canvas) return;
    const token = ++this.previewToken;
    const img = new Image();
    img.src = `${fileUrl(sheet.image)}?t=${Date.now()}`;
    img.onload = () => {
      if (token !== this.previewToken) return;
      window.clearInterval(this.previewTimer);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      let i = 0;
      const draw = () => {
        const f = anim.frames[i++ % anim.frames.length]!;
        const sx = (f % cols) * sheet.frameWidth;
        const sy = Math.floor(f / cols) * sheet.frameHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(1, canvas.width / sheet.frameWidth, canvas.height / sheet.frameHeight);
        ctx.drawImage(
          img, sx, sy, sheet.frameWidth, sheet.frameHeight,
          (canvas.width - sheet.frameWidth * scale) / 2,
          (canvas.height - sheet.frameHeight * scale) / 2,
          sheet.frameWidth * scale, sheet.frameHeight * scale,
        );
      };
      draw();
      this.previewTimer = window.setInterval(draw, 1000 / anim.frameRate);
    };
  }

  private async loadRecovered(id: string) {
    // A variant workspace dir (has variant.png) resumes animating; a session
    // dir (has variants.png) resumes at the picker.
    try {
      const res = await fetch(`${fileUrl(`${id}/variant.png`)}?t=${Date.now()}`, { method: 'HEAD' });
      if (res.ok) {
        this.sessionId = id;
        const ws: VariantWs = { box: { x: 0, y: 0, w: 0, h: 0 }, wsId: id, kept: [] };
        this.variants = [ws];
        this.active = 0;
        await this.restoreConcept(id);
        // Re-link the parent session so ◄ VARIANTS reopens the 2x2 picker
        // (and its concept.json wins over the workspace copy when present).
        try {
          const workspaces = await api.listWorkspaces();
          const sessionId = workspaces.find((w) => w.id === id)?.source?.sessionId;
          if (sessionId) {
            this.sessionId = sessionId;
            await this.restoreConcept(sessionId);
          }
        } catch {
          /* grouping unavailable — stay workspace-scoped */
        }
        await this.restoreClips(ws);
        this.ensureAnimPanels();
        this.setStage('editing');
        await this.refreshAnchors();
        this.refreshClipList();
        if (ws.kept[0]) this.previewClip(ws.kept[0]);
        await this.showVariantConfirmed();
        HudShell.toast(
          ws.kept.length > 0
            ? `SESSION RECOVERED — ${ws.kept.length} CLIP${ws.kept.length > 1 ? 'S' : ''} RESTORED`
            : 'SESSION RECOVERED — VARIANT INTACT, FORGE ANIMATIONS',
          'success',
        );
        return;
      }
    } catch {
      /* fall through to session probe */
    }
    try {
      this.sessionId = id;
      await this.restoreConcept(id);
      const det = await api.detect({ assetId: id, sourceFile: 'variants.png' });
      this.variants = det.boxes.map((box) => ({ box, wsId: null, kept: [] }));
      // Re-link workspaces that already exist for this session's variants.
      try {
        const orphans = await api.listOrphans();
        for (const o of orphans) {
          if (o.source?.sessionId !== id || o.source.variantIndex === null) continue;
          const ws = this.variants[o.source.variantIndex];
          if (ws) ws.wsId = o.id;
        }
      } catch {
        /* grouping unavailable — fresh workspaces will be created on click */
      }
      this.setStage('variants');
      await this.showVariantPicker();
      HudShell.toast('SESSION RECOVERED — PICK A VARIANT', 'success');
    } catch {
      HudShell.toast('RECOVERED FILES UNREADABLE', 'error');
    }
  }

  // ---------------- Shared helpers ----------------

  /**
   * Run one operation behind the busy indicator. `timing` turns the bar
   * determinate: it fills over this bucket's learned average duration and the
   * real duration is folded back in afterwards. EVERY AI request (image,
   * video, text — API or local) must pass timing and update the stage text
   * via HudShell.setBusyLabel; see CLAUDE.md "Progress feedback".
   */
  private async busy(
    label: string,
    fn: () => Promise<unknown>,
    timing?: { key: string; fallbackMs: number },
    opts?: { onActivity?: (a: import('@genvy/shared').AiActivityResponse) => void },
  ) {
    HudShell.showBusy(label, timing ? expectedDuration(timing.key, timing.fallbackMs) : undefined);
    // Server truth beats the client's guesses: while the op runs, poll the
    // activity feed — real stage text (retries, candidate 2/4, frame 5/8)
    // replaces the static label, and real step counts drive the bar instead
    // of a learned average that can hit 100% and then wait forever.
    const activityPoll = setInterval(() => {
      void api
        .activity()
        .then((a) => {
          if (!a.active) return;
          if (a.label) HudShell.setBusyLabel(a.label);
          if (a.fraction !== undefined && a.nextFraction !== undefined) {
            HudShell.setBusyProgress(a.fraction, a.nextFraction);
          }
          // Local renders are abortable — surface the red CANCEL.
          if (a.cancelable) HudShell.setBusyCancel(() => void api.cancelAi());
          opts?.onActivity?.(a);
        })
        .catch(() => {
          /* the feed is best-effort */
        });
    }, 1000);
    const started = Date.now();
    let ok = true;
    try {
      await fn();
    } catch (err) {
      ok = false;
      const msg = err instanceof ApiError ? err.message : 'OPERATION FAILED';
      HudShell.toast(msg.toUpperCase().slice(0, 180), 'error');
    } finally {
      clearInterval(activityPoll);
      // Only successful runs teach the estimator; failures end early and would
      // bias the average low.
      if (timing && ok) recordDuration(timing.key, Date.now() - started);
      HudShell.hideBusy();
    }
  }

  private textureKey(file: string) {
    return `sprite:${this.sessionId}:${file}:${Date.now()}`;
  }

  private loadTexture(key: string, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.load.image(key, url);
      this.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
      this.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, () => reject(new Error('texture load failed')));
      this.load.start();
    });
  }

  /** Clear scene-stage objects (image, overlay, zones, caption, DOM labels). */
  /**
   * Stage fit: the image sits in a virtual SQUARE whose side is its largest
   * dimension, and that square is fitted to the stage — so every variant and
   * anchor presents at a consistent size regardless of aspect ratio. Never
   * above 1:1: upscaling only renders the same pixels softer.
   */
  private stageFit(img: Phaser.GameObjects.Image, availW: number, availH: number): number {
    const fit = Math.min(1, Math.min(availW, availH) / Math.max(img.width, img.height));
    // Snap DOWN to the wheel's 10% grid so the opening zoom is a round number.
    return Math.max(0.1, Math.floor(fit * 10) / 10);
  }

  /**
   * Sit the image's top-left edge on a whole pixel. A centered image whose
   * half-size is fractional lands on a half-pixel boundary, and the sampler
   * then blurs EVERY texel by half a pixel — the classic "1:1 but soft" bug.
   */
  private pixelAlign(img: Phaser.GameObjects.Image) {
    img.setPosition(
      Math.round(img.x - img.displayWidth / 2) + img.displayWidth / 2,
      Math.round(img.y - img.displayHeight / 2) + img.displayHeight / 2,
    );
  }

  /**
   * Caption reads "<label> · <zoom>%" so the actual scale is never a mystery.
   * It is a FIXED overlay pinned near the bottom of the stage — it never moves
   * with the image, so a tall or zoomed-in sprite can't push it off-screen.
   */
  private setCaptionZoom(img: Phaser.GameObjects.Image) {
    if (!this.captionText || this.previewImage !== img) return;
    const base = (this.captionText.getData('base') as string) ?? this.captionText.text;
    this.captionText.setData('base', base);
    this.captionText.setText(`${base} · ${Math.round(img.scaleX * 100)}%`);
    this.captionText.setPosition(this.scale.width / 2, this.scale.height - 64);
    this.captionText.setDepth(10);
    // Legible over whatever the sprite puts behind it.
    this.captionText.setStyle({ backgroundColor: 'rgba(2,10,16,0.78)' });
    this.captionText.setPadding(10, 5, 10, 5);
  }

  /**
   * Scroll-wheel zoom on the stage image. Images render at natural size (never
   * auto-upscaled — inflating past 1:1 only makes the same pixels bigger and
   * softer); the wheel is the deliberate way to magnify, in crisp
   * nearest-neighbor steps around the image's center.
   */
  private enableWheelZoom(img: Phaser.GameObjects.Image, onZoom?: () => void) {
    if (this.zoomHandler) this.input.off('wheel', this.zoomHandler);
    this.zoomHandler = (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      if (!img.active) return;
      // Steps of exactly 10%, snapped to the 10% grid so a view opened at an
      // odd fit percentage lands back on round values (94% -> 90% -> 80%...).
      const step = dy > 0 ? -0.1 : 0.1;
      const snapped = Math.round((img.scaleX + step) * 10) / 10;
      const next = Phaser.Math.Clamp(snapped, 0.1, 8);
      if (next === img.scaleX) return;
      img.setScale(next);
      this.pixelAlign(img);
      this.setCaptionZoom(img);
      onZoom?.();
    };
    this.input.on('wheel', this.zoomHandler);
    this.setCaptionZoom(img);
  }

  private clearStage() {
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.setScroll(0, 0);
    if (this.zoomHandler) {
      this.input.off('wheel', this.zoomHandler);
      this.zoomHandler = null;
    }
    this.detachReviewKeys();
    this.previewImage?.destroy();
    this.previewImage = null;
    this.overlayGfx?.destroy();
    this.overlayGfx = null;
    this.pivotGfx?.destroy();
    this.pivotGfx = null;
    for (const z of this.hitZones) z.destroy();
    this.hitZones = [];
    this.captionText?.destroy();
    this.captionText = null;
    this.removeLabelLayer();
  }

  private removeLabelLayer() {
    this.labelLayer?.remove();
    this.labelLayer = null;
  }
}
