/**
 * Tile Family Elevation & Seam Contract Implementation
 * Owned by: tile_family_worker (`src/tiles/families/index.ts`)
 */

import {
  DirIndex,
  LEVEL_HEIGHT,
  Rotation,
  TileSpec,
  getRotatedEdgeLevels,
  getRotatedEdges,
} from '../../contracts';

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function getEdgeProfile(t: number, lvlCurr: number, lvlStart: number, lvlEnd: number): number {
  const hCurr = lvlCurr * LEVEL_HEIGHT;
  const hStart = Math.max(lvlCurr, lvlStart) * LEVEL_HEIGHT;
  const hEnd = Math.max(lvlCurr, lvlEnd) * LEVEL_HEIGHT;

  if (t < 0.25) {
    const w = smoothstep(t / 0.25);
    return (1 - w) * hStart + w * hCurr;
  } else if (t > 0.75) {
    const w = smoothstep((1 - t) / 0.25);
    return (1 - w) * hEnd + w * hCurr;
  } else {
    return hCurr;
  }
}

/**
 * Computes base local terrain surface height at relative tile coordinates (u, v).
 *
 * u: [0, 1] West (0) to East (1)
 * v: [0, 1] North (0) to South (1)
 *
 * SEAM INVARIANT:
 * Along each of the 4 boundaries (v=0, u=1, v=1, u=0), for 0.25 <= t <= 0.75,
 * tileHeight equals rotatedEdgeLevels[side] * LEVEL_HEIGHT.
 */
export function tileHeight(spec: TileSpec, rotation: Rotation, u: number, v: number): number {
  const cu = Math.max(0, Math.min(1, u));
  const cv = Math.max(0, Math.min(1, v));

  const [lvlN, lvlE, lvlS, lvlW] = getRotatedEdgeLevels(spec, rotation);

  // Uniform level tiles (e.g. flat [0,0,0,0] or plateau [1,1,1,1])
  if (lvlN === lvlE && lvlE === lvlS && lvlS === lvlW) {
    return lvlN * LEVEL_HEIGHT;
  }

  // Corner heights
  const CNW = Math.max(lvlN, lvlW) * LEVEL_HEIGHT;
  const CNE = Math.max(lvlN, lvlE) * LEVEL_HEIGHT;
  const CSW = Math.max(lvlS, lvlW) * LEVEL_HEIGHT;
  const CSE = Math.max(lvlS, lvlE) * LEVEL_HEIGHT;

  // Interior blending factors
  let su = smoothstep(cu);
  let sv = smoothstep(cv);

  // Custom curves for cliff drops (waterfalls) and terraced ramps (hills)
  if (lvlN < 0 || lvlE < 0 || lvlS < 0 || lvlW < 0) {
    if (lvlS < 0) {
      sv = smoothstep(Math.max(0, Math.min(1, (cv - 0.4) / 0.45)));
    } else if (lvlN < 0) {
      sv = 1 - smoothstep(Math.max(0, Math.min(1, ((1 - cv) - 0.4) / 0.45)));
    }
    if (lvlE < 0) {
      su = smoothstep(Math.max(0, Math.min(1, (cu - 0.4) / 0.45)));
    } else if (lvlW < 0) {
      su = 1 - smoothstep(Math.max(0, Math.min(1, ((1 - cu) - 0.4) / 0.45)));
    }
  } else if (lvlN > 0 || lvlE > 0 || lvlS > 0 || lvlW > 0) {
    if (lvlN > 0 && lvlS === 0) {
      sv = smoothstep(Math.max(0, Math.min(1, (cv - 0.15) / 0.7)));
    } else if (lvlS > 0 && lvlN === 0) {
      sv = 1 - smoothstep(Math.max(0, Math.min(1, ((1 - cv) - 0.15) / 0.7)));
    }
    if (lvlW > 0 && lvlE === 0) {
      su = 1 - smoothstep(Math.max(0, Math.min(1, ((1 - cu) - 0.15) / 0.7)));
    } else if (lvlE > 0 && lvlW === 0) {
      su = smoothstep(Math.max(0, Math.min(1, (cu - 0.15) / 0.7)));
    }
  }

  // Base interior surface from corner levels using interior factors su, sv
  const Hbase = (1 - su) * (1 - sv) * CNW + su * (1 - sv) * CNE + (1 - su) * sv * CSW + su * sv * CSE;

  // Target edge boundary profiles
  const HNtarget = getEdgeProfile(cu, lvlN, lvlW, lvlE);
  const HEtarget = getEdgeProfile(cv, lvlE, lvlN, lvlS);
  const HStarget = getEdgeProfile(cu, lvlS, lvlW, lvlE);
  const HWtarget = getEdgeProfile(cv, lvlW, lvlN, lvlS);

  // Boundary corrections matching Hbase on boundaries
  const deltaN = HNtarget - ((1 - su) * CNW + su * CNE);
  const deltaE = HEtarget - ((1 - sv) * CNE + sv * CSE);
  const deltaS = HStarget - ((1 - su) * CSW + su * CSE);
  const deltaW = HWtarget - ((1 - sv) * CNW + sv * CSW);

  const wN = cv < 0.25 ? 1 - smoothstep(cv / 0.25) : 0;
  const wE = cu > 0.75 ? 1 - smoothstep((1 - cu) / 0.25) : 0;
  const wS = cv > 0.75 ? 1 - smoothstep((1 - cv) / 0.25) : 0;
  const wW = cu < 0.25 ? 1 - smoothstep(cu / 0.25) : 0;

  return Hbase + wN * deltaN + wE * deltaE + wS * deltaS + wW * deltaW;
}

