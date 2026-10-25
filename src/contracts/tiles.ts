// Pure geometry helpers shared by logic and render. No THREE imports.
import { getTile } from './deck';
import type { Dir, Placement, Rotation, Side } from './types';

/** World units per grid cell, and world height per elevation level. */
export const TILE_SIZE = 1;
export const LEVEL_HEIGHT = 0.5;

export const DIR_OFFSETS: Record<Dir, { dx: number; dy: number }> = {
  0: { dx: 0, dy: -1 },
  1: { dx: 1, dy: 0 },
  2: { dx: 0, dy: 1 },
  3: { dx: -1, dy: 0 },
};

export const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir;

/** Map a direction in the unrotated tile frame to the board frame. */
export const rotateDir = (d: Dir, r: Rotation): Dir => ((d + r) % 4) as Dir;

const FLAT = [0, 0, 0, 0] as const;

/** Rotate a [N, E, S, W] array by r clockwise quarter turns. */
function rotate<T>(arr: readonly T[], r: Rotation): [T, T, T, T] {
  return [0, 1, 2, 3].map((d) => arr[(d - r + 4) % 4]) as [T, T, T, T];
}

/** The tile's sides as they sit on the board after rotation, in [N, E, S, W] order. */
export function rotatedSides(tileId: string, r: Rotation): [Side, Side, Side, Side] {
  return rotate(getTile(tileId).sides, r);
}

/** The tile's per-edge level steps after rotation, in [N, E, S, W] order. */
export function rotatedHeights(tileId: string, r: Rotation): [number, number, number, number] {
  return rotate(getTile(tileId).heights ?? FLAT, r);
}

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
