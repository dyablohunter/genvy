import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAssetSchema,
  newAssetId,
  ID_PREFIXES,
  type AssetType,
  type AssetIndexEntry,
} from '@genvy/shared';

const ASSET_TYPES = new Set(Object.keys(ID_PREFIXES));

export class LibraryError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
  }
}

export class Library {
  constructor(private rootDir: string) {}

  get filesDir() {
    return path.join(this.rootDir, 'files');
  }

  /** Engine-ready exports (sheet + manifests), one dir per export. */
  get exportsDir() {
    return path.join(this.rootDir, 'exports');
  }

  private assetPath(type: AssetType, id: string) {
    return path.join(this.rootDir, 'assets', type, `${id}.json`);
  }

  private indexPath() {
    return path.join(this.rootDir, 'index.json');
  }

  async init() {
    await fs.mkdir(path.join(this.rootDir, 'assets'), { recursive: true });
    await fs.mkdir(this.filesDir, { recursive: true });
    await fs.mkdir(this.exportsDir, { recursive: true });
    try {
      await fs.access(this.indexPath());
    } catch {
      await this.writeJsonAtomic(this.indexPath(), []);
    }
  }

  private async writeJsonAtomic(file: string, data: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  async readIndex(): Promise<AssetIndexEntry[]> {
    try {
      return JSON.parse(await fs.readFile(this.indexPath(), 'utf8'));
    } catch {
      return [];
    }
  }

  private async updateIndex(mutate: (entries: AssetIndexEntry[]) => AssetIndexEntry[]) {
    const entries = await this.readIndex();
    await this.writeJsonAtomic(this.indexPath(), mutate(entries));
  }

  async list(query: { type?: string; tag?: string; q?: string }): Promise<AssetIndexEntry[]> {
    let entries = await this.readIndex();
    if (query.type) entries = entries.filter((e) => e.type === query.type);
    if (query.tag) entries = entries.filter((e) => e.tags.includes(query.tag!));
    if (query.q) {
      const q = query.q.toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(q));
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Record<string, unknown>> {
    const entry = (await this.readIndex()).find((e) => e.id === id);
    if (!entry) throw new LibraryError(404, `Asset ${id} not found`);
    return JSON.parse(await fs.readFile(this.assetPath(entry.type, id), 'utf8'));
  }

  private validate(type: string, data: Record<string, unknown>): Record<string, unknown> {
    if (!ASSET_TYPES.has(type)) throw new LibraryError(400, `Unknown asset type: ${type}`);
    const schema = getAssetSchema(type);
    if (!schema) throw new LibraryError(400, `Asset type not yet implemented: ${type}`);
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new LibraryError(400, 'Asset failed validation', result.error.flatten());
    }
    return result.data as Record<string, unknown>;
  }

  /** Collect all outbound AssetRefs ({id, type} objects) anywhere in the asset JSON. */
  static collectRefs(value: unknown, out: { id: string; type: string }[] = []) {
    if (Array.isArray(value)) {
      for (const v of value) Library.collectRefs(v, out);
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (
        typeof obj.id === 'string' &&
        typeof obj.type === 'string' &&
        ASSET_TYPES.has(obj.type) &&
        Object.keys(obj).length === 2
      ) {
        out.push({ id: obj.id, type: obj.type });
      } else {
        for (const v of Object.values(obj)) Library.collectRefs(v, out);
      }
    }
    return out;
  }

  private async assertRefsExist(data: Record<string, unknown>, selfId: string) {
    const refs = Library.collectRefs(data).filter((r) => r.id !== selfId);
    if (refs.length === 0) return;
    const known = new Set((await this.readIndex()).map((e) => e.id));
    const missing = refs.filter((r) => !known.has(r.id));
    if (missing.length > 0) {
      throw new LibraryError(400, 'Asset references missing assets', { missing });
    }
  }

  async create(type: AssetType, data: Record<string, unknown>) {
    const now = new Date().toISOString();
    const id = typeof data.id === 'string' && data.id.length > 0 ? (data.id as string) : newAssetId(type);
    const full = this.validate(type, { ...data, id, type, createdAt: now, updatedAt: now });
    await this.assertRefsExist(full, id);
    await this.writeJsonAtomic(this.assetPath(type, id), full);
    await this.updateIndex((entries) => [
      ...entries.filter((e) => e.id !== id),
      this.toIndexEntry(full),
    ]);
    return full;
  }

  async update(id: string, data: Record<string, unknown>) {
    const existing = await this.get(id);
    const now = new Date().toISOString();
    const merged = {
      ...data,
      id,
      type: existing.type,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    const full = this.validate(existing.type as string, merged);
    await this.assertRefsExist(full, id);
    await this.writeJsonAtomic(this.assetPath(existing.type as AssetType, id), full);
    await this.updateIndex((entries) =>
      entries.map((e) => (e.id === id ? this.toIndexEntry(full) : e)),
    );
    return full;
  }

  async referrers(id: string): Promise<AssetIndexEntry[]> {
    const entries = await this.readIndex();
    const result: AssetIndexEntry[] = [];
    for (const entry of entries) {
      if (entry.id === id) continue;
      try {
        const asset = await this.get(entry.id);
        if (Library.collectRefs(asset).some((r) => r.id === id)) result.push(entry);
      } catch {
        /* skip unreadable */
      }
    }
    return result;
  }

  async remove(id: string, opts: { force?: boolean; cascade?: boolean } = {}) {
    await this.removeInner(id, opts, new Set());
  }

  private async removeInner(
    id: string,
    opts: { force?: boolean; cascade?: boolean },
    seen: Set<string>,
  ) {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = (await this.readIndex()).find((e) => e.id === id);
    if (!entry) {
      if (seen.size === 1) throw new LibraryError(404, `Asset ${id} not found`);
      return;
    }
    const refs = await this.referrers(id);
    if (refs.length > 0) {
      if (opts.cascade) {
        // Dependents cannot exist without this asset — take them down first.
        for (const ref of refs) await this.removeInner(ref.id, opts, seen);
      } else if (!opts.force) {
        throw new LibraryError(409, `Asset ${id} is referenced by other assets`, {
          error: 'referenced',
          referrers: refs,
        });
      }
    }
    await fs.rm(this.assetPath(entry.type, id), { force: true });
    await fs.rm(path.join(this.filesDir, id), { recursive: true, force: true });
    await this.updateIndex((entries) => entries.filter((e) => e.id !== id));
  }

  async outboundRefs(id: string): Promise<AssetIndexEntry[]> {
    const asset = await this.get(id);
    const refs = Library.collectRefs(asset);
    const index = await this.readIndex();
    return index.filter((e) => refs.some((r) => r.id === e.id));
  }

  private toIndexEntry(asset: Record<string, unknown>): AssetIndexEntry {
    return {
      id: asset.id as string,
      type: asset.type as AssetType,
      name: asset.name as string,
      tags: (asset.tags as string[]) ?? [],
      updatedAt: asset.updatedAt as string,
      thumbnail: asset.thumbnail as string | undefined,
    };
  }

  /**
   * File dirs with no saved asset — interrupted sessions whose forged images
   * are still on disk. Surfaced as "recovered" entries so work can resume.
   */
  async orphans(): Promise<
    {
      id: string;
      files: string[];
      updatedAt: string;
      source?: { sessionId: string; variantIndex: number | null };
    }[]
  > {
    const known = new Set((await this.readIndex()).map((e) => e.id));
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(this.filesDir);
    } catch {
      return [];
    }
    const out: {
      id: string;
      files: string[];
      updatedAt: string;
      source?: { sessionId: string; variantIndex: number | null };
    }[] = [];
    for (const dir of dirs) {
      if (known.has(dir)) continue;
      try {
        const files = await fs.readdir(path.join(this.filesDir, dir));
        if (files.length === 0) continue;
        const stat = await fs.stat(path.join(this.filesDir, dir));
        let source;
        if (files.includes('source.json')) {
          try {
            source = JSON.parse(await fs.readFile(path.join(this.filesDir, dir, 'source.json'), 'utf8'));
          } catch {
            /* corrupt marker — ignore */
          }
        }
        out.push({ id: dir, files, updatedAt: stat.mtime.toISOString(), source });
      } catch {
        /* unreadable dir — skip */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Every file directory with its session linkage and the assets saved from
   * it — the drawer groups these into one card per forge session.
   */
  async workspaces(): Promise<
    {
      id: string;
      files: string[];
      updatedAt: string;
      source?: { sessionId: string; variantIndex: number | null };
      sheet?: AssetIndexEntry;
      character?: AssetIndexEntry;
      subject?: string;
    }[]
  > {
    const index = await this.readIndex();
    const byId = new Map(index.map((e) => [e.id, e]));
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(this.filesDir);
    } catch {
      return [];
    }
    const out = [];
    for (const dir of dirs) {
      let files: string[];
      let stat;
      try {
        files = await fs.readdir(path.join(this.filesDir, dir));
        if (files.length === 0) continue;
        stat = await fs.stat(path.join(this.filesDir, dir));
      } catch {
        continue;
      }
      let source;
      if (files.includes('source.json')) {
        try {
          source = JSON.parse(await fs.readFile(path.join(this.filesDir, dir, 'source.json'), 'utf8'));
        } catch {
          /* corrupt marker */
        }
      }
      const sheet = byId.get(dir);
      let character: AssetIndexEntry | undefined;
      if (sheet) {
        character = (await this.referrers(dir)).find((e) => e.type === 'character');
      }
      // What KIND of thing this sprite is (character/weapon/prop/...), so the
      // inventory can label it without another fetch.
      let subject: string | undefined;
      if (files.includes('concept.json')) {
        try {
          const concept = JSON.parse(
            await fs.readFile(path.join(this.filesDir, dir, 'concept.json'), 'utf8'),
          );
          if (typeof concept.subject === 'string') subject = concept.subject;
        } catch {
          /* corrupt concept — no label */
        }
      }
      out.push({ id: dir, files, updatedAt: stat.mtime.toISOString(), source, sheet, character, subject });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async removeOrphan(id: string) {
    const known = new Set((await this.readIndex()).map((e) => e.id));
    if (known.has(id)) throw new LibraryError(400, 'Asset exists — delete the asset instead');
    await fs.rm(path.join(this.filesDir, id), { recursive: true, force: true });
  }

  /** Dev/testing: delete every asset JSON and binary, reset the index. */
  async wipe() {
    await fs.rm(path.join(this.rootDir, 'assets'), { recursive: true, force: true });
    await fs.rm(this.filesDir, { recursive: true, force: true });
    await fs.mkdir(path.join(this.rootDir, 'assets'), { recursive: true });
    await fs.mkdir(this.filesDir, { recursive: true });
    await this.writeJsonAtomic(this.indexPath(), []);
  }

  /** Absolute directory for an asset's binary files (created on demand). */
  async fileDir(assetId: string) {
    const dir = path.join(this.filesDir, assetId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Resolve a library-relative file path ("<assetId>/<file>") safely. */
  resolveFile(relPath: string) {
    const abs = path.resolve(this.filesDir, relPath);
    if (!abs.startsWith(path.resolve(this.filesDir))) {
      throw new LibraryError(400, 'Invalid file path');
    }
    return abs;
  }
}
