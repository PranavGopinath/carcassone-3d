// Wiring only: builds window.__game from the engine and renderer. Keep this file small.
import { DECK, getTile } from './contracts/deck';
import type { GameApi } from './contracts/game-api';
import { INSPECTION_SEGMENTS, type Renderer } from './contracts/renderer';
import type { GameState, Move } from './contracts/types';
import * as engine from './logic/engine';
import { StubRenderer } from './render/stub-renderer';

const fixtures = import.meta.glob<GameState>('../fixtures/*.json', { import: 'default' });

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const renderer: Renderer = new StubRenderer();
  renderer.mount(document.getElementById('scene') as HTMLCanvasElement);

  let state = engine.newGame();
  const fixtureName = params.get('fixture');
  if (fixtureName) {
    const load = fixtures[`../fixtures/${fixtureName}.json`];
    if (!load) throw new Error(`Unknown fixture: ${fixtureName}`);
    state = structuredClone(await load());
  }
  const tileParam = params.get('tile');
  if (tileParam) {
    getTile(tileParam); // validate early
    // Workbench: one tile alone with nothing in the dock, so no ghost spots.
    state = {
      ...state,
      placements: [{ tileId: tileParam, x: 0, y: 0, rotation: 0, level: 0 }],
      deckIndex: DECK.length,
    };
  }

  const setState = (next: GameState) => {
    state = next;
    renderer.sync(state);
    renderer.setGhosts(state.deckIndex < DECK.length ? engine.legalMoves(state) : []);
  };

  const applyMove = (move: Move) => {
    setState(engine.applyMove(state, move).state);
    return state;
  };

  const api: GameApi = {
    ready: Promise.resolve(),
    getState: () => state,
    getLegalMoves: () => engine.legalMoves(state),
    applyMove,
    runReplay: (moves) => {
      // Fold first, render once; an illegal move throws before any state is replaced.
      setState(moves.reduce((s, m) => engine.applyMove(s, m).state, engine.newGame()));
      return state;
    },
    loadState: setState,
    startDemo: async () => {
      throw new Error('startDemo: not implemented'); // TODO(bot)
    },
    setView: (view, opts) => renderer.setView(view, opts),
    setTheme: (t) => renderer.setTheme(t),
    setQuality: (q) => renderer.setQuality(q),
    setClockMode: (m) => renderer.setClockMode(m),
    renderFrame: (t) => renderer.renderFrame(t),
    getManifest: () => renderer.getManifest(),
    getInspectionSegments: () => INSPECTION_SEGMENTS,
    startInspectionFlight: () => renderer.startInspectionFlight(),
  };

  if (params.get('clock') === 'manual') renderer.setClockMode('manual');
  setState(state);
  if (tileParam || fixtureName) await renderer.setView('3d', { instant: true });
  renderer.renderFrame(0); // `ready` promises a drawn frame, even with the manual clock
  window.__game = api;
}

boot().catch((err) => {
  console.error(err);
  document.body.dataset.bootError = String(err);
});
