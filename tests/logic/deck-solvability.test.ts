import { describe, expect, it } from 'vitest';
import { DECK } from '../../src/contracts';
import {
  applyMove,
  CANONICAL_MOVES,
  chooseBotMove,
  createInitialState,
  loadNamedFixture,
  runReplay,
} from '../../src/logic';

describe('20-Tile Deck Solvability Gate', () => {
  it('plays the canonical 20-tile deck to completion with <= 2 discards (0 discards) and >= 3 completed chains', () => {
    expect(DECK).toHaveLength(20);
    expect(CANONICAL_MOVES).toHaveLength(19);

    const finalState = runReplay(CANONICAL_MOVES);

    expect(finalState.gameOver).toBe(true);
    expect(finalState.currentTile).toBeNull();
    expect(finalState.discards).toBeLessThanOrEqual(2);
    expect(finalState.discards).toBe(0);
    expect(Object.keys(finalState.board)).toHaveLength(20);
    expect(finalState.completedChains).toBeGreaterThanOrEqual(3);
  });

  it('branches into both upward hill plateaus (L+1) and downward waterfall canyons (L-1)', () => {
    const finalState = runReplay(CANONICAL_MOVES);
    const placedTiles = Object.values(finalState.board);

    const hasCanyonTile = placedTiles.some((t) => t.level <= -1);
    const hasPlateauTile = placedTiles.some((t) => t.level >= 1 || t.crownLevel >= 1);

    expect(hasCanyonTile).toBe(true);
    expect(hasPlateauTile).toBe(true);

    // Check specific canonical tiles
    expect(finalState.board['-1,1']?.specId).toBe('RIVER_STRAIGHT_LOW');
    expect(finalState.board['-1,1']?.level).toBe(-1);

    expect(finalState.board['1,3']?.specId).toBe('ROAD_BRANCH_3WAY');
    expect(finalState.board['1,3']?.level).toBe(1);

    expect(finalState.board['0,-3']?.specId).toBe('GRASS_PLATEAU');
    expect(finalState.board['0,-3']?.crownLevel).toBe(1);
  });

  it('awards +2 immediate elevation bonuses, completed chain points, and end-game incomplete chain half-points', () => {
    const finalState = runReplay(CANONICAL_MOVES);

    const elevationEvents = finalState.events.filter((e) => e.featureType === 'ELEVATION');
    // 5 elevation changer tiles in DECK: GRASS_HILL_A, WATERFALL_BRIDGE, BRIDGE_HILL_A, WATERFALL_BEND, GRASS_PLATEAU
    expect(elevationEvents).toHaveLength(5);
    for (const ev of elevationEvents) {
      expect(ev.points).toBe(2);
      expect(ev.completed).toBe(true);
    }

    const completedFeatureEvents = finalState.events.filter(
      (e) => e.completed && e.featureType !== 'ELEVATION',
    );
    expect(completedFeatureEvents.length).toBeGreaterThanOrEqual(2);

    const incompleteEvents = finalState.events.filter((e) => !e.completed);
    expect(incompleteEvents.length).toBeGreaterThanOrEqual(3);

    expect(finalState.players[1].score).toBeGreaterThan(0);
    expect(finalState.players[2].score).toBeGreaterThan(0);
  });

  it('completes a full deterministic playthrough via chooseBotMove', () => {
    let state = createInitialState();
    let safety = 0;

    while (!state.gameOver && safety < 30) {
      const move = chooseBotMove(state);
      expect(move).not.toBeNull();
      state = applyMove(state, move!);
      safety += 1;
    }

    expect(state.gameOver).toBe(true);
    expect(state.discards).toBeLessThanOrEqual(2);
    expect(state.completedChains).toBeGreaterThanOrEqual(3);
  });

  it('loads fixture-all-features and demo-board with required features and grounded meeples', () => {
    const allFeatures = loadNamedFixture('fixture-all-features');
    expect(allFeatures.gameOver).toBe(true);
    expect(Object.keys(allFeatures.board)).toHaveLength(20);

    const tiles = Object.values(allFeatures.board);
    expect(tiles.some((t) => t.specId === 'WATERFALL_BRIDGE')).toBe(true);
    expect(tiles.some((t) => t.specId === 'BRIDGE_HILL_A')).toBe(true);
    expect(tiles.some((t) => t.specId === 'GRASS_HILL_A')).toBe(true);
    expect(tiles.some((t) => t.specId === 'CITY_CORNER_A')).toBe(true);
    expect(tiles.some((t) => t.meeple !== null)).toBe(true);

    const demoBoard = loadNamedFixture('demo-board');
    expect(demoBoard.gameOver).toBe(false);
    expect(Object.keys(demoBoard.board)).toHaveLength(16);
  });
});
