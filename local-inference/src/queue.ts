import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * In-memory serial job queue. One GPU means one job at a time; everything
 * else waits in FIFO order. Jobs carry live progress (stage text + step i/n)
 * that the SSE endpoint streams to the HUD, so a 90-second render is never an
 * unexplained wait — that is the Progress feedback contract, enforced here at
 * the source instead of guessed at by the client.
 */

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobProgress {
  /** Human stage text, HUD-ready ("2/9 RENDERING WALK FRAME 1..."). */
  stage: string;
  /** 1-based step within `steps`; 0 while queued. */
  step: number;
  steps: number;
  /** Steps that cost nothing are labelled so the HUD can say FREE. */
  free: boolean;
}

export interface JobRecord {
  id: string;
  type: string;
  state: JobState;
  progress: JobProgress;
  /** Queue position while queued (1 = next), 0 otherwise. */
  queuePosition: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface JobHandle extends JobRecord {
  /** Result PNG (or strip) once state === 'done'. */
  result?: Buffer;
}

export type ProgressReporter = (p: Partial<JobProgress> & { stage: string }) => void;
export type JobRunner = (report: ProgressReporter, signal: AbortSignal) => Promise<Buffer>;

interface InternalJob extends JobHandle {
  runner: JobRunner;
  events: EventEmitter;
  abort: AbortController;
}

/** How long finished jobs stay retrievable before being swept. */
const RETENTION_MS = 10 * 60_000;

export class JobQueue {
  private jobs = new Map<string, InternalJob>();
  private pending: InternalJob[] = [];
  private running: InternalJob | null = null;

  /** Called when any job finishes (success or failure) — usage metering hook. */
  onFinished?: (job: JobRecord, durationMs: number) => void;

  submit(type: string, runner: JobRunner): JobRecord {
    const job: InternalJob = {
      id: randomUUID(),
      type,
      state: 'queued',
      progress: { stage: 'QUEUED', step: 0, steps: 1, free: true },
      queuePosition: this.pending.length + (this.running ? 1 : 0) + 1,
      createdAt: Date.now(),
      runner,
      events: new EventEmitter(),
      abort: new AbortController(),
    };
    job.events.setMaxListeners(50);
    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.pump();
    return this.record(job);
  }

  get(id: string): JobHandle | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return { ...this.record(job), result: job.result };
  }

  /**
   * Subscribe to a job's lifecycle. The listener fires immediately with the
   * current state (so late subscribers miss nothing), then on every progress
   * change, and finally with state done/failed. Returns an unsubscribe.
   */
  subscribe(id: string, listener: (r: JobRecord) => void): (() => void) | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const emit = () => listener(this.record(job));
    emit();
    job.events.on('update', emit);
    return () => job.events.off('update', emit);
  }

  /** Depth of the queue including the running job. */
  depth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /**
   * Cancel a job. Queued jobs fail immediately; the running job's abort
   * signal fires and it fails at its next checkpoint (runners check between
   * steps; the service also interrupts ComfyUI's in-flight render).
   * Returns whether the job was found and still cancelable.
   */
  cancel(id: string): { ok: boolean; wasRunning: boolean } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, wasRunning: false };
    if (job.state === 'queued') {
      this.pending = this.pending.filter((j) => j !== job);
      job.state = 'failed';
      job.error = 'canceled by user';
      job.finishedAt = Date.now();
      job.events.emit('update');
      this.onFinished?.(this.record(job), 0);
      return { ok: true, wasRunning: false };
    }
    if (job.state === 'running') {
      job.abort.abort();
      return { ok: true, wasRunning: true };
    }
    return { ok: false, wasRunning: false };
  }

  /**
   * Every job still in memory, newest first. Exists because an orphaned
   * job id (a caller that died mid-poll) is otherwise unrecoverable — the
   * result would sit here for its retention window with no way to find it.
   */
  list(): JobRecord[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this.record(j));
  }

  private record(job: InternalJob): JobRecord {
    const { id, type, state, progress, error, createdAt, startedAt, finishedAt } = job;
    return {
      id,
      type,
      state,
      progress: { ...progress },
      queuePosition: state === 'queued' ? this.pending.indexOf(job) + (this.running ? 2 : 1) : 0,
      error,
      createdAt,
      startedAt,
      finishedAt,
    };
  }

  private pump() {
    if (this.running) return;
    const job = this.pending.shift();
    if (!job) return;
    this.running = job;
    job.state = 'running';
    job.startedAt = Date.now();
    job.progress = { stage: 'STARTING', step: 0, steps: job.progress.steps, free: true };
    job.events.emit('update');

    const report: ProgressReporter = (p) => {
      job.progress = { ...job.progress, ...p };
      job.events.emit('update');
    };

    void job
      .runner(report, job.abort.signal)
      .then((result) => {
        job.result = result;
        job.state = 'done';
        job.progress = { ...job.progress, step: job.progress.steps, stage: 'DONE' };
      })
      .catch((err: unknown) => {
        job.state = 'failed';
        job.error = (err as Error)?.message ?? 'unknown error';
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.running = null;
        job.events.emit('update');
        this.onFinished?.(this.record(job), job.finishedAt - (job.startedAt ?? job.finishedAt));
        setTimeout(() => this.jobs.delete(job.id), RETENTION_MS).unref?.();
        this.pump();
      });
  }
}
