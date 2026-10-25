/**
 * Minimalist Frosted UI for Tiers (Carcassonne-3D)
 * Matches `reference/UI_reference.jpg`
 * Owned by: ui_engineer (`src/ui/index.ts`)
 */

import './styles.css';
import type {
  GameState,
  ViewMode,
  ThemeMode,
  QualityMode,
  LegalMove,
  DirIndex,
  EdgeType,
  TileSpec,
  Rotation,
  PlayerId,
} from '../contracts';
import { DIR_NAMES, getRotatedEdges } from '../contracts';
import { paintTile } from '../tiles/painter';

export interface UIActions {
  onToggleView: () => void;
  onRotateTile: () => void;
  onChangeTheme: (theme: ThemeMode) => void;
  onToggleQuality: () => void;
  onStartDemo: () => void;
  onSelectMeepleOption: (
    meeple: { edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> } | null
  ) => void;
  onDropMeepleOnBoard?: (clientX: number, clientY: number) => boolean;
}

const PREVIEW_SIZE = 132;

/** Socket coordinates (in % of tile preview) for N, E, S, W circular drop targets */
const SOCKET_POS_PCT: Record<DirIndex, { left: number; top: number }> = {
  0: { left: 50, top: 15 }, // North
  1: { left: 85, top: 50 }, // East
  2: { left: 50, top: 85 }, // South
  3: { left: 15, top: 50 }, // West
};

/**
 * Super clean, minimal geometric person/pawn icon (SF Symbols / Linear style).
 */
