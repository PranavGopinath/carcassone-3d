// window.__game: the stable debug surface used by Playwright, the demo, and the audit loop.
import type { ClockMode, FrameManifest, InspectionSegment, Quality, Theme, View } from './renderer';
import type { GameState, LegalPlacement, Move } from './types';

export interface GameApi {
  /** Resolves once the renderer is mounted and the first frame is drawn. */
  ready: Promise<void>;

  // Game (owned by logic/UI)
  getState(): GameState;
  getLegalMoves(): LegalPlacement[];
  applyMove(move: Move): GameState;
  runReplay(moves: Move[]): GameState;
  /** Replace the whole state, e.g. with a fixture. Skips rules validation. */
  loadState(state: GameState): void;
  startDemo(): Promise<void>;

  // View (owned by render)
  setView(view: View, opts?: { instant?: boolean }): Promise<void>;
  setTheme(theme: Theme): void;
  setQuality(quality: Quality): void;

  // Inspection (owned by render, consumed by scripts/)
  setClockMode(mode: ClockMode): void;
  renderFrame(tMs: number): void;
  getManifest(): FrameManifest;
  getInspectionSegments(): InspectionSegment[];
  /** Realtime 12 s flight; resolves when finished. For frame-exact capture use manual clock + renderFrame. */
  startInspectionFlight(): Promise<void>;
}

/**
 * URL params the app honours:
 *   ?fixture=<name>   load fixtures/<name>.json instead of a new game
 *   ?tile=<TILE_ID>   workbench: render one tile alone on a turntable
 *   ?clock=manual     start with the manual clock
 */
export const TEST_IDS = {
  viewToggle: 'view-toggle',
  demoButton: 'demo-button',
  turnIndicator: 'turn-indicator',
  rotateTile: 'rotate-tile',
  tileDock: 'tile-dock',
  scorePanel: 'score-panel',
} as const;

declare global {
  interface Window {
    __game: GameApi;
  }
}
