import { type GameState } from '../contracts';
import { CANONICAL_MOVES } from './bot';
import { createInitialState, runReplay } from './engine';

export function loadNamedFixture(name: string): GameState {
  if (name === 'initial' || name === 'start') {
    return createInitialState();
  }
  if (name === 'demo-board') {
    return runReplay(CANONICAL_MOVES.slice(0, 15));
  }
  // Default / 'fixture-all-features' runs the full 19-move canonical playthrough
  return runReplay(CANONICAL_MOVES);
}
