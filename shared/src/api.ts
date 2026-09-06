import type { AssetType, AssetId } from './ids.js';
import type { FileRef } from './schemas/base.js';
import type { AiConceptSchemaName } from './schemas/aiConcepts.js';

/** Lightweight entry in library/index.json and GET /api/assets responses. */
export interface AssetIndexEntry {
  id: AssetId;
  type: AssetType;
  name: string;
  tags: string[];
  updatedAt: string;
  thumbnail?: string;
}

export interface ListAssetsQuery {
  type?: AssetType;
  tag?: string;
  q?: string;
}

export interface CreateAssetRequest {
  type: AssetType;
  data: Record<string, unknown>;
}

export interface DeleteConflictResponse {
  error: 'referenced';
  referrers: AssetIndexEntry[];
}

export interface RefsResponse {
  inbound: AssetIndexEntry[];
  outbound: AssetIndexEntry[];
}

// ---- AI ----

export interface AiTextRequest {
  tool: string;
  prompt: string;
  schemaName?: AiConceptSchemaName;
  context?: Record<string, unknown>;
  /** Creativity 0..1.5 (DeepSeek temperature). */
  temperature?: number;
}

export interface AiTextResponse {
  /** Parsed + validated JSON when schemaName was given, otherwise { text }. */
  result: unknown;
}

export type ImageOrientation = 'portrait' | 'landscape';

/** Sprite Pipeline v2 anchor directions. East is computed (flip of west), never generated. */
export type AnchorDirection = 'south' | 'west' | 'east' | 'north';

export interface AiImageRequest {
  prompt: string;
  orientation: ImageOrientation;
  /** When set, the output is saved under this asset's file dir. */
  assetId?: string;
  /**
   * 'anchor': 2x2 neutral south-anchor candidates; 'anchorDirectional': west/north
   * anchor edited from the south anchor; 'neutralReset': strip props/fx from a
   * flawed anchor (preserve/change edit).
   */
  kind?:
    | 'variants'
    | 'animation'
    | 'tileset'
    /** One painted level backdrop (isometric/side/top-down), not a tile grid. */
    | 'scene'
    | 'raw'
    | 'anchor'
    | 'anchorDirectional'
    | 'neutralReset';
  /** kind 'scene': how the level is framed. */
  view?: 'isometric' | 'side' | 'topdown' | 'threequarter';
  /** kind 'scene': the backdrop loops horizontally. */
  seamless?: boolean;
  /** kind 'animation': library file used as the character reference. */
  referenceFile?: string;
  category?: string;
  frames?: number;
  /** Explicit grid layout for the frames (e.g. 4 columns × 2 rows). */
  gridCols?: number;
  gridRows?: number;
  outName?: string;
  /** User-chosen art direction (e.g. from the realism/stylized slider). */
  styleHint?: string;
  /** Pose all variants share (from the pose preset select). */
  pose?: string;
  /** Image provider id ('openai' | 'retrodiffusion'); default 'openai'. */
  provider?: string;
  /** Model family for multi-model providers (local ComfyUI families); others ignore it. */
  modelFamily?: string;
  /** kind 'animation': appearance text — the identity channel for models with no reference adapter. */
  identityPrompt?: string;
  /** kind 'anchor'/'variants' on grid-incapable providers: how many candidates to render (1-4, default 4). */
  variantCount?: number;
  /** Square render-canvas side for providers with a choosable one (local): speed<->detail dial, NOT the sprite's output size. */
  renderSize?: number;
  /** Quality tier for providers that price by it (gpt-image-2: low/medium/high — cost scales hard). */
  quality?: 'low' | 'medium' | 'high';
  /** StyleContract preset id — its prompt/negative blocks are appended server-side. */
  styleId?: string;
  /** What is being drawn (see spriteSubjects.ts); defaults to 'character'. */
  subject?: string;
  /** kind 'anchor'/'anchorDirectional': character name interpolated into the prompt. */
  characterName?: string;
  /**
   * kind 'anchorDirectional': which anchor to derive (west|north).
   * kind 'animation': the clip's facing — locks orientation in every frame.
   */
  direction?: 'west' | 'north' | 'south' | 'east';
  /**
   * kind 'anchorDirectional': the reference IS the target view — redraw it in
   * place applying the prompt as corrections, instead of turning the primary
   * anchor into that view.
   */
  refine?: boolean;
  /** kind 'neutralReset': the effect/prop to strip (e.g. "the flaming sword"). */
  effect?: string;
  /**
   * kind 'animation': generation attempts (1-3). Each failing attempt injects
   * the gate's correction hints into the retry prompt; the best-scoring sheet
   * is kept ("one repair attempt, then publish best").
   */
  attempts?: number;
}