/**
 * Returns the world height at an edge boundary given a tile's placed base level.
 */
export function getEdgeWorldHeight(
  placedLevel: number,
  spec: TileSpec,
  rotation: Rotation,
  side: DirIndex
): number {
  const edgeLevels = getRotatedEdgeLevels(spec, rotation);
  return (placedLevel + edgeLevels[side]) * LEVEL_HEIGHT;
}

/**
 * Returns the world elevation for props / features on the base terrain at relative tile coordinates (u, v).
 */
export function getPropElevation(
  placedLevel: number,
  spec: TileSpec,
  rotation: Rotation,
  u: number,
  v: number
): number {
  return placedLevel * LEVEL_HEIGHT + tileHeight(spec, rotation, u, v);
}

/**
 * Returns the elevated deck height for bridge arches on BRIDGE_FLAT, BRIDGE_HILL, WATERFALL_BRIDGE.
 * Lifts the bridge arch 0.14 units above base terrain at center (u=0.5, v=0.5).
 */
export function getBridgeDeckHeight(
  placedLevel: number,
  spec: TileSpec,
  rotation: Rotation,
  u: number,
  v: number
): number {
  const base = getPropElevation(placedLevel, spec, rotation, u, v);
  const isBridgeSpecial =
    spec.special === 'BRIDGE_FLAT' ||
    spec.special === 'BRIDGE_HILL' ||
    spec.special === 'WATERFALL_BRIDGE';

  if (!isBridgeSpecial) {
    return base;
  }

  const rotatedEdges = getRotatedEdges(spec, rotation);
  const isNS = rotatedEdges[0] === 'ROAD' && rotatedEdges[2] === 'ROAD';

  const cu = Math.max(0, Math.min(1, u));
  const cv = Math.max(0, Math.min(1, v));

  let archFactor = 0;
  if (isNS) {
    const lengthFactor = Math.sin(Math.PI * cv);
    const widthFactor = Math.max(0, 1 - 4 * (cu - 0.5) * (cu - 0.5));
    archFactor = lengthFactor * widthFactor;
  } else {
    const lengthFactor = Math.sin(Math.PI * cu);
    const widthFactor = Math.max(0, 1 - 4 * (cv - 0.5) * (cv - 0.5));
    archFactor = lengthFactor * widthFactor;
  }

  return base + 0.14 * archFactor;
}
