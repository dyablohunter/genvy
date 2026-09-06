import { describe, it, expect } from 'vitest';
import { buildWorldGrid, WorldPlanSchema, type WorldPlan } from '@genvy/shared';

/**
 * The builder — not the model — is responsible for a map being playable:
 * rooms carved, everything reachable, walls enclosing, decor only where it
 * belongs. These pin that contract.
 */

const basePlan = (over: Partial<WorldPlan> = {}): WorldPlan =>
  WorldPlanSchema.parse({
    name: 'Cave',
    ground: 0,
    wall: 5,
    seed: 7,
    rooms: [
      { name: 'entry', x: 2, y: 2, w: 6, h: 5 },
      { name: 'hall', x: 20, y: 4, w: 8, h: 6 },
      { name: 'vault', x: 10, y: 14, w: 7, h: 5 },
    ],
    spawnPoints: [{ name: 'player', room: 0 }],
    ...over,
  });

const SIZE = { width: 40, height: 23 };

/** Flood fill from the first walkable cell; returns how many it reaches. */
function reachable(ground: number[][], wall: number): number {
  const h = ground.length;
  const w = ground[0]!.length;
  const start: [number, number] | null = (() => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (ground[y]![x] !== wall) return [x, y];
    return null;
  })();
  if (!start) return 0;
  const seen = new Set<string>([start.join(',')]);
  const queue: [number, number][] = [start];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen.has(key)) continue;
      if (ground[ny]![nx] === wall) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return seen.size;
}

describe('buildWorldGrid', () => {
  it('produces the requested size with ground and decor layers', () => {
    const world = buildWorldGrid(basePlan(), SIZE);
    expect(world.layers.map((l) => l.name)).toEqual(['ground', 'decor']);
    for (const layer of world.layers) {
      expect(layer.data).toHaveLength(SIZE.height);
      expect(layer.data[0]).toHaveLength(SIZE.width);
    }
  });

  it('carves every room as floor', () => {
    const plan = basePlan();
    const { layers } = buildWorldGrid(plan, SIZE);
    const ground = layers[0]!.data;
    for (const room of plan.rooms) {
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          expect(ground[y]![x], `room cell ${x},${y}`).not.toBe(plan.wall);
        }
      }
    }
  });

  it('connects every room — no marooned chambers', () => {
    const plan = basePlan();
    const { layers } = buildWorldGrid(plan, SIZE);
    const ground = layers[0]!.data;
    const walkable = ground.flat().filter((t) => t !== plan.wall).length;
    // One flood fill must cover ALL walkable cells: rooms + corridors.
    expect(reachable(ground, plan.wall)).toBe(walkable);
  });

  it('keeps a wall border around the map', () => {
    const plan = basePlan();
    const { layers } = buildWorldGrid(plan, SIZE);
    const g = layers[0]!.data;
    for (let x = 0; x < SIZE.width; x++) {
      expect(g[0]![x]).toBe(plan.wall);
      expect(g[SIZE.height - 1]![x]).toBe(plan.wall);
    }
    for (let y = 0; y < SIZE.height; y++) {
      expect(g[y]![0]).toBe(plan.wall);
      expect(g[y]![SIZE.width - 1]).toBe(plan.wall);
    }
  });

  it('clamps rooms that fall outside the map instead of throwing', () => {
    const plan = basePlan({
      rooms: [
        { name: 'huge', x: 35, y: 20, w: 30, h: 30, floor: undefined },
        { name: 'ok', x: 4, y: 4, w: 5, h: 5, floor: undefined },
      ],
    } as Partial<WorldPlan>);
    const world = buildWorldGrid(plan, SIZE);
    expect(world.notes.join(' ')).toMatch(/clamped/);
    for (const layer of world.layers) expect(layer.data[0]).toHaveLength(SIZE.width);
  });

  it('places decor only on the surface it targets', () => {
    const plan = basePlan({ decor: [{ tile: 9, density: 0.5, on: 'floor' }] } as Partial<WorldPlan>);
    const { layers } = buildWorldGrid(plan, SIZE);
    const [ground, decor] = [layers[0]!.data, layers[1]!.data];
    let placed = 0;
    for (let y = 0; y < SIZE.height; y++) {
      for (let x = 0; x < SIZE.width; x++) {
        if (decor[y]![x] === -1) continue;
        placed++;
        expect(ground[y]![x], `decor on wall at ${x},${y}`).not.toBe(plan.wall);
      }
    }
    expect(placed).toBeGreaterThan(0);
  });

  it('resolves spawn points to room centres and keeps them clear of decor', () => {
    const plan = basePlan({ decor: [{ tile: 9, density: 0.6, on: 'floor' }] } as Partial<WorldPlan>);
    const world = buildWorldGrid(plan, SIZE);
    expect(world.spawnPoints).toHaveLength(1);
    const spawn = world.spawnPoints[0]!;
    expect(spawn.name).toBe('player');
    const room = plan.rooms[0]!;
    expect(spawn.x).toBeGreaterThanOrEqual(room.x);
    expect(spawn.x).toBeLessThan(room.x + room.w);
    expect(world.layers[1]!.data[spawn.y]![spawn.x]).toBe(-1);
  });

  it('is deterministic for a given seed, and different for another', () => {
    const a = buildWorldGrid(basePlan({ seed: 42 }), SIZE);
    const b = buildWorldGrid(basePlan({ seed: 42 }), SIZE);
    const c = buildWorldGrid(basePlan({ seed: 43, decor: [{ tile: 9, density: 0.3, on: 'floor' }] } as Partial<WorldPlan>), SIZE);
    expect(a.layers).toEqual(b.layers);
    expect(c.layers[1]).not.toEqual(a.layers[1]);
  });
});