/**
 * Targeted repair (Sprite Pipeline v2 §C4): regenerate ONLY the frames the
 * gate flagged and patch them into the clip's raw sheet, instead of paying to
 * re-roll poses that were already good.
 */
export interface RepairFramesRequest {
  assetId: string;
  /** Model family for multi-model providers (routes to the family's 'repair' workflow). */
  modelFamily?: string;
  /** The clip's raw sheet — patched in place. */
  rawFile: string;
  /** Identity reference, usually the directional anchor ("<id>/anchor-west.png"). */
  referenceFile: string;
  /** Where every frame lives in the raw sheet, in playback order. */
  boxes: SpriteBox[];
  /** Indexes into `boxes` to redraw. */
  frameIndexes: number[];
  category: string;
  /** Motion notes, direction lock and style, as for a full sheet. */
  prompt?: string;
  direction?: 'south' | 'west' | 'east' | 'north';
  /** What is being drawn (spriteSubjects.ts); defaults to 'character'. */
  subject?: string;
  styleId?: string;
  styleHint?: string;
  provider?: string;
}

export interface RepairFramesResponse {
  repaired: number[];
  /** Frames whose regeneration failed, with the reason. */
  failed: { index: number; reason: string }[];
  fileRef: FileRef;
}

/** Compact result of the animation validation gate (Sprite Pipeline v2 §C4). */
export interface AnimationGateSummary {
  score: number;
  pass: boolean;
  frameCount: number;
  expectedFrames: number;
  /** Frame indexes (reading order) with at least one hard failure. */
  failedFrames: number[];
  hints: string[];
  /** Most frames failed identity — the anchor itself is the likely culprit. */
  anchorCascade: boolean;
}

export interface AiImageResult {
  fileRef: FileRef;
  assetId: string;
  /** kind 'animation' only. */
  gate?: AnimationGateSummary;
  attemptsUsed?: number;
}

export interface AiImageResponse {
  fileRef: FileRef;
}

/** Estimated AI spend per provider (GET /api/usage) — pricing-based, not billing. */
export interface UsageResponse {
  providers: {
    id: string;
    cents: number;
    calls: number;
    /** Account balance the provider itself reported, in cents. */
    balanceCents?: number;
    /** Spend came from the provider's own figures, not our estimate. */
    exact?: boolean;
  }[];
  totalCents: number;
}

/** Live stage/step of the in-flight AI op (GET /api/ai/activity) — server truth for the busy bar. */
export interface AiActivityResponse {
  active: boolean;
  label?: string;
  step?: number;
  steps?: number;
  subStep?: number;
  subSteps?: number;
  /** Composed progress [0,1] across op+sub layers — what the bar should show, and where the current sub-step's completion lands. */
  fraction?: number;
  nextFraction?: number;
  /** The running work can be aborted via POST /api/ai/cancel. */
  cancelable?: boolean;
  startedAt?: number;
}

/** Live/offline status of one image provider (from GET /api/health). */
export interface ImageProviderStatus {
  id: string;
  name: string;
  live: boolean;
  /** Costs nothing per call (the local-inference provider) — pickers label it FREE. */
  free?: boolean;
  /** Selectable models for multi-model providers; pickers disable unverified/unavailable ones. */
  models?: {
    id: string;
    label: string;
    verified: boolean;
    /** Verified but very slow without a large GPU — pickers warn instead of hiding it. */
    heavy?: boolean;
    available: boolean;
    workflows: string[];
  }[];
  capabilities: {
    generate: boolean;
    edit: boolean;
    multiReference: boolean;
    nativeAlpha: boolean;
    animation: boolean;
    /** Can draw a 2x2 candidate grid in one call; otherwise the server composes 4 singles. */
    gridSheets?: boolean;
    maxSize: number;
    /** Quality tiers the provider prices/renders by; pickers show a select when present. */
    qualityLevels?: ('low' | 'medium' | 'high')[];
  };
}

