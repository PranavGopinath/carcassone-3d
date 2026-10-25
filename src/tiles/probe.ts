import {
  DirIndex,
  EdgeType,
  getRotatedEdges,
  PALETTE,
  PaletteClass,
  RGB,
  Rotation,
  TileSpec,
} from '../contracts';

export interface SocketProbeFailure {
  location: string;
  x: number;
  y: number;
  expected: PaletteClass;
  actual: PaletteClass;
  rgb: RGB;
}

export interface SocketProbeResult {
  ok: boolean;
  rotatedEdges: [EdgeType, EdgeType, EdgeType, EdgeType];
  detectedEdges: [PaletteClass, PaletteClass, PaletteClass, PaletteClass];
  cornerClasses: [PaletteClass, PaletteClass, PaletteClass, PaletteClass];
  failures: SocketProbeFailure[];
}

export interface SeamSampleDiff {
  t: number;
  rgbA: RGB;
  rgbB: RGB;
  delta: number;
}

export interface SeamProbeResult {
  ok: boolean;
  maxDelta: number;
  samples: SeamSampleDiff[];
}

const PALETTE_ENTRIES = Object.entries(PALETTE) as Array<[PaletteClass, RGB]>;

/**
 * Classifies an RGB pixel to the nearest canonical PALETTE class using Euclidean RGB distance.
 */
export function classifyPixel(r: number, g: number, b: number): PaletteClass {
  let bestClass: PaletteClass = 'GRASS';
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (const [cls, target] of PALETTE_ENTRIES) {
    const dr = r - target.r;
    const dg = g - target.g;
    const db = b - target.b;
    const distSq = dr * dr + dg * dg + db * db;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestClass = cls;
    }
  }

  return bestClass;
}

/**
 * Reads a single pixel's RGB values from a 2D canvas context.
 */
