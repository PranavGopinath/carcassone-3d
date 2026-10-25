/**
 * Tactical Tabletop UI Component for Tiers (Carcassonne-3D)
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
  PlayerId
} from '../contracts';
import { DIR_NAMES, getRotatedEdges } from '../contracts';
// @ts-ignore - tile_engineer creates src/tiles/painter.ts
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
}

function drawFallbackTile(
  ctx: CanvasRenderingContext2D,
  tile: TileSpec | null,
  rotation: Rotation,
  size: number
) {
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#6ca64c';
  ctx.fillRect(0, 0, size, size);

  if (!tile) return;

  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate((rotation * Math.PI) / 2);
  ctx.translate(-size / 2, -size / 2);

  const rotatedEdges = getRotatedEdges(tile, rotation);
  const edgeColors: Record<EdgeType, string> = {
    GRASS: '#6ca64c',
    ROAD: '#d6c49c',
    CITY: '#c48a5c',
    WATER: '#3e8ed0'
  };

  const edgeCoords = [
    [0, 0, size, size * 0.22], // N
    [size * 0.78, 0, size * 0.22, size], // E
    [0, size * 0.78, size, size * 0.22], // S
    [0, 0, size * 0.22, size] // W
  ];

  rotatedEdges.forEach((edge, i) => {
    if (edge !== 'GRASS') {
      ctx.fillStyle = edgeColors[edge];
      const [x, y, w, h] = edgeCoords[i];
      ctx.fillRect(x, y, w, h);
    }
  });

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tile.name.substring(0, 10), size / 2, size / 2);

  ctx.restore();
}

function renderTileDock(
  canvas: HTMLCanvasElement,
  tile: TileSpec | null,
  rotation: Rotation
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (!tile) {
    ctx.clearRect(0, 0, 140, 140);
    ctx.fillStyle = '#1a2234';
    ctx.fillRect(0, 0, 140, 140);
    return;
  }

  try {
    if (typeof paintTile === 'function') {
      paintTile(ctx, tile, rotation, 140);
    } else {
      drawFallbackTile(ctx, tile, rotation, 140);
    }
  } catch {
    drawFallbackTile(ctx, tile, rotation, 140);
  }
}

export function createGameUI(container: HTMLElement, actions: UIActions) {
  // Clear existing content
  container.innerHTML = '';

  // Root Overlay
  const rootElement = document.createElement('div');
  rootElement.className = 'ui-overlay-root';

  // --- Top Bar ---
  const topBar = document.createElement('div');
  topBar.className = 'ui-top-bar';

  // Left section: Active Player Indicator
  const turnIndicator = document.createElement('div');
  turnIndicator.setAttribute('data-testid', 'turn-indicator');
  turnIndicator.className = 'ui-player-pill p1';
  turnIndicator.innerHTML = `<span class="ui-pulse-dot"></span><span class="p-name">Player 1</span>`;

  // Middle section: View Toggle Pill
  const viewToggleBtn = document.createElement('button');
  viewToggleBtn.setAttribute('data-testid', 'view-toggle');
  viewToggleBtn.className = 'ui-pill-btn';
  viewToggleBtn.innerHTML = `<span>🌐</span> Top View (2D)`;
  viewToggleBtn.addEventListener('click', () => actions.onToggleView());

  // Right section: Theme, Quality & Demo controls
  const topControls = document.createElement('div');
  topControls.className = 'ui-bar-section';

  const themeSelect = document.createElement('select');
  themeSelect.className = 'ui-select';
  themeSelect.innerHTML = `
    <option value="day">☀️ Day</option>
    <option value="golden">🌅 Golden Hour</option>
    <option value="overcast">☁️ Overcast</option>
  `;
  themeSelect.addEventListener('change', (e) => {
    actions.onChangeTheme((e.target as HTMLSelectElement).value as ThemeMode);
  });

  const qualityBtn = document.createElement('button');
  qualityBtn.className = 'ui-btn';
  qualityBtn.innerText = 'Quality: High';
  qualityBtn.addEventListener('click', () => actions.onToggleQuality());

  const demoBtn = document.createElement('button');
  demoBtn.setAttribute('data-testid', 'demo-button');
  demoBtn.className = 'ui-btn ui-btn-primary';
  demoBtn.innerText = '▶ Auto Demo';
  demoBtn.addEventListener('click', () => actions.onStartDemo());

  topControls.appendChild(themeSelect);
  topControls.appendChild(qualityBtn);
  topControls.appendChild(demoBtn);

  topBar.appendChild(turnIndicator);
  topBar.appendChild(viewToggleBtn);
  topBar.appendChild(topControls);

  // --- Right Sidebar ---
  const sidebar = document.createElement('div');
  sidebar.className = 'ui-sidebar';

  // 1. Tile Dock
  const tileDock = document.createElement('div');
  tileDock.setAttribute('data-testid', 'tile-dock');
  tileDock.className = 'ui-panel ui-tile-dock';

  const dockHeader = document.createElement('div');
  dockHeader.className = 'ui-panel-header';
  dockHeader.innerHTML = `<span>Current Tile</span><span class="ui-counter-badge" id="ui-tile-counter">Tile 1 / 20</span>`;

  const previewWrapper = document.createElement('div');
  previewWrapper.className = 'ui-tile-preview-wrapper';

  const dockCanvas = document.createElement('canvas');
  dockCanvas.className = 'ui-tile-canvas';
  dockCanvas.width = 140;
  dockCanvas.height = 140;
  previewWrapper.appendChild(dockCanvas);

  const tileMeta = document.createElement('div');
  tileMeta.className = 'ui-tile-meta';
  tileMeta.innerHTML = `
    <div class="ui-tile-title" id="ui-tile-title">Starter City & Road</div>
    <div class="ui-tile-desc" id="ui-tile-desc">Classic Carcassonne starter tile</div>
  `;

  const dockActions = document.createElement('div');
  dockActions.className = 'ui-dock-actions';

  const rotateBtn = document.createElement('button');
  rotateBtn.setAttribute('data-testid', 'rotate-tile');
  rotateBtn.className = 'ui-btn ui-btn-primary';
  rotateBtn.style.width = '100%';
  rotateBtn.innerText = '🔄 Rotate Tile (R)';
  rotateBtn.addEventListener('click', () => actions.onRotateTile());
  dockActions.appendChild(rotateBtn);

  tileDock.appendChild(dockHeader);
  tileDock.appendChild(previewWrapper);
  tileDock.appendChild(tileMeta);
  tileDock.appendChild(dockActions);

  // 2. Meeple Placement Panel
  const meeplePanel = document.createElement('div');
  meeplePanel.className = 'ui-panel ui-meeple-panel';

  const meepleHeader = document.createElement('div');
  meepleHeader.className = 'ui-panel-header';
  meepleHeader.innerHTML = `<span>Meeple Placement</span>`;

  const reservesContainer = document.createElement('div');
  reservesContainer.className = 'ui-meeple-reserves';
  reservesContainer.id = 'ui-meeple-reserves';

  const meepleOptionsContainer = document.createElement('div');
  meepleOptionsContainer.className = 'ui-meeple-options';
  meepleOptionsContainer.id = 'ui-meeple-options';

  meeplePanel.appendChild(meepleHeader);
  meeplePanel.appendChild(reservesContainer);
  meeplePanel.appendChild(meepleOptionsContainer);

  // 3. Mosaic Score Panel
  const scorePanel = document.createElement('div');
  scorePanel.setAttribute('data-testid', 'score-panel');
  scorePanel.className = 'ui-panel ui-score-panel';

  const scoreHeader = document.createElement('div');
  scoreHeader.className = 'ui-panel-header';
  scoreHeader.innerHTML = `<span>0-49 Mosaic Score Track</span>`;

  const scoreReadout = document.createElement('div');
  scoreReadout.className = 'ui-score-readout';
  scoreReadout.id = 'ui-score-readout';

  const mosaicGrid = document.createElement('div');
  mosaicGrid.className = 'ui-mosaic-grid';

  // Build 50 cells for 0-49 track
  for (let i = 0; i < 50; i++) {
    const cell = document.createElement('div');
    cell.className = `ui-mosaic-cell${i === 0 ? ' start-cell' : ''}`;
    cell.innerText = i % 10 === 0 ? `${i}` : '•';
    cell.dataset.index = `${i}`;
    mosaicGrid.appendChild(cell);
  }

  // Tokens for P1 and P2
  const tokenP1 = document.createElement('div');
  tokenP1.className = 'ui-score-token p1';
  tokenP1.id = 'token-p1';

  const tokenP2 = document.createElement('div');
  tokenP2.className = 'ui-score-token p2';
  tokenP2.id = 'token-p2';

  mosaicGrid.appendChild(tokenP1);
  mosaicGrid.appendChild(tokenP2);

  scorePanel.appendChild(scoreHeader);
  scorePanel.appendChild(scoreReadout);
  scorePanel.appendChild(mosaicGrid);

  // 4. Event Log
  const eventLog = document.createElement('div');
  eventLog.setAttribute('data-testid', 'event-log');
  eventLog.className = 'ui-panel ui-event-log';

  const eventHeader = document.createElement('div');
  eventHeader.className = 'ui-panel-header';
  eventHeader.innerHTML = `<span>Recent Events</span>`;

  const eventList = document.createElement('div');
  eventList.className = 'ui-event-list';
  eventList.id = 'ui-event-list';

  eventLog.appendChild(eventHeader);
  eventLog.appendChild(eventList);

  // 5. Level Legend
  const levelLegend = document.createElement('div');
  levelLegend.setAttribute('data-testid', 'level-legend');
  levelLegend.className = 'ui-panel ui-level-legend';

  levelLegend.innerHTML = `
    <div class="ui-panel-header"><span>Elevation Levels</span></div>
    <div class="ui-legend-grid">
      <div class="ui-legend-item">
        <span class="ui-legend-swatch plus"></span>
        <span><strong>L+1</strong> Hill Plateau (Amber)</span>
      </div>
      <div class="ui-legend-item">
        <span class="ui-legend-swatch zero"></span>
        <span><strong>L0</strong> Fertile Valley (Green)</span>
      </div>
      <div class="ui-legend-item">
        <span class="ui-legend-swatch minus"></span>
        <span><strong>L-1</strong> River Canyon (Blue)</span>
      </div>
    </div>
    <div class="ui-legend-note">⚡ +2 pt Immediate Elevation Bonus</div>
  `;

  // Assemble Sidebar
  sidebar.appendChild(tileDock);
  sidebar.appendChild(meeplePanel);
  sidebar.appendChild(scorePanel);
  sidebar.appendChild(eventLog);
  sidebar.appendChild(levelLegend);

  // --- Transient Turn Banner Toast ---
  const turnBanner = document.createElement('div');
  turnBanner.className = 'ui-turn-banner';
  turnBanner.id = 'ui-turn-banner';

  // --- End-Game Modal ---
  const modalBackdrop = document.createElement('div');
  modalBackdrop.className = 'ui-modal-backdrop';
  modalBackdrop.style.display = 'none';

  const modalCard = document.createElement('div');
  modalCard.className = 'ui-modal-card';
  modalCard.innerHTML = `
    <div class="ui-modal-title">Game Over</div>
    <div class="ui-winner-announcement" id="ui-winner-text">Player 1 Wins!</div>
    <div class="ui-final-scores" id="ui-final-scores"></div>
    <button class="ui-btn ui-btn-primary" id="ui-restart-btn" style="padding: 12px 24px; font-size: 15px;">
      🔄 Play Again / Run Demo
    </button>
  `;
  modalBackdrop.appendChild(modalCard);

  // Assemble Root
  rootElement.appendChild(topBar);
  rootElement.appendChild(sidebar);
  rootElement.appendChild(turnBanner);
  rootElement.appendChild(modalBackdrop);

  container.appendChild(rootElement);

  // Banner timer reference
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;

  function updateTokenPosition(token: HTMLElement, score: number, offsetPx: number) {
    const spaceIndex = Math.max(0, score) % 50;
    const targetCell = mosaicGrid.children[spaceIndex] as HTMLElement;
    if (targetCell && targetCell.offsetLeft !== undefined) {
      const left = targetCell.offsetLeft + 2 + offsetPx;
      const top = targetCell.offsetTop + 2;
      token.style.transform = `translate(${left}px, ${top}px)`;
    }
  }

  return {
    update(
      state: GameState,
      viewMode: ViewMode,
      theme: ThemeMode,
      quality: QualityMode,
      selectedMeeple: { edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> } | null,
      legalMoves: LegalMove[]
    ) {
      // 1. Update View Toggle
      viewToggleBtn.innerHTML =
        viewMode === '2d'
          ? `<span>📐</span> Top View (2D)`
          : `<span>🌐</span> Explore World (3D)`;

      // 2. Update Turn Indicator
      const activeP = state.activePlayer;
      turnIndicator.className = `ui-player-pill p${activeP}`;
      turnIndicator.innerHTML = `<span class="ui-pulse-dot"></span><span>Player ${activeP}'s Turn</span>`;

      // 3. Theme & Quality
      if (themeSelect.value !== theme) {
        themeSelect.value = theme;
      }
      qualityBtn.innerText = `Quality: ${quality === 'high' ? 'High' : 'Low'}`;

      // 4. Update Tile Dock
      const tileCounterEl = document.getElementById('ui-tile-counter');
      if (tileCounterEl) {
        const currentNum = Math.min(state.turnNumber || state.deckIndex + 1, 20);
        tileCounterEl.innerText = `Tile ${currentNum} / 20`;
      }

      const titleEl = document.getElementById('ui-tile-title');
      const descEl = document.getElementById('ui-tile-desc');
      if (titleEl && descEl) {
        if (state.currentTile) {
          titleEl.innerText = state.currentTile.name;
          descEl.innerText = state.currentTile.description;
        } else {
          titleEl.innerText = 'Deck Exhausted';
          descEl.innerText = 'All 20 tiles have been placed on the board.';
        }
      }

      renderTileDock(dockCanvas, state.currentTile, state.currentRotation);

      // 5. Update Meeple Reserves & Options
      const reservesEl = document.getElementById('ui-meeple-reserves');
      if (reservesEl && state.players) {
        const p1 = state.players[1];
        const p2 = state.players[2];
        reservesEl.innerHTML = `
          <div class="ui-reserve-item p1">
            <span>P1:</span>
            <div class="ui-reserve-dots">
              ${[1, 2, 3]
                .map(
                  (i) =>
                    `<span class="ui-meeple-dot${
                      i <= (p1?.meeplesAvailable ?? 0) ? ' filled' : ''
                    }"></span>`
                )
                .join('')}
            </div>
            <span>(${p1?.meeplesAvailable ?? 0})</span>
          </div>
          <div class="ui-reserve-item p2">
            <span>P2:</span>
            <div class="ui-reserve-dots">
              ${[1, 2, 3]
                .map(
                  (i) =>
                    `<span class="ui-meeple-dot${
                      i <= (p2?.meeplesAvailable ?? 0) ? ' filled' : ''
                    }"></span>`
                )
                .join('')}
            </div>
            <span>(${p2?.meeplesAvailable ?? 0})</span>
          </div>
        `;
      }

      // Feature options on current tile
      if (meepleOptionsContainer) {
        meepleOptionsContainer.innerHTML = '';

        if (state.currentTile && state.players[activeP]?.meeplesAvailable > 0) {
          const rotatedEdges = getRotatedEdges(state.currentTile, state.currentRotation);
          const availableFeatures: Array<{ edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> }> = [];

          rotatedEdges.forEach((edge, idx) => {
            if (edge !== 'GRASS') {
              // Avoid duplicate feature entries for same edge type if same segment
              if (!availableFeatures.some((f) => f.edgeIndex === idx && f.featureType === edge)) {
                availableFeatures.push({
                  edgeIndex: idx as DirIndex,
                  featureType: edge as Exclude<EdgeType, 'GRASS'>
                });
              }
            }
          });

          if (availableFeatures.length > 0) {
            const promptTitle = document.createElement('div');
            promptTitle.style.fontSize = '12px';
            promptTitle.style.color = 'var(--ui-text-muted)';
            promptTitle.innerText = 'Place Meeple on Feature:';
            meepleOptionsContainer.appendChild(promptTitle);

            availableFeatures.forEach((feat) => {
              const optBtn = document.createElement('button');
              const isSelected =
                selectedMeeple !== null &&
                selectedMeeple.edgeIndex === feat.edgeIndex &&
                selectedMeeple.featureType === feat.featureType;

              optBtn.className = `ui-option-btn${isSelected ? ' selected' : ''}`;
              optBtn.innerHTML = `
                <span>${feat.featureType} (${DIR_NAMES[feat.edgeIndex]})</span>
                <span>${isSelected ? '✓' : '+'}</span>
              `;
              optBtn.addEventListener('click', () => {
                actions.onSelectMeepleOption(isSelected ? null : feat);
              });
              meepleOptionsContainer.appendChild(optBtn);
            });

            const skipBtn = document.createElement('button');
            skipBtn.className = `ui-option-btn${selectedMeeple === null ? ' selected' : ''}`;
            skipBtn.innerHTML = `<span>Skip Meeple Placement</span><span>${
              selectedMeeple === null ? '✓' : ''
            }</span>`;
            skipBtn.addEventListener('click', () => actions.onSelectMeepleOption(null));
            meepleOptionsContainer.appendChild(skipBtn);
          }
        }
      }

      // 6. Update Score Panel
      const p1Score = state.players[1]?.score ?? 0;
      const p2Score = state.players[2]?.score ?? 0;

      if (scoreReadout) {
        scoreReadout.innerHTML = `
          <div class="ui-player-score p1" style="color: var(--p1-color)">
            <span>P1: ${p1Score}</span>
            ${p1Score >= 50 ? `<span class="ui-wrap-badge">+50</span>` : ''}
          </div>
          <div class="ui-player-score p2" style="color: var(--p2-color)">
            <span>P2: ${p2Score}</span>
            ${p2Score >= 50 ? `<span class="ui-wrap-badge">+50</span>` : ''}
          </div>
        `;
      }

      updateTokenPosition(tokenP1, p1Score, 0);
      updateTokenPosition(tokenP2, p2Score, 2);

      // 7. Update Event Log
      if (eventList) {
        eventList.innerHTML = '';
        const recentEvents = [...(state.events || [])].slice(-10).reverse();
        if (recentEvents.length === 0) {
          eventList.innerHTML = `<div style="font-size: 11px; color: var(--ui-text-muted); font-style: italic;">No score events yet</div>`;
        } else {
          recentEvents.forEach((evt) => {
            const item = document.createElement('div');
            item.className = `ui-event-item p${evt.playerId}`;
            item.innerHTML = `
              <span>P${evt.playerId}: </span>
              <span class="ui-event-pts">+${evt.points} pts</span>
              <span> - ${evt.reason}</span>
            `;
            eventList.appendChild(item);
          });
        }
      }

      // 8. End Game Modal
      if (state.gameOver) {
        modalBackdrop.style.display = 'flex';
        const winnerText = document.getElementById('ui-winner-text');
        const finalScores = document.getElementById('ui-final-scores');
        const restartBtn = document.getElementById('ui-restart-btn');

        if (winnerText) {
          if (p1Score > p2Score) {
            winnerText.innerText = '🏆 Player 1 Wins!';
            winnerText.style.color = 'var(--p1-color)';
          } else if (p2Score > p1Score) {
            winnerText.innerText = '🏆 Player 2 Wins!';
            winnerText.style.color = 'var(--p2-color)';
          } else {
            winnerText.innerText = '🤝 It\'s a Tie!';
            winnerText.style.color = '#fbbf24';
          }
        }

        if (finalScores) {
          finalScores.innerHTML = `
            <div class="ui-final-player">
              <span class="ui-final-pname" style="color: var(--p1-color)">Player 1</span>
              <span class="ui-final-pscore">${p1Score}</span>
            </div>
            <div class="ui-final-player">
              <span class="ui-final-pname" style="color: var(--p2-color)">Player 2</span>
              <span class="ui-final-pscore">${p2Score}</span>
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
      }, 1800);
    },

    destroy() {
      if (bannerTimer) clearTimeout(bannerTimer);
      container.innerHTML = '';
    }
  };
}
