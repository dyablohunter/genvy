import Phaser from 'phaser';
import type {
  Tileset,
  World,
  TilesetConcept,
  Scene,
  ImageProviderStatus,
} from '@genvy/shared';
import {
  buildWorldGrid,
  SCENE_MASK_KINDS,
  maskKindsForView,
  shapeOutline,
  pointInShape,
  fillMaskPolygon,
  sceneSegments,
  type SceneShape,
  type SceneSegment,
  type Character,
  type WorldProp,
} from '@genvy/shared';

/** Which way a strip travels, and which side an extension grows towards. */
type StripAxis = 'horizontal' | 'vertical';
type StripDirection = 'right' | 'left' | 'down' | 'up';

/** Round a point to whole image pixels — shapes are stored as integers. */
const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
import { HudShell } from '../../hud/HudShell.js';
import type { BusyStepState } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { expectedDuration, recordDuration } from '../../hud/progress.js';
import { goToScene, enterScene, registerAssetOpenHandlers } from '../../hud/transitions.js';
import { api, fileUrl, ApiError } from '../../api/client.js';
import { collection } from '../../state/collection.js';
import { saveDraft, loadDraft, clearDraft, packGrid, unpackGrid } from '../../state/drafts.js';
import { ProviderControls } from '../../hud/providerControls.js';
import { buildScenePanel } from './scenePanel.js';
import { SceneDummy } from '../dummy.js';
import type { DummyOptions } from '../dummy.js';
import {
  field,
  textInput,
  textArea,
  numberInput,
  forgeStatus,
  progressBar,
  autoGrow,
  GenvyButton,
} from '../../hud/components.js';

interface WorldToolData {
  assetId?: string;
  assetType?: string;
}

const GRID_COLS = 4;
const GRID_ROWS = 6;

type PaintTool = 'brush' | 'erase' | 'fill';
/** Cell tools paint the grid mask; vector tools produce SceneShapes. */
type MaskTool = 'freehand' | 'line' | 'shape' | 'rect' | 'triangle' | 'circle' | 'fill';
const VECTOR_TOOLS: MaskTool[] = ['shape', 'rect', 'triangle', 'circle'];
/** What a colliding TILE reports as: the dummy treats it like painted solid. */
const SOLID_KIND = SCENE_MASK_KINDS.find((k) => k.key === 'solid')?.id ?? 1;

export class WorldToolScene extends Phaser.Scene {
  private tileset: Tileset | null = null;
  private tilesetKey = '';
  private concept: TilesetConcept | null = null;
  private worldId: string | null = null;

  private map: Phaser.Tilemaps.Tilemap | null = null;
  /** Faint tile grid drawn under the layers. */
  private gridGfx: Phaser.GameObjects.Graphics | null = null;
  private layers: Phaser.Tilemaps.TilemapLayer[] = [];
  private activeLayer = 0;
  private selectedTile = 0;
  private tool: PaintTool = 'brush';
  private painting = false;
  /** Painting at the edge extends the map instead of being clipped. */
  private autoGrow = false;

  private worldNameIn = textInput('New World', '');
  private widthIn = numberInput(40, 8, 200);
  private heightIn = numberInput(23, 8, 200);
  private paletteHost: HTMLElement | null = null;
  // The concept blueprint: visible and editable before any image spend.
  /**
   * Painting undo: a snapshot of every layer taken before each stroke (and
   * before any structural change like deleting a tile). Bounded, because a
   * 200x200 map is 40k numbers per layer per entry.
   */
  private undoStack: { layers: number[][][]; props: WorldProp[] }[] = [];
  /** Stretched-tile props: one tile drawn over a block of cells. */
  private props: WorldProp[] = [];
  private propImages: Phaser.GameObjects.Image[] = [];
  /** One prop per click — a drag must not smear a trail of them. */
  private propStamped = false;
  /** Wide brush behaviour in tile modes: repeat the tile, or stretch one. */
  private stretchTiles = false;
  private static readonly UNDO_LIMIT = 40;
  private conceptFields: HTMLElement | null = null;
  private editTextsBtn: GenvyButton | null = null;
  /** Spawn points from the last generated plan; saved with the world. */
  private plannedSpawns: { name: string; x: number; y: number }[] = [];
  private conceptNameIn = textInput('', '');
  private conceptPromptIn = textArea('', '');
  private conceptTilesIn = textArea('', '');
  private toolButtons = new Map<PaintTool, GenvyButton>();
  /** Provider/model/size/quality controls shared with the Sprite Forge. */
  private providerControls: ProviderControls | null = null;
  /** Which kind of level is being built: a tilemap or a painted scene. */
  private mode: 'tilemap' | 'scene' | 'mixed' = 'tilemap';
  private modeButtons = new Map<'tilemap' | 'scene' | 'mixed', GenvyButton>();
  /**
   * Two steps, like the sprite forge: CONCEPT (choose the kind of level and
   * write/generate its texts) and EDIT (the tools). Forging moves forward;
   * EDIT CONCEPT moves back.
   */
  private stage: 'concept' | 'edit' = 'concept';
  /** Mixed mode paints two things; this says which the tools hit. */
  private paintTarget: 'tiles' | 'zones' = 'tiles';

  /** A painted backdrop exists in this mode. */
  private get sceneActive() {
    return this.mode !== 'tilemap';
  }

  /** Tile layers exist in this mode. */
  private get tilesActive() {
    return this.mode !== 'scene';
  }

  /** What a stroke writes right now: mask zones, or tiles. */
  private get paintingZones() {
    return this.mode === 'scene' || (this.mode === 'mixed' && this.paintTarget === 'zones');
  }
  private tilesetPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private worldPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private modePanel: ReturnType<typeof HudShell.makePanel> | null = null;
  /** Step 1 as one centred panel, the way the sprite forge opens. */
  private conceptPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private tilesetSection: HTMLElement | null = null;
  private sceneSection: HTMLElement | null = null;
  /** The edit stage's tile picker, split out of the concept panel. */
  private palettePanel: ReturnType<typeof HudShell.makePanel> | null = null;
  /** The picker half of it — hidden when there are no tiles to pick. */
  private paletteSection: HTMLElement | null = null;
  private scenePanel: ReturnType<typeof buildScenePanel> | null = null;
  private sceneImage: Phaser.GameObjects.Image | null = null;
  /** Every panel of the open strip, in travel order. */
  private sceneImages: Phaser.GameObjects.Image[] = [];
  /** Total extent of the strip in image pixels — the mask spans all of it. */
  private stripSize = { width: 0, height: 0 };
  /** The timeline band, when a looping scene is open. */
  private timelineEl: HTMLElement | null = null;
  /** The hover card carrying the actions for whichever panel is under the pointer. */
  private timelineCard: HTMLElement | null = null;
  /** Pending dismissal of that card, cancelled while the pointer is on it. */
  private cardHideTimer: number | null = null;
  /** The playtest figure walking the painted collision, when one is out. */
  private dummy: SceneDummy | null = null;
  /** The X that leaves fullscreen playtest; exists only while in it. */
  private playtestExit: HTMLElement | null = null;
  /** Its neighbour: shows/hides the painted overlays mid-playtest. */
  private playtestMask: HTMLElement | null = null;
  /** The panel's OVERLAY toggle, kept in step with the playtest one. */
  private overlayBtn: GenvyButton | null = null;

  /**
   * Show or hide the painted overlays — a VIEW switch only. Collision is
   * read from the mask data, never from these pixels, so the dummy walks the
   * same level either way. Both toggles (the panel's and the playtest's)
   * route through here so they can never disagree about the state.
   */
  private setOverlayVisible(visible: boolean) {
    this.maskVisible = visible;
    this.maskGfx?.setVisible(this.sceneActive && visible);
    this.shapeGfx?.setVisible(this.sceneActive && visible);
    if (visible) this.overlayBtn?.removeAttribute('data-off');
    else this.overlayBtn?.setAttribute('data-off', '');
    this.playtestMask?.classList.toggle('off', !visible);
  }
  /** Unsaved strokes exist; the next autosave tick writes them to a draft. */
  private draftDirty = false;
  private draftTimer: number | null = null;
  private draftFlusher: (() => void) | null = null;

  /**
   * Last mouse position in CSS pixels, tracked on the WINDOW. Phaser's own
   * pointer goes quiet when the mouse is over the HUD or holds still, and
   * edge-panning has to keep flowing while the mouse HOLDS STILL at an edge
   * and stop the instant it is over a panel instead of the canvas.
   */
  private edgePointer: { x: number; y: number; overCanvas: boolean } | null = null;
  private edgePointerHandler: ((ev: MouseEvent) => void) | null = null;
  /** Cropping one panel: which, the drag, and the overlay drawing it. */
  private crop: {
    index: number;
    start: { x: number; y: number } | null;
    rect: { x: number; y: number; w: number; h: number } | null;
    gfx: Phaser.GameObjects.Graphics;
  } | null = null;
  /** Which panel the timeline has selected. */
  private activeSegment = 0;
  private activeScene: Scene | null = null;
  /** Gameplay mask over a painted scene: rows of SCENE_MASK_KINDS ids. */
  private mask: number[][] = [];
  private maskCell = 16;
  private maskKind = 1;
  private brushSize = 1;
  private maskVisible = true;
  private maskGfx: Phaser.GameObjects.Graphics | null = null;
  private maskPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private maskKindButtons = new Map<number, GenvyButton>();
  private sceneNameInput: HTMLInputElement | null = null;
  /** The PAINT AS row, rebuilt whenever the scene's view changes. */
  private kindRow: HTMLElement | null = null;
  /** Whether the row shows every layer or just this view's. */
  private showAllKinds = false;
  private onKindPicked: (() => void) | null = null;
  /** Friction stamped onto new shapes; null = the layer's own default. */
  private shapeFriction: number | null = null;
  private brushSel: HTMLSelectElement | null = null;
  /** Step 1's theme box, so a draft can restore it. */
  private themeIn: HTMLTextAreaElement | null = null;
  /** Tile resolution for the next forge; existing tilesets keep their own. */
  private tileSizeSel: HTMLSelectElement | null = null;
  /** Which mask tool is armed. See MaskTool. */
  private maskTool: MaskTool = 'freehand';
  /** The pen path's open anchor, if a path is being laid. */
  private penAnchor: { x: number; y: number } | null = null;
  /**
   * The SHAPE pen's open outline in IMAGE PIXELS, not cells — a traced cave
   * floor must follow the art, and cell-snapped points come out ragged at any
   * grid size.
   */
  private penPoints: { x: number; y: number }[] = [];
  /** Vector collision shapes on the open scene. */
  private shapes: SceneShape[] = [];
  private shapeGfx: Phaser.GameObjects.Graphics | null = null;
  /**
   * Which way the triangle tool points. Set explicitly by the arrow keys —
   * inferring it from the drag direction made placing a ramp finicky, because
   * the same gesture has to size the shape AND aim it.
   */
  private triangleDir: 'up' | 'down' | 'left' | 'right' = 'up';
  /** In-progress primitive drag: start point and current point, image px. */
  private shapeDrag: { start: { x: number; y: number }; now: { x: number; y: number } } | null =
    null;
  /** Held SPACE pans the view and suspends painting (image-editor behaviour). */
  private spacePanning = false;
  /** Held SHIFT constrains to straight lines and squares, as in Photoshop. */
  private shiftKey: Phaser.Input.Keyboard.Key | null = null;
  /** Where the current freehand stroke began, for SHIFT's axis lock. */
  private strokeOrigin: { x: number; y: number } | null = null;
  /** Last cell touched in the current stroke, for interpolation. */
  private lastMaskCell: { x: number; y: number } | null = null;
  /** Ring showing the pen's nib and size under the cursor. */
  private brushCursor: Phaser.GameObjects.Graphics | null = null;
  /** Mask snapshots for undo, one per stroke. */
  private maskUndo: { mask: number[][]; shapes: SceneShape[]; segments: SceneSegment[] }[] = [];

  constructor() {
    super('worldTool');
  }

  create(data: WorldToolData) {
    enterScene(this);
    this.resetState();

    HudShell.setBackVisible(true);
    HudShell.setStatus('WORLD MAKER');
    HudShell.hideDrawer();
    HudShell.onBackToHub = () => void goToScene(this, 'hub');
    // One shared routing table — see transitions.ts. Hand-rolled per-scene
    // branches are what made some inventory clicks do nothing.
    registerAssetOpenHandlers(this);

    // World Maker has MODES, because 2D levels are built in more than one
    // way: a tilemap (grid, autotiling, collision flags) and a painted scene
    // (one backdrop the camera pans across). They share the collection and
    // the provider controls, not their editors.
    const scenePanel = buildScenePanel({
      display: (scene) => this.displayScene(scene),
      current: () => this.activeScene,
      busy: (label, fn, timing) => this.busy(null, label, fn, timing),
    });
    this.scenePanel = scenePanel;
    // Step 1 is ONE centred panel: the mode choice and the concept fields of
    // whichever crafts that mode needs, transplanted out of their panels so
    // the step reads as a single screen rather than two docked columns.
    this.modePanel = this.buildModePanel();
    const tilesetPanel = this.buildTilesetPanel();
    const conceptPanel = HudShell.makePanel('01 · CONCEPT', 'center');
    this.conceptPanel = conceptPanel;
    // Panels build their .gp-body only when CONNECTED; before that their
    // content sits as direct children. Wrap those, not a body that does not
    // exist yet — querying it here silently killed the whole create().
    const sectionOf = (panel: HTMLElement) => {
      const section = document.createElement('div');
      section.className = 'g-field-stack';
      section.append(...Array.from(panel.childNodes));
      return section;
    };
    const modeSection = sectionOf(this.modePanel);
    this.tilesetSection = sectionOf(tilesetPanel);
    this.sceneSection = sectionOf(scenePanel.panel);
    conceptPanel.append(modeSection, this.tilesetSection, this.sceneSection);

    // Re-assert the current stage once the layout has actually mounted:
    // setLayout re-docks panels asynchronously, and whatever showPanel did
    // before that would be overridden (the sprite forge learned this first).
    void HudShell.setLayout([
      conceptPanel,
      this.buildPalettePanel(),
      this.buildWorldPanel(),
      this.buildMaskPanel(),
    ]).then(() => {
      this.refreshStage();
      this.restoreConceptDraft();
    });
    this.setMode('tilemap');
    this.setupCameraControls();
    this.setupPainting();
    // Crash insurance: unsaved strokes go to a draft every few seconds and
    // on the way out of the page. The library stays the truth — the draft is
    // only the bridge to the next SAVE.
    this.draftTimer = window.setInterval(() => {
      if (this.draftDirty) this.writeDraft();
    }, 4000);
    this.draftFlusher = () => {
      if (this.draftDirty) this.writeDraft();
    };
    window.addEventListener('beforeunload', this.draftFlusher);
    document.addEventListener('visibilitychange', this.draftFlusher);

    this.edgePointerHandler = (ev: MouseEvent) => {
      this.edgePointer = {
        x: ev.clientX,
        y: ev.clientY,
        overCanvas: ev.target === this.game.canvas,
      };
    };
    window.addEventListener('mousemove', this.edgePointerHandler);
    // Opening or closing a timeline band resizes the canvas: re-fit the strip
    // so the level does not end up half off-screen when the layout changes.
    const refit = () => {
      if (!this.sceneActive || this.sceneImages.length === 0) return;
      // Fullscreen keeps its edge-to-edge fit; the editor keeps its framing.
      if (this.inPlaytest) this.fitPlaytest();
      else this.frameStrip();
    };
    this.scale.on(Phaser.Scale.Events.RESIZE, refit);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.scale.off(Phaser.Scale.Events.RESIZE, refit),
    );
    // The pickers are empty until the roster arrives — without this the
    // provider/model/quality selects render as blank boxes.
    void this.loadProviders();

