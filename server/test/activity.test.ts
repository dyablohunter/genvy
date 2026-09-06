import { describe, it, expect, beforeEach } from 'vitest';
import { activity } from '../src/services/activity.js';

/**
 * The activity feed composes TWO progress layers: the route's op layer
 * (candidate 2 of 4) and the provider's sub layer (that job's own stages).
 * Reading a job's internal "2/2" as op progress pinned the HUD bar at ~100%
 * during candidate 1 of 4 — these tests pin the composition instead.
 */

describe('activity progress composition', () => {
  beforeEach(() => activity.end());

  it('sub progress moves WITHIN the op band, never past it', () => {
    activity.begin('DRAWING...');
    activity.update({ step: 1, steps: 4 });
    // The job's internal final stage (2/2) during candidate 1:
    activity.update({ subStep: 2, subSteps: 2, label: 'DRAWING THE ANCHOR' });
    const s = activity.snapshot();
    expect(s.fraction).toBeCloseTo(0.125, 5); // half of candidate 1's band
    expect(s.nextFraction).toBeCloseTo(0.25, 5); // finishing it lands at 1/4
  });

  it('advancing the op layer clears the previous unit\'s sub progress', () => {
    activity.begin('DRAWING...');
    activity.update({ step: 1, steps: 4 });
    activity.update({ subStep: 2, subSteps: 2 });
    activity.update({ step: 2, steps: 4 }); // candidate 2 begins
    const s = activity.snapshot();
    expect(s.subStep).toBeUndefined();
    expect(s.fraction).toBeCloseTo(0.25, 5);
    expect(s.nextFraction).toBeCloseTo(0.5, 5);
  });

  it('sub-only ops (one local job = the whole op) use sub progress directly', () => {
    activity.begin('GENERATING WALK...');
    activity.update({ subStep: 5, subSteps: 11, label: 'RENDERING WALK FRAME 3/8' });
    const s = activity.snapshot();
    expect(s.fraction).toBeCloseTo(4 / 11, 5);
    expect(s.nextFraction).toBeCloseTo(5 / 11, 5);
  });

  it('op-only progress spans the unit band; inactive feeds carry no fractions and ignore updates', () => {
    activity.begin('DRAWING...');
    activity.update({ step: 3, steps: 4 });
    const s = activity.snapshot();
    expect(s.fraction).toBeCloseTo(0.5, 5);
    expect(s.nextFraction).toBeCloseTo(0.75, 5);
    activity.end();
    activity.update({ subStep: 1, subSteps: 2 }); // stray provider poll after the op ended
    expect(activity.snapshot()).toEqual({ active: false });
  });
});
