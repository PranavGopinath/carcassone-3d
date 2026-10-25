import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/demo-board.json';
import { DECK, getTile } from '../src/contracts/deck';
import { DIRS, DIR_OFFSETS, FEATURE_SIDE, edgesMatch, rotatedHeights } from '../src/contracts/tiles';
import type { GameState } from '../src/contracts/types';

describe('deck', () => {
  it('has 20 uniquely-identified tiles', () => {
    expect(DECK).toHaveLength(20);
    expect(new Set(DECK.map((t) => t.id)).size).toBe(20);
  });

  it('every feature sits on sides of its own type, and every non-grass side has a feature', () => {
    for (const tile of DECK) {
      const covered = new Set<number>();
      for (const f of tile.features) {
        for (const d of f.sides) {
          expect(tile.sides[d], `${tile.id}.${f.id}`).toBe(FEATURE_SIDE[f.kind]);
          covered.add(d);
        }
      }
      tile.sides.forEach((side, d) => {
        if (side !== 'GRASS') expect(covered.has(d), `${tile.id} edge ${d}`).toBe(true);
      });
    }
  });

  it('only waterfalls change height', () => {
    for (const tile of DECK) {
      if (tile.heights) expect(tile.special, tile.id).toBe('WATERFALL');
    }
  });

  it('rotation moves heights clockwise', () => {
    // WATERFALL_1 drops on S; one turn clockwise puts the drop on W.
    expect(rotatedHeights('WATERFALL_1', 1)).toEqual([0, 0, 0, -1]);
  });
});

describe('demo-board fixture', () => {
  const state = fixture as unknown as GameState;
  const at = new Map(state.placements.map((p) => [`${p.x},${p.y}`, p]));

  it('uses each tile at most once', () => {
    const ids = state.placements.map((p) => p.tileId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('obeys the edge type + height rule everywhere', () => {
    for (const p of state.placements) {
      for (const d of DIRS) {
        const { dx, dy } = DIR_OFFSETS[d];
        const n = at.get(`${p.x + dx},${p.y + dy}`);
        if (n) expect(edgesMatch(p, n, d), `${p.tileId} -> ${n.tileId} dir ${d}`).toBe(true);
      }
    }
  });

  it('meeples reference real features', () => {
    for (const p of state.placements) {
      if (p.meeple) expect(getTile(p.tileId).features.map((f) => f.id)).toContain(p.meeple.featureId);
    }
  });
});
