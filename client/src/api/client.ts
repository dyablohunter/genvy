import type {
  AssetIndexEntry,
  AiTextRequest,
  AiImageRequest,
  RemoveBgRequest,
  SliceSheetRequest,
  SliceSheetResponse,
  AutoSliceRequest,
  AutoSliceResponse,
  DetectRequest,
  CropRequest,
  ComposeSheetRequest,
  ComposeSheetResponse,
  SpriteBox,
  OrphanInfo,
  WorkspaceInfo,
  RefsResponse,
  ExtractTilesRequest,
  ExtractTilesResponse,
  FileRef,
  AssetType,
  FlipRequest,
  FlipResponse,
  AnchorGateRequest,
  AnchorGateResponse,
  UsageResponse,
  AiImageResult,
  ImageProviderStatus,
  RepairFramesRequest,
  RepairFramesResponse,
  ExportSpriteRequest,
  ExportSpriteResponse,
} from '@genvy/shared';
import { aiImageBucket } from '../hud/progress.js';

/** Anything listening (the top-bar spend readout) refetches /api/usage. */
function bumpUsage<T>(p: Promise<T>): Promise<T> {
  return p.then((r) => {
    window.dispatchEvent(new Event('genvy-usage-changed'));
    return r;
  });
}

/**
 * Safety net for CLAUDE.md "Progress feedback": every image/video generation
 * announces itself, so the HUD can guarantee a determinate progress bar even
 * when a call site forgot to wrap the request in a timed `busy()`.
 */