    if (data?.assetId) void this.loadExisting(data.assetId, data.assetType ?? '');
  }

  update(_time: number, delta: number) {
    this.edgePan(delta);
    if (!this.dummy?.active) return;
    this.dummy.update(delta);
    const cam = this.cameras.main;
    const p = this.dummy.position;
    if (this.activeScene?.view === 'side') {
      // A side-scroller's camera IS the player's position: locked to centre,
      // as the game will hold it. A drifting camera here would be testing a
      // camera the game does not have.
      cam.centerOn(p.x, p.y);
    } else {
      // Overhead maps pan freely, so the follow stays gentle.
      cam.scrollX += (p.x - (cam.scrollX + cam.width / 2 / cam.zoom)) * 0.06;
      cam.scrollY += (p.y - (cam.scrollY + cam.height / 2 / cam.zoom)) * 0.06;
    }
  }

  /**
   * Fill the viewport with the LEVEL, not with empty world: a horizontal
   * side-scroller stretches to full height and scrolls along its length, a
   * vertical one to full width — and the camera is fenced to the strip, so
   * the void beyond the artwork never shows.
   */
  private fitPlaytest() {
    const { width, height } = this.stripSize;
    if (width < 1 || height < 1) return;
    const cam = this.cameras.main;
    const vertical = this.activeScene?.loop === 'vertical';
    cam.setZoom(vertical ? this.scale.width / width : this.scale.height / height);
    cam.setBounds(0, 0, width, height);
  }

  /** Hand the whole viewport to the playtest: no panels, no band, just game. */
  private enterPlaytest() {
    document.body.classList.add('g-playtest');
    this.fitPlaytest();
    if (!this.playtestExit) {
      const x = document.createElement('div');
      x.className = 'g-playtest-exit';
      x.textContent = '✕';
      x.title = 'Back to the editor (ESC)';
      x.addEventListener('click', () => {
        UISound.play('click');
        this.exitPlaytest();
      });
      document.getElementById('app')?.appendChild(x);
      this.playtestExit = x;

      // Toggle the overlays without touching what they MEAN: collision is
      // read from the mask data, not from these pixels, so the dummy walks
      // the same level either way — this only decides whether you SEE it.
      const m = document.createElement('div');
      m.className = `g-playtest-mask g-playtest-exit${this.maskVisible ? '' : ' off'}`;
      m.textContent = '▦';
      m.title = 'Show/hide the collision overlays (collision itself stays on)';
      m.addEventListener('click', () => {
        UISound.play('click');
        this.setOverlayVisible(!this.maskVisible);
        m.classList.toggle('off', !this.maskVisible);
      });
      document.getElementById('app')?.appendChild(m);
      this.playtestMask = m;
    }
  }

  /** Bring the editor back; the dummy stays out until dismissed itself. */
  private exitPlaytest() {
    if (!this.inPlaytest) return;
    document.body.classList.remove('g-playtest');
    this.playtestExit?.remove();
    this.playtestExit = null;
    this.playtestMask?.remove();
    this.playtestMask = null;
    // The editor pans freely again, and gets its framing back.
    this.cameras.main.removeBounds();
    this.frameStrip();
  }

  private get inPlaytest() {
    return document.body.classList.contains('g-playtest');
  }

  /**
   * Playtest setup: pick a body, size it, set the jump, then walk the level.
   * A mask is only right when something walks on it, and painting collision
   * without ever feeling it is how a level ships with a hole in the floor.
   */
  private openDummyModal() {
    // The button is a toggle: with a dummy out, pressing it again clears the
    // stage instead of stacking a second figure on the first.
    if (this.dummy?.active) {
      this.dummy.destroy();
      this.dummy = null;
      UISound.play('click');
      HudShell.toast('DUMMY REMOVED');
      return;
    }
    const scene = this.activeScene;
    if (!scene && !this.map) {
      return HudShell.toast('PAINT A SCENE OR BUILD A MAP FIRST', 'error');
    }
    // Physics, stated plainly. GRAVITY is the one that changes the game:
    // with it the level is a platformer (ground, one-way platforms, a jump);
    // without it the figure simply walks in all eight directions, which is
    // what an overhead map wants — and also how a flying or swimming
    // character gets tested on a side level.
    const gravitySel = document.createElement('select');
    for (const [value, label] of [
      ['1', 'NORMAL — PLATFORMER'],
      ['0.5', 'LOW — FLOATY'],
      ['1.8', 'HIGH — HEAVY'],
      ['0', 'NONE — WALK IN ALL DIRECTIONS'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      gravitySel.appendChild(opt);
    }
    // A scene's own framing proposes the default; it stays changeable.
    if (scene && scene.view !== 'side') gravitySel.value = '0';

    const jumpsSel = document.createElement('select');
    for (const [value, label] of [
      ['1', 'SINGLE'],
      ['2', 'DOUBLE'],
      ['3', 'TRIPLE'],
      ['0', 'NONE'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      jumpsSel.appendChild(opt);
    }

    const speedSel = document.createElement('select');
    for (const [value, label] of [
      ['1', 'NORMAL'],
      ['0.6', 'SLOW'],
      ['1.6', 'FAST'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      speedSel.appendChild(opt);
    }

    const frictionCheck = document.createElement('input');
    frictionCheck.type = 'checkbox';
    frictionCheck.checked = true;
    const frictionLabel = document.createElement('label');
    frictionLabel.style.display = 'flex';
    frictionLabel.style.alignItems = 'center';
    frictionLabel.style.gap = '8px';
    frictionLabel.style.cursor = 'pointer';
    const frictionText = document.createElement('span');
    frictionText.className = 'g-hint';
    frictionText.style.margin = '0';
    frictionText.textContent = 'SURFACES SLIDE — USE EACH LAYER’S FRICTION (ICE, RAMPS)';
    frictionLabel.append(frictionCheck, frictionText);

    const gravityField = field('GRAVITY', gravitySel);
    const jumpsField = field('JUMPS', jumpsSel);
    const physicsRow = document.createElement('div');
    physicsRow.style.display = 'flex';
    physicsRow.style.gap = '8px';
    for (const f of [gravityField, jumpsField]) {
      f.style.flex = '1 1 50%';
      f.style.minWidth = '0';
    }
    physicsRow.append(gravityField, jumpsField);

    const syncPhysics = () => {
      // Without gravity there is nothing to jump against, and nothing to
      // fall back down to — so the jump controls step aside entirely.
      const hasGravity = Number(gravitySel.value) > 0;
      jumpsSel.disabled = !hasGravity;
      jumpsField.style.opacity = hasGravity ? '1' : '0.45';
      const canJump = hasGravity && Number(jumpsSel.value) > 0;
      jumpIn.disabled = !canJump;
      jumpField.style.opacity = canJump ? '1' : '0.45';
    };
    for (const sel of [gravitySel, jumpsSel]) {
      sel.addEventListener('change', () => {
        UISound.play('click');
        syncPhysics();
      });
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'g-modal g-modal-narrow';
    const titleRow = document.createElement('div');
    titleRow.className = 'g-modal-titlerow';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = 'PLAYTEST DUMMY';
    const closeX = document.createElement('div');
    closeX.className = 'g-modal-close';
    closeX.textContent = '✕';
    titleRow.append(title, closeX);
    const close = () => backdrop.remove();

    // The body: the built-in stick figure, or a character that can actually
    // BE a dummy. A forged character is really a family — "Name V1".."V4"
    // are separate assets — so the picker offers the FAMILY and a VERSION
    // beside it, the same way the inventory presents them. Only versions
    // with a walk clip are selectable: one that cannot walk would glide
    // around frozen, which reads as a bug in the playtest, not the asset.
    // Unqualified versions stay listed, disabled, WITH the reason — silently
    // missing looks lost, not unqualified.
    const charSel = document.createElement('select');
    const stick = document.createElement('option');
    stick.value = '';
    stick.textContent = 'STICK FIGURE (BUILT IN)';
    charSel.appendChild(stick);

    const versionSel = document.createElement('select');
    type Version = { id: string; label: string; walks: boolean };
    const families = new Map<string, Version[]>();

    const syncVersions = () => {
      versionSel.replaceChildren();
      const versions = families.get(charSel.value) ?? [];
      versionSel.disabled = versions.length === 0;
      if (versions.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '—';
        versionSel.appendChild(opt);
        return;
      }
      for (const v of versions) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.walks ? v.label : `${v.label} · NO WALK CLIP`;
        opt.disabled = !v.walks;
        versionSel.appendChild(opt);
      }
      // Newest walking version first serve: that is the one being iterated on.
      const best = [...versions].reverse().find((v) => v.walks);
      if (best) versionSel.value = best.id;
    };
    charSel.addEventListener('change', () => {
      UISound.play('click');
      syncVersions();
    });

    void (async () => {
      const entries = collection.entries.filter((e) => e.type === 'character');
      const checked = await Promise.all(
        entries.map(async (entry) => {
          try {
            const c = await api.getAsset<Character>(entry.id);
            return { entry, walks: Boolean(c.animations['walk']) };
          } catch {
            return { entry, walks: false };
          }
        }),
      );
      for (const { entry, walks } of checked) {
        const base = entry.name.replace(/\s+V\d+$/i, '');
        const version = /\s(V\d+)$/i.exec(entry.name)?.[1]?.toUpperCase() ?? 'V1';
        const list = families.get(base) ?? [];
        list.push({ id: entry.id, label: version, walks });
        list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        families.set(base, list);
      }
      for (const [base, versions] of families) {
        const opt = document.createElement('option');
        opt.value = base;
        const anyWalks = versions.some((v) => v.walks);
        opt.textContent = anyWalks ? base.toUpperCase() : `${base.toUpperCase()} · NO WALK CLIP`;
        opt.disabled = !anyWalks;
        charSel.appendChild(opt);
      }
      syncVersions();
    })();
    syncVersions();

    const heightIn = numberInput(64, 16, 512);
    const jumpIn = numberInput(120, 16, 1024);
    // syncPhysics below decides whether this is live: jumping needs gravity
    // to jump against, and at least one jump allowed.
    const jumpField = field('JUMP HEIGHT (PX)', jumpIn);
    jumpField.title = 'HOW HIGH A JUMP REACHES, IN LEVEL PIXELS';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    const heightField = field('HEIGHT (PX)', heightIn);
    for (const f of [heightField, jumpField]) {
      f.style.flex = '1 1 50%';
      f.style.minWidth = '0';
    }
    row.append(heightField, jumpField);

    // The level on the game's own terms: no docks, no band, just viewport.
    const fullLabel = document.createElement('label');
    fullLabel.style.display = 'flex';
    fullLabel.style.alignItems = 'center';
    fullLabel.style.gap = '8px';
    fullLabel.style.cursor = 'pointer';
    const fullCheck = document.createElement('input');
    fullCheck.type = 'checkbox';
    const fullText = document.createElement('span');
    fullText.className = 'g-hint';
    fullText.style.margin = '0';
    fullText.textContent = 'FULL VIEWPORT — HIDE ALL UI (ESC OR ✕ RETURNS)';
    fullLabel.append(fullCheck, fullText);

    const spawnBtn = document.createElement('genvy-button') as GenvyButton;
    spawnBtn.setAttribute('variant', 'accent');
    spawnBtn.setAttribute('label', 'SPAWN');
    spawnBtn.onClick(() => {
      UISound.play('confirm');
      close();
      if (fullCheck.checked) this.enterPlaytest();
      void this.spawnDummy({
        characterId: charSel.value ? versionSel.value || null : null,
        height: Number(heightIn.value) || 64,
        jumpHeight: Number(jumpIn.value) || 120,
        gravity: Number(gravitySel.value),
        jumps: Number(jumpsSel.value) || 0,
        speed: Number(speedSel.value) || 1,
        useFriction: frictionCheck.checked,
      });
    });

    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent =
      'ARROWS OR WASD MOVE, SHIFT RUNS, SPACE JUMPS. WITHOUT GRAVITY THE FIGURE WALKS IN ALL ' +
      'DIRECTIONS INSTEAD. SPAWNS AT THE PLAYER SPAWN (✦) OR THE CENTRE. ESC REMOVES IT.';

    closeX.addEventListener('click', () => {
      UISound.play('click');
      close();
    });
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop) close();
    });

    const stack = document.createElement('div');
    stack.className = 'g-field-stack';
    const whoRow = document.createElement('div');
    whoRow.style.display = 'flex';
    whoRow.style.gap = '8px';
    const charField = field('CHARACTER', charSel);
    const versionField = field('VERSION', versionSel);
    charField.style.flex = '2 1 0';
    versionField.style.flex = '1 1 0';
    for (const f of [charField, versionField]) f.style.minWidth = '0';
    whoRow.append(charField, versionField);
    stack.append(
      whoRow,
      physicsRow,
      field('MOVE SPEED', speedSel),
      row,
      frictionLabel,
      fullLabel,
      spawnBtn,
      hint,
    );
    syncPhysics();
    modal.append(titleRow, stack);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  /** The first painted player spawn: a shape's centre wins, then a mask cell. */
  private findPlayerSpawn(): { x: number; y: number } | null {
    const spawnId = SCENE_MASK_KINDS.find((k) => k.key === 'spawnPlayer')?.id ?? 8;
    const shape = this.shapes.find((sh) => sh.kind === spawnId);
    if (shape) {
      const outline = shapeOutline(shape);
      if (shape.type === 'circle' && shape.points[0]) return { ...shape.points[0] };
      if (outline.length > 0) {
        const x = outline.reduce((s, p) => s + p.x, 0) / outline.length;
        const y = outline.reduce((s, p) => s + p.y, 0) / outline.length;
        return { x, y };
      }
    }
    for (let y = 0; y < this.mask.length; y++) {
      for (let x = 0; x < (this.mask[y]?.length ?? 0); x++) {
        if (this.mask[y]![x] === spawnId) {
          return { x: (x + 0.5) * this.maskCell, y: (y + 0.5) * this.maskCell };
        }
      }
    }
    // A tilemap has no painted spawn: use the planned player point, which a
    // generated layout provides in TILE coordinates.
    const ts = this.tileset;
    const player = this.plannedSpawns.find((p) => p.name === 'player') ?? this.plannedSpawns[0];
    if (player && ts) {
      return { x: (player.x + 0.5) * ts.tileWidth, y: (player.y + 0.5) * ts.tileHeight };
    }
    return null;
  }

  /** The pixel extent of whatever is being walked: the strip, or the map. */
  private levelBounds(): { width: number; height: number } {
    if (this.sceneActive && this.stripSize.width > 0) return this.stripSize;
    const ts = this.tileset;
    if (this.map && ts) {
      return { width: this.map.width * ts.tileWidth, height: this.map.height * ts.tileHeight };
    }
    return { width: 0, height: 0 };
  }

  /**
   * Collision at a world point, from every source the level has: painted
   * zones, vector shapes, and TILES flagged as colliding. A tilemap's
   * collision is the tiles themselves — which is what lets the dummy walk a
   * level that has no painted mask at all.
   */
  private collisionAt(x: number, y: number): number {
    if (this.sceneActive) {
      const cx = Math.floor(x / this.maskCell);
      const cy = Math.floor(y / this.maskCell);
      const painted = this.mask[cy]?.[cx] ?? 0;
      if (painted !== 0) return painted;
    }
    if (this.tilesActive && this.map && this.tileset) {
      const tx = Math.floor(x / this.tileset.tileWidth);
      const ty = Math.floor(y / this.tileset.tileHeight);
      for (const layer of this.layers) {
        const index = layer.getTileAt(tx, ty)?.index ?? -1;
        if (index >= 0 && this.tileset.tiles.find((t) => t.index === index)?.collides) {
          return SOLID_KIND;
        }
      }
    }
    return 0;
  }

  private async spawnDummy(opts: DummyOptions) {
    const bounds = this.levelBounds();
    if (bounds.width < 1) return HudShell.toast('NOTHING TO WALK ON YET', 'error');
    this.dummy?.destroy();
    const at = this.findPlayerSpawn();
    if (!at) {
      HudShell.toast('NO PLAYER SPAWN — SPAWNING AT THE CENTRE', 'warn');
    }
    const spawn = at ?? { x: bounds.width / 2, y: bounds.height / 2 };
    const dummy = new SceneDummy(this, opts, {
      maskAt: (x, y) => this.collisionAt(x, y),
      shapes: () => this.shapes,
      // The dummy asks the view only to describe itself; gravity is what
      // actually decides how it moves, and that comes from the options.
      view: () => (opts.gravity > 0 ? 'side' : 'topdown'),
      bounds: () => this.levelBounds(),
    });
    await dummy.spawn(spawn.x, spawn.y);
    this.dummy = dummy;
    HudShell.toast(
      'DUMMY OUT — WASD/ARROWS, SHIFT RUNS' +
        (opts.gravity > 0 && opts.jumps > 0 ? ', SPACE JUMPS' : ''),
    );
  }

  /**
   * Nudge the camera when the mouse sits within a few pixels of the canvas
   * edge — the standard map-editor autoscroll, so a stroke or a shape can
   * keep going past the visible edge without letting go of the tool.
   */
  private edgePan(deltaMs: number) {
    const p = this.edgePointer;
    // Painted mode only. In tilemap mode the pointer commutes constantly
    // between the map and the palette, and every trip across the canvas edge
    // scooted the map out from under the next click.
    if (this.mode !== 'scene') return;
    // Not while something else owns the camera: the pan grab, or the dummy's
    // follow — autoscroll under those reads as the view running away.
    if (!p || !p.overCanvas || this.spacePanning || this.dummy?.active) return;
    const rect = this.game.canvas.getBoundingClientRect();
    const margin = 5; // CSS px, as specified
    const dx = p.x - rect.left < margin ? -1 : rect.right - p.x < margin ? 1 : 0;
    const dy = p.y - rect.top < margin ? -1 : rect.bottom - p.y < margin ? 1 : 0;
    if (dx === 0 && dy === 0) return;
    const cam = this.cameras.main;
    // Slow and steady, in SCREEN terms: ~260 CSS px/s whatever the zoom.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const step = (260 * dpr * (deltaMs / 1000)) / cam.zoom;
    cam.scrollX += dx * step;
    cam.scrollY += dy * step;
  }

  /** The draft key for what is on the stage right now, or null. */
  private draftKey(): string | null {
    if (!this.tilesActive) {
      return this.activeScene ? `world:scene:${this.activeScene.id}` : null;
    }
    if (!this.map || !this.tileset) return null;
    return this.worldId ? `world:world:${this.worldId}` : `world:new:${this.tileset.id}`;
  }

  /** Park the unsaved layer of the current session in localStorage. Mixed
   * mode has BOTH kinds of unsaved work, so both drafts are written. */
  private writeDraft() {
    if (this.sceneActive && this.activeScene) {
      saveDraft(`world:scene:${this.activeScene.id}`, {
        name: this.sceneNameInput?.value ?? '',
        maskCell: this.maskCell,
        mask: packGrid(this.mask),
        shapes: this.shapes,
      });
    }
    if (this.tilesActive && this.map && this.tileset) {
      saveDraft(this.worldId ? `world:world:${this.worldId}` : `world:new:${this.tileset.id}`, {
        name: this.worldNameIn.value,
        layers: this.layers.map((l) => packGrid(this.layerToData(l))),
        spawns: this.plannedSpawns,
        props: this.props,
      });
    }
    this.draftDirty = false;
  }

  /** Restore a parked scene draft over what the asset holds, if one exists. */
  private restoreSceneDraft() {
    const scene = this.activeScene;
    if (!scene) return;
    const draft = loadDraft<{ name: string; maskCell: number; mask: string; shapes: SceneShape[] }>(
      `world:scene:${scene.id}`,
    );
    if (!draft) return;
    const d = draft.data;
    if (d.maskCell === this.maskCell && d.mask) {
      const grid = unpackGrid(d.mask);
      // Only where the geometry still agrees — a re-painted scene of a new
      // size makes the old strokes meaningless.
      if (grid.length === this.mask.length && (grid[0]?.length ?? 0) === (this.mask[0]?.length ?? 0)) {
        this.mask = grid;
      }
    }
    if (Array.isArray(d.shapes)) this.shapes = d.shapes;
    if (d.name && this.sceneNameInput) this.sceneNameInput.value = d.name;
    this.drawMask();
    this.drawShapes();
    const mins = Math.max(1, Math.round((Date.now() - draft.savedAt) / 60000));
    HudShell.toast(`UNSAVED WORK FROM ${mins} MIN AGO RESTORED — SAVE SCENE TO KEEP IT`, 'warn');
  }

  /** Restore a parked tilemap draft onto the freshly built layers. */
  private restoreWorldDraft() {
    const key = this.draftKey();
    if (!key || !this.tilesActive) return;
    const draft = loadDraft<{
      name: string;
      layers: string[];
      spawns: { name: string; x: number; y: number }[];
      props?: WorldProp[];
    }>(key);
    if (!draft) return;
    const d = draft.data;
    d.layers?.forEach((packed, li) => {
      const layer = this.layers[li];
      if (!layer) return;
      unpackGrid(packed).forEach((row, y) => {
        row.forEach((index, x) => {
          if (x >= layer.tilemap.width || y >= layer.tilemap.height) return;
          if (index < 0) layer.removeTileAt(x, y);
          else layer.putTileAt(index, x, y);
        });
      });
    });
    if (d.name) this.worldNameIn.value = d.name;
    if (Array.isArray(d.spawns) && d.spawns.length > 0) this.plannedSpawns = d.spawns;
    if (Array.isArray(d.props)) {
      this.props = d.props;
      this.drawProps();
    }
    const mins = Math.max(1, Math.round((Date.now() - draft.savedAt) / 60000));
    HudShell.toast(`UNSAVED WORK FROM ${mins} MIN AGO RESTORED — SAVE WORLD TO KEEP IT`, 'warn');
  }

  /** The band lives on the HUD root, so leaving the tool must take it down. */
  shutdown() {
    document.body.classList.remove('g-page-scroll');
    this.exitPlaytest();
    if (this.draftDirty) this.writeDraft();
    if (this.draftTimer !== null) window.clearInterval(this.draftTimer);
    this.draftTimer = null;
    if (this.draftFlusher) {
      window.removeEventListener('beforeunload', this.draftFlusher);
      document.removeEventListener('visibilitychange', this.draftFlusher);
      this.draftFlusher = null;
    }
    if (this.edgePointerHandler) {
      window.removeEventListener('mousemove', this.edgePointerHandler);
      this.edgePointerHandler = null;
    }
    this.edgePointer = null;
    this.dummy?.destroy();
    this.dummy = null;
    this.keepCard();
    this.timelineEl?.remove();
    this.timelineEl = null;
    this.timelineCard = null;
    document.body.classList.remove('g-timeline-left', 'g-timeline-bottom');
  }

  private resetState() {
    this.tileset = null;
    this.tilesetKey = '';
    this.concept = null;
    this.worldId = null;
    this.map = null;
    this.gridGfx = null;
    this.layers = [];
    this.activeLayer = 0;
    this.selectedTile = 0;
    this.tool = 'brush';
    this.painting = false;
    this.autoGrow = false;
    this.worldNameIn = textInput('New World', '');
    this.widthIn = numberInput(40, 8, 200);
    this.heightIn = numberInput(23, 8, 200);
    this.paletteHost = null;
    this.conceptFields = null;
    this.editTextsBtn = null;
    this.plannedSpawns = [];
    this.providerControls = null;
    this.mode = 'tilemap';
    this.stage = 'concept';
    this.paintTarget = 'tiles';
    this.modeButtons = new Map();
    this.tilesetPanel = null;
    this.worldPanel = null;
    this.modePanel = null;
    this.conceptPanel = null;
    this.tilesetSection = null;
    this.sceneSection = null;
    this.palettePanel = null;
    this.paletteSection = null;
    this.scenePanel = null;
    this.sceneImage = null;
    this.sceneImages = [];
    this.stripSize = { width: 0, height: 0 };
    this.timelineEl?.remove();
    this.timelineEl = null;
    this.timelineCard = null;
    this.cardHideTimer = null;
    this.dummy?.destroy();
    this.dummy = null;
    this.crop?.gfx.destroy();
    this.crop = null;
    this.activeSegment = 0;
    this.activeScene = null;
    this.mask = [];
    this.maskCell = 16;
    this.maskKind = 1;
    this.brushSize = 1;
    this.maskVisible = true;
    this.maskGfx = null;
    this.maskPanel = null;
    this.overlayBtn = null;
    this.maskKindButtons = new Map();
    this.sceneNameInput = null;
    this.kindRow = null;
    this.showAllKinds = false;
    this.onKindPicked = null;
    this.shapeFriction = null;
    this.brushSel = null;
    this.themeIn = null;
    this.tileSizeSel = null;
    this.maskTool = 'freehand';
    this.penAnchor = null;
    this.penPoints = [];
    this.shapes = [];
    this.shapeGfx = null;
    this.shapeDrag = null;
    this.spacePanning = false;
    this.shiftKey = null;
    this.strokeOrigin = null;
    this.lastMaskCell = null;
    this.brushCursor = null;
    this.maskUndo = [];
    this.undoStack = [];
    this.props = [];
    this.propImages = [];
    this.propStamped = false;
    this.toolButtons = new Map();
  }

  /** Read the live provider roster once and fill every image control set. */
  private async loadProviders() {
    let providers: ImageProviderStatus[] = [];
    try {
      providers = (await api.health()).ai.providers ?? [];
    } catch {
      // Offline: the controls stay empty and the guards block paid work.
    }
    this.providerControls?.setProviders(providers);
    this.scenePanel?.controls.setProviders(providers);
  }

  /**
   * Scene-mode tools: paint the gameplay layer over the artwork. A painted
   * backdrop is only a picture until something says which pixels are solid.
   */
  private buildMaskPanel() {
    const panel = HudShell.makePanel('04 · PAINTING', 'right');
    this.maskPanel = panel;

    // Mixed mode paints two different things; every stroke needs to know
    // which. TILES hits the grid, ZONES hits the collision layer on top.
    const targetRow = document.createElement('div');
    targetRow.className = 'g-row';
    const targetButtons = new Map<'tiles' | 'zones', GenvyButton>();
    for (const [id, label] of [
      ['tiles', 'PAINT TILES'],
      ['zones', 'PAINT ZONES'],
    ] as const) {
      const btn = document.createElement('genvy-button') as GenvyButton;
      btn.setAttribute('label', label);
      btn.style.flex = '1 1 50%';
      btn.onClick(() => {
        UISound.play('click');
        this.paintTarget = id;
        this.endPenPath(true);
        for (const [otherId, b] of targetButtons) {
          b.setAttribute('variant', otherId === id ? 'accent' : '');
        }
        this.refreshToolsPanel();
      });
      targetButtons.set(id, btn);
      targetRow.appendChild(btn);
    }
    targetButtons.get('tiles')?.setAttribute('variant', 'accent');

    const kindRow = document.createElement('div');
    kindRow.className = 'g-row';
    kindRow.style.flexWrap = 'wrap';
    this.kindRow = kindRow;
    this.onKindPicked = () => eraseBtn.setAttribute('variant', '');
    this.renderKindRow();

    // Friction rides on SHAPES, not cells: a cell holds one id and nothing
    // else, while a traced ramp can say how slippery that particular ramp is.
    const frictionSel = document.createElement('select');
    for (const [value, label] of [
      ['', 'DEFAULT FOR THE LAYER'],
      ['0.1', 'ICE · 0.1'],
      ['0.4', 'SLICK · 0.4'],
      ['0.7', 'LOOSE · 0.7'],
      ['1', 'NORMAL · 1.0'],
      ['1.4', 'GRIPPY · 1.4'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      frictionSel.appendChild(opt);
    }
    frictionSel.addEventListener('change', () => {
      UISound.play('click');
      this.shapeFriction = frictionSel.value === '' ? null : Number(frictionSel.value);
    });
    const frictionField = field('SURFACE FRICTION (SHAPES)', frictionSel);

    // Brush size in MASK CELLS, so it means the same thing at any zoom.
    const brushSel = document.createElement('select');
    for (const [size, label] of [
      [1, '1 CELL · FINE'],
      [2, '2 CELLS'],
      [3, '3 CELLS'],
      [5, '5 CELLS'],
      [8, '8 CELLS'],
      [12, '12 CELLS · BROAD'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = String(size);
      opt.textContent = label;
      brushSel.appendChild(opt);
    }
    brushSel.addEventListener('change', () => {
      UISound.play('click');
      this.brushSize = Number(brushSel.value) || 1;
    });
    this.brushSel = brushSel;

    // Cell size is the mask's resolution: finer costs more cells to paint.
    const cellSel = document.createElement('select');
    for (const [size, label] of [
      [4, '4 PX · FINEST'],
      [8, '8 PX · PRECISE'],
      [16, '16 PX · BALANCED'],
      [32, '32 PX · COARSE'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = String(size);
      opt.textContent = label;
      if (size === 16) opt.selected = true;
      cellSel.appendChild(opt);
    }
    cellSel.addEventListener('change', () => {
      UISound.play('click');
      const scene = this.activeScene;
      const img = this.sceneImage;
      if (!scene || !img) return;
      // Changing resolution restarts the mask — say so rather than silently
      // resampling into something the user did not paint.
      this.maskCell = Number(cellSel.value) || 16;
      // Vector shapes are resolution-independent, so they survive this.
      this.initMask({ ...scene, mask: undefined, shapes: this.shapes }, img.width, img.height);
      HudShell.toast('MASK RESOLUTION CHANGED — PREVIOUS PAINTING CLEARED', 'warn');
    });

    // Square icon buttons, not squeezed words: six tools do not fit as text
    // in a panel column, and a tool bar reads faster as glyphs anyway.
    const penRow = document.createElement('div');
    penRow.className = 'g-icon-row';
    const penButtons = new Map<MaskTool, GenvyButton>();
    for (const [id, icon, hint] of [
      ['freehand', '✎', 'BRUSH — drag to paint mask cells'],
      ['line', '∠', 'PEN · PATH — click point to point along an edge; ESC ends it'],
      ['shape', '⬠', 'PEN · SHAPE — trace an outline, click point 1 to close and fill (vector)'],
      ['rect', '▭', 'RECTANGLE — drag a box (vector)'],
      ['triangle', '△', 'TRIANGLE — drag toward where the tip should point (vector)'],
      ['circle', '◯', 'CIRCLE — drag from the centre (vector)'],
      ['fill', '▨', 'FILL — flood a connected region'],
    ] as const) {
      const btn = document.createElement('genvy-button') as GenvyButton;
      btn.classList.add('g-icon');
      btn.setAttribute('label', icon);
      btn.title = hint;
      btn.onClick(() => {
        UISound.play('click');
        this.maskTool = id;
        this.endPenPath(true);
        for (const [otherId, b] of penButtons) {
          b.setAttribute('variant', otherId === id ? 'accent' : '');
        }
        this.showToolHint(id);
      });
      penButtons.set(id, btn);
      penRow.appendChild(btn);
    }
    penButtons.get('freehand')?.setAttribute('variant', 'accent');

    const eraseBtn = document.createElement('genvy-button') as GenvyButton;
    eraseBtn.setAttribute('label', 'ERASER');
    eraseBtn.onClick(() => {
      UISound.play('click');
      this.tool = this.tool === 'erase' ? 'brush' : 'erase';
      eraseBtn.setAttribute('variant', this.tool === 'erase' ? 'accent' : '');
      if (this.tool === 'erase') {
        HudShell.keyHint(
          '<div class="row"><div class="pair"><div class="key">⌫</div>' +
            '<div class="cap">ERASER</div></div></div>',
          VECTOR_TOOLS.includes(this.maskTool)
            ? 'CLICK A SHAPE TO DELETE IT'
            : 'PAINTS CELLS EMPTY INSTEAD OF FILLING THEM',
          7500,
        );
      } else {
        this.showToolHint(this.maskTool, 6500);
      }
    });

    // One word, two states: struck through when the overlay is hidden.
    const showBtn = document.createElement('genvy-button') as GenvyButton;
    showBtn.setAttribute('label', 'OVERLAY');
    this.overlayBtn = showBtn;
    showBtn.onClick(() => {
      UISound.play('click');
      this.setOverlayVisible(!this.maskVisible);
    });

    const clearBtn = document.createElement('genvy-button') as GenvyButton;
    clearBtn.setAttribute('variant', 'danger');
    clearBtn.setAttribute('label', 'CLEAR ALL');
    clearBtn.onClick(() => {
      UISound.play('click');
      this.pushMaskUndo();
      for (const row of this.mask) row.fill(0);
      this.shapes = [];
      this.endPenPath(true);
      this.drawMask();
      this.drawShapes();
      this.draftDirty = true;
      HudShell.toast('MASK AND SHAPES CLEARED');
    });

    // Saving is the panel's headline action, so it sits at the top with the
    // name beside it rather than buried under six paint controls.
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'SCENE NAME';
    nameInput.addEventListener('input', () => (this.draftDirty = true));
    this.sceneNameInput = nameInput;

    const saveBtn = document.createElement('genvy-button') as GenvyButton;
    saveBtn.setAttribute('variant', 'accent');
    saveBtn.setAttribute('label', 'SAVE SCENE');
    saveBtn.onClick(() => void this.saveMask());

    const toolRow = document.createElement('div');
    toolRow.className = 'g-row';
    for (const b of [eraseBtn, showBtn]) {
      b.style.flex = '1 1 50%';
      toolRow.appendChild(b);
    }


    const backBtn = document.createElement('genvy-button') as GenvyButton;
    backBtn.setAttribute('label', '✎ EDIT CONCEPT');
    backBtn.title = 'Back to step 1: mode, texts, view and canvas';
    backBtn.onClick(() => {
      UISound.play('click');
      this.setStage('concept');
    });
    const layerSel = document.createElement('select');
    for (const [value, label] of [
      ['0', 'GROUND'],
      ['1', 'DECOR'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      layerSel.appendChild(opt);
    }
    layerSel.addEventListener('change', () => {
      UISound.play('click');
      this.activeLayer = Number(layerSel.value) || 0;
    });
    const layerField = field('LAYER', layerSel);
    layerField.dataset.tiles = '1';

    // A wide brush can repeat the tile or stretch ONE across the stamp. That
    // used to be an invisible consequence of the brush size; now it is asked.
    const stampSel = document.createElement('select');
    for (const [value, label] of [
      ['repeat', 'REPEAT THE TILE'],
      ['stretch', 'STRETCH ONE TILE'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      stampSel.appendChild(opt);
    }
    stampSel.addEventListener('change', () => {
      UISound.play('click');
      this.stretchTiles = stampSel.value === 'stretch';
    });
    const stampField = field('WIDE BRUSH', stampSel);
    stampField.dataset.tiles = '1';

    const nameField = field('SCENE NAME', nameInput);
    const kindField = field('PAINT AS', kindRow);
    const cellField = field('MASK RESOLUTION', cellSel);
    panel.append(
      targetRow,
      layerField,
      nameField,
      saveBtn,
      kindField,
      field('TOOL', penRow),
      frictionField,
      field('BRUSH SIZE', brushSel),
      stampField,
      cellField,
      toolRow,
      clearBtn,
    );
    // Which sections belong only to ZONE painting: in tile modes the panel
    // keeps just the tools, the brush size and the eraser — the rest of the
    // painting experience is identical between the two crafts.
    for (const el of [nameField, saveBtn, kindField, frictionField, cellField, showBtn, clearBtn]) {
      if (el instanceof HTMLElement) el.dataset.zones = '1';
    }
    targetRow.dataset.mixed = '1';
    this.refreshToolsPanel();
    return panel;
  }

  /**
   * Build the PAINT AS row for the open scene's view.
   *
   * A side-scroller is authored as negative space (paint what blocks); a
   * top-down or isometric map is the opposite — the walkable path is a sliver
   * of the image, so painting where actors MAY go beats fencing off
   * everything they may not. Offering one fixed list forced the wrong one of
   * those on half the scenes, so the roster follows the view, with every
   * layer still one click away.
   */
  private renderKindRow() {
    const row = this.kindRow;
    if (!row) return;
    row.replaceChildren();
    // Square glyphs, like the tool bar: a dozen word-buttons do not fit a
    // panel column, and each one's name is a tooltip and a toast away.
    row.className = 'g-icon-row';
    this.maskKindButtons.clear();
    const view = this.activeScene?.view ?? 'side';
    const kinds = this.showAllKinds ? [...SCENE_MASK_KINDS] : maskKindsForView(view);
    // Keep the armed layer valid when the view narrows the list.
    if (!kinds.some((k) => k.id === this.maskKind)) this.maskKind = kinds[0]?.id ?? 1;

    for (const kind of kinds) {
      const btn = document.createElement('genvy-button') as GenvyButton;
      btn.classList.add('g-icon');
      btn.setAttribute('label', kind.icon);
      btn.title = `${kind.label} — ${kind.hint}`;
      // The layer's own colour, so the row reads as the palette it is.
      btn.style.setProperty('--g-kind', kind.color);
      btn.onClick(() => {
        UISound.play('click');
        this.maskKind = kind.id;
        this.tool = 'brush';
        this.onKindPicked?.();
        for (const [id, b] of this.maskKindButtons) {
          b.setAttribute('variant', id === kind.id ? 'accent' : '');
        }
        this.setTool('brush');
        HudShell.toast(`${kind.label} · ${kind.hint.toUpperCase()}`);
      });
      this.maskKindButtons.set(kind.id, btn);
      row.appendChild(btn);
    }

    // A word button, kept out of the glyph row so the grid stays even.
    const more = document.createElement('genvy-button') as GenvyButton;
    more.style.flexBasis = '100%';
    more.setAttribute('label', this.showAllKinds ? `LAYERS FOR ${view.toUpperCase()}` : 'ALL LAYERS');
    more.title = 'Show every layer, or only the ones this view usually needs';
    more.onClick(() => {
      UISound.play('click');
      this.showAllKinds = !this.showAllKinds;
      this.renderKindRow();
    });
    row.appendChild(more);
    this.maskKindButtons.get(this.maskKind)?.setAttribute('variant', 'accent');
  }

  /** Bring back unsaved step-1 text after a crash or a closed tab. */
  private restoreConceptDraft() {
    const draft = loadDraft<{
      theme: string;
      name: string;
      art: string;
      tiles: string;
      tileSize: string;
    }>('world:concept');
    if (!draft) return;
    const d = draft.data;
    if (!d.theme && !d.art && !d.tiles) return;
    if (d.theme && this.themeIn) this.themeIn.value = d.theme;
    if (d.name) this.conceptNameIn.value = d.name;
    if (d.art) this.conceptPromptIn.value = d.art;
    if (d.tiles) this.conceptTilesIn.value = d.tiles;
    if (d.tileSize && this.tileSizeSel) this.tileSizeSel.value = d.tileSize;
    if ((d.art || d.tiles) && this.conceptFields) {
      this.conceptFields.style.display = '';
      this.syncConceptFromFields();
    }
    for (const el of [this.themeIn, this.conceptPromptIn, this.conceptTilesIn]) {
      if (el) autoGrow.refresh(el);
    }
    HudShell.toast('UNSAVED CONCEPT TEXT RESTORED', 'warn');
  }

  /**
   * The edit stage's left panel: the way back to step 1, the playtest dummy,
   * and — in tile modes — the tile picker. It is present in every mode, so
   * these two actions live in one predictable place.
   */
  private buildPalettePanel() {
    const panel = HudShell.makePanel('01 · TILES', 'left');
    this.palettePanel = panel;

    const dummyBtn = document.createElement('genvy-button') as GenvyButton;
    dummyBtn.setAttribute('label', 'DUMMY');
    dummyBtn.title = 'Drop a controllable test character onto the level';
    dummyBtn.onClick(() => {
      UISound.play('click');
      this.openDummyModal();
    });

    const editBtn = document.createElement('genvy-button') as GenvyButton;
    editBtn.setAttribute('label', '✎ EDIT CONCEPT');
    editBtn.title = 'Back to step 1: rewrite the texts, re-forge the sheet';
    this.editTextsBtn = editBtn;
    editBtn.onClick(() => {
      const ts = this.tileset;
      UISound.play('click');
      if (ts && this.conceptFields) {
        // Seed from the SAVED asset so edits apply to what is on disk.
        this.conceptNameIn.value = ts.name;
        this.conceptPromptIn.value = ts.description;
        this.conceptTilesIn.value = ts.tiles.map((t) => t.name).join('\n');
        this.conceptFields.style.display = '';
        for (const el of [this.conceptPromptIn, this.conceptTilesIn]) autoGrow.refresh(el);
        // The fields now describe the SAVED tileset; make that the concept so
        // re-forging draws what is on screen.
        this.concept = null;
        this.syncConceptFromFields();
      }
      this.setStage('concept');
    });

    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent = 'CLICK A TILE TO PAINT WITH IT. RIGHT-CLICK TOGGLES COLLISION (RED DOT).';

    this.paletteHost = document.createElement('div');
    // The picker and its instruction belong to tile modes only; the buttons
    // above them belong to every mode.
    this.paletteSection = document.createElement('div');
    this.paletteSection.className = 'g-field-stack';
    this.paletteSection.append(hint, this.paletteHost);
    panel.append(editBtn, dummyBtn, this.paletteSection);
    return panel;
  }

  /**
   * The painting panel serves BOTH crafts now: in tile modes it keeps only
   * what paints tiles (tools, brush size, eraser); the zone-only sections —
   * layers, friction, mask resolution, saving the scene — stay for painted
   * work. Mixed mode adds the switch saying which of the two a stroke hits.
   */
  private refreshToolsPanel() {
    const panel = this.maskPanel;
    if (!panel) return;
    // Zone sections follow the SCENE's existence, not the current target:
    // in mixed mode both crafts are in play, so both toolsets stay to hand.
    panel.querySelectorAll<HTMLElement>('[data-zones]').forEach((el) => {
      el.style.display = this.sceneActive ? '' : 'none';
    });
    panel.querySelectorAll<HTMLElement>('[data-tiles]').forEach((el) => {
      el.style.display = this.tilesActive ? '' : 'none';
    });
    panel.querySelectorAll<HTMLElement>('[data-mixed]').forEach((el) => {
      el.style.display = this.mode === 'mixed' ? '' : 'none';
    });
  }

  /** Mode switch: a tilemap level and a painted scene are different crafts. */
  private buildModePanel() {
    const panel = HudShell.makePanel('MODE', 'left');
    const row = document.createElement('div');
    row.className = 'g-row';
    for (const [mode, label] of [
      ['tilemap', 'TILEMAP'],
      ['scene', 'PAINTED'],
      ['mixed', 'MIXED'],
    ] as const) {
      const btn = document.createElement('genvy-button') as GenvyButton;
      btn.setAttribute('label', label);
      btn.onClick(() => {
        UISound.play('click');
        this.setMode(mode);
      });
      this.modeButtons.set(mode, btn);
      row.appendChild(btn);
    }
    panel.append(row);
    return panel;
  }

  private setMode(mode: 'tilemap' | 'scene' | 'mixed') {
    this.mode = mode;
    // Mixed starts on tiles: the backdrop goes in first, zones come after.
    if (mode !== 'mixed') this.paintTarget = mode === 'scene' ? 'zones' : 'tiles';
    for (const [id, btn] of this.modeButtons) {
      btn.setAttribute('variant', id === mode ? 'accent' : '');
    }
    this.refreshStage();
  }

  private setStage(stage: 'concept' | 'edit') {
    this.stage = stage;
    this.refreshStage();
  }

  /**
   * One choreography for (stage x mode): which panels are up, which world
   * objects are visible. Hide, never destroy — switching must not throw away
   * a painted map or a loaded scene.
   */
  private refreshStage() {
    for (const panel of [this.conceptPanel, this.worldPanel, this.maskPanel, this.palettePanel]) {
      if (panel) HudShell.hidePanel(panel);
    }

    const concept = this.stage === 'concept';
    // Step 1 owns the screen: the page scrolls behind a pinned canvas, the
    // panel sits centred and wide, exactly like the sprite forge's opening.
    document.body.classList.toggle('g-page-scroll', concept);
    if (concept) {
      if (this.conceptPanel) {
        HudShell.showPanel(this.conceptPanel, 'center');
        this.conceptPanel.style.width = 'min(720px, 90vw)';
      }
      if (this.tilesetSection) this.tilesetSection.style.display = this.tilesActive ? '' : 'none';
      if (this.sceneSection) this.sceneSection.style.display = this.sceneActive ? '' : 'none';
    } else {
      if (this.palettePanel) {
        HudShell.showPanel(this.palettePanel, 'left');
        // The panel is named for the KIND of level being built, so the
        // header always answers "what am I making?".
        this.palettePanel.setTitle(
          `01 · ${{ tilemap: 'TILEMAP', scene: 'PAINTED', mixed: 'MIXED' }[this.mode]}`,
        );
      }
      if (this.paletteSection) {
        this.paletteSection.style.display = this.tilesActive ? '' : 'none';
      }
      if (this.tilesActive && this.worldPanel) HudShell.showPanel(this.worldPanel, 'right');
      if (this.maskPanel) HudShell.showPanel(this.maskPanel, 'right');
      this.refreshToolsPanel();
    }

    // World objects. In mixed the backdrop sits BEHIND the tile layers.
    const showTiles = this.tilesActive && !concept;
    const showScene = this.sceneActive && !concept;
    for (const layer of this.layers) layer.setVisible(showTiles);
    for (const img of this.propImages) img.setVisible(showTiles);
    this.gridGfx?.setVisible(showTiles);
    for (const img of this.sceneImages) {
      img.setVisible(showScene);
      img.setDepth(this.mode === 'mixed' ? -5 : 0);
    }
    this.maskGfx?.setVisible(showScene && this.maskVisible);
    this.shapeGfx?.setVisible(showScene && this.maskVisible);

    if (!this.sceneActive) {
      this.dummy?.destroy();
      this.dummy = null;
      this.exitPlaytest();
    }
    this.brushCursor?.clear();
    this.endPenPath(true);
    this.renderTimeline();
    HudShell.hideKeyHint();
    this.restoreCursor();
  }

  // ---------------- Scene collision mask ----------------

  /** Start (or restore) the mask grid for a scene at its natural resolution. */
  private initMask(scene: Scene, imgWidth: number, imgHeight: number) {
    const cellSize = scene.mask?.cellSize ?? 16;
    const width = Math.max(1, Math.ceil(imgWidth / cellSize));
    const height = Math.max(1, Math.ceil(imgHeight / cellSize));
    const saved = scene.mask?.data;
    this.maskCell = cellSize;
    this.mask = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => saved?.[y]?.[x] ?? 0),
    );
    this.shapes = (scene.shapes ?? []).map((sh) => ({
      ...sh,
      points: sh.points.map((p) => ({ ...p })),
    }));
    this.drawMask();
    this.drawShapes();
  }

  /** Repaint the translucent overlay from the mask grid. */
  private drawMask() {
    this.maskGfx?.destroy();
    if (this.mask.length === 0) return;
    const g = this.add.graphics();
    g.setDepth(20); // above the artwork
    const size = this.maskCell;
    // Merge each row's runs into one rect. A filled shape at 4px cells is
    // tens of thousands of cells; one draw call each would stall the editor.
    for (let y = 0; y < this.mask.length; y++) {
      const row = this.mask[y]!;
      let x = 0;
      while (x < row.length) {
        const id = row[x]!;
        if (id === 0) {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < row.length && row[end] === id) end++;
        const kind = SCENE_MASK_KINDS.find((k) => k.id === id);
        if (kind) {
          g.fillStyle(Number(`0x${kind.color.slice(1)}`), 0.45);
          g.fillRect(x * size, y * size, (end - x) * size, size);
        }
        x = end;
      }
    }
    g.setVisible(this.sceneActive && this.maskVisible);
    this.maskGfx = g;
  }

  /** Stamp one round brush dab centred on a mask cell. */
  private stampMask(cx: number, cy: number, value: number): boolean {
    // brushSize is the DIAMETER in cells, stepping by one — an even size
    // centres between cells, which is why the centre is fractional.
    const d = this.brushSize;
    const off = (d - 1) / 2;
    const rr = (d / 2) * (d / 2) + 0.01;
    let changed = false;
    for (let y = cy - Math.floor(off); y <= cy + Math.ceil(off); y++) {
      for (let x = cx - Math.floor(off); x <= cx + Math.ceil(off); x++) {
        if (y < 0 || x < 0 || y >= this.mask.length || x >= this.mask[0]!.length) continue;
        // Round nib, not a square block: a square brush cannot follow a
        // slope cleanly, which is most of what collision painting is.
        const dx = x - (cx - Math.floor(off) + off);
        const dy = y - (cy - Math.floor(off) + off);
        if (dx * dx + dy * dy > rr) continue;
        if (this.mask[y]![x] === value) continue;
        this.mask[y]![x] = value;
        changed = true;
      }
    }
    return changed;
  }

  /** The mask cell under the pointer, or null when no scene is loaded. */
  private maskCellAt(pointer: Phaser.Input.Pointer): { x: number; y: number } | null {
    if (this.mask.length === 0) return null;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return {
      x: Math.floor(world.x / this.maskCell),
      y: Math.floor(world.y / this.maskCell),
    };
  }

  /** What a dab writes right now: the chosen kind, or 0 while erasing. */
  private maskValue() {
    return this.tool === 'erase' ? 0 : this.maskKind;
  }

  /** Stamp every dab along a straight run of cells (Bresenham-ish). */
  private strokeBetween(
    from: { x: number; y: number },
    to: { x: number; y: number },
    value: number,
  ): boolean {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    if (steps === 0) return this.stampMask(to.x, to.y, value);
    let changed = false;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = Math.round(from.x + (to.x - from.x) * t);
      const iy = Math.round(from.y + (to.y - from.y) * t);
      if (this.stampMask(ix, iy, value)) changed = true;
    }
    return changed;
  }

  /**
   * The PEN's click behaviour: each click lays a straight segment from the
   * last anchor, so long edges — a floor, a ramp, a wall — are two clicks
   * rather than a shaky freehand drag. ESC or right-click ends the path.
   */
  private penClick(pointer: Phaser.Input.Pointer) {
    const raw = this.paintCellAt(pointer);
    if (!raw) return;
    const cell = this.constrainAxis(this.penAnchor, raw);
    if (this.paintingZones) {
      const value = this.maskValue();
      this.pushMaskUndo();
      const changed = this.penAnchor
        ? this.strokeBetween(this.penAnchor, cell, value)
        : this.stampMask(cell.x, cell.y, value);
      if (changed) {
        this.drawMask();
        this.draftDirty = true;
      }
    } else {
      // The same segment pen, writing TILES: a floor is two clicks here too.
      this.pushUndo();
      const from = this.penAnchor ?? cell;
      const steps = Math.max(Math.abs(cell.x - from.x), Math.abs(cell.y - from.y));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        this.stampTiles(
          Math.round(from.x + (cell.x - from.x) * t),
          Math.round(from.y + (cell.y - from.y) * t),
        );
      }
      this.draftDirty = true;
    }
    this.penAnchor = cell;
    UISound.play('click');
  }

  /** ALT+click for the path pen: let go of the anchor without ending anything. */
  private dropPenAnchor() {
    if (!this.penAnchor) return;
    this.penAnchor = null;
    UISound.play('click');
    HudShell.toast('ANCHOR DROPPED — NEXT CLICK STARTS FRESH');
  }

  /**
   * ALT+click for the shape pen: delete the outline point under the cursor.
   * Uses the same screen-constant tolerance as closing, so a point is as
   * easy to remove as point 1 is to hit.
   */
  private deletePenPoint(pointer: Phaser.Input.Pointer) {
    if (this.penPoints.length === 0) return;
    const at = this.pixelAt(pointer);
    const reach = this.closeTolerance() * 1.5;
    let nearest = -1;
    let best = reach;
    for (let i = 0; i < this.penPoints.length; i++) {
      const d = Math.hypot(this.penPoints[i]!.x - at.x, this.penPoints[i]!.y - at.y);
      if (d <= best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest < 0) return;
    this.penPoints.splice(nearest, 1);
    UISound.play('click');
    if (this.penPoints.length === 0) HudShell.toast('OUTLINE CLEARED');
  }

  /** Drop the pen's open path (ESC, right-click, tool or mode change). */
  private endPenPath(quiet = false) {
    const had = this.penAnchor !== null || this.penPoints.length > 0 || this.shapeDrag !== null;
    this.penAnchor = null;
    this.penPoints = [];
    this.shapeDrag = null;
    if (had && !quiet) HudShell.toast('PATH ENDED');
  }

  private get shiftDown() {
    return this.shiftKey?.isDown ?? false;
  }

  /**
   * SHIFT's constraint: snap to whichever axis the pointer has travelled
   * furthest along, measured from a reference point. This is what makes a
   * level's floors flat and its walls plumb — freehand cannot hold a line,
   * and a collision edge that wobbles by a cell is visible in play.
   */
  private constrainAxis<T extends { x: number; y: number }>(
    from: T | null,
    p: { x: number; y: number },
  ): { x: number; y: number } {
    if (!from || !this.shiftDown) return p;
    return Math.abs(p.x - from.x) >= Math.abs(p.y - from.y)
      ? { x: p.x, y: from.y }
      : { x: from.x, y: p.y };
  }

  /** Flood a connected region of whatever the stroke targets. */
  private floodAt(pointer: Phaser.Input.Pointer) {
    const cell = this.paintCellAt(pointer);
    if (!cell) return;
    if (this.paintingZones) {
      const value = this.maskValue();
      const from = this.mask[cell.y]?.[cell.x];
      if (from === undefined || from === value) return;
      this.pushMaskUndo();
      const stack = [cell];
      while (stack.length > 0) {
        const { x, y } = stack.pop()!;
        if (this.mask[y]?.[x] !== from) continue;
        this.mask[y]![x] = value;
        stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
      }
      this.drawMask();
    } else {
      const layer = this.layers[this.activeLayer];
      if (!layer) return;
      this.pushUndo();
      this.floodFill(layer, cell.x, cell.y, this.tool === 'erase' ? -1 : this.selectedTile);
    }
    this.draftDirty = true;
    UISound.play('confirm');
  }

  /** Cell size of whatever the stroke is writing: mask cells, or tiles. */
  private paintCellSize(): number {
    return this.paintingZones ? this.maskCell : this.tileset?.tileWidth ?? 32;
  }

  /** The cell under the pointer in the CURRENT target's grid, or null. */
  private paintCellAt(pointer: Phaser.Input.Pointer): { x: number; y: number } | null {
    if (this.paintingZones) return this.maskCellAt(pointer);
    if (!this.map || !this.tileset) return null;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tx = Math.floor(world.x / this.tileset.tileWidth);
    const ty = Math.floor(world.y / this.tileset.tileHeight);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return null;
    return { x: tx, y: ty };
  }

  /** Stamp the brush-sized block of tiles (no prop stretch — pen strokes). */
  private stampTiles(tx: number, ty: number) {
    const layer = this.layers[this.activeLayer];
    if (!layer || !this.map) return;
    const off = Math.floor((this.brushSize - 1) / 2);
    for (let dy = -off; dy <= this.brushSize - 1 - off; dy++) {
      for (let dx = -off; dx <= this.brushSize - 1 - off; dx++) {
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) continue;
        if (this.tool === 'erase') layer.removeTileAt(x, y);
        else layer.putTileAt(this.selectedTile, x, y);
      }
    }
  }

  /**
   * Rasterize a traced outline (image pixels) into tiles. The same polygon
   * fill the zones use, aimed at the tile grid: trace a hill with the shape
   * pen and it comes back as terrain, not as a mask.
   */
  private rasterizePolygonToTiles(points: { x: number; y: number }[]) {
    const layer = this.layers[this.activeLayer];
    const ts = this.tileset;
    const map = this.map;
    if (!layer || !map || !ts || points.length < 3) return;
    this.pushUndo();
    const grid = Array.from({ length: map.height }, () =>
      Array.from({ length: map.width }, () => 0),
    );
    fillMaskPolygon(
      grid,
      points.map((pt) => ({ x: pt.x / ts.tileWidth, y: pt.y / ts.tileHeight })),
      1,
    );
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y]!.length; x++) {
        if (grid[y]![x] !== 1) continue;
        if (this.tool === 'erase') layer.removeTileAt(x, y);
        else layer.putTileAt(this.selectedTile, x, y);
      }
    }
    this.draftDirty = true;
  }

  /** The exact image-pixel point under the cursor — no grid snapping. */
  private pixelAt(pointer: Phaser.Input.Pointer): { x: number; y: number } {
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return { x: world.x, y: world.y };
  }

  /**
   * How close (in image pixels) a click must land on point 1 to close the
   * outline. Divided by zoom so it is a constant distance ON SCREEN: zoomed
   * out, a few pixels of art are a big target; zoomed in, they are a sliver.
   */
  private closeTolerance() {
    return 12 / this.cameras.main.zoom;
  }

  /** True when this point would close the open outline. */
  private closesShape(p: { x: number; y: number }) {
    const first = this.penPoints[0];
    if (!first || this.penPoints.length < 3) return false;
    return Math.hypot(p.x - first.x, p.y - first.y) <= this.closeTolerance();
  }

  /**
   * The SHAPE pen: click an outline point by point; clicking back on the
   * first point closes it into a VECTOR polygon. Nothing here touches the
   * mask grid — a traced cave floor has to follow the art, and cell-snapped
   * geometry is ragged at every grid size.
   */
  private shapeClick(pointer: Phaser.Input.Pointer) {
    if (this.paintingZones ? !this.sceneImage : !this.map) return;
    const p = this.constrainAxis(
      this.penPoints[this.penPoints.length - 1] ?? null,
      this.pixelAt(pointer),
    );
    if (this.closesShape(p)) {
      if (this.paintingZones) {
        this.commitShape({
          id: `sh_${Date.now().toString(36)}`,
          kind: this.maskKind,
          type: 'polygon',
          points: this.penPoints.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
        });
      } else {
        this.rasterizePolygonToTiles(this.penPoints);
      }
      this.penPoints = [];
      UISound.play('confirm');
      HudShell.toast('SHAPE CLOSED', 'success');
      return;
    }
    this.penPoints.push(p);
    UISound.play('click');
    if (this.penPoints.length === 3) HudShell.toast('CLICK POINT 1 AGAIN TO CLOSE THE SHAPE');
  }

  /** Add a finished vector shape, undoably. */
  private commitShape(shape: SceneShape) {
    this.pushMaskUndo();
    if (this.shapeFriction !== null) shape.friction = this.shapeFriction;
    this.shapes.push(shape);
    this.drawShapes();
    this.draftDirty = true;
  }

  /**
   * The card that explains the armed tool: its keys drawn as keys, and one
   * line saying what the pointer does. It replaces the wall of hint text the
   * panel used to carry — nobody reads a paragraph, and the paragraph was
   * describing six tools at once when only one of them is ever armed.
   */
  private showToolHint(tool: MaskTool, ms = 9000) {
    // An uncaptioned key gets NO caption element: an empty one still holds
    // its line height, which pushed the arrow keypad's rows apart.
    const key = (glyph: string, caption: string, on = false) =>
      `<div class="pair"><div class="key${glyph.length > 2 ? ' wide' : ''}${on ? ' on' : ''}">` +
      `${glyph}</div>${caption ? `<div class="cap">${caption}</div>` : ''}</div>`;
    const row = (...keys: string[]) => `<div class="row">${keys.join('')}</div>`;
    // The arrow keys are a picture of a keypad, so they stay clustered while
    // captioned keys spread across the card.
    const cluster = (...keys: string[]) => `<div class="row cluster">${keys.join('')}</div>`;

    const SPECIFIC: Record<MaskTool, { art: string; msg: string }> = {
      freehand: {
        art: row(key('SHIFT', 'STRAIGHT'), key('[', 'SMALLER'), key(']', 'BIGGER')),
        msg: 'DRAG TO PAINT MASK CELLS',
      },
      line: {
        art: row(key('SHIFT', 'STRAIGHT'), key('ALT', 'DROP PT'), key('ESC', 'END PATH')),
        msg: 'CLICK POINT TO POINT ALONG AN EDGE',
      },
      shape: {
        art: row(key('SHIFT', 'STRAIGHT'), key('ALT', 'DELETE PT'), key('ESC', 'CANCEL')),
        msg: 'TRACE AN OUTLINE · CLICK POINT 1 TO CLOSE IT',
      },
      rect: {
        art: row(key('SHIFT', 'SQUARE')),
        msg: 'DRAG A BOX',
      },
      triangle: {
        art:
          cluster(key('↑', '', this.triangleDir === 'up')) +
          cluster(
            key('←', '', this.triangleDir === 'left'),
            key('↓', '', this.triangleDir === 'down'),
            key('→', '', this.triangleDir === 'right'),
          ),
        msg: 'ARROW KEYS SET DIRECTION · DRAG TO SIZE IT',
      },
      circle: {
        art: row(key('◯', 'DRAG OUT')),
        msg: 'DRAG FROM THE CENTRE TO THE EDGE',
      },
      fill: {
        art: row(key('▨', 'CLICK')),
        msg: 'CLICK A REGION TO FLOOD IT — THE ERASER FLOODS IT EMPTY',
      },
    };
    const { art, msg } = SPECIFIC[tool];
    HudShell.keyHint(art, msg, ms);
  }

  /** Build the primitive a drag describes, or null when it is too small. */
  private dragToShape(): SceneShape | null {
    const drag = this.shapeDrag;
    if (!drag) return null;
    const { start, now } = drag;
    const id = `sh_${Date.now().toString(36)}`;
    const kind = this.maskKind;
    if (this.maskTool === 'circle') {
      const radius = Math.hypot(now.x - start.x, now.y - start.y);
      if (radius < 2) return null;
      return { id, kind, type: 'circle', points: [round(start)], radius: Math.round(radius) };
    }
    // SHIFT squares the drag box off the anchor corner, keeping its
    // direction — dragging up-left with SHIFT still goes up-left.
    let end = now;
    if (this.shiftDown) {
      const side = Math.max(Math.abs(now.x - start.x), Math.abs(now.y - start.y));
      end = {
        x: start.x + Math.sign(now.x - start.x) * side,
        y: start.y + Math.sign(now.y - start.y) * side,
      };
    }
    const x1 = Math.min(start.x, end.x);
    const y1 = Math.min(start.y, end.y);
    const x2 = Math.max(start.x, end.x);
    const y2 = Math.max(start.y, end.y);
    if (x2 - x1 < 2 || y2 - y1 < 2) return null;
    if (this.maskTool === 'triangle') {
      // The drag sizes the triangle; the arrow keys aim it.
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const corners = {
        right: [{ x: x2, y: midY }, { x: x1, y: y1 }, { x: x1, y: y2 }],
        left: [{ x: x1, y: midY }, { x: x2, y: y2 }, { x: x2, y: y1 }],
        down: [{ x: midX, y: y2 }, { x: x2, y: y1 }, { x: x1, y: y1 }],
        up: [{ x: midX, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }],
      }[this.triangleDir];
      return { id, kind, type: 'triangle', points: corners.map(round) };
    }
    return { id, kind, type: 'rect', points: [round({ x: x1, y: y1 }), round({ x: x2, y: y2 })] };
  }

  /** Delete the topmost vector shape under the pointer. */
  private eraseShapeAt(pointer: Phaser.Input.Pointer): boolean {
    const p = this.pixelAt(pointer);
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      if (!pointInShape(this.shapes[i]!, p.x, p.y)) continue;
      this.pushMaskUndo();
      this.shapes.splice(i, 1);
      this.drawShapes();
      this.draftDirty = true;
      UISound.play('click');
      HudShell.toast('SHAPE DELETED');
      return true;
    }
    return false;
  }

  /** Repaint every vector shape, plus the primitive being dragged. */
  private drawShapes() {
    this.shapeGfx?.destroy();
    const g = this.add.graphics();
    g.setDepth(21); // above the cell mask, below the cursor
    for (const shape of this.shapes) {
      const kind = SCENE_MASK_KINDS.find((k) => k.id === shape.kind);
      const color = Number(`0x${(kind?.color ?? '#ffffff').slice(1)}`);
      this.paintShape(g, shape, color, 0.4);
    }
    const dragged = this.dragToShape();
    if (dragged) {
      const kind = SCENE_MASK_KINDS.find((k) => k.id === dragged.kind);
      const color = Number(`0x${(kind?.color ?? '#ffffff').slice(1)}`);
      this.paintShape(g, dragged, color, 0.25);
    }
    g.setVisible(this.sceneActive && this.maskVisible);
    this.shapeGfx = g;
  }

  /** Fill + outline one shape. Circles are drawn as circles, not as facets. */
  private paintShape(
    g: Phaser.GameObjects.Graphics,
    shape: SceneShape,
    color: number,
    alpha: number,
  ) {
    if (shape.type === 'circle') {
      const c = shape.points[0];
      if (!c || !shape.radius) return;
      g.fillStyle(color, alpha);
      g.fillCircle(c.x, c.y, shape.radius);
      g.lineStyle(1 / this.cameras.main.zoom, color, 0.95);
      g.strokeCircle(c.x, c.y, shape.radius);
      return;
    }
    const outline = shapeOutline(shape).map((p) => new Phaser.Math.Vector2(p.x, p.y));
    if (outline.length < 3) return;
    g.fillStyle(color, alpha);
    g.fillPoints(outline, true);
    g.lineStyle(1 / this.cameras.main.zoom, color, 0.95);
    g.strokePoints(outline, true, true);
  }

  /**
   * Paint mask cells like a pen: dabs are interpolated between the previous
   * pointer position and this one, so a fast drag draws a continuous stroke
   * instead of a dotted line of missed frames.
   */
  private paintMask(pointer: Phaser.Input.Pointer) {
    if (this.mask.length === 0 || this.spacePanning) return;
    const raw = this.maskCellAt(pointer);
    if (!raw) return;
    // SHIFT holds the stroke to one axis from wherever it began.
    const cell = this.constrainAxis(this.strokeOrigin, raw);
    const value = this.maskValue();

    let changed = false;
    const from = this.lastMaskCell;
    if (from && (from.x !== cell.x || from.y !== cell.y)) {
      changed = this.strokeBetween(from, cell, value);
    } else if (this.stampMask(cell.x, cell.y, value)) {
      changed = true;
    }
    this.lastMaskCell = cell;
    if (changed) {
      this.drawMask();
      this.draftDirty = true;
    }
  }

  /**
   * Persist the scene: its name and the painted mask, onto the SAME asset it
   * was loaded from. Saving must never mint a second copy in the inventory.
   */
  private async saveMask() {
    const scene = this.activeScene;
    if (!scene) return HudShell.toast('PAINT OR OPEN A SCENE FIRST', 'error');
    await this.busy(null, 'SAVING THE SCENE...', async () => {
      const painted = this.mask.flat().filter((v) => v > 0).length;
      const shapeCount = this.shapes.length;
      const name = this.sceneNameInput?.value.trim() || scene.name;
      const saved = await api.updateAsset<Scene>(scene.id, {
        ...scene,
        name,
        shapes: this.shapes,
        mask: {
          cellSize: this.maskCell,
          width: this.mask[0]?.length ?? 0,
          height: this.mask.length,
          data: this.mask,
        },
      });
      this.activeScene = saved;
      clearDraft(`world:scene:${saved.id}`);
      this.draftDirty = false;
      this.scenePanel?.refresh();
      await collection.refresh();
      UISound.play('confirm');
      HudShell.toast(
        `SCENE SAVED · ${painted} MASK CELLS · ${shapeCount} SHAPE${shapeCount === 1 ? '' : 'S'}`,
        'success',
      );
    });
  }

  /** Put a painted scene on the stage, fitted to the viewport. */
  /**
   * Put a scene on the stage as a STRIP.
   *
   * A looping level is not one image shown twice — it is a run of panels the
   * camera travels along, and the editor has to show the run, because that is
   * what the seams between panels look like in play. A scene with no strip is
   * a strip of one, so there is only ever one code path here.
   */
  private async displayScene(scene: Scene) {
    const segments = sceneSegments(scene);
    const stamp = Date.now();
    await new Promise<void>((resolve, reject) => {
      segments.forEach((seg, i) => {
        this.load.image(`scene:${scene.id}:${i}:${stamp}`, `${fileUrl(seg.image)}?t=${stamp}`);
      });
      this.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
      this.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, () => reject(new Error('scene load failed')));
      this.load.start();
    });

    for (const img of this.sceneImages) img.destroy();
    this.sceneImages = [];
    this.sceneImage?.destroy();
    this.activeScene = scene;

    // Panel 1 sits at the world origin, exactly like the tilemap, so the mask
    // and the art share one coordinate space and cannot drift apart.
    const vertical = scene.loop === 'vertical';
    let offset = 0;
    segments.forEach((seg, i) => {
      const img = this.add
        .image(vertical ? 0 : offset, vertical ? offset : 0, `scene:${scene.id}:${i}:${stamp}`)
        .setOrigin(0, 0);
      // Mirroring is applied about the panel's own box, so a flipped panel
      // still occupies exactly its own slot in the strip.
      img.setFlip(seg.flipX, seg.flipY);
      this.sceneImages.push(img);
      offset += vertical ? img.height : img.width;
      if (i === 0) this.sceneImage = img;
    });

    const width = vertical
      ? Math.max(...this.sceneImages.map((i) => i.width), 1)
      : offset;
    const height = vertical ? offset : Math.max(...this.sceneImages.map((i) => i.height), 1);
    this.stripSize = { width, height };

    if (this.sceneNameInput) this.sceneNameInput.value = scene.name;
    if (this.stage !== 'edit') this.setStage('edit');
    this.renderKindRow(); // a top-down scene needs different layers than a side one
    this.scenePanel?.refresh();
    this.renderTimeline();
    // The mask spans the WHOLE strip: collision does not stop at panel 1.
    this.initMask(scene, width, height);
    this.restoreSceneDraft();
    this.frameStrip();
  }

  /** Which way the timeline runs, or null when the scene does not loop. */
  private timelineAxis(): 'horizontal' | 'vertical' | null {
    const loop = this.activeScene?.loop ?? 'none';
    if (loop === 'none') return null;
    // The band runs along the axis the level repeats on: a horizontal level
    // reads as a band under the stage, a tower as a column beside it.
    return loop === 'horizontal' ? 'horizontal' : 'vertical';
  }

  /**
   * The strip timeline: one cell per panel, in travel order, like a video
   * editor's track. A looping level is authored by ARRANGING panels, so the
   * arrangement has to be visible and directly editable — duplicating a panel
   * mirrored is free, and is how a two-render strip becomes a long level
   * without paying for every screen of it.
   */
  private renderTimeline() {
    const axis = this.timelineAxis();
    const scene = this.activeScene;
    // The band is a ROW (or a column) of the app layout: these classes inset
    // the canvas and the docks so nothing is covered by it.
    const on = axis !== null && this.sceneActive && this.stage === 'edit';
    document.body.classList.toggle('g-timeline-left', on && axis === 'vertical');
    document.body.classList.toggle('g-timeline-bottom', on && axis === 'horizontal');
    if (!axis || !scene || !this.sceneActive || this.stage !== 'edit') {
      this.timelineEl?.remove();
      this.timelineEl = null;
      this.timelineCard = null;
      return;
    }
    if (!this.timelineEl) {
      const el = document.createElement('div');
      el.id = 'genvy-timeline';
      // On #app, not #hud-root: the HUD is inset AROUND the band, so a child
      // of it could not occupy the band's own row.
      document.getElementById('app')?.appendChild(el);
      this.timelineEl = el;
    }
    const el = this.timelineEl;
    el.className = axis === 'vertical' ? 'vertical' : 'horizontal';
    el.replaceChildren();

    const segments = sceneSegments(scene);
    const track = document.createElement('div');
    track.className = 'g-tl-track';
    for (let i = 0; i < segments.length; i++) {
      track.appendChild(this.timelineCell(segments[i]!, i, segments.length));
    }

    // The tail cell adds a panel: a mirrored copy, which costs nothing.
    const add = document.createElement('div');
    add.className = 'g-tl-cell g-tl-add';
    add.title = 'Duplicate the last panel, mirrored — free, no render';
    add.textContent = '+';
    add.addEventListener('click', () => {
      UISound.play('click');
      void this.addSegment(segments.length - 1, true);
    });
    track.appendChild(add);
    el.appendChild(track);

    // The strip's own padding, as a hover target in the band's colour: the
    // pointer has to cross it to reach the tab, and crossing dead space would
    // close the tab under the cursor.
    const bridge = document.createElement('div');
    bridge.className = 'g-tl-bridge';
    bridge.addEventListener('pointerenter', () => this.keepCard());
    bridge.addEventListener('pointerleave', () => this.scheduleHideCard());
    el.appendChild(bridge);

    // The hover card lives on the BAND. Inside the track it was invisible: a
    // scrolling box clips anything positioned outside itself, and the card is
    // positioned outside itself by design.
    const card = document.createElement('div');
    card.className = 'g-tl-actions';
    card.addEventListener('pointerenter', () => this.keepCard());
    card.addEventListener('pointerleave', () => this.scheduleHideCard());
    el.appendChild(card);
    this.timelineCard = card;
  }

  /** Cancel a pending dismissal — the pointer is still somewhere it belongs. */
  private keepCard() {
    if (this.cardHideTimer !== null) {
      window.clearTimeout(this.cardHideTimer);
      this.cardHideTimer = null;
    }
  }

  /**
   * Dismiss the tab shortly, unless the pointer lands on the panel, the
   * bridge or the tab itself first. A grace period, rather than geometry:
   * every route between those three is then safe, whatever the layout.
   */
  private scheduleHideCard() {
    this.keepCard();
    this.cardHideTimer = window.setTimeout(() => {
      this.timelineCard?.classList.remove('visible');
      this.cardHideTimer = null;
    }, 140);
  }

  /** Fill the hover card with one panel's actions and place it beside it. */
  private showPanelActions(cell: HTMLElement, index: number, total: number) {
    const card = this.timelineCard;
    const band = this.timelineEl;
    if (!card || !band) return;
    card.replaceChildren();
    const act = (glyph: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = glyph;
      b.title = title;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        UISound.play('click');
        card.classList.remove('visible');
        fn();
      });
      card.appendChild(b);
    };
    act('⧉', 'Duplicate this panel — free, no render', () => void this.addSegment(index, false));
    act('⇋', 'Mirror this panel horizontally', () => this.flipSegment(index, 'x'));
    act('⇅', 'Mirror this panel vertically', () => this.flipSegment(index, 'y'));
    act('✎', 'Modify this panel with an instruction', () => this.openModifyModal(index));
    if (total > 1) act('✕', 'Remove this panel from the strip', () => this.removeSegment(index));

    const cellBox = cell.getBoundingClientRect();
    const bandBox = band.getBoundingClientRect();
    card.classList.add('visible');
    // Positioned in pixels rather than centred by transform, so it can be
    // CLAMPED: the first and last panels sit at the edges, and a card centred
    // on them would hang off the screen where its icons cannot be clicked.
    card.style.transform = 'none';
    card.style.bottom = 'auto';
    card.style.right = 'auto';
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    // Flush against the band's edge, whose border is painted in the band's
    // own colour: the two surfaces join and the card reads as a tab growing
    // out of the strip rather than a box hovering near it.
    const vertical = band.classList.contains('vertical');
    card.classList.toggle('side', vertical);
    if (vertical) {
      // Beside the column, not over the panel above it.
      card.style.left = `${bandBox.width}px`;
      card.style.top = `${clamp(cellBox.top - bandBox.top, 0, Math.max(0, bandBox.height - h))}px`;
    } else {
      const centred = cellBox.left - bandBox.left + cellBox.width / 2 - w / 2;
      card.style.left = `${clamp(centred, 0, Math.max(0, bandBox.width - w))}px`;
      card.style.top = `${-h}px`;
    }
  }

  /** One timeline cell: the panel's artwork, and nothing else. */
  private timelineCell(seg: SceneSegment, index: number, total: number): HTMLElement {
    const cell = document.createElement('div');
    cell.className = `g-tl-cell${index === this.activeSegment ? ' active' : ''}`;
    cell.title = `PANEL ${index + 1} (DOUBLE-CLICK TO CROP)`;

    const img = document.createElement('img');
    img.src = fileUrl(seg.image);
    img.alt = '';
    // The thumbnail mirrors exactly as the panel does, so a mirrored pair
    // reads as a mirrored pair at a glance.
    img.style.transform = `scale(${seg.flipX ? -1 : 1}, ${seg.flipY ? -1 : 1})`;
    cell.appendChild(img);

    cell.addEventListener('click', () => {
      UISound.play('click');
      this.activeSegment = index;
      this.focusSegment(index);
      this.renderTimeline();
    });
    cell.addEventListener('dblclick', () => {
      UISound.play('confirm');
      this.beginCrop(index);
    });
    cell.addEventListener('pointerenter', () => {
      this.keepCard();
      this.showPanelActions(cell, index, total);
    });
    cell.addEventListener('pointerleave', () => this.scheduleHideCard());
    return cell;
  }

  /**
   * Crop a panel: double-click it in the timeline, drag the keep-rectangle
   * over the artwork, ENTER commits. Deterministic and free — the crop is a
   * byte-faithful cut of the file, done by the platform, not a render.
   */
  private beginCrop(index: number) {
    const img = this.sceneImages[index];
    if (!img) return;
    this.cancelCrop(true);
    this.endPenPath(true);
    this.activeSegment = index;
    this.focusSegment(index);
    this.renderTimeline();
    this.crop = { index, start: null, rect: null, gfx: this.add.graphics().setDepth(35) };
    this.drawCrop();
    HudShell.keyHint(
      '<div class="row"><div class="pair"><div class="key wide">DRAG</div>' +
        '<div class="cap">KEEP AREA</div></div><div class="pair"><div class="key wide">ENTER</div>' +
        '<div class="cap">CROP</div></div><div class="pair"><div class="key wide">ESC</div>' +
        '<div class="cap">CANCEL</div></div></div>',
      `CROP PANEL ${index + 1} — DRAG WHAT TO KEEP`,
      8000,
    );
  }

  private cancelCrop(quiet = false) {
    if (!this.crop) return;
    this.crop.gfx.destroy();
    this.crop = null;
    HudShell.hideKeyHint();
    if (!quiet) HudShell.toast('CROP CANCELLED');
  }

  /** Dim everything but the kept rectangle, over the panel being cropped. */
  private drawCrop() {
    const crop = this.crop;
    const img = crop ? this.sceneImages[crop.index] : null;
    if (!crop || !img) return;
    const g = crop.gfx;
    g.clear();
    g.fillStyle(0x02040a, 0.55);
    if (crop.rect) {
      const r = crop.rect;
      // Four shades around the kept area, so the keep reads bright.
      g.fillRect(img.x, img.y, img.width, r.y - img.y);
      g.fillRect(img.x, r.y + r.h, img.width, img.y + img.height - (r.y + r.h));
      g.fillRect(img.x, r.y, r.x - img.x, r.h);
      g.fillRect(r.x + r.w, r.y, img.x + img.width - (r.x + r.w), r.h);
      g.lineStyle(2 / this.cameras.main.zoom, 0xff9d1d, 1);
      g.strokeRect(r.x, r.y, r.w, r.h);
    } else {
      g.fillRect(img.x, img.y, img.width, img.height);
      g.lineStyle(2 / this.cameras.main.zoom, 0xff9d1d, 0.8);
      g.strokeRect(img.x, img.y, img.width, img.height);
    }
  }

  /** Clamp a world point into the cropped panel's bounds. */
  private clampToPanel(p: { x: number; y: number }, img: Phaser.GameObjects.Image) {
    return {
      x: Phaser.Math.Clamp(p.x, img.x, img.x + img.width),
      y: Phaser.Math.Clamp(p.y, img.y, img.y + img.height),
    };
  }

  private async applyCrop() {
    const crop = this.crop;
    const scene = this.activeScene;
    const img = crop ? this.sceneImages[crop.index] : null;
    if (!crop || !scene || !img) return;
    const rect = crop.rect;
    if (!rect || rect.w < 8 || rect.h < 8) {
      return HudShell.toast('DRAG THE AREA TO KEEP FIRST', 'error');
    }
    const segments = sceneSegments(scene);
    const seg = segments[crop.index];
    if (!seg) return;
    // The rectangle was drawn over the panel AS DISPLAYED; the file on disk
    // is the unmirrored original, so a flipped panel's rectangle must be
    // mirrored back before it is cut, or the crop keeps the wrong side.
    let x = rect.x - img.x;
    let y = rect.y - img.y;
    if (seg.flipX) x = img.width - (x + rect.w);
    if (seg.flipY) y = img.height - (y + rect.h);
    const index = crop.index;
    this.cancelCrop(true);

    await this.busy(null, 'CROPPING THE PANEL (FREE)...', async () => {
      const out = await api.cropRect({
        assetId: scene.id,
        sourceFile: seg.image.path,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
      });
      await this.applySegments(
        segments.map((s, i) => (i === index ? { ...s, image: out.fileRef } : s)),
        'PANEL CROPPED',
      );
    });
  }

  /** Centre the camera on one panel of the strip. */
  private focusSegment(index: number) {
    const img = this.sceneImages[index];
    if (!img) return;
    this.cameras.main.centerOn(img.x + img.width / 2, img.y + img.height / 2);
  }

  /** Write a new panel list onto the open scene and redraw everything. */
  private async applySegments(segments: SceneSegment[], toast: string) {
    const scene = this.activeScene;
    if (!scene) return;
    this.pushMaskUndo(); // strip changes are steps in the same history
    const saved = await api.updateAsset<Scene>(scene.id, { ...scene, segments });
    this.activeSegment = Math.max(0, Math.min(this.activeSegment, segments.length - 1));
    await this.displayScene(saved);
    await collection.refresh();
    HudShell.toast(toast, 'success');
  }

  /** Copy a panel into the strip, optionally mirrored along the loop axis. */
  private async addSegment(from: number, mirror: boolean) {
    const scene = this.activeScene;
    if (!scene) return;
    const segments = sceneSegments(scene);
    const source = segments[from] ?? segments[0];
    if (!source) return;
    const vertical = scene.loop === 'vertical';
    const copy: SceneSegment = {
      ...source,
      id: `seg_${Date.now().toString(36)}`,
      // Mirroring on the TRAVEL axis is what makes a copy read as the level
      // continuing rather than as the same screen shown twice.
      flipX: mirror && !vertical ? !source.flipX : source.flipX,
      flipY: mirror && vertical ? !source.flipY : source.flipY,
    };
    await this.busy(null, 'ADDING A PANEL (FREE)...', async () => {
      await this.applySegments(
        [...segments.slice(0, from + 1), copy, ...segments.slice(from + 1)],
        mirror ? 'PANEL ADDED · MIRRORED COPY (FREE)' : 'PANEL DUPLICATED (FREE)',
      );
    });
  }

  private flipSegment(index: number, axis: 'x' | 'y') {
    const scene = this.activeScene;
    if (!scene) return;
    const segments = sceneSegments(scene).map((seg, i) =>
      i === index
        ? {
            ...seg,
            flipX: axis === 'x' ? !seg.flipX : seg.flipX,
            flipY: axis === 'y' ? !seg.flipY : seg.flipY,
          }
        : seg,
    );
    void this.applySegments(segments, `PANEL ${index + 1} MIRRORED`);
  }

  private removeSegment(index: number) {
    const scene = this.activeScene;
    if (!scene) return;
    const segments = sceneSegments(scene).filter((_, i) => i !== index);
    if (segments.length === 0) return HudShell.toast('A STRIP NEEDS AT LEAST ONE PANEL', 'warn');
    void this.applySegments(segments, `PANEL ${index + 1} REMOVED`);
  }

  /**
   * Ask the model to change ONE panel — as it is drawn, mirroring included.
   * The instruction is the whole interface: "remove the palm", "make the sky
   * dusk", "cut the background out". Merge/extend controls used to live here
   * and were dropped: the model renders a fixed canvas whatever it is shown,
   * so working panel by panel is all the resolution there is.
   */
  private openModifyModal(index: number) {
    const scene = this.activeScene;
    const controls = this.scenePanel?.controls;
    const img = this.sceneImages[index];
    if (!scene || !controls || !img) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'g-modal';
    const titleRow = document.createElement('div');
    titleRow.className = 'g-modal-titlerow';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = `MODIFY PANEL ${index + 1}`;
    const closeX = document.createElement('div');
    closeX.className = 'g-modal-close';
    closeX.textContent = '✕';
    titleRow.append(title, closeX);
    const close = () => backdrop.remove();

    const instruction = autoGrow(
      textArea(
        '',
        'e.g. remove the sky so it can go over a parallax background, or take out the palm on the left',
      ),
    );

    // Alpha output is a REQUEST, not a default: forcing it once overrode
    // "make the background red" and handed back a cut-out instead. And it is
    // TRUE alpha, not a keyed colour — no picking magenta and hoping the art
    // does not contain it.
    const transparentSel = document.createElement('select');
    for (const [value, label] of [
      ['no', 'OPAQUE — AS THE ARTWORK/INSTRUCTION SAYS'],
      ['yes', 'CUT OUT — TRUE TRANSPARENT PNG'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      transparentSel.appendChild(opt);
    }

    const go = document.createElement('genvy-button') as GenvyButton;
    go.setAttribute('variant', 'accent');
    const cost = controls.costPreview();
    go.setLabel(`MODIFY · 1 RENDER${cost ? ` · ${cost}` : ''}`);

    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent =
      'THE PANEL IS SENT EXACTLY AS DRAWN, MIRRORING INCLUDED, AND COMES BACK AT ITS OWN SIZE. ' +
      `USES THE SCENE PANEL'S PROVIDER (${controls.tag()}).`;

    const stack = document.createElement('div');
    stack.className = 'g-field-stack';
    stack.append(field('WHAT SHOULD CHANGE', instruction), field('BACKGROUND', transparentSel));

    // A cropped panel is an odd shape the model cannot render: it works at
    // its standard canvas and the result is scaled back. Say so BEFORE the
    // button, not after the render.
    const aspect = img.width / img.height;
    const standard = [1.5, 1 / 1.5, 1].some((r) => Math.abs(aspect - r) / r < 0.05);
    if (!standard) {
      const warn = document.createElement('div');
      warn.className = 'g-hint';
      warn.style.color = 'var(--hud-warn)';
      warn.textContent =
        `THIS PANEL IS ${img.width}×${img.height} — A CROPPED SHAPE. THE MODEL RENDERS AT ITS ` +
        `STANDARD ${aspect >= 1 ? 'LANDSCAPE' : 'PORTRAIT'} CANVAS AND THE RESULT IS SCALED BACK ` +
        'TO THIS SIZE, WHICH CAN SOFTEN OR STRETCH DETAIL.';
      stack.append(warn);
    }
    stack.append(go, hint);

    go.onClick(() => {
      const blocked = controls.blockedReason();
      if (blocked) return HudShell.toast(blocked, 'error');
      const text = instruction.value.trim();
      if (!text && transparentSel.value === 'no') {
        return HudShell.toast('SAY WHAT TO CHANGE', 'error');
      }
      close();
      void this.runModify(index, text, transparentSel.value === 'yes');
    });
    closeX.addEventListener('click', () => {
      UISound.play('click');
      close();
    });
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop) close();
    });

    modal.append(titleRow, stack);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => instruction.dispatchEvent(new Event('input')));
  }

  /** Run the modification and put the resulting panel back in the strip. */
  private async runModify(index: number, instruction: string, transparent: boolean) {
    const scene = this.activeScene;
    const controls = this.scenePanel?.controls;
    if (!scene || !controls) return;
    const segments = sceneSegments(scene);
    const seg = segments[index];
    if (!seg) return;

    await this.busy(
      null,
      'MODIFYING THE PANEL...',
      async () => {
        UISound.play('generate');
        HudShell.setBusyLabel(`${controls.tag()} · SENDING THE PANEL AS DRAWN...`);
        const result = await api.sceneModify({
          assetId: scene.id,
          panel: { file: seg.image.path, flipX: seg.flipX, flipY: seg.flipY },
          instruction,
          styleId: scene.styleId,
          transparent,
          provider: controls.providerId(),
          modelFamily: controls.modelFamily(),
          renderSize: controls.renderSize(),
          quality: controls.quality(),
        });
        HudShell.setBusyLabel('PUTTING THE PANEL BACK IN THE STRIP (FREE)...');
        // The result is already drawn the way it should look, so it carries
        // no mirroring of its own.
        await this.applySegments(
          segments.map((s, i) =>
            i === index
              ? { ...s, image: result.fileRef, flipX: false, flipY: false, prompt: instruction || s.prompt }
              : s,
          ),
          'PANEL MODIFIED',
        );
        UISound.play('complete');
        await HudShell.refreshSpend();
      },
      { key: `scene-modify:${controls.providerId() ?? 'openai'}`, fallbackMs: 40000 },
    );
  }

  /**
   * Fit the whole strip in the viewport, leaving room for the docks.
   *
   * The timeline is NOT subtracted here: it owns its own row of the app
   * layout, so the canvas has already shrunk to the content area and
   * `this.scale` reports that smaller size.
   */
  private frameStrip() {
    const { width, height } = this.stripSize;
    if (width < 1 || height < 1) return;
    const cam = this.cameras.main;
    cam.centerOn(width / 2, height / 2);
    cam.setZoom(
      Phaser.Math.Clamp(
        Math.min((this.scale.width - 680) / width, (this.scale.height - 140) / height),
        0.02,
        2,
      ),
    );
  }

  // ---------------- Panels ----------------

  private buildTilesetPanel() {
    const panel = HudShell.makePanel('01 · TILESET', 'left');
    this.tilesetPanel = panel;
    const prompt = textArea('', 'e.g. overgrown alien jungle ruins');
    const genBtn = document.createElement('genvy-button') as GenvyButton;
    genBtn.setAttribute('label', 'GENERATE CONCEPT');
    const forgeBtn = document.createElement('genvy-button') as GenvyButton;
    forgeBtn.setAttribute('variant', 'accent');
    forgeBtn.setAttribute('label', 'FORGE TILESET');
    forgeBtn.title =
      'Renders the 24-tile sheet from the concept above — just the PALETTE. The map stays yours ' +
      'to paint from scratch.';
    // A saved tileset arrives with no concept in memory, so its texts were
    // previously uneditable — this reopens them from the ASSET itself.
    const applyBtn = document.createElement('genvy-button') as GenvyButton;
    applyBtn.setAttribute('label', 'UPDATE TEXTS');
    const statusHost = document.createElement('div');

    this.providerControls = new ProviderControls({
      workflow: 'anchor-generate', // a tileset sheet is a plain generation
      candidates: false, // the sheet IS the set; candidates would mean 4 sheets
    });
    this.providerControls.onChange = () => {
      forgeBtn.setLabel(`FORGE TILESET · ${this.providerControls?.costPreview() ?? ''}`);
    };

    /**
     * The blueprint the world tool was missing: what DeepSeek actually wrote
     * has to be visible and editable BEFORE the image call spends anything —
     * the same lesson the sprite forge learned. Hidden behind a toast, a bad
     * tile list was only discovered after paying for the sheet.
     */
    this.conceptNameIn = textInput('', 'tileset name');
    // autoGrow so a 24-line tile list is readable instead of a 3-line scroll.
    this.conceptPromptIn = autoGrow(textArea('', 'art direction for the whole set'));
    this.conceptTilesIn = autoGrow(
      textArea('', 'tile subjects in reading order, one per line'),
      520,
    );
    this.conceptFields = document.createElement('div');
    this.conceptFields.className = 'g-field-stack';
    this.conceptFields.style.display = 'none';
    this.conceptFields.append(
      field('TILESET NAME', this.conceptNameIn),
      field('ART DIRECTION', this.conceptPromptIn),
      field('TILE SUBJECTS · ONE PER LINE', this.conceptTilesIn),
      applyBtn,
    );
    // Edits are the source of truth from here on.
    for (const el of [this.conceptNameIn, this.conceptPromptIn, this.conceptTilesIn]) {
      el.addEventListener('change', () => this.syncConceptFromFields());
    }

    // The AI draws the sheet at 1024x1536 — 256px per cell natively — so
    // 256 costs nothing in resampling. Smaller is a stylistic choice for
    // chunkier art; 512 upscales.
    const tileSizeSel = document.createElement('select');
    for (const size of [64, 128, 256, 512]) {
      const opt = document.createElement('option');
      opt.value = String(size);
      opt.textContent = size === 256 ? '256 PX · NATIVE' : `${size} PX${size === 512 ? ' · UPSCALED' : ''}`;
      if (size === 256) opt.selected = true;
      tileSizeSel.appendChild(opt);
    }
    this.tileSizeSel = tileSizeSel;

    // Pre-forge text has no asset behind it: a closed tab used to take the
    // theme and the tile list with it. Draft on every keystroke, restore on
    // entry, clear when a tileset finally owns the words.
    this.themeIn = prompt;
    const saveConceptDraft = () => {
      saveDraft('world:concept', {
        theme: prompt.value,
        name: this.conceptNameIn.value,
        art: this.conceptPromptIn.value,
        tiles: this.conceptTilesIn.value,
        tileSize: tileSizeSel.value,
      });
    };
    for (const el of [prompt, this.conceptNameIn, this.conceptPromptIn, this.conceptTilesIn]) {
      el.addEventListener('input', saveConceptDraft);
    }
    tileSizeSel.addEventListener('change', saveConceptDraft);

    panel.append(
      field('DESCRIBE THE WORLD THEME', prompt),
      field('TILE SIZE', tileSizeSel),
      ...this.providerControls.elements(),
      genBtn,
      this.conceptFields,
      forgeBtn,
      statusHost,
    );

    applyBtn.onClick(async () => {
      const ts = this.tileset;
      this.syncConceptFromFields();
      if (!ts) {
        // Pre-forge: the fields ARE the concept; nothing to persist yet.
        UISound.play('confirm');
        return HudShell.toast('CONCEPT UPDATED — FORGE WHEN READY', 'success');
      }
      const names = this.conceptTilesIn.value.split('\n').map((t) => t.trim());
      const updated = {
        ...ts,
        name: this.conceptNameIn.value.trim() || ts.name,
        description: this.conceptPromptIn.value.trim() || ts.description,
        tiles: ts.tiles.map((t, i) => ({ ...t, name: names[i] ?? t.name })),
      };
      this.tileset = await api.updateAsset<Tileset>(ts.id, updated);
      this.renderPalette();
      await collection.refresh();
      UISound.play('confirm');
      HudShell.toast('TILESET TEXTS UPDATED', 'success');
    });

    genBtn.onClick(async () => {
      if (!prompt.value.trim()) return HudShell.toast('DESCRIBE THE THEME FIRST', 'error');
      await this.busy(
        statusHost,
        'DESIGNING TILE SET...',
        async () => {
          UISound.play('generate');
          HudShell.setBusyLabel('DEEPSEEK · PLANNING 24 TILES, NAMES & COLLISION FLAGS...');
          const res = await api.aiText<TilesetConcept>({
            tool: 'tileset',
            prompt: prompt.value,
            schemaName: 'tilesetConcept',
          });
          this.concept = res.result;
          this.showConcept(this.concept);
          UISound.play('confirm');
          HudShell.toast(
            `CONCEPT: ${this.concept.name.toUpperCase()} — REVIEW THE TILE LIST, THEN FORGE`,
            'success',
          );
        },
        { key: 'tileset:concept', fallbackMs: 16000 },
      );
    });

    forgeBtn.onClick(async () => {
      // Whatever is in the FIELDS right now is what gets drawn — typed by
      // hand, generated, or seeded from a saved tileset by EDIT CONCEPT.
      // Requiring a prior GENERATE left this button silently inert after a
      // round trip through step 2.
      this.syncConceptFromFields();
      if (!this.concept) {
        return HudShell.toast('GENERATE A CONCEPT, OR WRITE THE TEXTS YOURSELF', 'error');
      }
      // Re-forging with a tileset open replaces it instead of adding a
      // near-duplicate to the inventory (and orphaning worlds that use it).
      const reforgeId = this.tileset?.id ?? null;
      const listed = this.concept.tileNames.length;
      const slots = GRID_COLS * GRID_ROWS;
      if (listed > 0 && listed !== slots) {
        HudShell.toast(
          `${listed} TILE SUBJECTS FOR ${slots} SLOTS — THE SHEET IS ALWAYS ${GRID_COLS}x${GRID_ROWS}`,
          'warn',
        );
      }
      await this.busy(statusHost, 'FORGING TILES · THIS TAKES A MINUTE...', async () => {
        UISound.play('generate');
        HudShell.setBusyLabel('GPT-IMAGE-2 · DRAWING THE 4x6 TILE GRID...');
        const subjects = this.concept!.tileNames.length
          ? this.concept!.tileNames.join(', ')
          : this.concept!.imagePrompt;
        const img = await api.aiImage({
          prompt: `${this.concept!.imagePrompt}. Tiles in order: ${subjects}`,
          orientation: 'portrait',
          kind: 'tileset',
        });
        HudShell.setBusyLabel('CUTTING & PACKING THE TILES...');
        const extract = await api.extractTiles({
          assetId: img.assetId,
          sourceFile: 'raw.png',
          cols: GRID_COLS,
          rows: GRID_ROWS,
          targetTileSize: Number(this.tileSizeSel?.value) || 256,
          dedupe: false,
        });
        const tiles = Array.from({ length: extract.tileCount }, (_, i) => ({
          index: i,
          name: this.concept!.tileNames[i] ?? `tile ${i}`,
          collides: this.concept!.collidingTiles.includes(i),
          tags: [],
        }));
        HudShell.setBusyLabel('WRITING THE TILESET TO THE COLLECTION...');
        const { asset: saved, replaced } = await this.saveForgedTileset({
          id: img.assetId,
          name: this.concept!.name,
          description: this.concept!.description,
          tags: this.concept!.tags,
          image: extract.tileset,
          sourceImage: { path: `${img.assetId}/raw.png` },
          tileWidth: extract.tileWidth,
          tileHeight: extract.tileHeight,
          tiles,
          thumbnail: extract.thumbnail,
        }, reforgeId);
        await this.useTileset(saved);
        if (!replaced) await HudShell.lootDrop();
        UISound.play('complete');
        // World Maker v2 §W1: the tile gate's verdict, in the user's terms.
        // A tileset that looks fine but does not tile is the failure this
        // whole gate exists to stop being invisible.
        const gate = extract.gate;
        if (gate) {
          console.log(
            `[genvy] tileset gate: ${gate.score}/100`,
            '\nflagged tiles:', gate.failedTiles,
            '\nhints:', gate.hints,
          );
        }
        if (gate && !gate.pass) {
          HudShell.toast(
            `TILESET SAVED · GATE ${gate.score}/100 — ${gate.failedTiles.length} TILE(S) FLAGGED: ` +
              `${gate.hints[0] ?? 'see console for details'}`,
            'warn',
          );
        } else {
          HudShell.toast(
            `TILESET FORGED & SAVED${gate ? ` · GATE ${gate.score}/100` : ''}`,
            'success',
          );
        }
        // The tileset now owns these words on disk; the local draft is spent.
        clearDraft('world:concept');
        // The concept did its job; the tools take over.
        this.setStage('edit');
      }, { key: 'tileset:image', fallbackMs: 50000 });
    });

    return panel;
  }

  private buildWorldPanel() {
    const panel = HudShell.makePanel('02 · WORLD', 'right');
    this.worldPanel = panel;

    const newBtn = document.createElement('genvy-button') as GenvyButton;
    newBtn.setAttribute('label', 'NEW BLANK WORLD');
    const saveBtn = document.createElement('genvy-button') as GenvyButton;
    saveBtn.setAttribute('variant', 'accent');
    saveBtn.setAttribute('label', 'SAVE WORLD');
    const statusHost = document.createElement('div');

    const dims = document.createElement('div');
    dims.className = 'g-row';
    // Let the canvas follow the level: painting at the edge grows the map,
    // so W/H become a starting point rather than a commitment.
    const growSel = document.createElement('select');
    for (const [value, label] of [
      ['fixed', 'FIXED SIZE'],
      ['grow', 'GROW AS I PAINT'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      growSel.appendChild(opt);
    }
    growSel.addEventListener('change', () => {
      UISound.play('click');
      this.autoGrow = growSel.value === 'grow';
      HudShell.toast(
        this.autoGrow ? 'MAP GROWS WHERE YOU PAINT' : 'MAP SIZE FIXED AT W x H',
        'success',
      );
    });
    dims.append(field('W', this.widthIn), field('H', this.heightIn), field('CANVAS', growSel));

    panel.append(
      field('WORLD NAME', this.worldNameIn),
      dims,
      newBtn,
      saveBtn,
      statusHost,
    );

    newBtn.onClick(() => {
      if (!this.tileset) return HudShell.toast('FORGE OR LOAD A TILESET FIRST', 'error');
      this.worldId = null;
      this.props = [];
      this.plannedSpawns = [];
      this.undoStack = [];
      this.buildMap(Number(this.widthIn.value) || 40, Number(this.heightIn.value) || 23);
      // Layers built after the stage was last resolved come up hidden unless
      // the stage is re-asserted — which looked exactly like "nothing happens".
      this.refreshStage();
      HudShell.toast('BLANK WORLD READY — PAINT AWAY');
    });

    saveBtn.onClick(async () => {
      if (!this.map || !this.tileset) return HudShell.toast('NOTHING TO SAVE YET', 'error');
      await this.busy(statusHost, 'WRITING TO COLLECTION...', async () => {
        const { created } = await this.saveWorld();
        // Only a genuinely NEW asset deserves the loot celebration; an update
        // should feel like saving a file, not minting something.
        if (created) await HudShell.lootDrop();
        else await collection.refresh();
        HudShell.toast(created ? 'WORLD SAVED TO INVENTORY' : 'WORLD UPDATED', 'success');
      });
    });

    return panel;
  }

  /**
   * Build a wrapping version of a tile and ADD it to the set, linked to the
   * tile it came from. No generator draws a tile that repeats — this is the
   * classical offset-and-heal (or mirror-and-heal) construction, done in
   * deterministic code, and the original stays untouched for props and edges.
   */
  private async addSeamlessVariant(index: number, mode: 'offset' | 'h' | 'v' | 'both') {
    const ts = this.tileset;
    if (!ts) return;
    const source = ts.tiles.find((t) => t.index === index);
    const label = { offset: 'OFFSET+HEAL', h: 'MIRROR H', v: 'MIRROR V', both: 'MIRROR BOTH' }[mode];
    await this.busy(null, `MAKING ${label} TILE...`, async () => {
      HudShell.setBusyLabel(`BUILDING A SEAMLESS TILE (FREE)...`);
      const res = await api.seamlessVariant({
        assetId: ts.id,
        sourceFile: 'tileset.png',
        tileWidth: ts.tileWidth,
        tileHeight: ts.tileHeight,
        index,
        mode,
      });
      const saved = await api.updateAsset<Tileset>(ts.id, {
        ...ts,
        image: res.tileset,
        thumbnail: res.thumbnail,
        tiles: [
          ...ts.tiles,
          {
            index: res.newIndex,
            name: `${source?.name || `tile ${index + 1}`} (seamless)`,
            collides: source?.collides ?? false,
            tags: [...(source?.tags ?? []), 'seamless'],
            derivedFrom: index,
          },
        ],
      });
      const keptData = this.layers.map((l) => this.layerToData(l));
      this.tileset = saved;
      await this.useTileset(saved);
      // The sheet on disk was REPACKED, but the map still drew from the old
      // texture — painting with the new tile put stale pixels down. Rebuild
      // on the fresh texture with the painting preserved (deleteTile already
      // learned this lesson).
      if (this.map) this.buildMap(this.map.width, this.map.height, keptData);
      // Painting continues with the new tile — that is why you made it.
      this.selectedTile = res.newIndex;
      this.renderPalette();
      await collection.refresh();
      UISound.play('confirm');
      HudShell.toast(
        `SEAMLESS TILE ADDED · WRAP ${res.before} → ${res.after}/100 · NOW SELECTED`,
        'success',
      );
    });
  }

  /** Small chooser for how to force a tile to wrap. */
  private openSeamlessModal(index: number) {
    const ts = this.tileset;
    if (!ts) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'g-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'g-modal g-modal-narrow';
    const titleRow = document.createElement('div');
    titleRow.className = 'g-modal-titlerow';
    const title = document.createElement('div');
    title.className = 'g-modal-title';
    title.textContent = `SEAMLESS · ${(ts.tiles.find((t) => t.index === index)?.name || `TILE ${index + 1}`).toUpperCase()}`;
    const closeX = document.createElement('div');
    closeX.className = 'g-modal-close';
    closeX.textContent = '✕';
    titleRow.append(title, closeX);

    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent =
      'A NEW TILE IS ADDED AND LINKED TO THIS ONE. OFFSET+HEAL KEEPS THE ART ASYMMETRIC; ' +
      'MIRRORING GUARANTEES THE WRAP BUT SHOWS SYMMETRY.';

    const close = () => backdrop.remove();
    const rows = document.createElement('div');
    rows.className = 'g-field-stack';
    for (const [mode, label] of [
      ['offset', 'OFFSET + HEAL (RECOMMENDED)'],
      ['h', 'MIRROR HORIZONTALLY'],
      ['v', 'MIRROR VERTICALLY'],
      ['both', 'MIRROR BOTH AXES'],
    ] as const) {
      const btn = document.createElement('genvy-button') as GenvyButton;
      btn.setAttribute('label', label);
      if (mode === 'offset') btn.setAttribute('variant', 'accent');
      btn.onClick(() => {
        UISound.play('click');
        close();
        void this.addSeamlessVariant(index, mode);
      });
      rows.appendChild(btn);
    }
    closeX.addEventListener('click', () => {
      UISound.play('click');
      close();
    });
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop) close();
    });
    modal.append(titleRow, hint, rows);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  private showConcept(concept: TilesetConcept) {
    this.conceptNameIn.value = concept.name;
    this.conceptPromptIn.value = concept.imagePrompt;
    this.conceptTilesIn.value = concept.tileNames.join('\n');
    if (this.conceptFields) this.conceptFields.style.display = '';
    for (const el of [this.conceptPromptIn, this.conceptTilesIn]) autoGrow.refresh(el);
  }

  /**
   * Edits win over what the writer produced (the fields ARE the concept
   * now) — and when there is no concept yet, the fields BECOME one, so
   * hand-written texts and a reopened tileset both forge.
   */
  private syncConceptFromFields() {
    const tiles = this.conceptTilesIn.value
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!this.concept) {
      const written = this.conceptPromptIn.value.trim();
      if (!written && tiles.length === 0) return; // nothing to build from
      this.concept = {
        name: this.conceptNameIn.value.trim() || 'Untitled Tileset',
        description: written,
        imagePrompt: written,
        tileNames: tiles,
        collidingTiles: [],
        tags: [],
      };
      return;
    }
    this.concept = {
      ...this.concept,
      name: this.conceptNameIn.value.trim() || this.concept.name,
      imagePrompt: this.conceptPromptIn.value.trim() || this.concept.imagePrompt,
      // Collision flags index into the tile list — drop any that no longer
      // point at a tile, or a deleted line would mark the wrong tile solid.
      tileNames: tiles.length > 0 ? tiles : this.concept.tileNames,
      collidingTiles: this.concept.collidingTiles.filter(
        (i) => i < (tiles.length > 0 ? tiles.length : this.concept!.tileNames.length),
      ),
    };
  }

  private setTool(t: PaintTool) {
    this.tool = t;
    HudShell.toast(`TOOL: ${t.toUpperCase()}`);
  }

  // ---------------- Tileset handling ----------------

  private async useTileset(ts: Tileset) {
    this.tileset = ts;
    this.tilesetKey = `tileset:${ts.id}:${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      this.load.image(this.tilesetKey, `${fileUrl(ts.image)}?t=${Date.now()}`);
      this.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
      this.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, () => reject(new Error('tileset load failed')));
      this.load.start();
    });
    this.renderPalette();
    if (this.editTextsBtn) this.editTextsBtn.style.display = '';
    /**
     * A tileset with no map to paint on is a dead end: every click silently
     * does nothing because there is no layer under the cursor. Forging (or
     * opening) a tileset now gives you a blank canvas immediately — pressing
     * NEW BLANK WORLD stays the way to resize or start over.
     */
    if (!this.map) {
      this.buildMap(Number(this.widthIn.value) || 40, Number(this.heightIn.value) || 23);
      HudShell.toast('BLANK WORLD READY — PICK A TILE AND PAINT', 'success');
      // A crash while painting an unsaved new world parks its strokes under
      // the tileset's key; a fresh blank canvas is where they come back.
      this.restoreWorldDraft();
    }
  }

  private renderPalette() {
    if (!this.paletteHost || !this.tileset) return;
    const ts = this.tileset;
    const img = this.textures.get(this.tilesetKey).getSourceImage() as HTMLImageElement;
    const cols = Math.max(1, Math.floor(img.width / ts.tileWidth));
    const rows = Math.max(1, Math.floor(img.height / ts.tileHeight));
    this.paletteHost.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'g-tile-grid';
    const url = fileUrl(ts.image);
    ts.tiles.forEach((tile) => {
      const cell = document.createElement('div');
      cell.className = 'g-tile';
      if (tile.collides) cell.classList.add('collides');
      if (tile.index === this.selectedTile) cell.classList.add('selected');
      const col = tile.index % cols;
      const row = Math.floor(tile.index / cols);
      cell.style.backgroundImage = `url(${url})`;
      // Explicit size on BOTH axes and positive fractional positions: the
      // old auto-height + negative-percentage arithmetic only held for some
      // sheet shapes, and a repacked sheet broke it into half-tiles.
      cell.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
      cell.style.backgroundPosition = `${cols > 1 ? (col / (cols - 1)) * 100 : 0}% ${
        rows > 1 ? (row / (rows - 1)) * 100 : 0
      }%`;
      cell.title = tile.name;
      cell.addEventListener('click', () => {
        UISound.play('click');
        this.selectedTile = tile.index;
        this.renderPalette();
      });
      // Delete this tile from the set (repacks + remaps painted cells).
      const del = document.createElement('div');
      del.className = 'g-tile-delete';
      del.textContent = '✕';
      del.title = `DELETE "${tile.name || `tile ${tile.index + 1}`}" FROM THE SET`;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        UISound.play('click');
        void this.deleteTile(tile.index);
      });
      cell.appendChild(del);
      // Build a wrapping version of this tile (terrain only — a prop has no
      // business tiling with itself).
      const seam = document.createElement('div');
      seam.className = 'g-tile-seamless';
      seam.textContent = '≈';
      seam.title = 'MAKE A SEAMLESS VERSION OF THIS TILE';
      seam.addEventListener('click', (e) => {
        e.stopPropagation();
        UISound.play('click');
        this.openSeamlessModal(tile.index);
      });
      cell.appendChild(seam);
      if (tile.tags.includes('seamless')) cell.classList.add('is-seamless');
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        tile.collides = !tile.collides;
        UISound.play('confirm');
        this.renderPalette();
        if (this.tileset) void api.updateAsset(this.tileset.id, this.tileset as unknown as Record<string, unknown>);
      });
      grid.appendChild(cell);
    });
    this.paletteHost.appendChild(grid);
  }

  // ---------------- Map handling ----------------

  private buildMap(width: number, height: number, layerData?: number[][][]) {
    if (!this.tileset) return;
    for (const layer of this.layers) layer.destroy();
    this.map?.destroy();
    this.layers = [];

    const ts = this.tileset;
    this.map = this.make.tilemap({
      tileWidth: ts.tileWidth,
      tileHeight: ts.tileHeight,
      width,
      height,
    });
    const image = this.map.addTilesetImage('tiles', this.tilesetKey, ts.tileWidth, ts.tileHeight);
    if (!image) return;

    ['ground', 'decor'].forEach((name, i) => {
      const layer = this.map!.createBlankLayer(name, image, 0, 0);
      if (!layer) return;
      const data = layerData?.[i];
      if (data) {
        for (let y = 0; y < Math.min(height, data.length); y++) {
          const row = data[y]!;
          for (let x = 0; x < Math.min(width, row.length); x++) {
            const idx = row[x]!;
            if (idx >= 0) layer.putTileAt(idx, x, y);
          }
        }
      }
      this.layers.push(layer);
    });

    this.drawGrid(width, height, ts.tileWidth, ts.tileHeight);
    this.drawProps();

    const cam = this.cameras.main;
    cam.centerOn((width * ts.tileWidth) / 2, (height * ts.tileHeight) / 2);
    const fit = Math.min(
      (this.scale.width - 660) / (width * ts.tileWidth),
      (this.scale.height - 120) / (height * ts.tileHeight),
    );
    cam.setZoom(Phaser.Math.Clamp(fit, 0.2, 1.5));
  }

  /**
   * Grow the map when painting reaches its edge, so the canvas follows the
   * level instead of the level being cut to fit a number typed up front.
   * Existing work is preserved and shifted when growth happens on the top or
   * left side (negative coordinates become row/column zero).
   */
  private growMapFor(tx: number, ty: number): { dx: number; dy: number } {
    const map = this.map;
    if (!map || !this.autoGrow) return { dx: 0, dy: 0 };
    const margin = 1; // start growing one tile before the edge
    const addLeft = Math.max(0, margin - tx);
    const addTop = Math.max(0, margin - ty);
    const addRight = Math.max(0, tx + 1 + margin - map.width);
    const addBottom = Math.max(0, ty + 1 + margin - map.height);
    if (!addLeft && !addTop && !addRight && !addBottom) return { dx: 0, dy: 0 };

    const width = Math.min(400, map.width + addLeft + addRight);
    const height = Math.min(400, map.height + addTop + addBottom);
    // Re-lay the existing cells at their new offsets.
    const shifted = this.layers.map((layer) => {
      const data = this.layerToData(layer);
      const next: number[][] = Array.from({ length: height }, () =>
        Array.from({ length: width }, () => -1),
      );
      for (let y = 0; y < data.length; y++) {
        for (let x = 0; x < data[y]!.length; x++) {
          const ny = y + addTop;
          const nx = x + addLeft;
          if (ny < height && nx < width) next[ny]![nx] = data[y]![x]!;
        }
      }
      return next;
    });
    this.buildMap(width, height, shifted);
    this.widthIn.value = String(width);
    this.heightIn.value = String(height);
    return { dx: addLeft, dy: addTop };
  }

  /**
   * A faint tile grid under the map. Painting is a per-cell operation, so
   * seeing the cells matters more here than anywhere else in the app — and
   * the map edge needs to be visible even where nothing is painted yet.
   */
  private drawGrid(width: number, height: number, tw: number, th: number) {
    this.gridGfx?.destroy();
    const g = this.add.graphics();
    g.setDepth(-10); // beneath the tile layers
    const w = width * tw;
    const h = height * th;
    g.fillStyle(0x060a12, 1).fillRect(0, 0, w, h); // the map's own ground
    g.lineStyle(1, 0x1de9ff, 0.09);
    for (let x = 0; x <= width; x++) g.lineBetween(x * tw, 0, x * tw, h);
    for (let y = 0; y <= height; y++) g.lineBetween(0, y * th, w, y * th);
    // Every 5th line slightly stronger, so counting cells is possible.
    g.lineStyle(1, 0x1de9ff, 0.18);
    for (let x = 0; x <= width; x += 5) g.lineBetween(x * tw, 0, x * tw, h);
    for (let y = 0; y <= height; y += 5) g.lineBetween(0, y * th, w, y * th);
    g.lineStyle(2, 0x1de9ff, 0.5).strokeRect(0, 0, w, h); // the map boundary
    this.gridGfx = g;
  }

  /**
   * Save a forged tileset. Re-forging while one is OPEN updates that asset
   * instead of minting another: iterating on a theme used to leave a trail of
   * near-identical "Bat Cave Ecosystem" entries in the inventory, and the
   * worlds referencing the old one silently kept the old art.
   */
  private async saveForgedTileset(data: Record<string, unknown>, existingId: string | null) {
    if (existingId) {
      const updated = await api.updateAsset<Tileset>(existingId, { ...data, id: existingId });
      return { asset: updated, replaced: true };
    }
    return { asset: await api.createAsset<Tileset>('tileset', data), replaced: false };
  }

  /** Snapshot every layer before a change that should be undoable. */
  private pushUndo() {
    this.draftDirty = true;
    if (this.layers.length === 0) return;
    this.undoStack.push({
      layers: this.layers.map((l) => this.layerToData(l)),
      props: this.props.map((pr) => ({ ...pr })),
    });
    if (this.undoStack.length > WorldToolScene.UNDO_LIMIT) this.undoStack.shift();
  }

  /** Put the last snapshot back on the map. */
  private undo() {
    // Each mode undoes its own history: a mask stroke and a tile stroke are
    // not interchangeable steps.
    if (this.paintingZones) {
      const snap = this.maskUndo.pop();
      if (!snap) return HudShell.toast('NOTHING TO UNDO', 'warn');
      this.mask = snap.mask;
      this.shapes = snap.shapes;
      this.drawMask();
      this.drawShapes();
      this.draftDirty = true;
      // A crop, flip, duplicate or modify changed the STRIP — put it back
      // too, on disk, so the undo is real and survives a reload.
      const scene = this.activeScene;
      if (scene && JSON.stringify(snap.segments) !== JSON.stringify(sceneSegments(scene))) {
        void (async () => {
          const saved = await api.updateAsset<Scene>(scene.id, { ...scene, segments: snap.segments });
          await this.displayScene(saved);
        })();
      }
      UISound.play('click');
      HudShell.toast(`UNDONE · ${this.maskUndo.length} STEP(S) LEFT`);
      return;
    }
    const snapshot = this.undoStack.pop();
    if (!snapshot) return HudShell.toast('NOTHING TO UNDO', 'warn');
    this.props = snapshot.props;
    this.drawProps();
    snapshot.layers.forEach((data, li) => {
      const layer = this.layers[li];
      if (!layer) return;
      for (let y = 0; y < data.length; y++) {
        const row = data[y]!;
        for (let x = 0; x < row.length; x++) {
          const index = row[x]!;
          if (index < 0) layer.removeTileAt(x, y);
          else layer.putTileAt(index, x, y);
        }
      }
    });
    UISound.play('click');
    HudShell.toast(`UNDONE · ${this.undoStack.length} STEP(S) LEFT`);
  }

  /**
   * Delete one tile from the set: repack the sheet server-side, then remap
   * every painted cell — tiles after the removed one shift down by one, and
   * cells that used it become empty. Skipping the remap would silently
   * repaint the level with neighbouring art.
   */
  private async deleteTile(index: number) {
    const ts = this.tileset;
    if (!ts) return;
    const name = ts.tiles[index]?.name || `tile ${index + 1}`;
    await this.busy(null, `REMOVING ${name.toUpperCase()}...`, async () => {
      HudShell.setBusyLabel('REPACKING THE TILESET (FREE)...');
      const res = await api.removeTile({
        assetId: ts.id,
        sourceFile: 'tileset.png',
        tileWidth: ts.tileWidth,
        tileHeight: ts.tileHeight,
        index,
      });
      const tiles = ts.tiles
        .filter((t) => t.index !== index)
        .map((t) => ({ ...t, index: res.indexMap[t.index] ?? t.index }));
      const saved = await api.updateAsset<Tileset>(ts.id, {
        ...ts,
        image: res.tileset,
        tiles,
        thumbnail: res.thumbnail,
      });
      // Repaint existing work through the mapping before the palette moves.
      this.pushUndo();
      for (const layer of this.layers) {
        const data = this.layerToData(layer);
        for (let y = 0; y < data.length; y++) {
          for (let x = 0; x < data[y]!.length; x++) {
            const old = data[y]![x]!;
            if (old < 0) continue;
            const next = res.indexMap[old] ?? -1;
            if (next < 0) layer.removeTileAt(x, y);
            else if (next !== old) layer.putTileAt(next, x, y);
          }
        }
      }
      const keptData = this.layers.map((l) => this.layerToData(l));
      this.tileset = saved;
      this.selectedTile = Math.max(0, Math.min(this.selectedTile, res.tileCount - 1));
      await this.useTileset(saved);
      // Rebuild with the new texture, then restore the remapped painting.
      if (this.map) this.buildMap(this.map.width, this.map.height, keptData);
      UISound.play('confirm');
      HudShell.toast(`${name.toUpperCase()} REMOVED · ${res.tileCount} TILES LEFT`, 'success');
    });
  }


  /**
   * Draw the stretched-tile props. Each is ONE tile scaled over its block —
   * what painting with a wide brush means — rendered from a texture frame
   * cut out of the tileset sheet, above the tile layers.
   */
  private drawProps() {
    for (const img of this.propImages) img.destroy();
    this.propImages = [];
    const ts = this.tileset;
    if (!ts || !this.map) return;
    const texture = this.textures.get(this.tilesetKey);
    if (!texture || texture.key === '__MISSING') return;
    const src = texture.getSourceImage() as HTMLImageElement;
    const cols = Math.max(1, Math.floor(src.width / ts.tileWidth));
    for (const prop of this.props) {
      const frameName = `prop:${prop.tile}`;
      if (!texture.has(frameName)) {
        texture.add(
          frameName,
          0,
          (prop.tile % cols) * ts.tileWidth,
          Math.floor(prop.tile / cols) * ts.tileHeight,
          ts.tileWidth,
          ts.tileHeight,
        );
      }
      const img = this.add
        .image(prop.x * ts.tileWidth, prop.y * ts.tileHeight, this.tilesetKey, frameName)
        .setOrigin(0, 0)
        .setDepth(2)
        .setVisible(this.tilesActive && this.stage === 'edit');
      img.setDisplaySize(prop.w * ts.tileWidth, prop.h * ts.tileHeight);
      this.propImages.push(img);
    }
  }

  /** The cursor for the current state, once a drag or a mode change ends. */
  private restoreCursor() {
    if (this.spacePanning) return this.input.setDefaultCursor('grab');
    // Painted mode aims at pixels, so it keeps a crosshair.
    this.input.setDefaultCursor(this.paintingZones ? 'crosshair' : 'default');
  }

  private setupCameraControls() {
    this.input.mouse?.disableContextMenu();
    let dragStart: { x: number; y: number; sx: number; sy: number } | null = null;

    /**
     * Hold SPACE to pan, as in every image editor. Held space also suppresses
     * painting, so grabbing the canvas mid-stroke never leaves a smear.
     */
    // Capture is off for both: they must still reach panel text fields.
    this.shiftKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT, false) ?? null;
    const space = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE, false);
    space?.on('down', () => {
      // Not while typing in a panel field — space belongs to the text there.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      // While the dummy is out, space is its JUMP, not the pan grab.
      if (this.dummy?.active) return;
      this.spacePanning = true;
      this.painting = false;
      // Grabbing mid-stroke ends the stroke; the next dab must not join it.
      this.lastMaskCell = null;
      this.brushCursor?.clear();
      this.input.setDefaultCursor('grab');
    });
    space?.on('up', () => {
      this.spacePanning = false;
      dragStart = null;
      this.restoreCursor();
    });

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (
        p.middleButtonDown() ||
        (this.spacePanning && p.leftButtonDown()) ||
        (p.rightButtonDown() && !this.overPalette(p))
      ) {
        dragStart = { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY, sx: p.x, sy: p.y };
        // Any pan grab shows the closed hand — right- and middle-drag are the
        // same gesture as space-drag, so they must look like it.
        this.input.setDefaultCursor('grabbing');
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (dragStart && (p.middleButtonDown() || p.rightButtonDown() || (this.spacePanning && p.leftButtonDown()))) {
        const cam = this.cameras.main;
        cam.scrollX = dragStart.x - (p.x - dragStart.sx) / cam.zoom;
        cam.scrollY = dragStart.y - (p.y - dragStart.sy) / cam.zoom;
      }
    });
    this.input.on('pointerup', () => {
      dragStart = null;
      this.restoreCursor();
    });
    this.input.on(
      'wheel',
      (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
        // Fullscreen playtest is played at the level's own fit — zooming
        // there would show the void past the artwork or crop the level.
        if (this.inPlaytest) return;
        const cam = this.cameras.main;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.15, 4));
      },
    );
  }

  private overPalette(_p: Phaser.Input.Pointer): boolean {
    // HUD panels sit above the canvas and swallow their own events; canvas
    // pointer events only fire on the open scene area.
    return false;
  }

  private setupPainting() {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      // Clicking the map must take focus off panel fields. A textarea that
      // keeps focus swallows CTRL+Z — the browser undoes the TEXT while the
      // map's own history sits there looking broken.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body) focused.blur();
      // Right-click ends an open pen path (it also pans, harmlessly).
      if (p.rightButtonDown()) this.endPenPath();
      // Vector tools click and drag; they never touch the mask grid. ALT is
      // the pens' delete modifier: laying points is the common case, so
      // removing one must not cost a tool switch.
      const alt = (p.event as MouseEvent | undefined)?.altKey === true;
      if (this.crop && p.leftButtonDown() && !this.spacePanning) {
        const img = this.sceneImages[this.crop.index];
        if (img) {
          this.crop.start = this.clampToPanel(this.pixelAt(p), img);
          this.crop.rect = null;
          this.drawCrop();
        }
        return;
      }
      if (this.stage === 'edit' && p.leftButtonDown() && !this.spacePanning) {
        // With the ERASER armed, a click on a vector tool removes the shape under
        // the cursor rather than starting another one.
        if (this.paintingZones && this.tool === 'erase' && VECTOR_TOOLS.includes(this.maskTool)) {
          if (this.eraseShapeAt(p)) return;
        }
        if (this.maskTool === 'fill') {
          this.floodAt(p);
          return;
        }
        if (this.maskTool === 'line') {
          if (alt) this.dropPenAnchor();
          else this.penClick(p);
          return;
        }
        if (this.maskTool === 'shape') {
          if (alt) this.deletePenPoint(p);
          else this.shapeClick(p);
          return;
        }
        if (this.maskTool === 'rect' || this.maskTool === 'triangle' || this.maskTool === 'circle') {
          const at = this.pixelAt(p);
          this.shapeDrag = { start: at, now: at };
          return;
        }
      }
      // Space is the pan grab, not a paint stroke.
      if (p.leftButtonDown() && !this.spacePanning) {
        // One snapshot per STROKE, not per tile — undo should step back a
        // drag, not 300 individual cells.
        if (this.paintingZones) this.pushMaskUndo();
        else this.pushUndo();
        this.painting = true;
        this.lastMaskCell = null; // a new stroke starts fresh
        this.strokeOrigin = this.maskCellAt(p);
        this.paintAt(p);
      }
    });
    // Pen size from the keyboard, like an image editor: [ and ].
    this.input.keyboard?.on('keydown', (ev: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (ev.key === '[') this.brushSize = Math.max(1, this.brushSize - 1);
      else if (ev.key === ']') this.brushSize = Math.min(12, this.brushSize + 1);
      else return;
      // Keep the picker honest — a size changed by keyboard must show there.
      if (this.brushSel) {
        const match = Array.from(this.brushSel.options).find(
          (o) => Number(o.value) === this.brushSize,
        );
        this.brushSel.value = match ? match.value : '';
      }
      HudShell.toast(`BRUSH ${this.brushSize} ${this.paintingZones ? 'CELL' : 'TILE'}${this.brushSize === 1 ? '' : 'S'} WIDE`);
    });
    // Ctrl+Z anywhere in the scene, as long as a field does not have focus.
    this.input.keyboard?.on('keydown-Z', (ev: KeyboardEvent) => {
      const editing = document.activeElement;
      const inField =
        editing instanceof HTMLInputElement || editing instanceof HTMLTextAreaElement;
      if (!(ev.ctrlKey || ev.metaKey) || inField) return;
      // Ours now — otherwise the browser ALSO undoes the last text edit in
      // whatever field it last remembered.
      ev.preventDefault();
      this.undo();
    });
    this.input.keyboard?.on('keydown-ENTER', () => {
      if (this.crop) void this.applyCrop();
    });
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.inPlaytest) {
        this.exitPlaytest();
        return;
      }
      if (this.crop) {
        this.cancelCrop();
        return;
      }
      if (this.dummy?.active) {
        this.dummy.destroy();
        this.dummy = null;
        HudShell.toast('DUMMY REMOVED');
        return;
      }
      this.endPenPath();
    });
    // Arrow keys aim the triangle tool, and only it: elsewhere they are free.
    for (const [event, dir] of [
      ['keydown-UP', 'up'],
      ['keydown-DOWN', 'down'],
      ['keydown-LEFT', 'left'],
      ['keydown-RIGHT', 'right'],
    ] as const) {
      this.input.keyboard?.on(event, (ev: KeyboardEvent) => {
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
        if (this.dummy?.active) return; // arrows steer the dummy, not the tool
        if (this.stage !== 'edit' || this.maskTool !== 'triangle') return;
        ev.preventDefault();
        this.triangleDir = dir;
        UISound.play('click');
        this.showToolHint('triangle');
        this.drawShapes(); // an in-progress drag re-aims immediately
      });
    }
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.crop?.start && p.leftButtonDown()) {
        const img = this.sceneImages[this.crop.index];
        if (img) {
          const now = this.clampToPanel(this.pixelAt(p), img);
          const st = this.crop.start;
          this.crop.rect = {
            x: Math.min(st.x, now.x),
            y: Math.min(st.y, now.y),
            w: Math.abs(now.x - st.x),
            h: Math.abs(now.y - st.y),
          };
          this.drawCrop();
        }
        return;
      }
      if (this.painting && p.leftButtonDown()) this.paintAt(p);
      if (this.shapeDrag && p.leftButtonDown()) {
        this.shapeDrag.now = this.pixelAt(p);
        this.drawShapes(); // live preview of the primitive being sized
      }
      this.drawBrushCursor(p);
    });
    this.input.on('pointerup', () => {
      if (this.crop) this.crop.start = null;
      this.painting = false;
      this.propStamped = false;
      this.lastMaskCell = null;
      this.strokeOrigin = null;
      if (this.shapeDrag) {
        const shape = this.dragToShape();
        this.shapeDrag = null;
        if (shape) {
          if (this.paintingZones) this.commitShape(shape);
          else this.rasterizePolygonToTiles(shapeOutline(shape));
          UISound.play('confirm');
        } else {
          this.drawShapes(); // clear the abandoned preview
        }
      }
    });
  }

  /**
   * The nib under the cursor: a ring the size of the brush, the exact cell it
   * is centred on, and — for the path pen — a preview of the segment about to
   * be laid. One persistent Graphics, cleared and redrawn, because creating
   * and destroying an object on every pointer move is both wasteful and a
   * good way to end up with nothing on screen.
   */
  private drawBrushCursor(pointer: Phaser.Input.Pointer) {
    if (!this.brushCursor) {
      this.brushCursor = this.add.graphics().setDepth(30);
    }
    const g = this.brushCursor;
    g.clear();
    // Playtest is for walking the level, not marking it: the nib ring and
    // its cell box are editor chrome and stay behind with the panels.
    if (this.spacePanning || this.inPlaytest || this.stage !== 'edit') return;

    // --- Tile target: the stamp, in tile cells ---
    if (!this.paintingZones) {
      const ts = this.tileset;
      if (!ts || !this.map) return;
      const camZoom = this.cameras.main.zoom;
      const tint = this.tool === 'erase' ? 0xff3d5a : 0x1de9ff;
      const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const tx = Math.floor(world.x / ts.tileWidth);
      const ty = Math.floor(world.y / ts.tileHeight);

      if (this.maskTool === 'line' && this.penAnchor) {
        g.lineStyle(2 / camZoom, tint, 0.5);
        g.lineBetween(
          (this.penAnchor.x + 0.5) * ts.tileWidth,
          (this.penAnchor.y + 0.5) * ts.tileHeight,
          (tx + 0.5) * ts.tileWidth,
          (ty + 0.5) * ts.tileHeight,
        );
      }
      if (this.maskTool === 'shape' && this.penPoints.length > 0) {
        g.lineStyle(2 / camZoom, tint, 0.9);
        for (let i = 0; i < this.penPoints.length - 1; i++) {
          const a = this.penPoints[i]!;
          const b = this.penPoints[i + 1]!;
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
        const last = this.penPoints[this.penPoints.length - 1]!;
        g.lineStyle(1 / camZoom, tint, 0.5);
        g.lineBetween(last.x, last.y, world.x, world.y);
        if (this.penPoints.length >= 3) {
          const first = this.penPoints[0]!;
          const hot = this.closesShape({ x: world.x, y: world.y });
          g.lineStyle(2 / camZoom, hot ? 0xffffff : tint, hot ? 1 : 0.7);
          g.strokeCircle(first.x, first.y, this.closeTolerance());
        }
      }
      if (this.shapeDrag) {
        const dragged = this.dragToShape();
        if (dragged) {
          const outline = shapeOutline(dragged).map((q) => new Phaser.Math.Vector2(q.x, q.y));
          if (outline.length >= 3) {
            g.lineStyle(2 / camZoom, tint, 0.9);
            g.strokePoints(outline, true, true);
          }
        }
      }
      // The stamp itself: the exact block a click would write, tinted and
      // outlined. Every stamping tool gets it — a wide eraser with no bounds
      // is aimed by guesswork.
      if (this.maskTool !== 'shape' && this.maskTool !== 'fill') {
        const off = Math.floor((this.brushSize - 1) / 2);
        const bx = (tx - off) * ts.tileWidth;
        const by = (ty - off) * ts.tileHeight;
        const bw = this.brushSize * ts.tileWidth;
        const bh = this.brushSize * ts.tileHeight;
        g.fillStyle(tint, 0.18);
        g.fillRect(bx, by, bw, bh);
        g.lineStyle(2 / camZoom, tint, 0.95);
        g.strokeRect(bx, by, bw, bh);
      }
      return;
    }

    if (!this.sceneImage) return;
    const zoom = this.cameras.main.zoom;
    // Previews must show what SHIFT will actually commit, not the free cursor.
    const px =
      this.maskTool === 'shape'
        ? this.constrainAxis(this.penPoints[this.penPoints.length - 1] ?? null, this.pixelAt(pointer))
        : this.pixelAt(pointer);
    const erasing = this.tool === 'erase';
    const kind = SCENE_MASK_KINDS.find((k) => k.id === this.maskKind);
    const color = erasing ? 0xffffff : Number(`0x${(kind?.color ?? '#ffffff').slice(1)}`);
    // Screen-constant line weights: a 2px outline must stay 2px at any zoom.
    const thin = 1 / zoom;
    const thick = 2 / zoom;

    // --- Vector tools: everything below is in image pixels, never cells ---
    if (this.maskTool === 'shape' && this.penPoints.length > 0) {
      const first = this.penPoints[0]!;
      const last = this.penPoints[this.penPoints.length - 1]!;
      // 1px on screen at any zoom: a fat preview line hides the very edge
      // being traced, which is the only thing the pen is aiming at.
      g.lineStyle(thin, color, 0.9);
      for (let i = 0; i < this.penPoints.length - 1; i++) {
        const a = this.penPoints[i]!;
        const b = this.penPoints[i + 1]!;
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
      g.lineStyle(thin, color, 0.5);
      g.lineBetween(last.x, last.y, px.x, px.y);
      const canClose = this.penPoints.length >= 3;
      if (canClose) {
        // The closing edge, and a translucent fill of the area it would
        // enclose, so the shape is readable before it is committed.
        g.lineStyle(thin, color, 0.3);
        g.lineBetween(px.x, px.y, first.x, first.y);
        g.fillStyle(color, 0.15);
        g.fillPoints(
          [...this.penPoints, px].map((p) => new Phaser.Math.Vector2(p.x, p.y)),
          true,
        );
      }
      const dot = 3 / zoom;
      for (const p of this.penPoints) {
        g.fillStyle(color, 0.95);
        g.fillRect(p.x - dot, p.y - dot, dot * 2, dot * 2);
      }
      if (canClose) {
        const hot = this.closesShape(px);
        g.lineStyle(thin, hot ? 0xffffff : color, hot ? 1 : 0.7);
        g.strokeCircle(first.x, first.y, this.closeTolerance());
      }
    }

    if (VECTOR_TOOLS.includes(this.maskTool)) {
      // A crosshair, not a cell box: these tools do not snap to the grid.
      const arm = 7 / zoom;
      g.lineStyle(thin, color, 0.9);
      g.lineBetween(px.x - arm, px.y, px.x + arm, px.y);
      g.lineBetween(px.x, px.y - arm, px.x, px.y + arm);
      return;
    }

    // --- Cell tools: the nib, snapped to the mask grid ---
    const size = this.maskCell;
    const raw = { x: Math.floor(px.x / size), y: Math.floor(px.y / size) };
    const cell = this.constrainAxis(
      this.maskTool === 'line' ? this.penAnchor : this.painting ? this.strokeOrigin : null,
      raw,
    );
    const r = this.brushSize / 2 - 0.5;
    if (this.maskTool === 'line' && this.penAnchor) {
      g.lineStyle(Math.max(thin, size * 0.35), color, 0.35);
      g.lineBetween(
        (this.penAnchor.x + 0.5) * size,
        (this.penAnchor.y + 0.5) * size,
        (cell.x + 0.5) * size,
        (cell.y + 0.5) * size,
      );
      g.fillStyle(color, 0.9);
      g.fillRect(this.penAnchor.x * size, this.penAnchor.y * size, size, size);
    }
    // The block a click covers, tinted, with the round nib inside it: the
    // ring says WHERE the dab lands, the rectangle says HOW BIG it is.
    if (this.maskTool !== 'fill') {
      const off = Math.floor((this.brushSize - 1) / 2);
      const bx = (cell.x - off) * size;
      const by = (cell.y - off) * size;
      const span = this.brushSize * size;
      g.fillStyle(color, 0.15);
      g.fillRect(bx, by, span, span);
      g.lineStyle(thin, color, 0.55);
      g.strokeRect(bx, by, span, span);
      g.lineStyle(thick, color, 0.95);
      g.strokeCircle((cell.x + 0.5) * size, (cell.y + 0.5) * size, (r + 0.5) * size);
    }
    g.lineStyle(thin, color, 0.4);
    g.strokeRect(cell.x * size, cell.y * size, size, size);
  }

  /** Snapshot the mask before a stroke (mask edits have their own history). */
  private pushMaskUndo() {
    // One history for the whole gameplay layer: a stroke and a placed shape
    // are both "the last thing I did".
    this.maskUndo.push({
      mask: this.mask.map((row) => [...row]),
      shapes: this.shapes.map((sh) => ({ ...sh, points: sh.points.map((p) => ({ ...p })) })),
      segments: this.activeScene
        ? sceneSegments(this.activeScene).map((seg) => ({ ...seg, image: { ...seg.image } }))
        : [],
    });
    if (this.maskUndo.length > WorldToolScene.UNDO_LIMIT) this.maskUndo.shift();
  }

  private paintAt(pointer: Phaser.Input.Pointer) {
    // Each mode paints its own thing: tiles into a tilemap, or gameplay
    // zones over a painted scene.
    if (this.paintingZones) {
      this.paintMask(pointer);
      return;
    }
    let layer = this.layers[this.activeLayer];
    if (!layer || !this.map) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    let tx = layer.worldToTileX(world.x);
    let ty = layer.worldToTileY(world.y);
    if (tx == null || ty == null) return;

    // With auto-grow on, painting at (or just past) the edge extends the map
    // instead of being ignored — the level defines its own size.
    if (this.autoGrow && this.tool !== 'fill') {
      const bleed = 2; // how far outside the map a click still counts
      if (
        tx >= -bleed &&
        ty >= -bleed &&
        tx < this.map.width + bleed &&
        ty < this.map.height + bleed
      ) {
        const { dx, dy } = this.growMapFor(tx, ty);
        if (dx || dy) {
          tx += dx;
          ty += dy;
          layer = this.layers[this.activeLayer]!; // rebuilt by growMapFor
        }
      }
    }
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return;

    if (this.tool === 'fill') {
      this.floodFill(layer, tx, ty, this.selectedTile);
      this.painting = false;
      return;
    }
    // The brush and the eraser share the [ ] size: brushSize IS the stamp's
    // width in tiles, stepping by one. Even sizes anchor a cell up-left of
    // the cursor, as tile editors do.
    const off = Math.floor((this.brushSize - 1) / 2);
    const x0 = tx - off;
    const y0 = ty - off;

    if (this.tool === 'brush' && this.brushSize > 1 && this.stretchTiles) {
      // A wide brush paints ONE tile stretched over the block, not a grid of
      // repeats — nine stamped rocks read as nine rocks. One per click.
      if (this.propStamped) return;
      this.propStamped = true;
      this.props.push({
        tile: this.selectedTile,
        x: x0,
        y: y0,
        w: this.brushSize,
        h: this.brushSize,
      });
      this.drawProps();
      return;
    }

    if (this.tool === 'erase') {
      // The eraser takes props with it: any prop the stamp touches goes.
      const before = this.props.length;
      this.props = this.props.filter(
        (pr) => pr.x + pr.w <= x0 || x0 + this.brushSize <= pr.x || pr.y + pr.h <= y0 || y0 + this.brushSize <= pr.y,
      );
      if (this.props.length !== before) this.drawProps();
    }

    for (let dy = -off; dy <= this.brushSize - 1 - off; dy++) {
      for (let dx = -off; dx <= this.brushSize - 1 - off; dx++) {
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) continue;
        if (this.tool === 'brush') layer.putTileAt(this.selectedTile, x, y);
        else layer.removeTileAt(x, y);
      }
    }
  }

  private floodFill(layer: Phaser.Tilemaps.TilemapLayer, x: number, y: number, newIndex: number) {
    const target = layer.getTileAt(x, y)?.index ?? -1;
    if (target === newIndex) return;
    const stack = [[x, y]];
    let guard = 0;
    while (stack.length > 0 && guard++ < 40000) {
      const [cx, cy] = stack.pop()!;
      if (cx! < 0 || cy! < 0 || cx! >= this.map!.width || cy! >= this.map!.height) continue;
      const cur = layer.getTileAt(cx!, cy!)?.index ?? -1;
      if (cur !== target) continue;
      if (newIndex < 0) layer.removeTileAt(cx!, cy!);
      else layer.putTileAt(newIndex, cx!, cy!);
      stack.push([cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1]);
    }
  }

  // ---------------- Persistence ----------------

  private layerToData(layer: Phaser.Tilemaps.TilemapLayer): number[][] {
    const rows: number[][] = [];
    for (let y = 0; y < this.map!.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < this.map!.width; x++) {
        row.push(layer.getTileAt(x, y)?.index ?? -1);
      }
      rows.push(row);
    }
    return rows;
  }

  private async saveWorld(): Promise<{ created: boolean }> {
    if (!this.map || !this.tileset) return { created: false };
    const payload = {
      name: this.worldNameIn.value.trim() || 'Unnamed World',
      description: '',
      tileset: { id: this.tileset.id, type: 'tileset' },
      width: this.map.width,
      height: this.map.height,
      tileWidth: this.tileset.tileWidth,
      tileHeight: this.tileset.tileHeight,
      layers: this.layers.map((layer, i) => ({
        name: i === 0 ? 'ground' : 'decor',
        kind: 'tiles',
        data: this.layerToData(layer),
        visible: true,
      })),
      // Real spawns from the generated plan (room centres); the 2,2 default
      // is only for a hand-painted map that never had a plan.
      spawnPoints:
        this.plannedSpawns.length > 0 ? this.plannedSpawns : [{ name: 'player', x: 2, y: 2 }],
      props: this.props,
      thumbnail: this.tileset.thumbnail,
    };
    /**
     * Saving twice must not leave two worlds behind. `worldId` lives only in
     * scene memory, so a hot reload or a trip back to the hub used to lose it
     * and the next save minted a near-identical asset. When the id is gone,
     * re-find the world by NAME + TILESET before creating anything.
     */
    let targetId = this.worldId;
    if (!targetId) {
      try {
        const existing = await api.listAssets({ type: 'world' });
        const match = existing.find(
          (a) => a.name.trim().toLowerCase() === payload.name.trim().toLowerCase(),
        );
        if (match) {
          const full = await api.getAsset<World>(match.id);
          if (full.tileset?.id === this.tileset.id) targetId = match.id;
        }
      } catch {
        // Listing failed — fall through and create, rather than lose the work.
      }
    }

    if (targetId) {
      await api.updateAsset(targetId, payload);
      this.worldId = targetId;
      this.clearWorldDrafts();
      return { created: false };
    }
    const saved = await api.createAsset<World>('world', payload);
    this.worldId = saved.id;
    this.clearWorldDrafts();
    return { created: true };
  }

  /** A saved world clears both its own draft and the unsaved-new one. */
  private clearWorldDrafts() {
    if (this.worldId) clearDraft(`world:world:${this.worldId}`);
    if (this.tileset) clearDraft(`world:new:${this.tileset.id}`);
    this.draftDirty = false;
  }

  private async loadExisting(assetId: string, assetType: string) {
    try {
      if (assetType === 'scene') {
        // A scene opens in its own mode — it has no tilemap to paint.
        const scene = await api.getAsset<Scene>(assetId);
        this.setMode('scene');
        await this.displayScene(scene);
        HudShell.toast(`SCENE LOADED: ${scene.name.toUpperCase()}`);
      } else if (assetType === 'tileset') {
        const ts = await api.getAsset<Tileset>(assetId);
        await this.useTileset(ts);
        this.setStage('edit');
        HudShell.toast(`TILESET LOADED: ${ts.name.toUpperCase()}`);
      } else if (assetType === 'world') {
        const world = await api.getAsset<World>(assetId);
        const ts = await api.getAsset<Tileset>(world.tileset.id);
        await this.useTileset(ts);
        this.worldId = world.id;
        this.worldNameIn.value = world.name;
        this.widthIn.value = String(world.width);
        this.heightIn.value = String(world.height);
        const tileLayers = world.layers.filter((l) => l.kind === 'tiles');
        this.props = (world.props ?? []).map((pr) => ({ ...pr }));
        this.buildMap(world.width, world.height, tileLayers.map((l) => (l as { data: number[][] }).data));
        this.setStage('edit');
        HudShell.toast(`WORLD LOADED: ${world.name.toUpperCase()}`);
        this.restoreWorldDraft();
      }
    } catch {
      HudShell.toast('FAILED TO LOAD ASSET', 'error');
    }
  }

  /**
   * See CLAUDE.md "Progress feedback": every AI request passes `timing` so the
   * bar is determinate, and updates its stage text via HudShell.setBusyLabel.
   */
  private async busy(
    _host: HTMLElement | null,
    label: string,
    fn: () => Promise<unknown>,
    timing?: { key: string; fallbackMs: number },
  ) {
    HudShell.showBusy(label, timing ? expectedDuration(timing.key, timing.fallbackMs) : undefined);
    const started = Date.now();
    let ok = true;
    try {
      await fn();
    } catch (err) {
      ok = false;
      const msg = err instanceof ApiError ? err.message : 'OPERATION FAILED';
      HudShell.toast(msg.toUpperCase().slice(0, 180), 'error');
    } finally {
      // Only successful runs teach the estimator.
      if (timing && ok) recordDuration(timing.key, Date.now() - started);
      HudShell.hideBusy();
    }
  }
}
