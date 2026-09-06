import type { WorldPlan } from './schemas/aiConcepts.js';

/**
 * World Maker v2 — deterministic map building from a small AI plan.
 *
 * The generator owns geometry the same way the sprite pipeline's registration
 * and skeleton code owns geometry: rooms are carved, corridors are guaranteed
 * to connect every room, walls actually enclose the walkable space, and decor
 * only lands where it makes sense. The model contributes intent (where the
 * rooms are, what the roles are, how dense the dressing is), never 900 hand-
 * written tile indices.
 *
 * Pure and seeded: the same plan always produces the same map, which makes it
 * testable and makes "regenerate" mean something predictable.
 */

export interface BuiltLayer {
  name: string;
  /** rows of tile indices, -1 = empty */
  data: number[][];
}

export interface BuiltWorld {
  width: number;
  height: number;
  layers: BuiltLayer[];
  spawnPoints: { name: string; x: number; y: number }[];
  /** Human-readable notes about what the builder had to correct. */
  notes: string[];
}

/** Small deterministic PRNG (mulberry32) — no dependency, stable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function buildWorldGrid(
  plan: WorldPlan,
  size: { width: number; height: number },
): BuiltWorld {
  const { width, height } = size;
  const notes: string[] = [];
  const random = rng(plan.seed ?? 1337);

  // Ground layer starts as solid wall; carving is what creates the space.
  const ground: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => plan.wall),
  );
  const decorData: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => -1),
  );
  /** true where a character can stand — drives corridors, decor and spawns. */
  const walkable: boolean[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );

  const carve = (x: number, y: number, tile: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    ground[y]![x] = tile;
    walkable[y]![x] = true;
  };

  // Rooms are clamped into bounds (a model happily proposes a room at x=38
  // on a 40-wide map) and always keep a one-tile wall margin.
  const rooms = plan.rooms.map((room, i) => {
    const x = clamp(room.x, 1, Math.max(1, width - 3));
    const y = clamp(room.y, 1, Math.max(1, height - 3));
    const w = clamp(room.w, 2, Math.max(2, width - 1 - x));
    const h = clamp(room.h, 2, Math.max(2, height - 1 - y));
    if (w !== room.w || h !== room.h || x !== room.x || y !== room.y) {
      notes.push(`room ${i + 1} was clamped to fit the map`);
    }
    const floor = room.floor ?? plan.ground;
    for (let ry = y; ry < y + h; ry++) {
      for (let rx = x; rx < x + w; rx++) carve(rx, ry, floor);
    }
    return { ...room, x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) };
  });

  // Every room connects to the previous one with an L-shaped corridor, so
  // the map is connected BY CONSTRUCTION — no marooned chambers.
  const half = Math.floor((plan.corridorWidth - 1) / 2);
  const corridor = (x: number, y: number) => {
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) carve(x + dx, y + dy, plan.ground);
    }
  };
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1]!;
    const b = rooms[i]!;
    const horizontalFirst = random() < 0.5;
    const stepX = () => {
      for (let x = Math.min(a.cx, b.cx); x <= Math.max(a.cx, b.cx); x++) {
        corridor(x, horizontalFirst ? a.cy : b.cy);
      }
    };
    const stepY = () => {
      for (let y = Math.min(a.cy, b.cy); y <= Math.max(a.cy, b.cy); y++) {
        corridor(horizontalFirst ? b.cx : a.cx, y);
      }
    };
    if (horizontalFirst) {
      stepX();
      stepY();
    } else {
      stepY();
      stepX();
    }
  }

  // Decor scatters only on cells of the right kind, and never on a spawn.
  for (const rule of plan.decor) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const isFloor = walkable[y]![x]!;
        const eligible = rule.on === 'floor' ? isFloor : !isFloor;
        if (!eligible || random() >= rule.density) continue;
        decorData[y]![x] = rule.tile;
      }
    }
  }

  const spawnPoints = plan.spawnPoints
    .map((sp) => {
      const room = rooms[clamp(sp.room, 0, rooms.length - 1)];
      if (!room) return null;
      // Keep the spawn tile clear of dressing.
      decorData[room.cy]![room.cx] = -1;
      return { name: sp.name, x: room.cx, y: room.cy };
    })
    .filter((s): s is { name: string; x: number; y: number } => s !== null);

  const walkableCount = walkable.flat().filter(Boolean).length;
  if (walkableCount < width * height * 0.05) {
    notes.push('the plan carved very little walkable space — try larger rooms');
  }

  return {
    width,
    height,
    layers: [
      { name: 'ground', data: ground },
      { name: 'decor', data: decorData },
    ],
    spawnPoints,
    notes,
  };
}
