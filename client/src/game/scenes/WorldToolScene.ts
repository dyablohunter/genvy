import Phaser from 'phaser';
import type {
  Tileset,
  World,
  TilesetConcept,
  WorldPlan,
  Scene,
  ImageProviderStatus,
} from '@genvy/shared';
import {
  buildWorldGrid,
  SCENE_MASK_KINDS,
  shapeOutline,
  pointInShape,
  type SceneShape,
} from '@genvy/shared';

/** Round a point to whole image pixels — shapes are stored as integers. */
const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
import { HudShell } from '../../hud/HudShell.js';
import type { BusyStepState } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { expectedDuration, recordDuration } from '../../hud/progress.js';
import { goToScene, enterScene, registerAssetOpenHandlers } from '../../hud/transitions.js';
import { api, fileUrl, ApiError } from '../../api/client.js';
import { collection } from '../../state/collection.js';
import { ProviderControls } from '../../hud/providerControls.js';
import { buildScenePanel } from './scenePanel.js';
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
const TILE_SIZE = 48;
type PaintTool = 'brush' | 'erase' | 'fill';
/** Cell tools paint the grid mask; vector tools produce SceneShapes. */
type MaskTool = 'freehand' | 'line' | 'shape' | 'rect' | 'triangle' | 'circle';
const VECTOR_TOOLS: MaskTool[] = ['shape', 'rect', 'triangle', 'circle'];

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
  private undoStack: number[][][][] = [];
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
  private mode: 'tilemap' | 'scene' = 'tilemap';
  private modeButtons = new Map<'tilemap' | 'scene', GenvyButton>();
  private tilesetPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private worldPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private scenePanel: ReturnType<typeof buildScenePanel> | null = null;
  private sceneImage: Phaser.GameObjects.Image | null = null;
  private activeScene: Scene | null = null;
  /** Gameplay mask over a painted scene: rows of SCENE_MASK_KINDS ids. */
  private mask: number[][] = [];
  private maskCell = 16;
  private maskKind = 1;
  private brushSize = 2;
  private maskVisible = true;
  private maskGfx: Phaser.GameObjects.Graphics | null = null;
  private maskPanel: ReturnType<typeof HudShell.makePanel> | null = null;
  private maskKindButtons = new Map<number, GenvyButton>();
  private sceneNameInput: HTMLInputElement | null = null;
  private brushSel: HTMLSelectElement | null = null;
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
  private maskUndo: { mask: number[][]; shapes: SceneShape[] }[] = [];

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
      clear: () => {
        this.activeScene = null;
        this.sceneImage?.destroy();
        this.sceneImage = null;
        this.maskGfx?.destroy();
        this.maskGfx = null;
        this.mask = [];
        this.shapes = [];
        this.shapeGfx?.destroy();
        this.shapeGfx = null;
        this.maskUndo = [];
      },
      busy: (label, fn, timing) => this.busy(null, label, fn, timing),
    });
    this.scenePanel = scenePanel;
    void HudShell.setLayout([
      this.buildModePanel(),
      this.buildTilesetPanel(),
      this.buildWorldPanel(),
      scenePanel.panel,
      this.buildMaskPanel(),
    ]);
    this.setMode('tilemap');
    this.setupCameraControls();
    this.setupPainting();
    // The pickers are empty until the roster arrives — without this the
    // provider/model/quality selects render as blank boxes.
    void this.loadProviders();

    if (data?.assetId) void this.loadExisting(data.assetId, data.assetType ?? '');
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
    this.modeButtons = new Map();
    this.tilesetPanel = null;
    this.worldPanel = null;
    this.scenePanel = null;
    this.sceneImage = null;
    this.activeScene = null;
    this.mask = [];
    this.maskCell = 16;
    this.maskKind = 1;
    this.brushSize = 2;
    this.maskVisible = true;
    this.maskGfx = null;
    this.maskPanel = null;
    this.maskKindButtons = new Map();
    this.sceneNameInput = null;
    this.brushSel = null;
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
    const panel = HudShell.makePanel('04 · COLLISION & ZONES', 'right');
    this.maskPanel = panel;

    const kindRow = document.createElement('div');
    kindRow.className = 'g-row';
    kindRow.style.flexWrap = 'wrap';
    for (const kind of SCENE_MASK_KINDS) {
      const btn = document.createElement('genvy-button') as GenvyButton;
      btn.setAttribute('label', kind.label);
      btn.title = kind.hint;
      btn.onClick(() => {
        UISound.play('click');
        this.maskKind = kind.id;
        this.tool = 'brush';
        eraseBtn.setAttribute('variant', '');
        for (const [id, b] of this.maskKindButtons) {
          b.setAttribute('variant', id === kind.id ? 'accent' : '');
        }
        this.setTool('brush');
      });
      this.maskKindButtons.set(kind.id, btn);
      kindRow.appendChild(btn);
    }

    // Brush size in MASK CELLS, so it means the same thing at any zoom.
    const brushSel = document.createElement('select');
    for (const [size, label] of [
      [1, '1 CELL · FINE'],
      [2, '3x3 CELLS'],
      [4, '7x7 CELLS'],
      [8, '15x15 · BROAD'],
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
        );
      } else {
        this.showToolHint(this.maskTool, 2500);
      }
    });

    // One word, two states: struck through when the overlay is hidden.
    const showBtn = document.createElement('genvy-button') as GenvyButton;
    showBtn.setAttribute('label', 'OVERLAY');
    showBtn.onClick(() => {
      UISound.play('click');
      this.maskVisible = !this.maskVisible;
      if (this.maskVisible) showBtn.removeAttribute('data-off');
      else showBtn.setAttribute('data-off', '');
      this.maskGfx?.setVisible(this.mode === 'scene' && this.maskVisible);
      this.shapeGfx?.setVisible(this.mode === 'scene' && this.maskVisible);
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
      HudShell.toast('MASK AND SHAPES CLEARED');
    });

    // Saving is the panel's headline action, so it sits at the top with the
    // name beside it rather than buried under six paint controls.
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'SCENE NAME';
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


    panel.append(
      field('SCENE NAME', nameInput),
      saveBtn,
      field('PAINT AS', kindRow),
      field('TOOL', penRow),
      field('BRUSH SIZE', brushSel),
      field('MASK RESOLUTION', cellSel),
      toolRow,
      clearBtn,
    );
    // Solid is the default: it is what most of a level needs.
    this.maskKindButtons.get(1)?.setAttribute('variant', 'accent');
    return panel;
  }

  /** Mode switch: a tilemap level and a painted scene are different crafts. */
  private buildModePanel() {
    const panel = HudShell.makePanel('MODE', 'left');
    const row = document.createElement('div');
    row.className = 'g-row';
    for (const [mode, label] of [
      ['tilemap', 'TILEMAP'],
      ['scene', 'PAINTED'],
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
    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent =
      'TILEMAP: A GRID YOU PAINT, WITH COLLISION AND AUTOTILING. ' +
      'PAINTED SCENE: ONE BACKDROP IMAGE FOR ADVENTURE, ISOMETRIC OR PLATFORM GAMES.';
    panel.append(row, hint);
    return panel;
  }

  private setMode(mode: 'tilemap' | 'scene') {
    this.mode = mode;
    for (const [id, btn] of this.modeButtons) {
      btn.setAttribute('variant', id === mode ? 'accent' : '');
    }
    // Only the active mode's panels are on screen; the stage clears so one
    // mode's artwork never lingers under the other's controls.
    if (this.tilesetPanel) HudShell.hidePanel(this.tilesetPanel);
    if (this.worldPanel) HudShell.hidePanel(this.worldPanel);
    if (this.scenePanel) HudShell.hidePanel(this.scenePanel.panel);
    if (this.maskPanel) HudShell.hidePanel(this.maskPanel);
    // Hide, never destroy: switching modes must not throw away a painted map
    // or a loaded scene. Each mode simply shows its own world.
    const tilemapVisible = mode === 'tilemap';
    for (const layer of this.layers) layer.setVisible(tilemapVisible);
    this.gridGfx?.setVisible(tilemapVisible);
    this.sceneImage?.setVisible(!tilemapVisible);
    this.maskGfx?.setVisible(!tilemapVisible && this.maskVisible);
    this.shapeGfx?.setVisible(!tilemapVisible && this.maskVisible);
    // The pen ring belongs to the mask; it must not hover over a tilemap.
    this.brushCursor?.clear();
    this.endPenPath(true);
    HudShell.hideKeyHint();
    this.restoreCursor();

    if (tilemapVisible) {
      if (this.tilesetPanel) HudShell.showPanel(this.tilesetPanel, 'left');
      if (this.worldPanel) HudShell.showPanel(this.worldPanel, 'right');
    } else {
      if (this.scenePanel) HudShell.showPanel(this.scenePanel.panel, 'left');
      if (this.maskPanel) HudShell.showPanel(this.maskPanel, 'right');
    }
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
    g.setVisible(this.mode === 'scene' && this.maskVisible);
    this.maskGfx = g;
  }

  /** Stamp one round brush dab centred on a mask cell. */
  private stampMask(cx: number, cy: number, value: number): boolean {
    const r = this.brushSize - 1;
    // Round nib, not a square block: a square brush cannot follow a slope
    // cleanly, which is most of what collision painting actually is.
    const rr = (r + 0.5) * (r + 0.5);
    let changed = false;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (y < 0 || x < 0 || y >= this.mask.length || x >= this.mask[0]!.length) continue;
        if (r > 0 && (x - cx) * (x - cx) + (y - cy) * (y - cy) > rr) continue;
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
    const raw = this.maskCellAt(pointer);
    if (!raw) return;
    const cell = this.constrainAxis(this.penAnchor, raw);
    const value = this.maskValue();
    if (this.penAnchor) {
      this.pushMaskUndo();
      if (this.strokeBetween(this.penAnchor, cell, value)) this.drawMask();
    } else {
      this.pushMaskUndo();
      if (this.stampMask(cell.x, cell.y, value)) this.drawMask();
    }
    this.penAnchor = cell;
    UISound.play('click');
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
    if (!this.sceneImage) return;
    const p = this.constrainAxis(
      this.penPoints[this.penPoints.length - 1] ?? null,
      this.pixelAt(pointer),
    );
    if (this.closesShape(p)) {
      this.commitShape({
        id: `sh_${Date.now().toString(36)}`,
        kind: this.maskKind,
        type: 'polygon',
        points: this.penPoints.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
      });
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
    this.shapes.push(shape);
    this.drawShapes();
  }

  /**
   * The card that explains the armed tool: its keys drawn as keys, and one
   * line saying what the pointer does. It replaces the wall of hint text the
   * panel used to carry — nobody reads a paragraph, and the paragraph was
   * describing six tools at once when only one of them is ever armed.
   */
  private showToolHint(tool: MaskTool, ms = 5000) {
    const key = (glyph: string, caption: string, on = false) =>
      `<div class="pair"><div class="key${glyph.length > 2 ? ' wide' : ''}${on ? ' on' : ''}">` +
      `${glyph}</div><div class="cap">${caption}</div></div>`;
    const row = (...keys: string[]) => `<div class="row">${keys.join('')}</div>`;

    // Every tool shares the view and history keys, so they sit on one row of
    // their own rather than being re-learned per tool.
    const common = row(key('SPACE', 'PAN'), key('CTRL+Z', 'UNDO'));

    const SPECIFIC: Record<MaskTool, { art: string; msg: string }> = {
      freehand: {
        art: row(key('SHIFT', 'STRAIGHT'), key('[', 'SMALLER'), key(']', 'BIGGER')),
        msg: 'DRAG TO PAINT MASK CELLS',
      },
      line: {
        art: row(key('SHIFT', 'STRAIGHT'), key('ESC', 'END PATH')),
        msg: 'CLICK POINT TO POINT ALONG AN EDGE',
      },
      shape: {
        art: row(key('SHIFT', 'STRAIGHT'), key('ESC', 'CANCEL')),
        msg: 'TRACE AN OUTLINE · CLICK POINT 1 TO CLOSE IT',
      },
      rect: {
        art: row(key('SHIFT', 'SQUARE')),
        msg: 'DRAG A BOX',
      },
      triangle: {
        art:
          row(key('↑', '', this.triangleDir === 'up')) +
          row(
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
    };
    const { art, msg } = SPECIFIC[tool];
    HudShell.keyHint(art + common, msg, ms);
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
    g.setVisible(this.mode === 'scene' && this.maskVisible);
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
    if (changed) this.drawMask();
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
  private async displayScene(scene: Scene) {
    const key = `scene:${scene.id}:${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      this.load.image(key, `${fileUrl(scene.image)}?t=${Date.now()}`);
      this.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
      this.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, () => reject(new Error('scene load failed')));
      this.load.start();
    });
    this.sceneImage?.destroy();
    // Top-left at the world origin, exactly like the tilemap: the mask
    // overlay then shares one coordinate space with the art, and the two
    // modes cannot drift apart on screen.
    const img = this.add.image(0, 0, key).setOrigin(0, 0);
    this.sceneImage = img;
    this.activeScene = scene;
    if (this.sceneNameInput) this.sceneNameInput.value = scene.name;
    this.scenePanel?.refresh();
    this.initMask(scene, img.width, img.height);
    const cam = this.cameras.main;
    cam.centerOn(img.width / 2, img.height / 2);
    cam.setZoom(
      Phaser.Math.Clamp(
        Math.min((this.scale.width - 680) / img.width, (this.scale.height - 140) / img.height),
        0.05,
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
    // A saved tileset arrives with no concept in memory, so its texts were
    // previously uneditable — this reopens them from the ASSET itself.
    const editBtn = document.createElement('genvy-button') as GenvyButton;
    editBtn.setAttribute('label', '✎ EDIT TEXTS');
    const applyBtn = document.createElement('genvy-button') as GenvyButton;
    applyBtn.setAttribute('label', 'UPDATE TEXTS');
    const statusHost = document.createElement('div');
    this.paletteHost = document.createElement('div');
    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent = 'CLICK A TILE TO PAINT WITH IT. RIGHT-CLICK TOGGLES COLLISION (RED DOT).';

    // One prompt to a playable scene: concept -> tileset -> plan -> built map.
    const oneShotBtn = document.createElement('genvy-button') as GenvyButton;
    oneShotBtn.setAttribute('variant', 'accent');
    oneShotBtn.setAttribute('label', '⚡ FORGE ENTIRE LEVEL');
    this.providerControls = new ProviderControls({
      workflow: 'anchor-generate', // a tileset sheet is a plain generation
      candidates: false, // the sheet IS the set; candidates would mean 4 sheets
    });
    this.providerControls.onChange = () => {
      oneShotBtn.setLabel(
        `⚡ FORGE ENTIRE LEVEL${
          this.providerControls ? ` · ${this.providerControls.costPreview()}` : ''
        }`,
      );
    };
    oneShotBtn.onClick(() => void this.forgeEntireLevel(prompt.value));

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

    panel.append(
      field('DESCRIBE THE WORLD THEME', prompt),
      ...this.providerControls.elements(),
      oneShotBtn,
      genBtn,
      this.conceptFields,
      forgeBtn,
      editBtn,
      statusHost,
      hint,
      this.paletteHost,
    );
    editBtn.style.display = 'none'; // only meaningful once a tileset exists
    this.editTextsBtn = editBtn;

    editBtn.onClick(() => {
      const ts = this.tileset;
      if (!ts) return;
      UISound.play('click');
      const showing = this.conceptFields!.style.display !== 'none';
      if (showing) {
        this.conceptFields!.style.display = 'none';
        return;
      }
      // Seed from the SAVED asset so edits apply to what is on disk.
      this.conceptNameIn.value = ts.name;
      this.conceptPromptIn.value = ts.description;
      this.conceptTilesIn.value = ts.tiles.map((t) => t.name).join('\n');
      this.conceptFields!.style.display = '';
      for (const el of [this.conceptPromptIn, this.conceptTilesIn]) autoGrow.refresh(el);
    });

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
      if (!this.concept) return HudShell.toast('GENERATE A CONCEPT FIRST', 'error');
      // Whatever is in the fields right now is what gets drawn.
      this.syncConceptFromFields();
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
          targetTileSize: TILE_SIZE,
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
      }, { key: 'tileset:image', fallbackMs: 50000 });
    });

    return panel;
  }

  private buildWorldPanel() {
    const panel = HudShell.makePanel('02 · WORLD', 'right');
    this.worldPanel = panel;

    const newBtn = document.createElement('genvy-button') as GenvyButton;
    newBtn.setAttribute('label', 'NEW BLANK WORLD');
    const aiPrompt = textArea('', 'e.g. a cave with three chambers and a lava pit');
    const aiBtn = document.createElement('genvy-button') as GenvyButton;
    aiBtn.setAttribute('label', 'AI LAYOUT DRAFT');
    const saveBtn = document.createElement('genvy-button') as GenvyButton;
    saveBtn.setAttribute('variant', 'accent');
    saveBtn.setAttribute('label', 'SAVE WORLD');
    const statusHost = document.createElement('div');

    const toolRow = document.createElement('div');
    toolRow.className = 'g-row';
    for (const t of ['brush', 'erase', 'fill'] as PaintTool[]) {
      const b = document.createElement('genvy-button') as GenvyButton;
      b.setAttribute('label', t.toUpperCase());
      b.onClick(() => this.setTool(t));
      this.toolButtons.set(t, b);
      toolRow.appendChild(b);
    }

    const layerRow = document.createElement('div');
    layerRow.className = 'g-row';
    (['GROUND', 'DECOR'] as const).forEach((name, i) => {
      const b = document.createElement('genvy-button') as GenvyButton;
      b.setAttribute('label', name);
      b.onClick(() => {
        this.activeLayer = i;
        HudShell.toast(`EDITING LAYER: ${name}`);
      });
      layerRow.appendChild(b);
    });

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
      document.createElement('div'),
      field('TOOL', toolRow),
      field('LAYER', layerRow),
      document.createElement('div'),
      field('DESCRIBE A LAYOUT', aiPrompt),
      aiBtn,
      saveBtn,
      statusHost,
    );

    newBtn.onClick(() => {
      if (!this.tileset) return HudShell.toast('FORGE OR LOAD A TILESET FIRST', 'error');
      this.worldId = null;
      this.buildMap(Number(this.widthIn.value) || 40, Number(this.heightIn.value) || 23);
      HudShell.toast('BLANK WORLD READY — PAINT AWAY');
    });

    aiBtn.onClick(async () => {
      if (!this.tileset) return HudShell.toast('FORGE OR LOAD A TILESET FIRST', 'error');
      if (!aiPrompt.value.trim()) return HudShell.toast('DESCRIBE THE LAYOUT FIRST', 'error');
      await this.busy(statusHost, 'DRAFTING LEVEL...', async () => {
        UISound.play('generate');
        HudShell.setBusyLabel(
          `DEEPSEEK · LAYING OUT ${this.widthIn.value}x${this.heightIn.value} TILES (GROUND, DECOR, SPAWNS)...`,
        );
        // The model PLANS (rooms, roles, densities — a few dozen numbers) and
        // buildWorldGrid carves the map. Asking for the raw 40x23 grid meant
        // ~920 integers per layer: truncated replies and disconnected rooms.
        const res = await api.aiText<WorldPlan>({
          tool: 'world',
          prompt: `${aiPrompt.value}\nLevel size: ${this.widthIn.value} x ${this.heightIn.value} tiles.`,
          schemaName: 'worldPlan',
          context: {
            width: Number(this.widthIn.value),
            height: Number(this.heightIn.value),
            tiles: this.tileset!.tiles.map((t) => ({ index: t.index, name: t.name, collides: t.collides })),
          },
        });
        HudShell.setBusyLabel('BUILDING ROOMS, CORRIDORS & DECOR (FREE)...');
        this.applyPlan(res.result);
        UISound.play('complete');
        HudShell.toast('LAYOUT DRAFTED — REFINE BY HAND', 'success');
      }, { key: 'world:layout', fallbackMs: 25000 });
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
      this.tileset = saved;
      await this.useTileset(saved);
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
    if (this.layers.length === 0) return;
    this.undoStack.push(this.layers.map((l) => this.layerToData(l)));
    if (this.undoStack.length > WorldToolScene.UNDO_LIMIT) this.undoStack.shift();
  }

  /** Put the last snapshot back on the map. */
  private undo() {
    // Each mode undoes its own history: a mask stroke and a tile stroke are
    // not interchangeable steps.
    if (this.mode === 'scene') {
      const snap = this.maskUndo.pop();
      if (!snap) return HudShell.toast('NOTHING TO UNDO', 'warn');
      this.mask = snap.mask;
      this.shapes = snap.shapes;
      this.drawMask();
      this.drawShapes();
      UISound.play('click');
      HudShell.toast(`UNDONE · ${this.maskUndo.length} STEP(S) LEFT`);
      return;
    }
    const snapshot = this.undoStack.pop();
    if (!snapshot) return HudShell.toast('NOTHING TO UNDO', 'warn');
    snapshot.forEach((data, li) => {
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
   * One prompt -> a playable scene. Chains the four steps that were manual
   * buttons: write the tileset concept, draw the sheet, plan the level, build
   * the geometry. Each step reports its own chip so a five-minute run reads as
   * progress rather than a hang, and the paid step is named before it runs.
   */
  private async forgeEntireLevel(theme: string) {
    if (!theme.trim()) return HudShell.toast('DESCRIBE THE WORLD THEME FIRST', 'error');
    const controls = this.providerControls;
    const blocked = controls?.blockedReason();
    if (blocked) return HudShell.toast(blocked, 'error');

    const steps: { label: string; state: BusyStepState }[] = [
      { label: 'CONCEPT', state: 'active' },
      { label: 'TILES', state: 'pending' },
      { label: 'PLAN', state: 'pending' },
      { label: 'BUILD', state: 'pending' },
    ];
    await this.busy(
      null,
      'FORGING AN ENTIRE LEVEL...',
      async () => {
        UISound.play('generate');
        const oneShotReforgeId = this.tileset?.id ?? null;
        HudShell.setBusySteps(steps);
        HudShell.setBusyLabel('DEEPSEEK · PLANNING THE TILE SET...');
        const concept = (
          await api.aiText<TilesetConcept>({
            tool: 'tileset',
            prompt: theme,
            schemaName: 'tilesetConcept',
          })
        ).result;
        this.concept = concept;
        this.showConcept(concept);
        steps[0]!.state = 'done';
        steps[1]!.state = 'active';
        HudShell.setBusySteps(steps);

        HudShell.setBusyLabel(`${controls?.tag() ?? 'GPT-IMAGE-2'} · DRAWING 24 TILES...`);
        const img = await api.aiImage({
          prompt: `${concept.imagePrompt}. Tiles in order: ${
            concept.tileNames.length ? concept.tileNames.join(', ') : concept.imagePrompt
          }`,
          orientation: 'portrait',
          kind: 'tileset',
          provider: controls?.providerId(),
          modelFamily: controls?.modelFamily(),
          renderSize: controls?.renderSize(),
          quality: controls?.quality(),
        });
        HudShell.setBusyLabel('CUTTING & PACKING THE TILES (FREE)...');
        const extract = await api.extractTiles({
          assetId: img.assetId,
          sourceFile: 'raw.png',
          cols: GRID_COLS,
          rows: GRID_ROWS,
          targetTileSize: TILE_SIZE,
          dedupe: false,
        });
        // Same rule as the manual forge: iterating replaces the open set.
        const { asset: saved } = await this.saveForgedTileset({
          id: img.assetId,
          name: concept.name,
          description: concept.description,
          tags: concept.tags,
          image: extract.tileset,
          sourceImage: { path: `${img.assetId}/raw.png` },
          tileWidth: extract.tileWidth,
          tileHeight: extract.tileHeight,
          tiles: Array.from({ length: extract.tileCount }, (_, i) => ({
            index: i,
            name: concept.tileNames[i] ?? `tile ${i + 1}`,
            collides: concept.collidingTiles.includes(i),
            tags: [],
          })),
          thumbnail: extract.thumbnail,
        }, oneShotReforgeId);
        await this.useTileset(saved);
        steps[1]!.state = extract.gate && !extract.gate.pass ? 'failed' : 'done';
        steps[2]!.state = 'active';
        HudShell.setBusySteps(steps);

        HudShell.setBusyLabel('DEEPSEEK · PLANNING ROOMS, CORRIDORS & SPAWNS...');
        const plan = (
          await api.aiText<WorldPlan>({
            tool: 'world',
            prompt: `${theme}\nLevel size: ${this.widthIn.value} x ${this.heightIn.value} tiles.`,
            schemaName: 'worldPlan',
            context: {
              width: Number(this.widthIn.value),
              height: Number(this.heightIn.value),
              tiles: saved.tiles.map((t) => ({
                index: t.index,
                name: t.name,
                collides: t.collides,
              })),
            },
          })
        ).result;
        steps[2]!.state = 'done';
        steps[3]!.state = 'active';
        HudShell.setBusySteps(steps);

        HudShell.setBusyLabel('BUILDING THE MAP (FREE)...');
        this.applyPlan(plan);
        steps[3]!.state = 'done';
        HudShell.setBusySteps(steps);

        await collection.refresh();
        UISound.play('complete');
        const gate = extract.gate;
        HudShell.toast(
          `LEVEL FORGED: ${concept.name.toUpperCase()} · ${plan.rooms.length} ROOMS` +
            `${gate ? ` · TILE GATE ${gate.score}/100` : ''} — PAINT TO REFINE, THEN SAVE`,
          gate && !gate.pass ? 'warn' : 'success',
        );
      },
      {
        // Keyed by provider + size: a local 1024 sheet and a gpt-image-2 call
        // are minutes apart, and one average for both is a lie.
        key: `world:oneshot:${this.providerControls?.providerId() ?? 'openai'}:${this.providerControls?.renderSize() ?? 'std'}`,
        fallbackMs: 90000,
      },
    );
  }

  /** Fill the blueprint from a freshly written concept and reveal it. */
  private showConcept(concept: TilesetConcept) {
    this.conceptNameIn.value = concept.name;
    this.conceptPromptIn.value = concept.imagePrompt;
    this.conceptTilesIn.value = concept.tileNames.join('\n');
    if (this.conceptFields) this.conceptFields.style.display = '';
    for (const el of [this.conceptPromptIn, this.conceptTilesIn]) autoGrow.refresh(el);
  }

  /** Edits win over what the writer produced (the fields ARE the concept now). */
  private syncConceptFromFields() {
    if (!this.concept) return;
    const tiles = this.conceptTilesIn.value
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
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
    }
  }

  private renderPalette() {
    if (!this.paletteHost || !this.tileset) return;
    const ts = this.tileset;
    const img = this.textures.get(this.tilesetKey).getSourceImage() as HTMLImageElement;
    const cols = Math.max(1, Math.floor(img.width / ts.tileWidth));
    this.paletteHost.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'g-tile-grid';
    const url = fileUrl(ts.image);
    ts.tiles.forEach((tile) => {
      const cell = document.createElement('div');
      cell.className = 'g-tile';
      if (tile.collides) cell.classList.add('collides');
      if (tile.index === this.selectedTile) cell.classList.add('selected');
      const x = (tile.index % cols) * ts.tileWidth;
      const y = Math.floor(tile.index / cols) * ts.tileHeight;
      cell.style.backgroundImage = `url(${url})`;
      cell.style.backgroundSize = `${(img.width / ts.tileWidth) * 100}% auto`;
      cell.style.backgroundPosition = `-${(x / ts.tileWidth) * 100}% -${(y / ts.tileHeight) * 100}%`;
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

    const cam = this.cameras.main;
    cam.centerOn((width * ts.tileWidth) / 2, (height * ts.tileHeight) / 2);
    const fit = Math.min(
      (this.scale.width - 660) / (width * ts.tileWidth),
      (this.scale.height - 120) / (height * ts.tileHeight),
    );
    cam.setZoom(Phaser.Math.Clamp(fit, 0.2, 1.5));
  }

  /**
   * Build a map from an AI plan. The geometry is produced locally, so it is
   * free, instant and correct by construction: every room reachable, walls
   * enclosing, decor only on the surface it targets.
   */
  private applyPlan(plan: WorldPlan) {
    if (!this.tileset) return;
    const width = Number(this.widthIn.value) || 40;
    const height = Number(this.heightIn.value) || 23;
    const built = buildWorldGrid(plan, { width, height });
    this.worldNameIn.value = plan.name || this.worldNameIn.value;
    this.pushUndo(); // a drafted layout is undoable like any other change
    this.buildMap(
      width,
      height,
      built.layers.map((l) => l.data),
    );
    this.plannedSpawns = built.spawnPoints;
    if (built.notes.length > 0) {
      console.log('[genvy] world builder notes:', built.notes);
      HudShell.toast(built.notes[0]!.toUpperCase(), 'warn');
    }
  }

  /** The cursor for the current state, once a drag or a mode change ends. */
  private restoreCursor() {
    if (this.spacePanning) return this.input.setDefaultCursor('grab');
    // Painted mode aims at pixels, so it keeps a crosshair.
    this.input.setDefaultCursor(this.mode === 'scene' ? 'crosshair' : 'default');
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
      // Vector tools click and drag; they never touch the mask grid.
      if (this.mode === 'scene' && p.leftButtonDown() && !this.spacePanning) {
        // With the ERASER armed, a click on a vector tool removes the shape under
        // the cursor rather than starting another one.
        if (this.tool === 'erase' && VECTOR_TOOLS.includes(this.maskTool)) {
          if (this.eraseShapeAt(p)) return;
        }
        if (this.maskTool === 'line') {
          this.penClick(p);
          return;
        }
        if (this.maskTool === 'shape') {
          this.shapeClick(p);
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
        if (this.mode === 'scene') this.pushMaskUndo();
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
      HudShell.toast(`BRUSH ${this.brushSize * 2 - 1} CELLS`);
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
    this.input.keyboard?.on('keydown-ESC', () => this.endPenPath());
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
        if (this.mode !== 'scene' || this.maskTool !== 'triangle') return;
        ev.preventDefault();
        this.triangleDir = dir;
        UISound.play('click');
        this.showToolHint('triangle');
        this.drawShapes(); // an in-progress drag re-aims immediately
      });
    }
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.painting && p.leftButtonDown()) this.paintAt(p);
      if (this.shapeDrag && p.leftButtonDown()) {
        this.shapeDrag.now = this.pixelAt(p);
        this.drawShapes(); // live preview of the primitive being sized
      }
      this.drawBrushCursor(p);
    });
    this.input.on('pointerup', () => {
      this.painting = false;
      this.lastMaskCell = null;
      this.strokeOrigin = null;
      if (this.shapeDrag) {
        const shape = this.dragToShape();
        this.shapeDrag = null;
        if (shape) {
          this.commitShape(shape);
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
    if (this.mode !== 'scene' || !this.sceneImage || this.spacePanning) return;

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
    const r = this.brushSize - 1;
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
    g.lineStyle(thick, color, 0.95);
    g.strokeCircle((cell.x + 0.5) * size, (cell.y + 0.5) * size, (r + 0.5) * size);
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
    });
    if (this.maskUndo.length > WorldToolScene.UNDO_LIMIT) this.maskUndo.shift();
  }

  private paintAt(pointer: Phaser.Input.Pointer) {
    // Each mode paints its own thing: tiles into a tilemap, or gameplay
    // zones over a painted scene.
    if (this.mode === 'scene') {
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

    if (this.tool === 'brush') {
      layer.putTileAt(this.selectedTile, tx, ty);
    } else if (this.tool === 'erase') {
      layer.removeTileAt(tx, ty);
    } else if (this.tool === 'fill') {
      this.floodFill(layer, tx, ty, this.selectedTile);
      this.painting = false;
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
      layer.putTileAt(newIndex, cx!, cy!);
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
      return { created: false };
    }
    const saved = await api.createAsset<World>('world', payload);
    this.worldId = saved.id;
    return { created: true };
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
        this.buildMap(world.width, world.height, tileLayers.map((l) => (l as { data: number[][] }).data));
        HudShell.toast(`WORLD LOADED: ${world.name.toUpperCase()}`);
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
