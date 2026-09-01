import Phaser from 'phaser';
import type {
  CharacterConcept,
  Spritesheet,
  Character,
  AnimationAsset,
  SpriteBox,
  AssetIndexEntry,
} from '@genvy/shared';
import { newAssetId } from '@genvy/shared';
import { HudShell } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { goToScene, enterScene } from '../../hud/transitions.js';
import { api, fileUrl, ApiError } from '../../api/client.js';
import { collection } from '../../state/collection.js';
import {
  field,
  textInput,
  textArea,
  rangeInput,
  GenvyButton,
  type GenvyPanel,
} from '../../hud/components.js';

const DESCRIBE_PLACEHOLDER =
  "e.g. a tiny rocket-powered axolotl knight, side view facing right — YOU set pose, view & angle ('3/4 top-down', 'front facing', ...)";
const IMAGE_PROMPT_PLACEHOLDER =
  "visual appearance — include the view & angle you want, e.g. 'side view facing right, full body'";
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

const STANDARD_ANIMS = [
  'idle', 'walk', 'run', 'jump', 'fall', 'land',
  'crouch', 'climb', 'swim', 'dash', 'roll', 'slide',
  'attack', 'attack2', 'shoot', 'cast', 'block',
  'hurt', 'death', 'spawn', 'victory', 'taunt',
];

const CLIP_RATES: Record<string, number> = {
  idle: 5, walk: 9, run: 12, jump: 8, fall: 8, land: 10,
  crouch: 8, climb: 8, swim: 8, dash: 14, roll: 14, slide: 12,
  attack: 12, attack2: 12, shoot: 12, cast: 10, block: 10,
  hurt: 8, death: 7, spawn: 8, victory: 7, taunt: 8,
};