// ---- Image ops ----

export interface RemoveBgRequest {
  assetId: string;
  sourceFile: string;
  tolerance?: number; // 0-64
  mode?: 'floodfill' | 'chroma' | 'both';
}

export interface SliceSheetRequest {
  assetId: string;
  sourceFile: string;
  cols: number;
  rows: number;
  offsetX?: number;
  offsetY?: number;
  cellWidth?: number;
  cellHeight?: number;
  trim?: boolean;
  /** Final per-frame size after nearest-neighbor downscale (square target). */
  targetFrameSize?: number;
  /** StyleContract preset id — its postSteps run on the sliced frames. */
  styleId?: string;
}

export interface SliceSheetResponse {
  sheet: FileRef;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  thumbnail: string;
}

export interface AutoSliceRequest {
  assetId: string;
  sourceFile: string;
  /** Final per-frame size after nearest-neighbor downscale (longest side); 0 = original. */
  targetFrameSize?: number;
  /** Background removal tolerance used only when the source has no alpha. */
  tolerance?: number;
  /** Output file name (default sheet.png; strips use anim_<cat>_sheet.png). */
  outName?: string;
  /** Packed sheet column count (strips pass the frame count for a single row). */
  columns?: number;
  /** How many frames were requested — forces splits when detection finds fewer. */
  expectedFrames?: number;
  /** User-corrected boxes: when given, detection is skipped and these are cut as-is. */
  boxes?: SpriteBox[];
  /**
   * One frame per group of rects: only pixels inside a group's rects are
   * copied (union mask), excluding overlapping neighbors. Takes precedence
   * over boxes and detection.
   */
  groups?: SpriteBox[][];
  /**
   * Cross-clip height matching (Sprite Pipeline v2 §C5): scale so the visible
   * body measures this many pixels tall, so every clip of a character renders
   * at the same size. Overrides targetFrameSize when set.
   */
  bodyHeightPx?: number;
  /**
   * StyleContract preset id — its postSteps (quantize/pixelSnap/outlineClean)
   * run on the sliced frames, with one palette shared across the clip.
   */
  styleId?: string;
}

export interface DetectRequest {
  assetId: string;
  sourceFile: string;
  tolerance?: number;
}

export interface CropRequest {
  /** Destination asset dir for the crop. */
  assetId: string;
  /** Where the source image lives (defaults to assetId). */
  sourceAssetId?: string;
  sourceFile: string;
  box: SpriteBox;
  outName: string;
  /** Which of the 4 variants this crop is (recorded for recovery grouping). */
  variantIndex?: number;
  /**
   * Expand the box by this fraction of its longest side (clamped to the
   * source), so gate checks can verify real padding around the content.
   */
  pad?: number;
}

// ---- Sprite Pipeline v2: anchors ----

export interface FlipRequest {
  assetId: string;
  sourceFile: string;
  outName: string;
  /** false = copy the image as-is (used to re-file an anchor under a new view). */
  mirror?: boolean;
  /** Clockwise quarter-turn to apply after the mirror step (0/90/180/270). */
  rotate?: number;
  /** Frame boxes to map through the same transform (for deriving a clip). */
  boxes?: SpriteBox[];
  /**
   * Normalized point to rotate around (0..1 of width/height). A weapon turns
   * about its grip; without this it turns about the middle of its bounding
   * box and the derived views drift apart.
   */
  pivot?: { x: number; y: number };
}

export interface FlipResponse {
  fileRef: FileRef;
  /** Present when `boxes` was sent: the same frames in the new image. */
  boxes?: SpriteBox[];
  /** Where the pivot ended up in the new image (normalized). */
  pivot?: { x: number; y: number };
}

export interface AnchorGateRequest {
  assetId: string;
  sourceFile: string;
}

export interface AnchorGateCheckResult {
  id: 'corners' | 'content' | 'uncropped' | 'singleBlob' | 'centered';
  pass: boolean;
  detail: string;
}

