import { type GameState } from '../contracts';
import { CANONICAL_MOVES } from './bot';
import { createInitialState, runReplay } from './engine';

export function loadNamedFixture(name: string): GameState {
  if (name === 'initial' || name === 'start') {
    return createInitialState();
  }
  if (name === 'fixture-midgame') {
    return runReplay(CANONICAL_MOVES.slice(0, 11));
  }
  if (name === 'demo-board') {
    return runReplay(CANONICAL_MOVES.slice(0, 15));
  }
  if (name === 'fixture-all-features') {
    return runReplay(CANONICAL_MOVES);
  }
  throw new Error(`Unknown fixture name: '${name}'`);
}