function checkbox(): HTMLInputElement {
  const c = document.createElement('input');
  c.type = 'checkbox';
  return c;
}

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
  private concept: CharacterConcept | null = null;
  private variants: VariantWs[] = [];
  private active = -1;
  private strip: Clip | null = null;

  private previewImage: Phaser.GameObjects.Image | null = null;
  private overlayGfx: Phaser.GameObjects.Graphics | null = null;
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
  /** Sheet frames removed but not yet applied — rendered as restorable ghosts. */
  private removedFrames: number[] = [];
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
  private framePreset = FRAME_PRESETS[2]!; // 8 · 4x2 default
  private notesIn = textArea('', NOTES_PLACEHOLDER);
  private styleIn = rangeInput(30, 0, 100);
  private creativityIn = rangeInput(60, 0, 100);
  private bordersChk = checkbox();
  private selectedClipCat: string | null = null;

  // panels
  private conceptPanel: GenvyPanel | null = null;
  private variantsPanel: GenvyPanel | null = null;
  private variantGrid: HTMLElement | null = null;
  private animPanel: GenvyPanel | null = null;
  private previewPanel: GenvyPanel | null = null;
  private resliceBtn: GenvyButton | null = null;
  private editShapesBtn: GenvyButton | null = null;
  private saveBtn: GenvyButton | null = null;
  private clipListEl: HTMLElement | null = null;

  // preview animator
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewTimer = 0;

  constructor() {
    super('spriteTool');
  }

  create(data: SpriteToolData) {
    enterScene(this);
    this.resetState();
    this.drawBackdrop();

    HudShell.setBackVisible(true);
    HudShell.setStatus('SPRITE FORGE');
    HudShell.hideDrawer();
    HudShell.onBackToHub = () => void goToScene(this, 'hub');
    HudShell.onOpenAsset = (entry) => {
      if (entry.type === 'spritesheet' || entry.type === 'character' || entry.type === 'animation') {
        void goToScene(this, 'spriteTool', { assetId: entry.id, assetType: entry.type });
      } else if (entry.type === 'tileset' || entry.type === 'world') {
        void goToScene(this, 'worldTool', { assetId: entry.id, assetType: entry.type });
      }
    };
    HudShell.onOpenRecovered = (id: string) => {
      void goToScene(this, 'spriteTool', { recoveredId: id });
    };

    void HudShell.setLayout([this.buildConceptPanel()]);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.removeLabelLayer();
      window.clearInterval(this.previewTimer);
    });

    if (data?.recoveredId) void this.loadRecovered(data.recoveredId);
    else if (data?.assetId) void this.loadExisting(data.assetId, data.assetType ?? '');
  }

  private resetState() {
    this.sessionId = '';
    this.sessionIsSaved = false;
    this.concept = null;
    this.variants = [];
    this.active = -1;
    this.strip = null;
    this.previewImage = null;
    this.overlayGfx = null;
    this.hitZones = [];
    this.captionText = null;
    this.stripGeom = null;
    this.worldGeom = null;
    this.stripGroups = null;
    this.activeGroup = 0;
    this.sheetBoxes = [];
    this.groupSheetIdx = [];
    this.removedFrames = [];
    this.shapesDirty = false;
    this.selectionsDirty = false;
    this.editMode = false;
    this.detachReviewKeys();
    this.removeLabelLayer();
    this.describeIn = textArea('', DESCRIBE_PLACEHOLDER);
    this.nameIn = textInput('', 'unnamed');
    this.descIn = textArea('', 'description');
    this.imagePromptIn = textArea('', IMAGE_PROMPT_PLACEHOLDER);
    this.frameSizeSel = resolutionSelect();
    this.animNameIn = textInput('idle', 'animation name');
    this.framePreset = FRAME_PRESETS[2]!;
    this.notesIn = textArea('', NOTES_PLACEHOLDER);
    this.styleIn = rangeInput(30, 0, 100);
    this.creativityIn = rangeInput(60, 0, 100);
    this.bordersChk = checkbox();
    this.selectedClipCat = null;
    this.conceptPanel = null;
    this.variantsPanel = null;
    this.variantGrid = null;
    this.animPanel = null;
    this.previewPanel = null;
    this.resliceBtn = null;
    this.editShapesBtn = null;
    this.saveBtn = null;
    this.clipListEl = null;
    this.previewCanvas = null;
    window.clearInterval(this.previewTimer);
  }

  private activeWs(): VariantWs | null {
    return this.variants[this.active] ?? null;
  }

  private drawBackdrop() {
    const { width, height } = this.scale;
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x0a1e2c, 1);
    for (let x = 0; x < width; x += 32) grid.lineBetween(x, 0, x, height);
    for (let y = 0; y < height; y += 32) grid.lineBetween(0, y, width, y);
    grid.setAlpha(0.6);
    this.add
      .text(width / 2, 70, 'SPRITE FORGE', {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '15px',
        color: '#12475c',
      })
      .setOrigin(0.5);
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

  private buildConceptPanel() {
    const panel = HudShell.makePanel('01 · CONCEPT', 'left');
    this.conceptPanel = panel;
    const prompt = this.describeIn;
    const genBtn = document.createElement('genvy-button') as GenvyButton;
    genBtn.setAttribute('label', 'GENERATE CONCEPT');
    const forgeBtn = document.createElement('genvy-button') as GenvyButton;
    forgeBtn.setAttribute('variant', 'accent');
    forgeBtn.setAttribute('label', 'FORGE 4 VARIANTS');

    panel.append(
      field('DESCRIBE YOUR CHARACTER', prompt),
      genBtn,
      document.createElement('div'),
      field('NAME', this.nameIn),
      field('LORE', this.descIn),
      field('IMAGE PROMPT', this.imagePromptIn),
      field('STYLE · STYLIZED ◄─► REALISTIC', this.styleIn),
      field('CREATIVITY · FAITHFUL ◄─► WILD', this.creativityIn),
      field('GREEN CELL BORDERS (EXPERIMENTAL)', this.bordersChk),
      forgeBtn,
    );

    genBtn.onClick(async () => {
      if (!prompt.value.trim()) return HudShell.toast('DESCRIBE THE CHARACTER FIRST', 'error');
      await this.busy('CONSULTING THE DESIGN CORE...', async () => {
        UISound.play('generate');
        const res = await api.aiText<CharacterConcept>({
          tool: 'sprite',
          prompt: prompt.value,
          schemaName: 'characterConcept',
          temperature: (Number(this.creativityIn.value) / 100) * 1.5,
        });
        this.concept = res.result;
        this.nameIn.value = this.concept.name;
        this.descIn.value = this.concept.description;
        this.imagePromptIn.value = this.concept.imagePrompt;
        if (this.sessionId) this.persistConcept(this.sessionId);
        UISound.play('confirm');
        HudShell.toast(`CONCEPT ACQUIRED: ${this.concept.name.toUpperCase()}`, 'success');
      });
    });

    forgeBtn.onClick(async () => {
      const appearance = this.imagePromptIn.value.trim();
      if (!appearance) return HudShell.toast('GENERATE OR WRITE AN IMAGE PROMPT FIRST', 'error');
      await this.busy('FORGING 4 VARIANTS · THIS TAKES A MINUTE...', async () => {
        UISound.play('generate');
        // Never write into an opened asset's folder — that work would be
        // invisible to the collection. Forging from a saved asset starts fresh.
        const res = await api.aiImage({
          prompt: appearance,
          orientation: 'portrait',
          kind: 'variants',
          assetId: this.sessionIsSaved ? undefined : this.sessionId || undefined,
          outName: 'variants.png',
          styleHint: this.styleHint(),
          cellBorders: this.bordersChk.checked,
        });
        this.sessionId = res.assetId;
        this.sessionIsSaved = false;
        this.persistConcept(this.sessionId);
        const det = await api.detect({ assetId: this.sessionId, sourceFile: 'variants.png' });
        this.variants = det.boxes.map((box) => ({ box, wsId: null, kept: [] }));
        this.active = -1;
        this.ensureVariantsPanel();
        await this.refreshVariantSquares();
        this.setStage('variants');
        await this.showVariantPicker();
        // Surface the new session in the collection drawer right away.
        await collection.refresh();
        UISound.play('complete');
        HudShell.toast('PICK A VARIANT (V1–V4) TO START ANIMATING', 'success');
      });
    });

    return panel;
  }

  /** Persistent V1–V4 squares under the concept panel. */
  private ensureVariantsPanel() {
    if (this.variantsPanel) return;
    this.variantsPanel = HudShell.makePanel('VARIANTS', 'right');
    this.variantGrid = document.createElement('div');
    this.variantGrid.className = 'g-variant-grid';
    this.variantsPanel.append(this.variantGrid);
    HudShell.addPanel(this.variantsPanel);
  }

  private refreshVariantSquares(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.variantGrid) return resolve();
      const grid = this.variantGrid;
      const img = new Image();
      img.src = `${fileUrl(`${this.sessionId}/variants.png`)}?t=${Date.now()}`;
      img.onload = () => {
        grid.innerHTML = '';
        this.variants.forEach((v, i) => {
          const cell = document.createElement('div');
          cell.className = `g-variant-cell${i === this.active ? ' selected' : ''}`;
          const canvas = document.createElement('canvas');
          canvas.width = 96;
          canvas.height = 96;
          const ctx = canvas.getContext('2d')!;
          const scale = Math.min(96 / v.box.w, 96 / v.box.h);
          ctx.drawImage(
            img, v.box.x, v.box.y, v.box.w, v.box.h,
            (96 - v.box.w * scale) / 2, (96 - v.box.h * scale) / 2,
            v.box.w * scale, v.box.h * scale,
          );
          const tag = document.createElement('div');
          tag.className = 'g-variant-tag';
          tag.textContent = `V${i + 1}`;
          cell.append(canvas, tag);
          cell.addEventListener('mouseenter', () => UISound.play('hover'));
          cell.addEventListener('click', () => void this.selectVariant(i));
          grid.appendChild(cell);
        });
        resolve();
      };
      img.onerror = () => resolve();
    });
  }

  /** Full-size picker in the scene (clickable regions mirror the squares). */
  private async showVariantPicker() {
    if (this.variants.length === 0) return;
    const key = this.textureKey('variants.png');
    await this.loadTexture(key, `${fileUrl(`${this.sessionId}/variants.png`)}?t=${Date.now()}`);
    this.clearStage();
    const { width, height } = this.scale;
    const img = this.add.image(width / 2 - 140, height / 2 + 10, key);
    const s = Math.min((height - 140) / img.height, (width - 900) / img.width, 1);
    img.setScale(s);
    this.previewImage = img;

    const x0 = img.x - img.displayWidth / 2;
    const y0 = img.y - img.displayHeight / 2;
    const g = this.add.graphics();
    this.overlayGfx = g;

    this.variants.forEach((v, i) => {
      const b = v.box;
      g.lineStyle(1, 0x1de9ff, 0.7);
      g.strokeRect(x0 + b.x * s, y0 + b.y * s, b.w * s, b.h * s);
      const label = this.add.text(x0 + b.x * s + 4, y0 + b.y * s + 4, `V${i + 1}`, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '12px',
        color: '#1de9ff',
      });
      this.hitZones.push(label as unknown as Phaser.GameObjects.Zone);
      const zone = this.add
        .zone(x0 + (b.x + b.w / 2) * s, y0 + (b.y + b.h / 2) * s, b.w * s, b.h * s)
        .setInteractive({ useHandCursor: true });
      zone.on('pointerover', () => {
        UISound.play('hover');
        g.lineStyle(2, 0xff9d1d, 1);
        g.strokeRect(x0 + b.x * s, y0 + b.y * s, b.w * s, b.h * s);
      });
      zone.on('pointerdown', () => void this.selectVariant(i));
      this.hitZones.push(zone);
    });
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
        this.persistConcept(ws.wsId);
      } else if (ws.kept.length === 0) {
        await this.restoreClips(ws);
      }
      this.active = index;
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
      await this.refreshVariantSquares();
      // Bring this variant's clips to the currently selected quality.
      await this.resampleClips(Number(this.frameSizeSel.value));
      this.refreshClipList();
      const ws2 = this.activeWs();
      if (ws2?.kept[0]) this.previewClip(ws2.kept[0]);
      await this.showVariantConfirmed();
      HudShell.toast(`V${index + 1} ACTIVE — EACH VARIANT KEEPS ITS OWN ANIMATIONS`, 'success');
    });
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
    const s = Math.min((height - 220) / img.height, (width - 680) / img.width, 1.5);
    img.setScale(s);
    this.previewImage = img;
    this.captionText = this.add
      .text(img.x, img.y + img.displayHeight / 2 + 20, `V${this.active + 1}`, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '13px',
        color: '#1de9ff',
      })
      .setOrigin(0.5);
  }

  // ---------------- Stage 2: one animation at a time ----------------

  /**
   * Two stages: the variant grid (concept left, variants right) and the
   * editing stage (animation forge left, clips & preview right).
   */
  private setStage(stage: 'variants' | 'editing') {
    if (stage === 'variants') {
      if (this.conceptPanel) HudShell.showPanel(this.conceptPanel, 'left');
      if (this.variantsPanel) HudShell.showPanel(this.variantsPanel, 'right');
      HudShell.hidePanel(this.animPanel);
      HudShell.hidePanel(this.previewPanel);
    } else {
      HudShell.hidePanel(this.conceptPanel);
      HudShell.hidePanel(this.variantsPanel);
      if (this.animPanel) HudShell.showPanel(this.animPanel, 'left');
      if (this.previewPanel) HudShell.showPanel(this.previewPanel, 'right');
    }
  }

  private ensureAnimPanels() {
    if (this.animPanel) return;
    this.animPanel = this.buildAnimPanel();
    this.previewPanel = this.buildPreviewPanel();
    this.animPanel.dataset.dock = 'left';
    this.previewPanel.dataset.dock = 'right';
    HudShell.addPanel(this.animPanel);
    HudShell.addPanel(this.previewPanel);
    this.refreshClipList();
  }

  /** Preset animation names: the AI's plan for this character first, then the standards. */
  private animationPresets(): string[] {
    const planned = (this.concept?.suggestedAnimations ?? []).map((c) => c.slot);
    return [...new Set([...planned, ...STANDARD_ANIMS])];
  }

  private currentAnimName(): string {
    return (this.animNameIn.value.trim().toLowerCase() || 'idle').replace(/[^\w-]+/g, '_');
  }

  private buildAnimPanel() {
    const panel = HudShell.makePanel('02 · ANIMATION FORGE', 'right');

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
        this.restoreNotesFor(presetSel.value);
        UISound.play('click');
      }
    });
    this.animNameIn.addEventListener('change', () => this.restoreNotesFor(this.currentAnimName()));
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
    const editShapesBtn = document.createElement('genvy-button') as GenvyButton;
    editShapesBtn.setAttribute('label', 'EDIT SHAPES');
    editShapesBtn.style.display = 'none';
    this.editShapesBtn = editShapesBtn;
    const resliceBtn = document.createElement('genvy-button') as GenvyButton;
    resliceBtn.setAttribute('label', 'MANUAL SLICING');
    resliceBtn.style.display = 'none';
    this.resliceBtn = resliceBtn;

    panel.append(
      backBtn,
      field('PRESETS', presetSel),
      field('ANIMATION NAME', this.animNameIn),
      field('FRAMES', chipRow),
      field('MOTION NOTES', this.notesIn),
      field('RESOLUTION', this.frameSizeSel),
      forgeBtn,
      editShapesBtn,
      resliceBtn,
    );

    backBtn.onClick(() => void this.backToVariants());
    forgeBtn.onClick(() => void this.forgeAnimation());
    editShapesBtn.onClick(() => {
      this.editMode = true;
      this.updateModeButtons();
      this.renderStripLabels();
      HudShell.toast('EDIT MODE — DRAW, LASSO (SHIFT), DELETE FRAMES; MANUAL SLICING APPLIES');
    });
    resliceBtn.onClick(() => void this.resliceStrip());
    // Resolution changes resample every clip locally from the original raws.
    this.frameSizeSel.addEventListener('change', () => void this.applyResolution());
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
      this.ensureVariantsPanel();
      await this.refreshVariantSquares();
      this.setStage('variants');
      await this.showVariantPicker();
    });
  }

  /** Re-cut the strip using the user's rect groups (union-masked, local, free). */
  private async resliceStrip(opts: { keepEditMode?: boolean } = {}) {
    const ws = this.activeWs();
    if (!ws?.wsId || !this.strip || !this.stripGroups) return;
    await this.busy('RE-SLICING WITH YOUR SELECTIONS...', async () => {
      const sliced = await api.autoSlice({
        assetId: ws.wsId!,
        sourceFile: this.strip!.rawFile,
        targetFrameSize: Number(this.frameSizeSel.value),
        outName: this.strip!.sheetFile,
        columns: STRIP_ROW,
        groups: this.stripGroups!,
      });
      this.strip = {
        ...this.strip!,
        count: sliced.frameCount,
        frameWidth: sliced.frameWidth,
        frameHeight: sliced.frameHeight,
        order: Array.from({ length: sliced.frameCount }, (_, i) => i),
        groups: this.stripGroups!,
      };
      this.sheetBoxes = sliced.boxes;
      this.groupSheetIdx = sliced.boxes.map((_, i) => i);
      this.removedFrames = [];
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
    for (const clip of ws.kept) {
      const res = await api.autoSlice({
        assetId: clip.wsId,
        sourceFile: clip.rawFile,
        targetFrameSize: target,
        outName: clip.sheetFile,
        columns: STRIP_ROW,
        groups: clip.groups && clip.groups.length > 0 ? clip.groups : undefined,
        expectedFrames: clip.groups ? undefined : clip.count,
      });
      clip.frameWidth = res.frameWidth;
      clip.frameHeight = res.frameHeight;
      if (res.frameCount !== clip.count) {
        clip.count = res.frameCount;
        clip.order = Array.from({ length: res.frameCount }, (_, i) => i);
      }
    }
    this.persistClips(ws);
  }

  /** Resolution change: resample every clip and refresh the preview. */
  private async applyResolution() {
    const ws = this.activeWs();
    if (!ws?.wsId || ws.kept.length === 0) return;
    await this.busy('RESAMPLING CLIPS FROM ORIGINALS...', async () => {
      await this.resampleClips(Number(this.frameSizeSel.value));
      this.refreshClipList();
      const current = this.strip ?? ws.kept[0];
      if (current) this.previewClip(current);
      UISound.play('confirm');
      HudShell.toast(`ALL CLIPS RESAMPLED · NO CREDITS SPENT`, 'success');
    });
  }

  /** Persist the character prompt + concept + sliders so any resume restores them. */
  private persistConcept(targetId: string) {
    const data = {
      describe: this.describeIn.value,
      name: this.nameIn.value,
      lore: this.descIn.value,
      imagePrompt: this.imagePromptIn.value,
      style: Number(this.styleIn.value),
      creativity: Number(this.creativityIn.value),
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
        pose?: string;
        concept?: CharacterConcept | null;
      };
      if (data.describe) this.describeIn.value = data.describe;
      if (data.name) this.nameIn.value = data.name;
      if (data.lore) this.descIn.value = data.lore;
      if (data.imagePrompt) this.imagePromptIn.value = data.imagePrompt;
      if (data.style !== undefined) this.styleIn.value = String(data.style);
      if (data.creativity !== undefined) this.creativityIn.value = String(data.creativity);
      if (data.concept) this.concept = data.concept;
    } catch {
      /* no concept.json yet */
    }
  }

  /** Recall the motion notes last used to forge this animation name. */
  private restoreNotesFor(cat: string) {
    const ws = this.activeWs();
    const clip = ws?.kept.find((k) => k.cat === cat);
    if (clip?.notes !== undefined) this.notesIn.value = clip.notes;
  }

  private async forgeAnimation() {
    const ws = this.activeWs();
    if (!ws?.wsId) return HudShell.toast('SELECT A VARIANT FIRST', 'error');
    const cat = this.currentAnimName();
    const preset = this.framePreset;
    const count = preset.n;
    const planned = this.concept?.suggestedAnimations?.find((c) => c.slot === cat);
    await this.busy(`FORGING ${cat.toUpperCase()} FOR V${this.active + 1}...`, async () => {
      UISound.play('generate');
      const rawFile = `anim_${cat}_raw.png`;
      const sheetFile = `anim_${cat}_sheet.png`;
      await api.aiImage({
        prompt: this.notesIn.value,
        orientation: 'landscape',
        kind: 'animation',
        assetId: ws.wsId!,
        referenceFile: `${ws.wsId}/variant.png`,
        category: cat,
        frames: count,
        gridCols: preset.cols,
        gridRows: preset.rows,
        outName: rawFile,
        styleHint: this.styleHint(),
        cellBorders: this.bordersChk.checked,
      });
      const sliced = await api.autoSlice({
        assetId: ws.wsId!,
        sourceFile: rawFile,
        targetFrameSize: Number(this.frameSizeSel.value),
        outName: sheetFile,
        columns: STRIP_ROW,
        expectedFrames: count,
      });
      const groups = sliced.boxes.map((b) => [b]);
      this.strip = {
        wsId: ws.wsId!,
        cat,
        rate: planned?.frameRate ?? CLIP_RATES[cat] ?? 8,
        count: sliced.frameCount,
        sheetFile,
        rawFile,
        frameWidth: sliced.frameWidth,
        frameHeight: sliced.frameHeight,
        order: Array.from({ length: sliced.frameCount }, (_, i) => i),
        groups,
        notes: this.notesIn.value,
      };
      this.stripGroups = groups;
      this.activeGroup = 0;
      this.sheetBoxes = sliced.boxes;
      this.groupSheetIdx = sliced.boxes.map((_, i) => i);
      this.removedFrames = [];
      this.shapesDirty = false;
      this.selectionsDirty = false;
      this.editMode = false;
      this.undoStack = [];
      this.updateModeButtons();
      this.upsertStrip(ws);
      await this.showStripReview();
      this.previewClip(this.strip);
      UISound.play('complete');
      HudShell.toast(
        `${cat.toUpperCase()} AUTO-SAVED · ${sliced.frameCount} FRAMES${sliced.frameCount !== count ? ` (ASKED FOR ${count})` : ''}`,
        'success',
      );
    });
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
    if (this.resliceBtn) this.resliceBtn.style.display = hasStrip && this.editMode ? '' : 'none';
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
    // The frame's sheet index stays valid until the next MANUAL SLICING:
    // drop it from playback now and leave a restorable ghost in its place.
    const sheetIdx = this.groupSheetIdx[index] ?? -1;
    if (sheetIdx >= 0 && this.strip) {
      this.strip.order = this.strip.order.filter((f) => f !== sheetIdx);
      this.removedFrames.push(sheetIdx);
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

  /** Bring a removed frame back from its ghost (no slicing needed). */
  private restoreFrame(sheetIdx: number) {
    if (!this.strip || !this.stripGroups) return;
    const box = this.sheetBoxes[sheetIdx];
    if (!box) return;
    // Insert at its chronological position among mapped groups.
    let insertAt = this.groupSheetIdx.findIndex((m) => m >= 0 && m > sheetIdx);
    if (insertAt < 0) insertAt = this.stripGroups.length;
    this.stripGroups.splice(insertAt, 0, [{ ...box }]);
    this.groupSheetIdx.splice(insertAt, 0, sheetIdx);
    this.removedFrames = this.removedFrames.filter((k) => k !== sheetIdx);
    const orderAt = this.strip.order.findIndex((f) => f > sheetIdx);
    if (orderAt < 0) this.strip.order.push(sheetIdx);
    else this.strip.order.splice(orderAt, 0, sheetIdx);
    // Only pure removals pending? Then selections match the sheet again.
    this.selectionsDirty = this.shapesDirty || this.removedFrames.length > 0;
    const ws = this.activeWs();
    if (ws) this.persistClips(ws);
    UISound.play('confirm');
    this.drawStripBoxes();
    this.renderStripLabels();
    this.previewClip(this.strip);
    HudShell.toast(`${this.strip.cat.toUpperCase()} · ${sheetIdx} RESTORED`, 'success');
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
    layer.className = 'g-label-layer';
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

    this.stripGroups.forEach((group, i) => {
      const activeFrame = i === this.activeGroup;
      const u = this.unionOf(group);
      const pos = this.strip!.order.indexOf(i);

      const bar = document.createElement('div');
      bar.className = `g-frame-bar${activeFrame ? '' : ' g-dim'}`;
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

      rect.addEventListener('pointerdown', () => {
        if (this.activeGroup !== i) {
          this.activeGroup = i;
          UISound.play('click');
          this.drawStripBoxes();
          this.renderStripLabels();
        }
      });
      // Right-click: undo the last added shape of this frame.
      rect.addEventListener('contextmenu', (ev) => {
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
      });

      // Reorder halves only in order mode with selections matching the sliced sheet.
      if (!this.editMode && !this.selectionsDirty) {
        const symbolSize = `${Math.max(22, Math.round(u.h * s * 0.3))}px`;
        const minus = document.createElement('div');
        minus.className = 'g-half minus';
        minus.textContent = '−';
        minus.style.fontSize = symbolSize;
        minus.addEventListener('click', () => this.bumpOrder(i, -1));
        const plus = document.createElement('div');
        plus.className = 'g-half plus';
        plus.textContent = '+';
        plus.style.fontSize = symbolSize;
        plus.addEventListener('click', () => this.bumpOrder(i, 1));
        rect.append(minus, plus);
      }

      // Edge handles only in edit mode, for simple single-rect frames.
      if (this.editMode && group.length === 1) {
        for (const edge of ['n', 's', 'e', 'w'] as const) {
          const handle = document.createElement('div');
          handle.className = `g-handle g-handle-${edge}`;
          handle.addEventListener('pointerdown', (ev) =>
            this.startEdgeDrag(ev, group[0]!, edge, rect, bar),
          );
          rect.appendChild(handle);
        }
      }
      layer.appendChild(rect);
    });

    // Ghosts of removed frames: click inside the original detection area to
    // restore that frame. Shown in both modes — removal happens in edit mode,
    // so the ghost must be reachable there too.
    for (const k of this.removedFrames) {
      const box = this.sheetBoxes[k];
      if (!box) continue;
      const ghost = document.createElement('div');
      ghost.className = 'g-ghost-rect';
      ghost.style.left = `${Math.round(x0 + box.x * s)}px`;
      ghost.style.top = `${Math.round(y0 + box.y * s)}px`;
      ghost.style.width = `${Math.round(box.w * s)}px`;
      ghost.style.height = `${Math.round(box.h * s)}px`;
      const label = `AUTO-SLICE ${this.strip.cat.toUpperCase()} · ${k}`;
      ghost.title = label;
      const tag = document.createElement('div');
      tag.className = 'g-ghost-label';
      tag.textContent = label;
      ghost.appendChild(tag);
      ghost.addEventListener('mouseenter', () => UISound.play('hover'));
      ghost.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.restoreFrame(k);
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
  ) {
    ev.preventDefault();
    ev.stopPropagation();
    const geo = this.stripGeom;
    if (!geo) return;
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
      rect.style.left = `${Math.round(geo.x0 + b.x * geo.s)}px`;
      rect.style.top = `${Math.round(geo.y0 + b.y * geo.s)}px`;
      rect.style.width = `${Math.round(b.w * geo.s)}px`;
      rect.style.height = `${Math.round(b.h * geo.s)}px`;
      bar.style.left = `${Math.round(geo.x0 + b.x * geo.s)}px`;
      bar.style.top = `${Math.round(geo.y0 + b.y * geo.s - 22)}px`;
      this.drawStripBoxes();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      const ws = this.activeWs();
      if (ws) this.persistClips(ws);
      UISound.play('click');
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
    const panel = HudShell.makePanel('03 · CLIPS & PREVIEW', 'right');
    const canvas = document.createElement('canvas');
    canvas.className = 'g-preview-canvas';
    canvas.width = 256;
    canvas.height = 256;
    this.previewCanvas = canvas;

    const list = document.createElement('div');
    list.className = 'g-asset-list';
    this.clipListEl = list;

    const saveBtn = document.createElement('genvy-button') as GenvyButton;
    saveBtn.setAttribute('variant', 'accent');
    saveBtn.setAttribute('label', 'SAVE CHARACTER');
    saveBtn.style.display = 'none';
    this.saveBtn = saveBtn;
    saveBtn.onClick(() => void this.saveCharacter());

    panel.append(canvas, list, saveBtn);
    return panel;
  }

  private refreshClipList() {
    if (!this.clipListEl) return;
    const ws = this.activeWs();
    this.clipListEl.innerHTML = '';
    const kept = ws?.kept ?? [];
    if (kept.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'g-hint';
      hint.textContent = this.active >= 0 ? `NO CLIPS KEPT FOR V${this.active + 1} YET.` : 'NO CLIPS KEPT YET.';
      this.clipListEl.appendChild(hint);
      if (this.saveBtn) this.saveBtn.style.display = 'none';
      return;
    }

    const selected = kept.find((k) => k.cat === this.selectedClipCat) ?? kept[0]!;
    this.selectedClipCat = selected.cat;

    for (const clip of kept) {
      const row = document.createElement('div');
      row.className = `g-clip-row${clip === selected ? ' selected' : ''}`;
      row.textContent = `${clip.cat.toUpperCase()} · ${clip.count}F`;
      row.addEventListener('mouseenter', () => UISound.play('hover'));
      row.addEventListener('click', () => {
        UISound.play('click');
        this.selectedClipCat = clip.cat;
        this.previewClip(clip);
        this.refreshClipList();
      });
      this.clipListEl.appendChild(row);
    }

    // One action row for the selected clip. No play button — selecting a clip
    // row above starts it immediately.
    const actions = document.createElement('div');
    actions.className = 'g-row g-card-actions';
    const edit = document.createElement('genvy-button') as GenvyButton;
    edit.setAttribute('label', '✎');
    edit.onClick(() => void this.editClip(selected));
    const drop = document.createElement('genvy-button') as GenvyButton;
    drop.setAttribute('variant', 'danger');
    drop.setAttribute('label', '✕');
    drop.onClick(() => {
      if (!ws) return;
      ws.kept = ws.kept.filter((k) => k !== selected);
      this.selectedClipCat = null;
      this.persistClips(ws);
      this.refreshClipList();
    });
    actions.append(edit, drop);
    this.clipListEl.appendChild(actions);

    if (this.saveBtn) this.saveBtn.style.display = '';
  }

  /** Reopen a kept clip in the strip review for selection/order editing. */
  private async editClip(clip: Clip) {
    await this.busy(`OPENING ${clip.cat.toUpperCase()} FOR EDITING...`, async () => {
      this.strip = clip;
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
      this.removedFrames = [];
      this.shapesDirty = false;
      this.selectionsDirty = false;
      this.editMode = true;
      this.undoStack = [];
      this.updateModeButtons();
      this.animNameIn.value = clip.cat;
      if (clip.notes !== undefined) this.notesIn.value = clip.notes;
      await this.showStripReview();
      this.previewClip(clip);
      HudShell.toast(`EDITING ${clip.cat.toUpperCase()} — MANUAL SLICING APPLIES CHANGES`);
    });
  }

  /** Stop and blank the 1:1 preview (e.g. when switching variants). */
  private clearPreviewCanvas() {
    window.clearInterval(this.previewTimer);
    const canvas = this.previewCanvas;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Play a clip in the square canvas from its packed single-row strip. */
  private previewClip(clip: Clip) {
    const canvas = this.previewCanvas;
    if (!canvas || clip.order.length === 0) return;
    const img = new Image();
    img.src = `${fileUrl(`${clip.wsId}/${clip.sheetFile}`)}?t=${Date.now()}`;
    img.onload = () => {
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

      const sheetPayload = {
        name: `${name} — sheet`,
        description: this.descIn.value,
        tags: this.concept?.tags ?? [],
        image: composed.sheet,
        sourceImage: { path: `${wsId}/variant.png` },
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
      if (ws.kept[0]) this.previewClip(ws.kept[0]);
      await HudShell.lootDrop();
      HudShell.toast(
        `${variantTag} CHARACTER ${existingChar ? 'UPDATED' : 'SAVED'} AT ${qualityLabel}`,
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
      // Editing an existing asset: no concept/generation panel.
      if (this.conceptPanel) this.conceptPanel.style.display = 'none';

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
          this.ensureVariantsPanel();
          await this.refreshVariantSquares();
        }
      } catch {
        /* session link unavailable — single-variant view */
      }

      await this.restoreClips(ws);
      this.ensureAnimPanels();
      this.setStage('editing');
      // Opened assets start at ORIGINAL size; the dropdown re-samples from there.
      this.frameSizeSel.value = '0';
      this.refreshClipList();

      const key = this.textureKey('master');
      await this.loadTexture(key, `${fileUrl(sheet.image)}?t=${Date.now()}`);
      this.clearStage();
      const { width, height } = this.scale;
      const img = this.add.image(width / 2 - 140, height / 2 + 10, key);
      const s = Math.min((height - 180) / img.height, (width - 960) / img.width, 4);
      img.setScale(s);
      this.previewImage = img;

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
    const img = new Image();
    img.src = `${fileUrl(sheet.image)}?t=${Date.now()}`;
    img.onload = () => {
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
        await this.restoreClips(ws);
        this.ensureAnimPanels();
        this.setStage('editing');
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
      this.ensureVariantsPanel();
      await this.refreshVariantSquares();
      this.setStage('variants');
      await this.showVariantPicker();
      HudShell.toast('SESSION RECOVERED — PICK A VARIANT', 'success');
    } catch {
      HudShell.toast('RECOVERED FILES UNREADABLE', 'error');
    }
  }

  // ---------------- Shared helpers ----------------

  private async busy(label: string, fn: () => Promise<unknown>) {
    HudShell.showBusy(label);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'OPERATION FAILED';
      HudShell.toast(msg.toUpperCase().slice(0, 180), 'error');
    } finally {
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
  private clearStage() {
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.setScroll(0, 0);
    this.detachReviewKeys();
    this.previewImage?.destroy();
    this.previewImage = null;
    this.overlayGfx?.destroy();
    this.overlayGfx = null;
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
