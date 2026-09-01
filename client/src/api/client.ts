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
} from '@genvy/shared';

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
    throw new ApiError(res.status, payload.error ?? `Request failed (${res.status})`, payload.details);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean; ai: { text: boolean; image: boolean } }>('GET', '/api/health'),

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
    request<{ result: T }>('POST', '/api/ai/text', body),
  aiImage: (body: AiImageRequest) =>
    request<{ fileRef: FileRef; assetId: string }>('POST', '/api/ai/image', body),

  detect: (body: DetectRequest) =>
    request<{ boxes: SpriteBox[] }>('POST', '/api/image/detect', body),
  crop: (body: CropRequest) => request<{ fileRef: FileRef }>('POST', '/api/image/crop', body),
  composeSheet: (body: ComposeSheetRequest) =>
    request<ComposeSheetResponse>('POST', '/api/image/compose-sheet', body),

  removeBg: (body: RemoveBgRequest) =>
    request<{ fileRef: FileRef }>('POST', '/api/image/remove-bg', body),
  sliceSheet: (body: SliceSheetRequest) =>
    request<SliceSheetResponse>('POST', '/api/image/slice-sheet', body),
  autoSlice: (body: AutoSliceRequest) =>
    request<AutoSliceResponse>('POST', '/api/image/auto-slice', body),
  extractTiles: (body: ExtractTilesRequest) =>
    request<ExtractTilesResponse>('POST', '/api/image/extract-tiles', body),
};

export function fileUrl(ref: FileRef | string): string {
  const p = typeof ref === 'string' ? ref : ref.path;
  return `/library/files/${p}`;
}
