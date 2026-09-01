import type { AssetIndexEntry } from '@genvy/shared';
import { api } from '../api/client.js';

type Listener = (entries: AssetIndexEntry[]) => void;

/** Client-side cache of the asset index with change events. */
class CollectionStore {
  entries: AssetIndexEntry[] = [];
  private listeners = new Set<Listener>();

  async refresh() {
    this.entries = await api.listAssets();
    for (const fn of this.listeners) fn(this.entries);
    return this.entries;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.entries);
    return () => this.listeners.delete(fn);
  }

  get count() {
    return this.entries.length;
  }
}

export const collection = new CollectionStore();