export function getPixelRGB(ctx: CanvasRenderingContext2D, x: number, y: number, size = 256): RGB {
  const cx = Math.max(0, Math.min(size - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(size - 1, Math.round(y)));
  const data = ctx.getImageData(cx, cy, 1, 1).data;
  return { r: data[0], g: data[1], b: data[2] };
}

/**
 * Computes pixel coordinates (x, y) for a point along side `side` (0=N, 1=E, 2=S, 3=W)
 * at parameter `t` in [0, 1] and `inset` pixels from the outer border.
 *
 * Parameterization:
 * - N (0) & S (2): t goes from West (x=0) to East (x=size-1) so opposite horizontal seams align at equal t.
 * - E (1) & W (3): t goes from North (y=0) to South (y=size-1) so opposite vertical seams align at equal t.
 */
export function getEdgeSampleCoords(
  side: DirIndex,
  t: number,
  inset: number,
  size = 256
): { x: number; y: number } {
  const span = Math.round(t * (size - 1));
  switch (side) {
    case 0: // North
      return { x: span, y: inset };
    case 1: // East
      return { x: size - 1 - inset, y: span };
    case 2: // South
      return { x: span, y: size - 1 - inset };
    case 3: // West
      return { x: inset, y: span };
  }
}

/**
 * Probes all 4 edges and 4 corners of a painted tile canvas to verify the Edge-First Socket Contract.
 */
export function probeTileSockets(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  rotation: Rotation,
  size = 256
): SocketProbeResult {
  const rotatedEdges = getRotatedEdges(spec, rotation);
  const failures: SocketProbeFailure[] = [];
  const edgeInset = 3;

  const checkPoint = (location: string, x: number, y: number, expected: PaletteClass): PaletteClass => {
    const rgb = getPixelRGB(ctx, x, y, size);
    const actual = classifyPixel(rgb.r, rgb.g, rgb.b);
    if (actual !== expected) {
      failures.push({ location, x, y, expected, actual, rgb });
    }
    return actual;
  };

  const detectedEdges: [PaletteClass, PaletteClass, PaletteClass, PaletteClass] = [
    'GRASS',
    'GRASS',
    'GRASS',
    'GRASS',
  ];

  const sideNames = ['N', 'E', 'S', 'W'] as const;

  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    const edgeType = rotatedEdges[s];
    const sideName = sideNames[s];

    // Always classify midpoint t=0.5 for detectedEdges
    const midPt = getEdgeSampleCoords(s, 0.5, edgeInset, size);
    const midRgb = getPixelRGB(ctx, midPt.x, midPt.y, size);
    detectedEdges[s] = classifyPixel(midRgb.r, midRgb.g, midRgb.b);

    if (edgeType === 'ROAD') {
      const pMid = getEdgeSampleCoords(s, 0.5, edgeInset, size);
      checkPoint(`${sideName}@0.5`, pMid.x, pMid.y, 'ROAD');
      const pLeft = getEdgeSampleCoords(s, 0.1, edgeInset, size);
      checkPoint(`${sideName}@0.1`, pLeft.x, pLeft.y, 'GRASS');
      const pRight = getEdgeSampleCoords(s, 0.9, edgeInset, size);
      checkPoint(`${sideName}@0.9`, pRight.x, pRight.y, 'GRASS');
    } else if (edgeType === 'WATER') {
      const pMid = getEdgeSampleCoords(s, 0.5, edgeInset, size);
      checkPoint(`${sideName}@0.5`, pMid.x, pMid.y, 'WATER');
      const pLeft = getEdgeSampleCoords(s, 0.1, edgeInset, size);
      checkPoint(`${sideName}@0.1`, pLeft.x, pLeft.y, 'GRASS');
      const pRight = getEdgeSampleCoords(s, 0.9, edgeInset, size);
      checkPoint(`${sideName}@0.9`, pRight.x, pRight.y, 'GRASS');
    } else if (edgeType === 'CITY') {
      for (const t of [0.15, 0.5, 0.85]) {
        const pt = getEdgeSampleCoords(s, t, edgeInset, size);
        checkPoint(`${sideName}@${t}`, pt.x, pt.y, 'CITY');
      }
    } else {
      // GRASS
      for (const t of [0.1, 0.5, 0.9]) {
        const pt = getEdgeSampleCoords(s, t, edgeInset, size);
        checkPoint(`${sideName}@${t}`, pt.x, pt.y, 'GRASS');
      }
    }
  }

  // Check all 4 corners at inset = 4px:
  // Order: [NW (W&N), NE (N&E), SE (E&S), SW (S&W)]
  const cornerInset = 4;
  const corners: Array<{
    name: string;
    x: number;
    y: number;
    adjA: DirIndex;
    adjB: DirIndex;
  }> = [
    { name: 'NW', x: cornerInset, y: cornerInset, adjA: 3, adjB: 0 },
    { name: 'NE', x: size - 1 - cornerInset, y: cornerInset, adjA: 0, adjB: 1 },
    { name: 'SE', x: size - 1 - cornerInset, y: size - 1 - cornerInset, adjA: 1, adjB: 2 },
    { name: 'SW', x: cornerInset, y: size - 1 - cornerInset, adjA: 2, adjB: 3 },
  ];

  const cornerClasses: [PaletteClass, PaletteClass, PaletteClass, PaletteClass] = [
    'GRASS',
    'GRASS',
    'GRASS',
    'GRASS',
  ];

  corners.forEach((corner, idx) => {
    const bothCity = rotatedEdges[corner.adjA] === 'CITY' && rotatedEdges[corner.adjB] === 'CITY';
    const expected: PaletteClass = bothCity ? 'CITY' : 'GRASS';
    cornerClasses[idx] = checkPoint(`Corner:${corner.name}`, corner.x, corner.y, expected);
  });

  return {
    ok: failures.length === 0,
    rotatedEdges,
    detectedEdges,
    cornerClasses,
    failures,
  };
}

const SEAM_SAMPLE_TS = [0.1, 0.2, 0.35, 0.45, 0.55, 0.65, 0.8, 0.9] as const;

/**
 * Samples 8 points along `sideA` of `ctxA` and `sideB` of `ctxB` at `inset = 2px`
 * and verifies that RGB values stitch within tolerance (`maxDelta <= 18`).
 */
export function probeSeamStitch(
  ctxA: CanvasRenderingContext2D,
  sideA: DirIndex,
  ctxB: CanvasRenderingContext2D,
  sideB: DirIndex,
  size = 256
): SeamProbeResult {
  const seamInset = 2;
  const samples: SeamSampleDiff[] = [];
  let maxDelta = 0;

  for (const t of SEAM_SAMPLE_TS) {
    const ptA = getEdgeSampleCoords(sideA, t, seamInset, size);
    const ptB = getEdgeSampleCoords(sideB, t, seamInset, size);
    const rgbA = getPixelRGB(ctxA, ptA.x, ptA.y, size);
    const rgbB = getPixelRGB(ctxB, ptB.x, ptB.y, size);

    const delta = Math.hypot(rgbA.r - rgbB.r, rgbA.g - rgbB.g, rgbA.b - rgbB.b);
    if (delta > maxDelta) {
      maxDelta = delta;
    }
    samples.push({ t, rgbA, rgbB, delta });
  }

  return {
    ok: maxDelta <= 18,
    maxDelta,
    samples,
  };
}
