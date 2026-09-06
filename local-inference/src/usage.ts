import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Usage metering for the local service. Local inference costs no credits, so
 * the unit here is work, not money: jobs run, GPU wall-time, images produced.
 * The contract stays open on purpose — hosted deployments will eventually
 * meter the same figures into billing, and the shape should not have to
 * change when that happens.
 */

export interface JobTypeUsage {
  jobs: number;
  failed: number;
  gpuMs: number;
  images: number;
}

export interface UsageSnapshot {
  types: Record<string, JobTypeUsage>;
  totalJobs: number;
  totalGpuMs: number;
}

export class LocalUsage {
  private types: Record<string, JobTypeUsage> = {};
  private file = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  async init(dataDir: string) {
    this.file = path.join(dataDir, 'usage.json');
    try {
      this.types = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, JobTypeUsage>;
    } catch {
      this.types = {};
    }
  }

  record(type: string, opts: { ms: number; images?: number; failed?: boolean }) {
    const entry = (this.types[type] ??= { jobs: 0, failed: 0, gpuMs: 0, images: 0 });
    entry.jobs += 1;
    if (opts.failed) entry.failed += 1;
    entry.gpuMs += Math.max(0, Math.round(opts.ms));
    entry.images += opts.images ?? 0;
    this.scheduleSave();
  }

  snapshot(): UsageSnapshot {
    const types = Object.fromEntries(Object.entries(this.types).map(([k, v]) => [k, { ...v }]));
    const all = Object.values(this.types);
    return {
      types,
      totalJobs: all.reduce((s, t) => s + t.jobs, 0),
      totalGpuMs: all.reduce((s, t) => s + t.gpuMs, 0),
    };
  }

  private scheduleSave() {
    if (this.writeTimer || !this.file) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void fs
        .mkdir(path.dirname(this.file), { recursive: true })
        .then(() => fs.writeFile(this.file, JSON.stringify(this.types, null, 2)))
        .catch(() => {
          /* metering is best-effort */
        });
    }, 500);
    this.writeTimer.unref?.();
  }
}