export interface AnchorGateResponse {
  pass: boolean;
  checks: AnchorGateCheckResult[];
}

export interface OrphanInfo {
  id: string;
  files: string[];
  updatedAt: string;
  source?: { sessionId: string; variantIndex: number | null };
}

/** A file directory plus its session linkage and the assets saved from it. */
export interface WorkspaceInfo extends OrphanInfo {
  sheet?: AssetIndexEntry;
  character?: AssetIndexEntry;
  /** Sprite subject id (spriteSubjects.ts), read from the dir's concept.json. */
  subject?: string;
}

export interface ComposeSheetRequest {
  assetId: string;
  /** StyleContract preset id — its postSteps run on every composed frame. */
  styleId?: string;
  parts: {
    file: string;
    frameWidth: number;
    frameHeight: number;
    count: number;
    /** Local frame indices to include, in playback order (default: all). */
    frames?: number[];
  }[];
}

export interface ComposeSheetResponse {
  sheet: FileRef;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  ranges: { file: string; start: number; count: number }[];
  thumbnail: string;
}

/**
 * Engine export (Sprite Pipeline v2 §C6): the packed sheet plus everything an
 * engine needs — absolute frame rects, per-view pivots (origin), animation
 * definitions. Deterministic and free: no provider call.
 */
export interface ExportSpriteRequest {
  /** Workspace/sheet asset id the files live under. */
  assetId: string;
  /** Sheet to export (a clip strip, or the composed master sheet). */
  sheetFile: string;
  name: string;
  description?: string;
  scope?: 'clip' | 'full';
  frameWidth: number;
  frameHeight: number;
  /** Grid columns; derived from the image width when omitted. */
  columns?: number;
  subject?: string;
  styleId?: string;
  /** Normalized origin per view, as placed in the editor. */
  pivots?: Partial<Record<'south' | 'west' | 'east' | 'north', { x: number; y: number }>>;
  /** Neutral anchor files to copy alongside the sheet, by view. */
  anchors?: Partial<Record<'south' | 'west' | 'east' | 'north', string>>;
  animations?: {
    name: string;
    direction?: 'south' | 'west' | 'east' | 'north';
    frameRate: number;
    repeat?: number;
    /** Sheet frame indexes in playback order. */
    frames: number[];
  }[];
}

export interface ExportSpriteResponse {
  /** Export folder name under library/exports/. */
  dir: string;
  /** Absolute path on disk, for showing the user where it landed. */
  diskPath: string;
  /** Every produced file in one archive — the normal way to take an export. */
  bundle: { name: string; url: string; bytes: number; fileCount: number };
  files: { name: string; url: string }[];
  frameCount: number;
  animationCount: number;
}

/** A detected sprite's bounding box in source-image pixel coordinates. */
export interface SpriteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AutoSliceResponse {
  sheet: FileRef;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  /** Columns in the packed sheet (needed to address frames). */
  columns: number;
  /** Where each frame was found in the source image, reading order. */
  boxes: SpriteBox[];
  thumbnail: string;
  /** Visible body height in output pixels (frames are cropped to content). */
  bodyHeight: number;
}

export interface ExtractTilesRequest {
  assetId: string;
  sourceFile: string;
  cols: number;
  rows: number;
  offsetX?: number;
  offsetY?: number;
  targetTileSize?: number;
  dedupe?: boolean;
  /** Indices that must tile with themselves (terrain). Omit = judge them all. */
  seamlessIndexes?: number[];
}

export interface ExtractTilesResponse {
  tileset: FileRef;
  tileWidth: number;
  tileHeight: number;
  tileCount: number;
  /** original cell index -> packed tile index (after dedupe) */
  indexMap: number[];
  thumbnail: string;
  /** Tile-gate verdict (World Maker v2 §W1) — advisory; the set is saved regardless. */
  gate?: {
    score: number;
    pass: boolean;
    failedTiles: number[];
    hints: string[];
  };
}

export interface DownscaleRequest {
  assetId: string;
  sourceFile: string;
  scale?: number;
  targetWidth?: number;
  kernel?: 'nearest' | 'lanczos';
}

export interface ImageOpFileResponse {
  fileRef: FileRef;
}
