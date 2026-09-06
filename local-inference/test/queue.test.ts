import { describe, it, expect } from 'vitest';
import { JobQueue, type JobRecord } from '../src/queue.js';

const tick = () => new Promise((r) => setTimeout(r, 10));
const until = async (cond: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await tick();
  }
};

describe('job queue', () => {
  it('runs jobs strictly one at a time, in FIFO order', async () => {
    const queue = new JobQueue();
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const job = (name: string) =>
      queue.submit('test', async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await tick();
        order.push(name);
        concurrent--;
        return Buffer.from(name);
      });
    const a = job('a');
    const b = job('b');
    const c = job('c');
    expect(queue.depth()).toBe(3);
    await until(() => queue.get(c.id)?.state === 'done');
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxConcurrent).toBe(1);
    expect(queue.get(a.id)?.result?.toString()).toBe('a');
    expect(queue.get(b.id)?.state).toBe('done');
  });

  it('a failed job reports its error and does not block the next one', async () => {
    const queue = new JobQueue();
    const bad = queue.submit('test', async () => {
      throw new Error('gpu on fire');
    });
    const good = queue.submit('test', async () => Buffer.from('ok'));
    await until(() => queue.get(good.id)?.state === 'done');
    expect(queue.get(bad.id)?.state).toBe('failed');
    expect(queue.get(bad.id)?.error).toBe('gpu on fire');
    expect(queue.get(good.id)?.result?.toString()).toBe('ok');
  });

  it('streams progress to subscribers, replaying the current state on subscribe', async () => {
    const queue = new JobQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = queue.submit('test', async (report) => {
      report({ stage: 'STEP ONE', step: 1, steps: 2, free: true });
      await gate;
      report({ stage: 'STEP TWO', step: 2, steps: 2 });
      return Buffer.from('x');
    });
    await until(() => queue.get(job.id)?.progress.stage === 'STEP ONE');
    const seen: JobRecord[] = [];
    const unsubscribe = queue.subscribe(job.id, (r) => seen.push(r))!;
    // Late subscriber immediately sees where the job already is.
    expect(seen[0]!.progress.stage).toBe('STEP ONE');
    release();
    await until(() => seen.some((r) => r.state === 'done'));
    const stages = seen.map((r) => r.progress.stage);
    expect(stages).toContain('STEP TWO');
    expect(seen[seen.length - 1]!.state).toBe('done');
    unsubscribe();
  });

  it('reports queue positions and fires the metering hook with a duration', async () => {
    const queue = new JobQueue();
    const finished: { type: string; state: string; ms: number }[] = [];
    queue.onFinished = (job, ms) => finished.push({ type: job.type, state: job.state, ms });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    queue.submit('slow', async () => {
      await gate;
      return Buffer.from('1');
    });
    const waiting = queue.submit('fast', async () => Buffer.from('2'));
    expect(queue.get(waiting.id)?.queuePosition).toBe(2);
    release();
    await until(() => finished.length === 2);
    expect(finished.map((f) => f.type)).toEqual(['slow', 'fast']);
    expect(finished.every((f) => f.state === 'done' && f.ms >= 0)).toBe(true);
  });
});
