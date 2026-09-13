import { describe, it, expect } from 'vitest';
import { surfaceFriction, defaultFriction, maskKindKey, SCENE_MASK_KINDS, LevelSchema, newAssetId } from '@genvy/shared';

/**
 * A mask CELL stores one kind id and nothing else, so per-cell friction has
 * nowhere to live — which is why the friction field only ever reached traced
 * shapes and a hand-painted ramp was always the stock 0.7. The level carries
 * a per-kind value for exactly that, and one resolver keeps the physics, the
 * on-screen readouts and the editor from disagreeing.
 */
const id = (key: string) => SCENE_MASK_KINDS.find((k) => k.key === key)!.id;

describe('surfaceFriction', () => {
  it('falls back to the kind default with nothing set', () => {
    expect(surfaceFriction(id('ramp'))).toBe(defaultFriction('ramp'));
    expect(surfaceFriction(id('water'))).toBe(defaultFriction('water'));
    // A kind with no opinion is ordinary footing.
    expect(surfaceFriction(id('ladder'))).toBe(1);
  });

  it('lets the level override a kind — this is what painted cells ride on', () => {
    const byKind = { [String(id('ramp'))]: 0.1 };
    expect(surfaceFriction(id('ramp'), byKind)).toBe(0.1);
    // Only the kind that was set; the others keep their defaults.
    expect(surfaceFriction(id('stairs'), byKind)).toBe(defaultFriction('stairs'));
  });

  it("lets a shape's own value beat the level's", () => {
    const byKind = { [String(id('ramp'))]: 0.1 };
    expect(surfaceFriction(id('ramp'), byKind, 1.6)).toBe(1.6);
  });

  it('treats 0 as a real value, not as absent', () => {
    // Frictionless ice is 0, and `?? ` on a falsy number is the classic way
    // to lose it.
    expect(surfaceFriction(id('ramp'), { [String(id('ramp'))]: 0 })).toBe(0);
    expect(surfaceFriction(id('ramp'), {}, 0)).toBe(0);
  });

  it('maps every kind id back to its key', () => {
    for (const kind of SCENE_MASK_KINDS) {
      expect(maskKindKey(kind.id)).toBe(kind.key);
    }
    // An id no kind claims must not throw; it reads as solid ground.
    expect(maskKindKey(999)).toBe('solid');
  });
});

describe('LevelSchema.frictionByKind', () => {
  const base = () => ({
    id: newAssetId('level'),
    type: 'level' as const,
    name: 'Cave',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it('defaults to empty and round-trips what was painted', () => {
    expect(LevelSchema.parse(base()).frictionByKind).toEqual({});
    const level = LevelSchema.parse({ ...base(), frictionByKind: { '11': 0.2 } });
    expect(level.frictionByKind['11']).toBe(0.2);
  });

  it('rejects a friction outside the range the picker offers', () => {
    expect(() => LevelSchema.parse({ ...base(), frictionByKind: { '11': 9 } })).toThrow();
    expect(() => LevelSchema.parse({ ...base(), frictionByKind: { '11': -1 } })).toThrow();
  });
});