async function announceAiWork<T>(body: AiImageRequest, run: () => Promise<T>): Promise<T> {
  const detail = aiImageBucket(body);
  window.dispatchEvent(new CustomEvent('genvy-ai-start', { detail }));
  try {
    return await run();
  } finally {
    window.dispatchEvent(new CustomEvent('genvy-ai-end', { detail }));
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload: { error?: string; details?: unknown } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-json error */
    }
    // Toasts truncate; the console keeps the whole thing for diagnosis.
    console.error(`[genvy] ${method} ${url} → ${res.status}`, payload.error ?? '(no message)', payload.details ?? '');
    throw new ApiError(res.status, payload.error ?? `Request failed (${res.status})`, payload.details);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
      ai: { text: boolean; image: boolean; providers?: ImageProviderStatus[] };
    }>('GET', '/api/health'),

  listAssets: (params: { type?: AssetType; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.type) qs.set('type', params.type);
    if (params.q) qs.set('q', params.q);
    const suffix = qs.size > 0 ? `?${qs}` : '';
    return request<AssetIndexEntry[]>('GET', `/api/assets${suffix}`);
  },
  getAsset: <T = Record<string, unknown>>(id: string) => request<T>('GET', `/api/assets/${id}`),
  createAsset: <T = Record<string, unknown>>(type: AssetType, data: Record<string, unknown>) =>
    request<T>('POST', '/api/assets', { type, data }),
  updateAsset: <T = Record<string, unknown>>(id: string, data: Record<string, unknown>) =>
    request<T>('PUT', `/api/assets/${id}`, data),
  assetRefs: (id: string) => request<RefsResponse>('GET', `/api/assets/${id}/refs`),
  deleteAsset: (id: string, opts: { force?: boolean; cascade?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (opts.force) qs.set('force', 'true');
    if (opts.cascade) qs.set('cascade', 'true');
    return request<void>('DELETE', `/api/assets/${id}${qs.size > 0 ? `?${qs}` : ''}`);
  },

  wipeAll: () => request<{ ok: boolean }>('POST', '/api/library/wipe'),
  listOrphans: () => request<OrphanInfo[]>('GET', '/api/library/orphans'),
  listWorkspaces: () => request<WorkspaceInfo[]>('GET', '/api/library/workspaces'),
  deleteOrphan: (id: string) => request<void>('DELETE', `/api/library/orphans/${id}`),

  aiText: <T = unknown>(body: AiTextRequest) =>
    bumpUsage(request<{ result: T }>('POST', '/api/ai/text', body)),
  aiImage: (body: AiImageRequest) =>
    announceAiWork(body, () => bumpUsage(request<AiImageResult>('POST', '/api/ai/image', body))),
  /** Change, merge or extend scene panels; costs one render per section. */
  sceneModify: (body: import('@genvy/shared').SceneModifyRequest) =>
    announceAiWork(
      { prompt: body.instruction ?? '', orientation: 'landscape' },
      () =>
        bumpUsage(
          request<import('@genvy/shared').SceneModifyResult>('POST', '/api/ai/scene-modify', body),
        ),
    ),
  usage: () => request<UsageResponse>('GET', '/api/usage'),
  /** Live server-side stage of the running AI op — the busy bar follows it. */
  activity: () => request<import('@genvy/shared').AiActivityResponse>('GET', '/api/ai/activity'),
  /** Abort abortable in-flight AI work (local renders). */
  cancelAi: () => request<{ canceled: boolean }>('POST', '/api/ai/cancel'),
  repairFrames: (body: RepairFramesRequest) =>
    bumpUsage(request<RepairFramesResponse>('POST', '/api/ai/repair-frames', body)),

  /**
   * Append a wrapping version of one tile (offset+heal, or mirrored) — no
   * model can draw a seamless texture, so it is constructed deterministically.
   */
  seamlessVariant: (body: {
    assetId: string;
    sourceAssetId?: string;
    sourceFile: string;
    tileWidth: number;
    tileHeight: number;
    index: number;
    mode?: 'offset' | 'h' | 'v' | 'both';
  }) =>
    request<{
      tileset: FileRef;
      thumbnail: string;
      newIndex: number;
      tileCount: number;
      before: number;
      after: number;
    }>('POST', '/api/image/seamless-variant', body),

  /** Drop one tile from a tileset and repack; returns the old->new index mapping. */
  removeTile: (body: {
    assetId: string;
    sourceAssetId?: string;
    sourceFile: string;
    tileWidth: number;
    tileHeight: number;
    index: number;
  }) =>
    request<{
      tileset: FileRef;
      tileWidth: number;
      tileHeight: number;
      tileCount: number;
      indexMap: number[];
      thumbnail: string;
    }>('POST', '/api/image/remove-tile', body),

  /** Remove one file from a workspace (anchor history entries). */
  deleteFile: (assetId: string, filename: string) =>
    request<void>('DELETE', `/api/files/${assetId}/${filename}`),

  detect: (body: DetectRequest) =>
    request<{ boxes: SpriteBox[] }>('POST', '/api/image/detect', body),
  crop: (body: CropRequest) => request<{ fileRef: FileRef }>('POST', '/api/image/crop', body),
  composeSheet: (body: ComposeSheetRequest) =>
    request<ComposeSheetResponse>('POST', '/api/image/compose-sheet', body),

  /** A detail-panel-sized preview of an asset, cut from its own art. Free. */
  /** Ids that some other asset points at: the parts, not the assembled thing. */
  listReferenced: () =>
    request<{ ids: string[] }>('GET', '/api/library/referenced').then((r) => r.ids),
  assetPreview: (id: string, size = 384) =>
    request<{ preview: string }>('GET', `/api/asset-preview/${id}?size=${size}`),
  /** Make a small square icon from an asset's own image — free, no AI. */
  makeThumbnail: (body: {
    assetId: string;
    /** Cut from THIS asset's files, but write the icon into `assetId`'s. */
    sourceAssetId?: string;
    sourceFile: string;
    size?: number;
    /** Defaults to thumb.png; sprite workspaces already use that name. */
    outName?: string;
  }) =>
    request<{ thumbnail: string }>('POST', '/api/image/thumbnail', body),
  /**
   * Paint a level's own icon from its grid — free, no AI. 409 when nothing is
   * painted yet, which is a reason to keep the palette fallback, not an error.
   */
  levelIcon: (body: {
    assetId: string;
    sourceAssetId: string;
    sourceFile: string;
    tileWidth: number;
    tileHeight: number;
    tiles: number[][];
    props?: { tile: number; x: number; y: number; w: number; h: number }[];
  }) =>
    request<{ thumbnail: string; preview: string; width: number; height: number }>(
      'POST',
      '/api/image/level-icon',
      body,
    ),
  /** Byte-faithful rectangle crop of a library image — free, no AI. */
  cropRect: (body: import('@genvy/shared').CropRectRequest) =>
    request<{ fileRef: import('@genvy/shared').FileRef }>('POST', '/api/image/crop-rect', body),
  removeBg: (body: RemoveBgRequest) =>
    request<{ fileRef: FileRef }>('POST', '/api/image/remove-bg', body),
  sliceSheet: (body: SliceSheetRequest) =>
    request<SliceSheetResponse>('POST', '/api/image/slice-sheet', body),
  autoSlice: (body: AutoSliceRequest) =>
    request<AutoSliceResponse>('POST', '/api/image/auto-slice', body),
  flip: (body: FlipRequest) => request<FlipResponse>('POST', '/api/image/flip', body),
  anchorGate: (body: AnchorGateRequest) =>
    request<AnchorGateResponse>('POST', '/api/image/anchor-gate', body),
  extractTiles: (body: ExtractTilesRequest) =>
    request<ExtractTilesResponse>('POST', '/api/image/extract-tiles', body),

  exportSprite: (body: ExportSpriteRequest) =>
    request<ExportSpriteResponse>('POST', '/api/export/sprite', body),
};

export function fileUrl(ref: FileRef | string): string {
  const p = typeof ref === 'string' ? ref : ref.path;
  return `/library/files/${p}`;
}
