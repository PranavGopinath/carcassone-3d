import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  DECK,
  DIR_OFFSETS,
  DirIndex,
  getRotatedEdges,
  Rotation,
  TileSpec,
} from '../../src/contracts';
import { createTileSheet, paintTile } from '../../src/tiles/painter';
import { classifyPixel, probeSeamStitch, probeTileSockets } from '../../src/tiles/probe';

const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];
const TILE_SIZE = 256;

interface RenderedTileEntry {
  spec: TileSpec;
  rotation: Rotation;
  ctx: CanvasRenderingContext2D;
  edges: [string, string, string, string];
}

describe('Procedural Tile Painter & Socket Probes', () => {
  // Pre-render all 20 tiles x 4 rotations = 80 tile instances once for fast, exhaustive testing
  const rendered: RenderedTileEntry[] = [];

  for (const spec of DECK) {
    for (const rotation of ROTATIONS) {
      const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      paintTile(ctx, spec, rotation, TILE_SIZE);
      rendered.push({
        spec,
        rotation,
        ctx,
        edges: getRotatedEdges(spec, rotation),
      });
    }
  }

  it('classifies canonical PALETTE colors accurately via classifyPixel', () => {
    expect(classifyPixel(108, 166, 76)).toBe('GRASS');
    expect(classifyPixel(214, 196, 156)).toBe('ROAD');
    expect(classifyPixel(196, 138, 92)).toBe('CITY');
    expect(classifyPixel(62, 142, 208)).toBe('WATER');
  });

  it('passes probeTileSockets for all 20 tiles across all 4 rotations (80 tile-rotations)', () => {
    expect(rendered.length).toBe(80);

    for (const entry of rendered) {
      const result = probeTileSockets(entry.ctx, entry.spec, entry.rotation, TILE_SIZE);
      if (!result.ok) {
        throw new Error(
          `Socket probe failed for ${entry.spec.id} (rot=${entry.rotation}): ${JSON.stringify(result.failures)}`
        );
      }
      expect(result.ok).toBe(true);
      expect(result.failures).toHaveLength(0);
    }
  });

  it('satisfies rotation invariance for all 20 tiles across all 4 rotations', () => {
    for (const spec of DECK) {
      const baseEdges = spec.edges;
      for (const r of ROTATIONS) {
        const entry = rendered.find((e) => e.spec.id === spec.id && e.rotation === r)!;
        const probe = probeTileSockets(entry.ctx, spec, r, TILE_SIZE);
        const expectedRotated = getRotatedEdges(spec, r);

        // Verify detected edge midpoints match rotated spec edges
        expect(probe.detectedEdges).toEqual(expectedRotated);

        // Verify each direction s matches baseEdges[(s - r + 4) % 4]
        for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
          expect(probe.detectedEdges[s]).toBe(baseEdges[(s - r + 4) % 4]);
        }

        // Verify corners are CITY iff both adjacent rotated edges are CITY
        const expectedCorners = [
          expectedRotated[3] === 'CITY' && expectedRotated[0] === 'CITY' ? 'CITY' : 'GRASS',
          expectedRotated[0] === 'CITY' && expectedRotated[1] === 'CITY' ? 'CITY' : 'GRASS',
          expectedRotated[1] === 'CITY' && expectedRotated[2] === 'CITY' ? 'CITY' : 'GRASS',
          expectedRotated[2] === 'CITY' && expectedRotated[3] === 'CITY' ? 'CITY' : 'GRASS',
        ];
        expect(probe.cornerClasses).toEqual(expectedCorners);
      }
    }
  });

  it('passes probeSeamStitch for every legal edge-to-edge pairing across the 80 tile-rotations', () => {
    let pairCount = 0;

    for (let i = 0; i < rendered.length; i++) {
      const tileA = rendered[i];
      for (let j = i; j < rendered.length; j++) {
        const tileB = rendered[j];

        for (const dirInfo of DIR_OFFSETS) {
          const sideA = dirInfo.dir;
          const sideB = dirInfo.opposite;

          if (tileA.edges[sideA] === tileB.edges[sideB]) {
            const stitch = probeSeamStitch(tileA.ctx, sideA, tileB.ctx, sideB, TILE_SIZE);
            pairCount++;
            if (!stitch.ok) {
              throw new Error(
                `Seam stitch failed between ${tileA.spec.id}(rot=${tileA.rotation}, side=${dirInfo.name}) and ` +
                  `${tileB.spec.id}(rot=${tileB.rotation}, side=${DIR_OFFSETS[sideB].name}) ` +
                  `for edge type ${tileA.edges[sideA]}: maxDelta=${stitch.maxDelta}`
              );
            }
            expect(stitch.ok).toBe(true);
            expect(stitch.maxDelta).toBeLessThanOrEqual(18);
          }
        }
      }
    }

    expect(pairCount).toBeGreaterThan(1000);
  });

  it('renders a complete 20x4 tile sheet via createTileSheet', () => {
    const sheet = createTileSheet((w, h) => createCanvas(w, h), 64);
    expect(sheet.width).toBeGreaterThan(256);
    expect(sheet.height).toBeGreaterThan(1000);
  });
});
