import { describe, it, expect, beforeAll } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { REQUIRED_SHOTS } from '../src/contracts';
import {
  createInitialState,
  chooseBotMove,
  applyMove,
  loadNamedFixture,
} from '../src/logic/index';
import { createDioramaRenderer } from '../src/render/index';

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          const c = createCanvas(256, 256) as any;
          c.style = {};
          c.addEventListener = () => {};
          c.removeEventListener = () => {};
          return c;
        }
        return { style: {}, appendChild: () => {}, removeChild: () => {} };
      },
    };
  }
  if (typeof globalThis.window === 'undefined') {
    (globalThis as any).window = {
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
});

describe('Inspector API & 3D Diorama Audit (Prompt 1)', () => {
  it('completes a full 20-tile bot playthrough deterministically', () => {
    let state = createInitialState();
    let safety = 0;
    while (!state.gameOver && state.currentTile && safety < 30) {
      const move = chooseBotMove(state);
      expect(move).not.toBeNull();
      state = applyMove(state, move!);
      safety++;
    }
    expect(state.gameOver).toBe(true);
    expect(Object.keys(state.board).length).toBe(20);
    expect(state.completedChains).toBeGreaterThanOrEqual(3);
  });

  it('loads fixture-all-features, renders inspection timeline (0-12s), captures all 8 required shots, and passes geometry audit', () => {
    const fakeContainer = {
      clientWidth: 1280,
      clientHeight: 720,
      appendChild: () => {},
      removeChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    } as unknown as HTMLElement;

    const renderer = createDioramaRenderer(fakeContainer, {
      inspectMode: true,
      width: 1280,
      height: 720,
    });

    const state = loadNamedFixture('fixture-all-features');
    renderer.syncState(state, []);

    // Deterministic timeline frames: 0-3s (2D), 3-5s (The Rise), 5-9s (Orbit), 9-12s (Macro zoom)
    for (const t of [0, 1.5, 3.0, 3.7, 4.4, 5.0, 7.0, 9.5, 11.2, 12.0]) {
      renderer.renderAt(t);
    }

    const shots = renderer.listShots();
    expect(shots).toEqual([...REQUIRED_SHOTS]);
    for (const shot of shots) {
      const dataUrl = renderer.captureShot(shot);
      expect(dataUrl.startsWith('data:image/png')).toBe(true);
    }

    const report = renderer.audit();
    expect(report.ok).toBe(true);
    expect(report.floatingProps).toBe(0);
    expect(report.missingPolygonOffset).toBe(0);
    expect(report.uvStretchOutliers).toBe(0);
    expect(report.ungroundedMeeples).toBe(0);
    expect(report.waterSeamMismatches).toBe(0);
    expect(report.webglWarnings).toBe(0);

    renderer.dispose();
  });
});
