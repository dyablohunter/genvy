import Phaser from 'phaser';
import type { Tileset, World, TilesetConcept, WorldLayout } from '@genvy/shared';
import { HudShell } from '../../hud/HudShell.js';
import { UISound } from '../../hud/UISound.js';
import { goToScene, enterScene } from '../../hud/transitions.js';
import { api, fileUrl, ApiError } from '../../api/client.js';
import {
  field,
  textInput,
  textArea,
  numberInput,
  forgeStatus,
  progressBar,
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

export class WorldToolScene extends Phaser.Scene {
  private tileset: Tileset | null = null;
  private tilesetKey = '';
  private concept: TilesetConcept | null = null;
  private worldId: string | null = null;

  private map: Phaser.Tilemaps.Tilemap | null = null;
  private layers: Phaser.Tilemaps.TilemapLayer[] = [];
  private activeLayer = 0;
  private selectedTile = 0;
  private tool: PaintTool = 'brush';
  private painting = false;

  private worldNameIn = textInput('New World', '');
  private widthIn = numberInput(40, 8, 200);
  private heightIn = numberInput(23, 8, 200);
  private paletteHost: HTMLElement | null = null;
  private toolButtons = new Map<PaintTool, GenvyButton>();

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
    HudShell.onOpenAsset = (entry) => {
      if (entry.type === 'tileset' || entry.type === 'world') {
        void goToScene(this, 'worldTool', { assetId: entry.id, assetType: entry.type });
      } else if (entry.type === 'spritesheet' || entry.type === 'character') {
        void goToScene(this, 'spriteTool', { assetId: entry.id, assetType: entry.type });
      }
    };

    void HudShell.setLayout([this.buildTilesetPanel(), this.buildWorldPanel()]);
    this.setupCameraControls();
    this.setupPainting();

    if (data?.assetId) void this.loadExisting(data.assetId, data.assetType ?? '');
  }

  private resetState() {
    this.tileset = null;
    this.tilesetKey = '';
    this.concept = null;
    this.worldId = null;
    this.map = null;
    this.layers = [];
    this.activeLayer = 0;
    this.selectedTile = 0;
    this.tool = 'brush';
    this.painting = false;
    this.worldNameIn = textInput('New World', '');
    this.widthIn = numberInput(40, 8, 200);
    this.heightIn = numberInput(23, 8, 200);
    this.paletteHost = null;
    this.toolButtons = new Map();
  }

  // ---------------- Panels ----------------

  private buildTilesetPanel() {
    const panel = HudShell.makePanel('01 · TILESET', 'left');
    const prompt = textArea('', 'e.g. overgrown alien jungle ruins');
    const genBtn = document.createElement('genvy-button') as GenvyButton;
    genBtn.setAttribute('label', 'GENERATE CONCEPT');
    const forgeBtn = document.createElement('genvy-button') as GenvyButton;
    forgeBtn.setAttribute('variant', 'accent');
    forgeBtn.setAttribute('label', 'FORGE TILESET');
    const statusHost = document.createElement('div');
    this.paletteHost = document.createElement('div');
    const hint = document.createElement('div');
    hint.className = 'g-hint';
    hint.textContent = 'CLICK A TILE TO PAINT WITH IT. RIGHT-CLICK TOGGLES COLLISION (RED DOT).';

    panel.append(field('DESCRIBE THE WORLD THEME', prompt), genBtn, forgeBtn, statusHost, hint, this.paletteHost);

    genBtn.onClick(async () => {
      if (!prompt.value.trim()) return HudShell.toast('DESCRIBE THE THEME FIRST', 'error');
      await this.busy(statusHost, 'DESIGNING TILE SET...', async () => {
        UISound.play('generate');
        const res = await api.aiText<TilesetConcept>({
          tool: 'tileset',
          prompt: prompt.value,
          schemaName: 'tilesetConcept',
        });
        this.concept = res.result;
        UISound.play('confirm');
        HudShell.toast(`CONCEPT: ${this.concept.name.toUpperCase()} — NOW FORGE IT`, 'success');
      });
    });

    forgeBtn.onClick(async () => {
      if (!this.concept) return HudShell.toast('GENERATE A CONCEPT FIRST', 'error');
      await this.busy(statusHost, 'FORGING TILES · THIS TAKES A MINUTE...', async () => {
        UISound.play('generate');
        const subjects = this.concept!.tileNames.length
          ? this.concept!.tileNames.join(', ')
          : this.concept!.imagePrompt;
        const img = await api.aiImage({
          prompt: `${this.concept!.imagePrompt}. Tiles in order: ${subjects}`,
          orientation: 'portrait',
          kind: 'tileset',
        });
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
        const saved = await api.createAsset<Tileset>('tileset', {
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
        });
        await this.useTileset(saved);
        await HudShell.lootDrop();
        UISound.play('complete');
        HudShell.toast('TILESET FORGED & SAVED', 'success');
      });
    });

    return panel;
  }

  private buildWorldPanel() {
    const panel = HudShell.makePanel('02 · WORLD', 'right');

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
    dims.append(field('W', this.widthIn), field('H', this.heightIn));

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
        const res = await api.aiText<WorldLayout>({
          tool: 'world',
          prompt: `${aiPrompt.value}\nLevel size: ${this.widthIn.value} x ${this.heightIn.value} tiles.`,
          schemaName: 'worldLayout',
          context: {
            tiles: this.tileset!.tiles.map((t) => ({ index: t.index, name: t.name, collides: t.collides })),
          },
        });
        this.applyLayout(res.result);
        UISound.play('complete');
        HudShell.toast('LAYOUT DRAFTED — REFINE BY HAND', 'success');
      });
    });

    saveBtn.onClick(async () => {
      if (!this.map || !this.tileset) return HudShell.toast('NOTHING TO SAVE YET', 'error');
      await this.busy(statusHost, 'WRITING TO COLLECTION...', async () => {
        await this.saveWorld();
        await HudShell.lootDrop();
        HudShell.toast('WORLD SAVED', 'success');
      });
    });

    return panel;
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

    const cam = this.cameras.main;
    cam.centerOn((width * ts.tileWidth) / 2, (height * ts.tileHeight) / 2);
    const fit = Math.min(
      (this.scale.width - 660) / (width * ts.tileWidth),
      (this.scale.height - 120) / (height * ts.tileHeight),
    );
    cam.setZoom(Phaser.Math.Clamp(fit, 0.2, 1.5));
  }

  private applyLayout(layout: WorldLayout) {
    if (!this.tileset) return;
    this.worldNameIn.value = layout.name || this.worldNameIn.value;
    this.widthIn.value = String(layout.width);
    this.heightIn.value = String(layout.height);
    const ground = layout.layers.find((l) => l.name.toLowerCase().includes('ground')) ?? layout.layers[0];
    const decor = layout.layers.find((l) => l !== ground);
    this.buildMap(layout.width, layout.height, [ground?.data ?? [], decor?.data ?? []]);
  }

  private setupCameraControls() {
    this.input.mouse?.disableContextMenu();
    let dragStart: { x: number; y: number; sx: number; sy: number } | null = null;

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.middleButtonDown() || (p.rightButtonDown() && !this.overPalette(p))) {
        dragStart = { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY, sx: p.x, sy: p.y };
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (dragStart && (p.middleButtonDown() || p.rightButtonDown())) {
        const cam = this.cameras.main;
        cam.scrollX = dragStart.x - (p.x - dragStart.sx) / cam.zoom;
        cam.scrollY = dragStart.y - (p.y - dragStart.sy) / cam.zoom;
      }
    });
    this.input.on('pointerup', () => (dragStart = null));
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
      if (p.leftButtonDown()) {
        this.painting = true;
        this.paintAt(p);
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.painting && p.leftButtonDown()) this.paintAt(p);
    });
    this.input.on('pointerup', () => (this.painting = false));
  }

  private paintAt(pointer: Phaser.Input.Pointer) {
    const layer = this.layers[this.activeLayer];
    if (!layer || !this.map) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tx = layer.worldToTileX(world.x);
    const ty = layer.worldToTileY(world.y);
    if (tx == null || ty == null || tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return;

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

  private async saveWorld() {
    if (!this.map || !this.tileset) return;
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
      spawnPoints: [{ name: 'player', x: 2, y: 2 }],
      thumbnail: this.tileset.thumbnail,
    };
    if (this.worldId) {
      await api.updateAsset(this.worldId, payload);
    } else {
      const saved = await api.createAsset<World>('world', payload);
      this.worldId = saved.id;
    }
  }

  private async loadExisting(assetId: string, assetType: string) {
    try {
      if (assetType === 'tileset') {
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

  private async busy(_host: HTMLElement, label: string, fn: () => Promise<unknown>) {
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
}
