// STUB — owned by Elili. Signatures are the contract; bodies are placeholders.
// Must stay pure: no DOM, no THREE.
import { DECK } from '../contracts/deck';
import type { GameState, LegalPlacement, Move, ScoreEvent } from '../contracts/types';

export function newGame(): GameState {
  return {
    placements: [{ tileId: DECK[0].id, x: 0, y: 0, rotation: 0, level: 0 }],
    players: [
      { id: 0, name: 'Player 1', color: '#1f4e8c', score: 0, meeplesLeft: 3 },
      { id: 1, name: 'Player 2', color: '#c8693a', score: 0, meeplesLeft: 3 },
    ],
    current: 0,
    turn: 1,
    deckIndex: 1,
    phase: 'place',
    log: [],
  };
}

/** Every legal spot for the docked tile (DECK[state.deckIndex]). */
export function legalMoves(_state: GameState): LegalPlacement[] {
  return []; // TODO(logic)
}

/** Returns a new state; never mutates the input. Throws on an illegal move. */
export function applyMove(_state: GameState, _move: Move): { state: GameState; events: ScoreEvent[] } {
  throw new Error('applyMove: not implemented'); // TODO(logic)
}