function createPersonSilhouetteSvg(color: string, width = 16, height = 24): string {
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 20 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="6" r="4.2" fill="${color}" />
      <path d="M10 12.2C6.1 12.2 3.2 14.8 3.2 18.4V23.2C3.2 24.4 4.2 25.4 5.4 25.4H6.6V27.6C6.6 28.6 7.4 29.4 8.4 29.4H11.6C12.6 29.4 13.4 28.6 13.4 27.6V25.4H14.6C15.8 25.4 16.8 24.4 16.8 23.2V18.4C16.8 14.8 13.9 12.2 10 12.2Z" fill="${color}"/>
    </svg>
  `;
}

/**
 * Minimal top-left player bust avatar.
 */
function createAvatarBustSvg(color: string): string {
  return `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="7.5" r="4.2" fill="${color}"/>
      <path d="M4.5 19.8C4.5 16.1 7.8 13.5 12 13.5C16.2 13.5 19.5 16.1 19.5 19.8C19.5 20.6 18.8 21.2 18 21.2H6C5.2 21.2 4.5 20.6 4.5 19.8Z" fill="${color}"/>
    </svg>
  `;
}

function renderTileDock(
  canvas: HTMLCanvasElement,
  tile: TileSpec | null,
  rotation: Rotation
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (!tile) {
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    return;
  }

  try {
    paintTile(ctx, tile, rotation, PREVIEW_SIZE);
  } catch {
    ctx.fillStyle = '#6ca64c';
    ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  }
}

export function createGameUI(container: HTMLElement, actions: UIActions) {
  container.innerHTML = '';

  const rootElement = document.createElement('div');
  rootElement.className = 'ui-overlay-root';

  // 1. Top-Left Minimal Turn Indicator (`PLAYER 1'S TURN`)
  const turnIndicator = document.createElement('div');
  turnIndicator.setAttribute('data-testid', 'turn-indicator');
  turnIndicator.className = 'ui-top-left-turn';
  turnIndicator.innerHTML = `
    <div class="ui-turn-avatar" id="ui-turn-avatar">${createAvatarBustSvg('#4f6ef7')}</div>
    <span class="ui-turn-text" id="ui-turn-text">PLAYER 1'S TURN</span>
  `;

  // 2. Top-Center Frosted 2D/3D Pill Toggle Switch + Auto Demo Pill
  const topCenterBar = document.createElement('div');
  topCenterBar.className = 'ui-top-center-bar';

  const viewToggleBtn = document.createElement('button');
  viewToggleBtn.setAttribute('data-testid', 'view-toggle');
  viewToggleBtn.className = 'ui-view-switch mode-2d';
  viewToggleBtn.innerHTML = `
    <div class="ui-view-switch-thumb"></div>
    <span class="ui-view-switch-label lbl-2d">2D</span>
    <span class="ui-view-switch-label lbl-3d">3D</span>
  `;
  viewToggleBtn.addEventListener('click', () => actions.onToggleView());

  const demoBtn = document.createElement('button');
  demoBtn.setAttribute('data-testid', 'demo-button');
  demoBtn.className = 'ui-demo-pill';
  demoBtn.innerText = 'Auto Demo';
  demoBtn.addEventListener('click', () => actions.onStartDemo());

  topCenterBar.appendChild(viewToggleBtn);

  // 3. Right Frosted Card Sidebar (`reference/UI_reference.jpg`)
  const sidebarCard = document.createElement('div');
  sidebarCard.setAttribute('data-testid', 'tile-dock');
  sidebarCard.className = 'ui-sidebar-card';

  const topSection = document.createElement('div');
  topSection.className = 'ui-top-section';

  const headerRow = document.createElement('div');
  headerRow.className = 'ui-header-row';
  headerRow.innerHTML = `
    <span class="ui-header-title">CURRENT TILE</span>
    <span class="ui-header-count" id="ui-tile-counter">1/20</span>
  `;

  const instructionCopy = document.createElement('p');
  instructionCopy.className = 'ui-instruction-copy';
  instructionCopy.id = 'ui-drag-hint';
  instructionCopy.innerText =
    'Click and drag a person to one of the circles on the tile if you wish to capture that area';

  const meepleBlackBar = document.createElement('div');
  meepleBlackBar.className = 'ui-meeple-black-bar';
  meepleBlackBar.id = 'ui-meeple-bar';

  topSection.appendChild(headerRow);
  topSection.appendChild(instructionCopy);
  topSection.appendChild(meepleBlackBar);

  // Middle Tile Preview with Circular Drop Targets
  const tileStage = document.createElement('div');
  tileStage.className = 'ui-tile-stage';

  const previewWrapper = document.createElement('div');
  previewWrapper.className = 'ui-tile-preview-wrapper';

  const dockCanvas = document.createElement('canvas');
  dockCanvas.className = 'ui-tile-canvas';
  dockCanvas.width = PREVIEW_SIZE;
  dockCanvas.height = PREVIEW_SIZE;

  const dropLayer = document.createElement('div');
  dropLayer.className = 'ui-tile-drop-layer';

  previewWrapper.appendChild(dockCanvas);
  previewWrapper.appendChild(dropLayer);

  const tileCaption = document.createElement('div');
  tileCaption.className = 'ui-tile-caption';
  tileCaption.id = 'ui-tile-title';
  tileCaption.innerText = 'Starter City & Road';

  tileStage.appendChild(previewWrapper);
  tileStage.appendChild(tileCaption);

  // Middle-Bottom Controls: Black ROTATE Pill + Divider + SCORE Box
  const bottomSection = document.createElement('div');
  bottomSection.style.display = 'flex';
  bottomSection.style.flexDirection = 'column';
  bottomSection.style.gap = '8px';

  const rotateBtn = document.createElement('button');
  rotateBtn.setAttribute('data-testid', 'rotate-tile');
  rotateBtn.className = 'ui-rotate-pill-btn';
  rotateBtn.innerText = 'ROTATE';
  rotateBtn.addEventListener('click', () => actions.onRotateTile());

  const divider = document.createElement('div');
  divider.className = 'ui-divider-line';

  const scoreSection = document.createElement('div');
  scoreSection.setAttribute('data-testid', 'score-panel');
  scoreSection.className = 'ui-score-section';

  const scoreHeading = document.createElement('div');
  scoreHeading.className = 'ui-score-heading';
  scoreHeading.innerText = 'SCORE';

  const scoreBlackBox = document.createElement('div');
  scoreBlackBox.className = 'ui-score-black-box';
  scoreBlackBox.id = 'ui-score-readout';

  scoreSection.appendChild(scoreHeading);
  scoreSection.appendChild(scoreBlackBox);

  bottomSection.appendChild(rotateBtn);
  bottomSection.appendChild(divider);
  bottomSection.appendChild(scoreSection);

  // Hidden compatibility stubs
  const hiddenEventLog = document.createElement('div');
  hiddenEventLog.setAttribute('data-testid', 'event-log');
  hiddenEventLog.style.display = 'none';

  const hiddenLevelLegend = document.createElement('div');
  hiddenLevelLegend.setAttribute('data-testid', 'level-legend');
  hiddenLevelLegend.style.display = 'none';

  sidebarCard.appendChild(topSection);
  sidebarCard.appendChild(tileStage);
  sidebarCard.appendChild(bottomSection);
  sidebarCard.appendChild(hiddenEventLog);
  sidebarCard.appendChild(hiddenLevelLegend);

  // Turn Banner Toast
  const turnBanner = document.createElement('div');
  turnBanner.className = 'ui-turn-banner';
  turnBanner.id = 'ui-turn-banner';

  // End-Game Modal
  const modalBackdrop = document.createElement('div');
  modalBackdrop.className = 'ui-modal-backdrop';
  modalBackdrop.style.display = 'none';

  const modalCard = document.createElement('div');
  modalCard.className = 'ui-modal-card';
  modalCard.innerHTML = `
    <div class="ui-modal-title">Game Over</div>
    <div class="ui-winner-announcement" id="ui-winner-text">Player 1 Wins!</div>
    <div class="ui-final-scores" id="ui-final-scores"></div>
    <button class="ui-rotate-pill-btn" id="ui-restart-btn">Play Again</button>
  `;
  modalBackdrop.appendChild(modalCard);

  rootElement.appendChild(turnIndicator);
  rootElement.appendChild(topCenterBar);
  rootElement.appendChild(demoBtn);
  rootElement.appendChild(sidebarCard);
  rootElement.appendChild(turnBanner);
  rootElement.appendChild(modalBackdrop);

  container.appendChild(rootElement);

  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let isDraggingMeeple = false;
  let floatingDragEl: HTMLElement | null = null;
  let availableTileSpots: Array<{
    dir: DirIndex;
    featureType: Exclude<EdgeType, 'GRASS'>;
    el: HTMLElement;
  }> = [];

  function findHoveredSpot(clientX: number, clientY: number) {
    let best: { dir: DirIndex; featureType: Exclude<EdgeType, 'GRASS'>; el: HTMLElement } | null = null;
    let bestDist = 44;
    for (const spot of availableTileSpots) {
      const rect = spot.el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(clientX - cx, clientY - cy);
      if (dist <= bestDist) {
        bestDist = dist;
        best = spot;
      }
    }
    return best;
  }

  function startPersonPointerDrag(e: PointerEvent, color: string) {
    e.preventDefault();
    isDraggingMeeple = true;

    if (floatingDragEl) {
      floatingDragEl.remove();
    }
    floatingDragEl = document.createElement('div');
    floatingDragEl.className = 'ui-floating-drag-meeple';
    floatingDragEl.innerHTML = createPersonSilhouetteSvg(color, 13, 19);
    floatingDragEl.style.left = `${e.clientX}px`;
    floatingDragEl.style.top = `${e.clientY}px`;
    document.body.appendChild(floatingDragEl);

    for (const spot of availableTileSpots) {
      spot.el.classList.add('dragging-active');
    }
  }

  function onGlobalPointerMove(e: PointerEvent) {
    if (!isDraggingMeeple || !floatingDragEl) return;
    floatingDragEl.style.left = `${e.clientX}px`;
    floatingDragEl.style.top = `${e.clientY}px`;

    const hovered = findHoveredSpot(e.clientX, e.clientY);
    for (const spot of availableTileSpots) {
      if (hovered && spot.dir === hovered.dir) {
        spot.el.classList.add('hover-target');
      } else {
        spot.el.classList.remove('hover-target');
      }
    }
  }

  function onGlobalPointerUp(e: PointerEvent) {
    if (!isDraggingMeeple) return;
    isDraggingMeeple = false;

    if (floatingDragEl) {
      floatingDragEl.remove();
      floatingDragEl = null;
    }

    const hovered = findHoveredSpot(e.clientX, e.clientY);
    for (const spot of availableTileSpots) {
      spot.el.classList.remove('dragging-active', 'hover-target');
    }

    if (hovered) {
      actions.onSelectMeepleOption({
        edgeIndex: hovered.dir,
        featureType: hovered.featureType,
      });
    } else if (actions.onDropMeepleOnBoard && actions.onDropMeepleOnBoard(e.clientX, e.clientY)) {
      // Dropped directly onto a legal tile spot on the board
    } else {
      actions.onSelectMeepleOption(null);
    }
  }

  window.addEventListener('pointermove', onGlobalPointerMove);
  window.addEventListener('pointerup', onGlobalPointerUp);

  return {
    update(
      state: GameState,
      viewMode: ViewMode,
      _theme: ThemeMode,
      _quality: QualityMode,
      selectedMeeple: { edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> } | null,
      _legalMoves: LegalMove[]
    ) {
      // 1. Update 2D / 3D Switch
      viewToggleBtn.className = `ui-view-switch mode-${viewMode}`;

      // 2. Update Top-Left Turn Indicator
      const activeP: PlayerId = state.activePlayer;
      const activeColor = activeP === 1 ? '#4f6ef7' : '#e06d3b';
      const avatarEl = document.getElementById('ui-turn-avatar');
      const turnTextEl = document.getElementById('ui-turn-text');
      if (avatarEl) avatarEl.innerHTML = createAvatarBustSvg(activeColor);
      if (turnTextEl) turnTextEl.innerText = `PLAYER ${activeP}'S TURN`;

      // 3. Update Tile Counter (`14/20`) and Title
      const tileCounterEl = document.getElementById('ui-tile-counter');
      if (tileCounterEl) {
        const currentNum = Math.min(state.turnNumber || state.deckIndex + 1, 20);
        tileCounterEl.innerText = `${currentNum}/20`;
      }

      const titleEl = document.getElementById('ui-tile-title');
      if (titleEl) {
        titleEl.innerText = state.currentTile ? state.currentTile.name : 'All 20 Tiles Placed';
      }

      renderTileDock(dockCanvas, state.currentTile, state.currentRotation);

      // 4. Rebuild Circular Drop Targets on the Current Tile
      dropLayer.innerHTML = '';
      availableTileSpots = [];

      if (state.currentTile && (state.players[activeP]?.meeplesAvailable ?? 0) > 0) {
        const rotatedEdges = getRotatedEdges(state.currentTile, state.currentRotation);
        ([0, 1, 2, 3] as DirIndex[]).forEach((dir) => {
          const edge = rotatedEdges[dir];
          if (edge === 'GRASS') return;

          const featureType = edge as Exclude<EdgeType, 'GRASS'>;
          const pos = SOCKET_POS_PCT[dir];
          const circleEl = document.createElement('div');
          const isOccupiedBySelection =
            selectedMeeple !== null &&
            selectedMeeple.edgeIndex === dir &&
            selectedMeeple.featureType === featureType;

          circleEl.className = `ui-tile-circle-target${isOccupiedBySelection ? ' has-person' : ''}`;
          circleEl.style.left = `${pos.left}%`;
          circleEl.style.top = `${pos.top}%`;
          circleEl.title = `${featureType} (${DIR_NAMES[dir]})`;

          if (isOccupiedBySelection) {
            circleEl.innerHTML = createPersonSilhouetteSvg(activeColor, 12, 18);
            circleEl.addEventListener('pointerdown', (ev) => {
              actions.onSelectMeepleOption(null);
              startPersonPointerDrag(ev, activeColor);
            });
          }

          dropLayer.appendChild(circleEl);
          availableTileSpots.push({ dir, featureType, el: circleEl });
        });
      }

      // 5. Update Black Meeple Bar (5 minimal silhouette slots)
      meepleBlackBar.innerHTML = '';
      const stagedDeduction = selectedMeeple ? 1 : 0;
      const availableCount = Math.max(
        0,
        (state.players[activeP]?.meeplesAvailable ?? 0) - stagedDeduction
      );

      for (let i = 1; i <= 5; i++) {
        const isLit = i <= availableCount && !state.gameOver;
        const canDrag = isLit && availableTileSpots.length > 0;
        const slotEl = document.createElement('div');
        slotEl.className = `ui-person-slot${isLit ? (canDrag ? ' draggable' : '') : ' inactive'}`;
        slotEl.innerHTML = createPersonSilhouetteSvg(isLit ? activeColor : '#6b7280', 16, 24);

        if (canDrag) {
          slotEl.title = 'Click and drag onto one of the circles on the tile';
          slotEl.addEventListener('pointerdown', (ev) => {
            startPersonPointerDrag(ev, activeColor);
          });
        }
        meepleBlackBar.appendChild(slotEl);
      }

      // 6. Update Black Scoreboard
      const p1Score = state.players[1]?.score ?? 0;
      const p2Score = state.players[2]?.score ?? 0;
      const p1Active = !state.gameOver && activeP === 1;
      const p2Active = !state.gameOver && activeP === 2;

      scoreBlackBox.innerHTML = `
        <div class="ui-scoreboard-col${p1Active ? ' is-active' : ''}" style="--player-accent: #4f6ef7">
          <div class="ui-scoreboard-header">
            <span class="ui-score-dot" style="background: #4f6ef7"></span>
            <span class="ui-scoreboard-name">PLAYER 1</span>
          </div>
          <div class="ui-scoreboard-digits">
            <span class="ui-score-val">${p1Score}</span>
          </div>
        </div>
        <div class="ui-scoreboard-divider" aria-hidden="true"></div>
        <div class="ui-scoreboard-col${p2Active ? ' is-active' : ''}" style="--player-accent: #e06d3b">
          <div class="ui-scoreboard-header">
            <span class="ui-score-dot" style="background: #e06d3b"></span>
            <span class="ui-scoreboard-name">PLAYER 2</span>
          </div>
          <div class="ui-scoreboard-digits">
            <span class="ui-score-val">${p2Score}</span>
          </div>
        </div>
      `;

      // 7. End Game Modal
      if (state.gameOver) {
        modalBackdrop.style.display = 'flex';
        const winnerText = document.getElementById('ui-winner-text');
        const finalScores = document.getElementById('ui-final-scores');
        const restartBtn = document.getElementById('ui-restart-btn');

        if (winnerText) {
          if (p1Score > p2Score) {
            winnerText.innerText = 'Player 1 Wins!';
            winnerText.style.color = '#4f6ef7';
          } else if (p2Score > p1Score) {
            winnerText.innerText = 'Player 2 Wins!';
            winnerText.style.color = '#e06d3b';
          } else {
            winnerText.innerText = "It's a Tie!";
            winnerText.style.color = '#111827';
          }
        }

        if (finalScores) {
          finalScores.innerHTML = `
            <div class="ui-scoreboard-col${p1Score >= p2Score ? ' is-active' : ''}" style="--player-accent: #4f6ef7">
              <div class="ui-scoreboard-header">
                <span class="ui-score-dot" style="background: #4f6ef7"></span>
                <span class="ui-scoreboard-name">PLAYER 1</span>
              </div>
              <div class="ui-scoreboard-digits">
                <span class="ui-score-val">${p1Score}</span>
              </div>
            </div>
            <div class="ui-scoreboard-divider" aria-hidden="true"></div>
            <div class="ui-scoreboard-col${p2Score >= p1Score ? ' is-active' : ''}" style="--player-accent: #e06d3b">
              <div class="ui-scoreboard-header">
                <span class="ui-score-dot" style="background: #e06d3b"></span>
                <span class="ui-scoreboard-name">PLAYER 2</span>
              </div>
              <div class="ui-scoreboard-digits">
                <span class="ui-score-val">${p2Score}</span>
              </div>
            </div>
          `;
        }

        if (restartBtn) {
          restartBtn.onclick = () => {
            modalBackdrop.style.display = 'none';
            actions.onStartDemo();
          };
        }
      } else {
        modalBackdrop.style.display = 'none';
      }
    },

    showTurnBanner(text: string) {
      if (bannerTimer) clearTimeout(bannerTimer);
      turnBanner.innerText = text;
      turnBanner.classList.add('visible');
      bannerTimer = setTimeout(() => {
        turnBanner.classList.remove('visible');
      }, 1600);
    },

    destroy() {
      if (bannerTimer) clearTimeout(bannerTimer);
      window.removeEventListener('pointermove', onGlobalPointerMove);
      window.removeEventListener('pointerup', onGlobalPointerUp);
      if (floatingDragEl) {
        floatingDragEl.remove();
        floatingDragEl = null;
      }
      container.innerHTML = '';
    },
  };
}
