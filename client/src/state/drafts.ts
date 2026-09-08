/**
 * Crash insurance for work in progress.
 *
 * The "one session, one asset" rule saves every finished step to the library,
 * but the strokes of the CURRENT session — a half-painted mask, a tile layer,
 * a long prompt — live only in memory until their save button. A closed tab
 * or a crash took them with it. Drafts park that state in localStorage until
 * the real save happens, at which point the draft is cleared: the library is
 * the truth, a draft is only the bridge to it.
 *
 * localStorage rather than IndexedDB on purpose: writes are synchronous (so
 * `beforeunload` can flush), the payloads are kept small (masks go in as
 * run-length strings), and the API is three lines instead of a schema.
 */

const PREFIX = 'genvy:draft:';

export interface Draft<T> {
  savedAt: number;
  data: T;
}

export function saveDraft<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Quota or private mode: insurance failing must never break the editor.
  }
}

export function loadDraft<T>(key: string): Draft<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft<T>;
    return typeof parsed?.savedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Already gone, or storage unavailable — either way there is no draft.
  }
}

/**
 * Run-length encode a mask grid ("id:count,id:count,..." per row, rows joined
 * with ";"). A 4px-cell mask of a large scene is tens of thousands of ints;
 * as plain JSON it flirts with the localStorage quota, as runs it is tiny —
 * collision masks are mostly empty space and long solid runs.
 */
export function packGrid(grid: number[][]): string {
  return grid
    .map((row) => {
      const parts: string[] = [];
      let value = row[0] ?? 0;
      let count = 0;
      for (const cell of row) {
        if (cell === value) {
          count++;
        } else {
          parts.push(`${value}:${count}`);
          value = cell;
          count = 1;
        }
      }
      if (count > 0) parts.push(`${value}:${count}`);
      return parts.join(',');
    })
    .join(';');
}

export function unpackGrid(packed: string): number[][] {
  if (!packed) return [];
  return packed.split(';').map((row) =>
    row.split(',').flatMap((part) => {
      const [value, count] = part.split(':');
      return new Array<number>(Math.max(0, Number(count) || 0)).fill(Number(value) || 0);
    }),
  );
}
