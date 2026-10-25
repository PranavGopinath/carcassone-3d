import {
  DECK,
  DirIndex,
  EdgeType,
  GameState,
  InspectorAPI,
  LegalMove,
  Move,
  QualityMode,
  REQUIRED_SHOTS,
  Rotation,
  ShotName,
  ThemeMode,
  ViewMode,
} from './contracts';
import {
  applyMove as engineApplyMove,
  chooseBotMove,
  createInitialState,
  getLegalMoves as engineGetLegalMoves,
  loadNamedFixture,
} from './logic/index';
import { paintTile } from './tiles/painter';
import { createDioramaRenderer } from './render/index';
import { createGameUI } from './ui/index';
import './ui/styles.css';

function createBrowserTileSheet(): HTMLCanvasElement {
  const cols = 4;
  const rows = DECK.length;
  const tileSize = 128;
  const pad = 28;
  const labelW = 180;
  const width = labelW + cols * (tileSize + pad) + pad;
  const height = rows * (tileSize + pad) + pad;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  const subCanvas = document.createElement('canvas');
  subCanvas.width = tileSize;
  subCanvas.height = tileSize;
  const subCtx = subCanvas.getContext('2d');

  DECK.forEach((spec, rowIdx) => {
    const y = pad + rowIdx * (tileSize + pad);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`#${rowIdx + 1} ${spec.id}`, 12, y + tileSize / 2 - 6);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.fillText(`Edges: ${spec.edges.join(',')}`, 12, y + tileSize / 2 + 12);
    ctx.fillText(`Lvls: ${spec.edgeLevels.join(',')}`, 12, y + tileSize / 2 + 28);

    for (let r = 0; r < 4; r++) {
      const rot = r as Rotation;
      const x = labelW + pad + r * (tileSize + pad);
      if (subCtx) {
        subCtx.clearRect(0, 0, tileSize, tileSize);
        paintTile(subCtx, spec, rot, tileSize);
        ctx.drawImage(subCanvas, x, y);
      }
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${r * 90}°`, x + 4, y - 6);
    }
  });

  return canvas;
}

function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const inspectMode = params.get('inspect') === '1';
  const reqW = Number(params.get('w')) || undefined;
  const reqH = Number(params.get('h')) || undefined;
  const workbenchTileId = params.get('tile');

  const viewportEl = document.getElementById('viewport') || document.body;
  const uiRootEl = document.getElementById('ui-root') || document.body;

  let state: GameState = createInitialState();
  if (workbenchTileId) {
    const found = DECK.find((t) => t.id === workbenchTileId);
    if (found) {
      state = {
        ...state,
        board: {
          '0,0': {
            x: 0,
            z: 0,
            specId: found.id,
            spec: found,
            rotation: 0,
            level: 0,
            crownLevel: Math.max(...found.edgeLevels),
            meeple: null,
            turnPlaced: 0,
          },
        },
        deckIndex: DECK.length,
        currentTile: null,
        gameOver: true,
      };
    }
  } else if (inspectMode) {
    state = loadNamedFixture('fixture-all-features');
  }

  let viewMode: ViewMode = '2d';
  let themeMode: ThemeMode = 'day';
  let qualityMode: QualityMode = 'high';
  let selectedMeeple: { edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> } | null = null;
  let demoRunning = false;

  const getActiveRotationMoves = (): LegalMove[] => {
    if (state.gameOver || !state.currentTile) return [];
    return engineGetLegalMoves(state, state.currentRotation);
  };

  const syncAll = () => {
    const movesForRot = getActiveRotationMoves();
    renderer.syncState(state, movesForRot);
    ui.update(state, viewMode, themeMode, qualityMode, selectedMeeple, movesForRot);
  };

  const handlePlaceMove = (legalMove: LegalMove) => {
    if (state.gameOver || !state.currentTile) return;
    const prevPlayer = state.activePlayer;
    let meepleChoice = selectedMeeple;
    if (meepleChoice) {
      const isAllowed = legalMove.legalMeepleEdges.some(
        (m) => m.edgeIndex === meepleChoice!.edgeIndex && m.featureType === meepleChoice!.featureType
      );
      if (!isAllowed) meepleChoice = null;
    }
    state = engineApplyMove(state, {
      x: legalMove.x,
      z: legalMove.z,
      rotation: legalMove.rotation,
      meeple: meepleChoice,
    });
    selectedMeeple = null;
    syncAll();
    if (!state.gameOver && state.activePlayer !== prevPlayer) {
      ui.showTurnBanner(`Player ${state.activePlayer}'s Turn`);
    } else if (state.gameOver) {
      ui.showTurnBanner('Game Over — Final Tallies!');
    }
  };

  const renderer = createDioramaRenderer(viewportEl, {
    inspectMode,
    width: reqW,
    height: reqH,
    onSelectMove: (move) => {
      if (!demoRunning) handlePlaceMove(move);
    },
  });

  const ui = createGameUI(uiRootEl, {
    onToggleView: () => {
      viewMode = viewMode === '2d' ? '3d' : '2d';
      renderer.setView(viewMode);
      syncAll();
    },
    onRotateTile: () => {
      if (state.gameOver || !state.currentTile) return;
      const nextRot = (((state.currentRotation + 1) % 4) as unknown) as Rotation;
      state = { ...state, currentRotation: nextRot };
      selectedMeeple = null;
      syncAll();
    },
    onChangeTheme: (theme: ThemeMode) => {
      themeMode = theme;
      renderer.setTheme(theme);
      syncAll();
    },
    onToggleQuality: () => {
      qualityMode = qualityMode === 'high' ? 'low' : 'high';
      renderer.setQuality(qualityMode);
      syncAll();
    },
    onStartDemo: () => {
      void api.startDemo();
    },
    onSelectMeepleOption: (choice) => {
      selectedMeeple = choice;
      syncAll();
    },
    onDropMeepleOnBoard: (clientX, clientY) => {
      if (demoRunning || state.gameOver || !state.currentTile) return false;
      const picked = renderer.pickGhostEdgeAtClientPoint?.(clientX, clientY);
      if (!picked) return false;
      selectedMeeple = {
        edgeIndex: picked.edgeIndex,
        featureType: picked.featureType,
      };
      handlePlaceMove(picked.move);
      return true;
    },
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      if (!state.gameOver && state.currentTile) {
        const nextRot = (((state.currentRotation + 1) % 4) as unknown) as Rotation;
        state = { ...state, currentRotation: nextRot };
        selectedMeeple = null;
        syncAll();
      }
    } else if (e.key === 'v' || e.key === 'V') {
      viewMode = viewMode === '2d' ? '3d' : '2d';
      renderer.setView(viewMode);
      syncAll();
    }
  });

  // Render first frame before exposing window.__game
  syncAll();
  renderer.renderAt(0);

  const api: InspectorAPI = {
    ready: true,
    getState() {
      return state;
    },
    getLegalMoves(rotation?: Rotation) {
      return engineGetLegalMoves(state, rotation);
    },
    applyMove(move: Move) {
      state = engineApplyMove(state, move);
      selectedMeeple = null;
      syncAll();
      return state;
    },
    runReplay(moves: Move[]) {
      let nextState = createInitialState();
      for (const m of moves) {
        nextState = engineApplyMove(nextState, m);
      }
      state = nextState;
      selectedMeeple = null;
      syncAll();
      return state;
    },
    setView(mode: ViewMode) {
      viewMode = mode;
      renderer.setView(mode);
      syncAll();
    },
    getView() {
      return viewMode;
    },
    setQuality(quality: QualityMode) {
      qualityMode = quality;
      renderer.setQuality(quality);
      syncAll();
    },
    setTheme(theme: ThemeMode) {
      themeMode = theme;
      renderer.setTheme(theme);
      syncAll();
    },
    async startDemo() {
      if (demoRunning) return;
      demoRunning = true;
      try {
        state = createInitialState();
        viewMode = '2d';
        renderer.setView('2d', true);
        syncAll();

        const stepDelay = inspectMode ? 10 : 90;
        while (!state.gameOver && state.currentTile) {
          const botMove = chooseBotMove(state);
          if (!botMove) break;
          state = { ...state, currentRotation: botMove.rotation };
          state = engineApplyMove(state, botMove);
          syncAll();
          await new Promise((r) => setTimeout(r, stepDelay));
        }

        // Trigger the 1.4s 2D -> 3D Rise transition
        viewMode = '3d';
        renderer.setView('3d');
        syncAll();
        await renderer.startOrbitFlythrough(inspectMode ? 200 : 2800);
      } finally {
        demoRunning = false;
      }
    },
    renderAt(tSeconds: number) {
      if (Object.keys(state.board).length <= 1 && !workbenchTileId) {
        state = loadNamedFixture('fixture-all-features');
        syncAll();
      }
      viewMode = tSeconds >= 3 ? '3d' : '2d';
      renderer.renderAt(tSeconds);
      ui.update(state, viewMode, themeMode, qualityMode, selectedMeeple, getActiveRotationMoves());
    },
    listShots(): ShotName[] {
      return [...REQUIRED_SHOTS];
    },
    captureShot(name: ShotName): string {
      if (Object.keys(state.board).length <= 1 && !workbenchTileId) {
        state = loadNamedFixture('fixture-all-features');
        syncAll();
      }
      return renderer.captureShot(name);
    },
    getTileSheet(): HTMLCanvasElement {
      return createBrowserTileSheet();
    },
    loadFixture(name: string): GameState {
      state = loadNamedFixture(name);
      selectedMeeple = null;
      syncAll();
      return state;
    },
    audit() {
      if (Object.keys(state.board).length <= 1 && !workbenchTileId) {
        state = loadNamedFixture('fixture-all-features');
        syncAll();
      }
      return renderer.audit();
    },
  };

  window.__game = api;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}
