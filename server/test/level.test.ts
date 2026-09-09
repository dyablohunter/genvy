import { describe, it, expect } from 'vitest';
import { LevelSchema, assetSchemaRegistry, newAssetId } from '@genvy/shared';

/**
 * A LEVEL is whichever layers it happens to have. The editor stopped asking
 * "what type of level is this?" precisely because the answer changes while
 * you work — so the schema must accept every combination, including the
 * empty one you start from.
 */
describe('LevelSchema', () => {
  const base = () => ({
    id: newAssetId('level'),
    type: 'level' as const,
    name: 'Cave',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it('accepts a level with nothing in it yet', () => {
    const level = LevelSchema.parse(base());
    expect(level.tiles).toEqual([]);
    expect(level.shapes).toEqual([]);
    expect(level.props).toEqual([]);
    expect(level.spawnPoints).toEqual([]);
    expect(level.scene).toBeUndefined();
    expect(level.tileset).toBeUndefined();
    // A grid it does not have still needs sane dimensions to grow into.
    expect(level.width).toBeGreaterThan(0);
    expect(level.tileWidth).toBe(64);
  });

  it('accepts tiles only, backdrop only, and both', () => {
    const tilesOnly = LevelSchema.parse({
      ...base(),
      tileset: { id: 'tls_x', type: 'tileset' },
      tiles: [
        [0, 1],
        [-1, 2],
      ],
    });
    expect(tilesOnly.tiles[1]).toEqual([-1, 2]); // -1 is empty, not invalid

    const backdropOnly = LevelSchema.parse({
      ...base(),
      scene: { id: 'scn_x', type: 'scene' },
      mask: { cellSize: 16, width: 2, height: 1, data: [[0, 1]] },
    });
    expect(backdropOnly.scene?.id).toBe('scn_x');
    expect(backdropOnly.tiles).toEqual([]);

    const both = LevelSchema.parse({
      ...base(),
      scene: { id: 'scn_x', type: 'scene' },
      tileset: { id: 'tls_x', type: 'tileset' },
      tiles: [[0]],
    });
    expect(both.scene && both.tileset).toBeTruthy();
  });

  it('carries the gameplay layers the level owns itself', () => {
    const level = LevelSchema.parse({
      ...base(),
      shapes: [
        {
          id: 'sh_1',
          kind: 1,
          type: 'rect',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 4 },
          ],
          friction: 0.3,
        },
      ],
      props: [{ tile: 3, x: 2, y: 2, w: 3, h: 3 }],
      spawnPoints: [{ name: 'player', x: 2, y: 2 }],
    });
    expect(level.shapes[0]!.friction).toBe(0.3);
    expect(level.props[0]!.w).toBe(3);
    expect(level.spawnPoints[0]!.name).toBe('player');
  });

  it('is registered so the server will store it', () => {
    expect(assetSchemaRegistry).toHaveProperty('level');
    expect(newAssetId('level').startsWith('lvl_')).toBe(true);
  });

  it('rejects a grid cell that is neither a tile nor empty', () => {
    expect(() => LevelSchema.parse({ ...base(), tiles: [[-2]] })).toThrow();
  });
});
