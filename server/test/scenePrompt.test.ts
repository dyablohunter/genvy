import { describe, it, expect } from 'vitest';
import {
  sceneImagePrompt,
  sceneCutoutEditPrompt,
  sceneModifyEditPrompt,
} from '../src/prompts/index.js';

/**
 * A scene's options are not independent of each other. The view decides what
 * the rest of them are even allowed to mean, and a request that pairs them
 * badly wastes a paid render — so the prompt builder, not just the UI, has to
 * refuse the impossible combinations.
 */
describe('sceneImagePrompt', () => {
  const loops = /loops horizontally/i;

  it('asks for a loop only on a side view', () => {
    expect(sceneImagePrompt('a jungle', { view: 'side', seamless: true })).toMatch(loops);
    for (const view of ['isometric', 'topdown', 'threequarter'] as const) {
      expect(sceneImagePrompt('a jungle', { view, seamless: true })).not.toMatch(loops);
    }
  });

  it('never asks for a loop when none was requested', () => {
    expect(sceneImagePrompt('a jungle', { view: 'side' })).not.toMatch(loops);
    expect(sceneImagePrompt('a jungle', { view: 'side', seamless: false })).not.toMatch(loops);
  });

  it('states the projection rules of the view it was given', () => {
    expect(sceneImagePrompt('x', { view: 'isometric' })).toMatch(/2:1 isometric/i);
    expect(sceneImagePrompt('x', { view: 'side' })).toMatch(/orthographic side view/i);
    expect(sceneImagePrompt('x', { view: 'topdown' })).toMatch(/top-down/i);
    expect(sceneImagePrompt('x', { view: 'threequarter' })).toMatch(/three-quarter/i);
    // A side view's rules must not leak into an isometric one.
    expect(sceneImagePrompt('x', { view: 'isometric' })).not.toMatch(/orthographic side view/i);
  });

  it('defaults to a side view when none is given', () => {
    expect(sceneImagePrompt('x')).toMatch(/orthographic side view/i);
  });

  it('keeps actors out of the artwork whatever the view', () => {
    for (const view of ['side', 'isometric', 'topdown', 'threequarter'] as const) {
      const p = sceneImagePrompt('a market square', { view });
      expect(p).toMatch(/EMPTY of characters/i);
      expect(p).toMatch(/full bleed/i);
      expect(p).toContain('a market square');
    }
  });
});

/**
 * Vertical loops: a tower or a shaft repeats top-to-bottom, and its seam is
 * the opposite pair of edges. Asking for the wrong pair produces art built
 * around a seam the level never uses.
 */
describe('sceneImagePrompt loops', () => {
  const horiz = /LEFT and RIGHT edges must continue/i;
  const vert = /TOP and BOTTOM edges must continue/i;

  it('asks for the edges that match the axis', () => {
    const h = sceneImagePrompt('a run', { view: 'side', loop: 'horizontal' });
    expect(h).toMatch(horiz);
    expect(h).not.toMatch(vert);
    const v = sceneImagePrompt('a tower', { view: 'side', loop: 'vertical' });
    expect(v).toMatch(vert);
    expect(v).not.toMatch(horiz);
  });

  it('asks for neither when the level does not loop', () => {
    const p = sceneImagePrompt('a room', { view: 'side', loop: 'none' });
    expect(p).not.toMatch(horiz);
    expect(p).not.toMatch(vert);
  });

  it('refuses both axes on a view that has no seam', () => {
    for (const view of ['isometric', 'topdown', 'threequarter'] as const) {
      for (const loop of ['horizontal', 'vertical'] as const) {
        const p = sceneImagePrompt('a map', { view, loop });
        expect(p).not.toMatch(horiz);
        expect(p).not.toMatch(vert);
      }
    }
  });

  it('still honours the old seamless flag as a horizontal loop', () => {
    expect(sceneImagePrompt('a run', { view: 'side', seamless: true })).toMatch(horiz);
    // An explicit loop wins over the legacy flag.
    expect(sceneImagePrompt('a tower', { view: 'side', seamless: true, loop: 'vertical' })).toMatch(vert);
  });
});

/**
 * The cutout must not become a re-render. Everything kept has to survive
 * untouched, or the panel no longer lines up with the mask painted on it.
 */
describe('sceneCutoutEditPrompt', () => {
  it('demands transparency and forbids redrawing what is kept', () => {
    const p = sceneCutoutEditPrompt();
    expect(p).toMatch(/transparent/i);
    expect(p).toMatch(/do NOT redraw/i);
    expect(p).toMatch(/same place, at the same size/i);
    expect(p).toMatch(/no halo|no matte/i);
  });

  it('names the sky as background and the ground as kept', () => {
    const p = sceneCutoutEditPrompt();
    expect(p).toMatch(/sky/i);
    expect(p).toMatch(/platforms|terrain/i);
  });

  it('takes an override for what counts as foreground', () => {
    expect(sceneCutoutEditPrompt('only the stone bridge')).toContain('only the stone bridge');
    // Blank notes fall back to the default rather than emptying the rule.
    expect(sceneCutoutEditPrompt('   ')).toMatch(/playable foreground/i);
  });
});

/**
 * Modify is ONE job now: change the panel it is given and nothing else. The
 * merge/extend machinery was dropped — the model renders a fixed canvas
 * whatever it is shown — so what is pinned is the edit's restraint.
 */
describe('sceneModifyEditPrompt', () => {
  it('keeps an edit an edit — nothing but the asked change moves', () => {
    const p = sceneModifyEditPrompt('remove the palm tree');
    expect(p).toContain('remove the palm tree');
    expect(p).toMatch(/stays EXACTLY as it is/i);
    expect(p).toMatch(/do not reframe, crop, zoom/i);
    expect(p).toMatch(/rebuild what would be behind it/i);
  });

  it('handles transparency and removals explicitly', () => {
    const p = sceneModifyEditPrompt('make the background transparent');
    expect(p).toMatch(/true alpha channel/i);
    expect(p).toMatch(/no halo/i);
  });

  it('keeps actors out and survives an empty instruction', () => {
    expect(sceneModifyEditPrompt('x')).toMatch(/EMPTY of characters/i);
    expect(sceneModifyEditPrompt('   ')).toMatch(/return the artwork as it is/i);
  });
});
