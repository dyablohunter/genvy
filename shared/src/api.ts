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

export interface AiImageRequest {
  prompt: string;
  orientation: ImageOrientation;
  /** When set, the output is saved under this asset's file dir. */
  assetId?: string;
  kind?: 'variants' | 'animation' | 'tileset' | 'raw';
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
  /** Ask the model to draw green cell borders (stripped by the pipeline). */
  cellBorders?: boolean;
  /** Pose all variants share (from the pose preset select). */
  pose?: string;
}

export interface AiImageResponse {
  fileRef: FileRef;
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
}

export interface ComposeSheetRequest {
  assetId: string;
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
}

export interface ExtractTilesResponse {
  tileset: FileRef;
  tileWidth: number;
  tileHeight: number;
  tileCount: number;
  /** original cell index -> packed tile index (after dedupe) */
  indexMap: number[];
  thumbnail: string;
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
