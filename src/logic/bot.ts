import { type GameState, isElevationChanger, type Move } from '../contracts';
import { applyMove, getLegalMoves } from './engine';

/**
 * Verified 19-move sequence for DECK[1..19] starting from DECK[0] at (0, 0).
 * Plays all 20 tiles with 0 discards, completes 3 feature chains,
 * builds both sunken river canyons (L-1) and high hill plateaus (L+1),
 * and showcases meeple placement and scoring.
 */
export const CANONICAL_MOVES: readonly Move[] = [
  // #2 ROAD_CURVE_A
  { x: 1, z: 0, rotation: 1, meeple: { edgeIndex: 3, featureType: 'ROAD' } },
  // #3 CITY_CORNER_A
  { x: 0, z: -1, rotation: 1, meeple: { edgeIndex: 2, featureType: 'CITY' } },
  // #4 GRASS_HILL_A (+2 elevation bonus)
  { x: 0, z: -2, rotation: 0 },
  // #5 WATERFALL_BRIDGE (+2 elevation bonus)
  { x: -1, z: 0, rotation: 0, meeple: { edgeIndex: 2, featureType: 'WATER' } },
  // #6 RIVER_STRAIGHT_LOW (canyon L-1)
  { x: -1, z: 1, rotation: 1 },
  // #7 BRIDGE_FLAT
  { x: -2, z: 0, rotation: 1 },
  // #8 ROAD_STRAIGHT_A
  { x: 1, z: 1, rotation: 0 },
  // #9 CITY_TWO_EDGES_STRAIGHT (Completes 3-tile City [(0,0),(0,-1),(1,-1)])
  { x: 1, z: -1, rotation: 1 },
  // #10 BRIDGE_HILL_A (+2 elevation bonus, climbs to L+1)
  { x: 1, z: 2, rotation: 2 },
  // #11 RIVER_BEND_A
  { x: -2, z: -1, rotation: 2 },
  // #12 CITY_CORNER_B
  { x: 2, z: -1, rotation: 2, meeple: { edgeIndex: 3, featureType: 'CITY' } },
  // #13 ROAD_BRANCH_3WAY (at L+1)
  { x: 1, z: 3, rotation: 1, meeple: { edgeIndex: 2, featureType: 'ROAD' } },
  // #14 RIVER_LAKE_LOW (at L-1)
  { x: -1, z: 2, rotation: 2 },
  // #15 CLOISTER_MEADOW (Completes Road [(1,3),(1,4)])
  { x: 1, z: 4, rotation: 2 },
  // #16 WATERFALL_BEND (+2 elevation bonus)
  { x: -3, z: -1, rotation: 1 },
  // #17 CITY_BIG_3EDGE
  { x: 2, z: -2, rotation: 0 },
  // #18 GRASS_PLATEAU (+2 elevation bonus, high plateau L+1)
  { x: 0, z: -3, rotation: 0 },
  // #19 RIVER_FORK_DELTA
  { x: 2, z: 2, rotation: 0 },
  // #20 CITY_GATE_ROAD (Completes Road [(1,3),(0,3)])
  { x: 0, z: 3, rotation: 3 },
];

export function chooseBotMove(state: GameState): Move | null {
  if (state.gameOver || !state.currentTile) {
    return null;
  }

  const legalMoves = getLegalMoves(state);
  if (legalMoves.length === 0) {
    return null;
  }

  // 1. Prefer canonical script move if legal on the current board
  const canonical = CANONICAL_MOVES[state.deckIndex - 1];
  if (canonical) {
    const match = legalMoves.find(
      (m) => m.x === canonical.x && m.z === canonical.z && m.rotation === canonical.rotation,
    );
    if (match) {
      if (canonical.meeple) {
        const canPlaceMeeple = match.legalMeepleEdges.some(
          (e) =>
            e.edgeIndex === canonical.meeple!.edgeIndex &&
            e.featureType === canonical.meeple!.featureType,
        );
        if (canPlaceMeeple) {
          return {
            x: canonical.x,
            z: canonical.z,
            rotation: canonical.rotation,
            meeple: { ...canonical.meeple },
          };
        }
      }
      return {
        x: canonical.x,
        z: canonical.z,
        rotation: canonical.rotation,
      };
    }
  }

  // 2. Fallback deterministic heuristic
  let bestMove: Move | null = null;
  let bestScore = -Infinity;

  for (const lm of legalMoves) {
    const candidateMeeple =
      lm.legalMeepleEdges.length > 0 && state.players[state.activePlayer].meeplesAvailable > 1
        ? lm.legalMeepleEdges[0]
        : null;

    const candidateMove: Move = {
      x: lm.x,
      z: lm.z,
      rotation: lm.rotation,
      ...(candidateMeeple ? { meeple: candidateMeeple } : {}),
    };

    try {
      const nextState = applyMove(state, candidateMove);
      const scoreGain =
        nextState.players[state.activePlayer].score - state.players[state.activePlayer].score;
      const chainGain = nextState.completedChains - state.completedChains;
      const elevationGain = isElevationChanger(state.currentTile) ? 2 : 0;
      const heuristic =
        scoreGain * 10 +
        chainGain * 25 +
        elevationGain * 5 +
        Math.abs(lm.crownLevel) * 2 +
        lm.legalMeepleEdges.length;

      if (heuristic > bestScore) {
        bestScore = heuristic;
        bestMove = candidateMove;
      }
    } catch {
      // Ignore any invalid simulation
    }
  }

  if (bestMove) {
    return bestMove;
  }

  const first = legalMoves[0];
  return {
    x: first.x,
    z: first.z,
    rotation: first.rotation,
  };
}
