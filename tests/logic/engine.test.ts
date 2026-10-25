import { describe, expect, it } from 'vitest';
import { TILE_BY_ID } from '../../src/contracts';
import {
  applyMove,
  calculateChainPoints,
  CANONICAL_MOVES,
  coordKey,
  createInitialState,
  getLegalMoves,
  getLegalMovesForTile,
  traceFeatureChain,
} from '../../src/logic';

describe('Game Logic Engine', () => {
  it('initializes starter tile START_CITY_ROAD at (0, 0) level 0', () => {
    const state = createInitialState();
    expect(state.deckIndex).toBe(1);
    expect(state.currentTile?.id).toBe('ROAD_CURVE_A');
    expect(state.activePlayer).toBe(1);
    expect(state.players[1].meeplesAvailable).toBe(3);
    expect(state.players[2].meeplesAvailable).toBe(3);

    const start = state.board[coordKey(0, 0)];
    expect(start).toBeDefined();
    expect(start.specId).toBe('START_CITY_ROAD');
    expect(start.level).toBe(0);
    expect(start.crownLevel).toBe(0);
  });

  it('enforces socket matching and level consistency across multiple neighbors', () => {
    let state = createInitialState();
    // Move 1: ROAD_CURVE_A at (1, 0), rot 1
    state = applyMove(state, CANONICAL_MOVES[0]);
    // Move 2: CITY_CORNER_A at (0, -1), rot 1
    state = applyMove(state, CANONICAL_MOVES[1]);

    // Attempting to place GRASS_HILL_A at (1, -1) where W neighbor (0, -1) has E=CITY must be illegal
    const illegalMovesAt1Minus1 = getLegalMoves(state).filter(
      (m) => m.x === 1 && m.z === -1,
    );
    expect(illegalMovesAt1Minus1).toHaveLength(0);

    // Attempting to apply an illegal move throws an error
    expect(() =>
      applyMove(state, { x: 1, z: -1, rotation: 0 }),
    ).toThrow(/Illegal move/);
  });

  it('rejects placements where two neighbors imply conflicting elevation levels', () => {
    const state = createInitialState();
    const grassPlateau = TILE_BY_ID.get('GRASS_PLATEAU')!;
    const startTile = state.board['0,0'];

    // Create a synthetic board where (0,1) is level 0 GRASS on E and (1,2) is level 1 GRASS on N
    const grassHill = TILE_BY_ID.get('GRASS_HILL_A')!;
    const board = {
      '0,0': startTile,
      '0,1': {
        x: 0,
        z: 1,
        specId: grassHill.id,
        spec: grassHill,
        rotation: 2 as const, // N=0, E=0, S=1, W=0
        level: 0,
        crownLevel: 1,
        meeple: null,
        turnPlaced: 1,
      },
      '1,2': {
        x: 1,
        z: 2,
        specId: grassPlateau.id,
        spec: grassPlateau,
        rotation: 0 as const, // all edges +1
        level: 1, // edge height = 2
        crownLevel: 2,
        meeple: null,
        turnPlaced: 2,
      },
    };

    // At (1, 1), W neighbor (0, 1) has E level 0+0=0, while S neighbor (1, 2) has N level 1+1=2.
    // Flat grass tile cannot satisfy both level 0 and level 2 simultaneously.
    const moves = getLegalMovesForTile(board, grassPlateau, 3).filter(
      (m) => m.x === 1 && m.z === 1,
    );
    expect(moves).toHaveLength(0);
  });

  it('prevents meeple placement on an occupied chain while allowing independent features on the same tile', () => {
    let state = createInitialState();
    // Move 1: P1 places meeple on ROAD at (1, 0) edge 3 (connects to (0, 0) E-W road)
    state = applyMove(state, CANONICAL_MOVES[0]);
    // Move 2: P2 places meeple on CITY at (0, -1)
    state = applyMove(state, CANONICAL_MOVES[1]);
    // Move 3: P1 places GRASS_HILL_A at (0, -2)
    state = applyMove(state, CANONICAL_MOVES[2]);

    // Move 4 is WATERFALL_BRIDGE at (-1, 0), rot 0.
    // Its E-W ROAD connects to (0, 0) which connects to (1, 0) where P1 already has a ROAD meeple!
    // So legalMeepleEdges at (-1, 0) rot 0 must NOT include ROAD (edges 1, 3), but MUST include WATER (edges 0, 2).
    const move4Legal = getLegalMoves(state, 0).find((m) => m.x === -1 && m.z === 0);
    expect(move4Legal).toBeDefined();
    const featureTypes = move4Legal!.legalMeepleEdges.map((e) => e.featureType);
    expect(featureTypes).not.toContain('ROAD');
    expect(featureTypes).toContain('WATER');
  });

  it('returns meeples and awards points when a city chain is completed on Move 8', () => {
    let state = createInitialState();
    for (let i = 0; i < 7; i++) {
      state = applyMove(state, CANONICAL_MOVES[i]);
    }

    // Before Move 8 (CITY_TWO_EDGES_STRAIGHT at (1, -1) rot 1):
    // Player 2 has a meeple on (0, -1) CITY and 1 meeple available
    expect(state.board['0,-1'].meeple?.playerId).toBe(2);
    const p2ScoreBefore = state.players[2].score;
    const p2MeeplesBefore = state.players[2].meeplesAvailable;

    // Apply Move 8
    state = applyMove(state, CANONICAL_MOVES[7]);

    // 3-tile city [(0,0), (0,-1), (1,-1)] is completed -> 3 * 2 = 6 pts for Player 2
    expect(state.completedChains).toBe(1);
    expect(state.players[2].score).toBe(p2ScoreBefore + 6);
    expect(state.players[2].meeplesAvailable).toBe(p2MeeplesBefore + 1);
    expect(state.board['0,-1'].meeple).toBeNull();
  });

  it('calculates bridge (+3) and waterfall (+3) bonuses on completed road and water chains', () => {
    let state = createInitialState();
    for (let i = 0; i < 6; i++) {
      state = applyMove(state, CANONICAL_MOVES[i]);
    }

    // Trace the road chain passing through (-1, 0) WATERFALL_BRIDGE and (-2, 0) BRIDGE_FLAT
    const roadChain = traceFeatureChain(state.board, -1, 0, 1);
    expect(roadChain).not.toBeNull();
    // 4 tiles: (-2,0), (-1,0), (0,0), (1,0), with 2 bridge tiles (-2,0 and -1,0)
    // If completed: 1 * 4 + 3 * 2 = 10 pts
    const roadCompletedPts = calculateChainPoints(state.board, roadChain!, true);
    expect(roadCompletedPts).toBe(4 + 6);

    // Trace the canyon water chain starting at (-1, 0) S (dir 2)
    const waterChain = traceFeatureChain(state.board, -1, 0, 2);
    expect(waterChain).not.toBeNull();
    // 2 tiles: (-1,0) WATERFALL_BRIDGE and (-1,1) RIVER_STRAIGHT_LOW, with 1 waterfall tile
    // If completed: 2 * 2 + 3 * 1 = 7 pts
    const waterCompletedPts = calculateChainPoints(state.board, waterChain!, true);
    expect(waterCompletedPts).toBe(4 + 3);
  });
});
