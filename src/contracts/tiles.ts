// Pure geometry helpers shared by logic and render. No THREE imports.
import { DECK } from './deck';
import type { Dir, FeatureKind, Placement, Rotation, Side } from './types';

/** World units per grid cell, and world height per elevation level. */
export const TILE_SIZE = 1;
export const LEVEL_HEIGHT = 0.5;

export const DIRS: readonly Dir[] = [0, 1, 2, 3];

export const DIR_OFFSETS: Record<Dir, { dx: number; dy: number }> = {
  0: { dx: 0, dy: -1 },
  1: { dx: 1, dy: 0 },
  2: { dx: 0, dy: 1 },
  3: { dx: -1, dy: 0 },
};

export const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir;

/** Map a direction in the unrotated tile frame to the board frame. */
export const rotateDir = (d: Dir, r: Rotation): Dir => ((d + r) % 4) as Dir;

/** Which side type each feature kind runs along. */
export const FEATURE_SIDE: Record<FeatureKind, Side> = { CITY: 'CITY', ROAD: 'ROAD', RIVER: 'WATER' };

type Four<T> = readonly [T, T, T, T];

/** Rotate a [N, E, S, W] array by r clockwise quarter turns. */
const rotate = <T>(arr: readonly T[], r: number): Four<T> =>
  DIRS.map((d) => arr[(d - r + 4) % 4]) as unknown as Four<T>;

// Every tile in all 4 rotations, built once: legalMoves calls these in a tight loop.
const ROTATIONS = new Map(
  DECK.map((t) => [
    t.id,
    DIRS.map((r) => ({ sides: rotate(t.sides, r), heights: rotate(t.heights ?? [0, 0, 0, 0], r) })),
  ]),
);

function rotated(tileId: string, r: Rotation) {
  const table = ROTATIONS.get(tileId);
  if (!table) throw new Error(`Unknown tile id: ${tileId}`);
  return table[r];
}

/** The tile's sides as they sit on the board after rotation, in [N, E, S, W] order. */
export const rotatedSides = (tileId: string, r: Rotation): Four<Side> => rotated(tileId, r).sides;

/** The tile's per-edge level steps after rotation, in [N, E, S, W] order. */
export const rotatedHeights = (tileId: string, r: Rotation): Four<number> => rotated(tileId, r).heights;

/** Absolute height of a placed tile's edge on the board. */
export function edgeHeight(p: Placement, boardDir: Dir): number {
  return p.level + rotatedHeights(p.tileId, p.rotation)[boardDir];
}

/** The single adjacency rule: same side type and same absolute height. */
export function edgesMatch(a: Placement, b: Placement, dirFromA: Dir): boolean {
  const back = opposite(dirFromA);
  return (
    rotatedSides(a.tileId, a.rotation)[dirFromA] === rotatedSides(b.tileId, b.rotation)[back] &&
    edgeHeight(a, dirFromA) === edgeHeight(b, back)
  );
}

/** Grid + level to world-space position of the tile's base centre (+y up). */
export function toWorld(x: number, y: number, level: number): { x: number; y: number; z: number } {
  return { x: x * TILE_SIZE, y: level * LEVEL_HEIGHT, z: y * TILE_SIZE };
}
