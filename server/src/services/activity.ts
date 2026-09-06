/**
 * Live server-side activity for the busy indicator (the progress-feedback
 * skill's "server-driven progress"). The route and the providers know things
 * the client can only guess: which gate-retry attempt is running, which
 * candidate of four is rendering, which frame the local service is on. They
 * write it here; GET /api/ai/activity serves it; the HUD polls and lets the
 * server's truth drive the label and the bar.
 *
 * One global record on purpose: Genvy is a single-user tool and image work
 * serializes in practice. If concurrent ops ever matter, this grows a key.
 */

export interface ActivitySnapshot {
  active: boolean;
  /** HUD-ready stage text, shown verbatim. */
  label?: string;
  /** OP layer: which top-level unit is running (candidate 2 of 4). Set by routes. */
  step?: number;
  steps?: number;
  /** SUB layer: progress INSIDE the current unit (a job's own stages). Set by providers. */
  subStep?: number;
  subSteps?: number;
  /**
   * Composed progress in [0,1]: work completed / where finishing the current
   * sub-step lands. The two layers MUST be composed — a job's internal "2/2"
   * read as op progress once pinned the bar at ~100% during candidate 1 of 4.
   */
  fraction?: number;
  nextFraction?: number;
  /** The running work can be aborted (POST /api/ai/cancel) — shows the red CANCEL. */
  cancelable?: boolean;
  startedAt?: number;
}

type ActivityPatch = Partial<Omit<ActivitySnapshot, 'active' | 'startedAt' | 'fraction' | 'nextFraction'>>;

class ActivityTracker {
  private state: ActivitySnapshot = { active: false };

  begin(label: string) {
    this.state = { active: true, label, startedAt: Date.now() };
  }

  /** No-op unless something began — a stray provider poll can't resurrect a finished op. */
  update(p: ActivityPatch) {
    if (!this.state.active) return;
    // Advancing the OP layer invalidates the previous unit's sub progress —
    // without this, candidate 2 starts with candidate 1's "done" sub-state.
    const clearsSub = p.step !== undefined && p.subStep === undefined;
    this.state = {
      ...this.state,
      ...p,
      ...(clearsSub ? { subStep: undefined, subSteps: undefined } : {}),
    };
  }

  end() {
    this.state = { active: false };
  }

  snapshot(): ActivitySnapshot {
    const s = { ...this.state };
    if (!s.active) return s;
    const hasOp = !!(s.step && s.steps);
    const hasSub = !!(s.subStep && s.subSteps);
    if (hasOp) {
      const low = (s.step! - 1) / s.steps!;
      const width = 1 / s.steps!;
      s.fraction = hasSub ? low + ((s.subStep! - 1) / s.subSteps!) * width : low;
      s.nextFraction = hasSub ? low + (s.subStep! / s.subSteps!) * width : low + width;
    } else if (hasSub) {
      s.fraction = (s.subStep! - 1) / s.subSteps!;
      s.nextFraction = s.subStep! / s.subSteps!;
    }
    return s;
  }
}

export const activity = new ActivityTracker();
