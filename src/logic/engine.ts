import {
  DECK,
  DIR_OFFSETS,
  type DirIndex,
  type EdgeType,
  type GameState,
  getRotatedEdgeLevels,
  getRotatedEdges,
  isElevationChanger,
  type LegalMove,
  type Move,
  type PlacedTile,
  type PlayerId,
  type Rotation,
  type ScoreEvent,
  type TileSpec,
} from '../contracts';

export function coordKey(x: number, z: number): string {
  return `${x},${z}`;
}

export interface ChainNode {
  x: number;
  z: number;
  dir: DirIndex;
}

export interface ChainMeeple {
  x: number;
  z: number;
  playerId: PlayerId;
  edgeIndex: DirIndex;
}

export interface FeatureChain {
  featureType: Exclude<EdgeType, 'GRASS'>;
  nodes: ChainNode[];
  nodeKeys: Set<string>;
  tileKeys: Set<string>;
  openEdges: number;
  completed: boolean;
  meeples: ChainMeeple[];
}

/**
 * Returns all edge directions on the given tile that belong to the same intra-tile feature segment as `dir`.
 */
export function getIntraTileConnectedEdges(
  spec: TileSpec,
  rotation: Rotation,
  dir: DirIndex,
): DirIndex[] {
  const edges = getRotatedEdges(spec, rotation);
  const feature = edges[dir];
  if (feature === 'GRASS') {
    return [];
  }

  if (feature === 'CITY') {
    if (spec.special === 'CITY_SEPARATE') {
      return [dir];
    }
    return ([0, 1, 2, 3] as DirIndex[]).filter((d) => edges[d] === 'CITY');
  }

  if (feature === 'ROAD') {
    if (spec.special === 'ROAD_JUNCTION') {
      return [dir];
    }
    return ([0, 1, 2, 3] as DirIndex[]).filter((d) => edges[d] === 'ROAD');
  }

  // WATER: 1-edge (LAKE/SPRING) returns [dir]; 2 or 3 edges connect through the tile
  return ([0, 1, 2, 3] as DirIndex[]).filter((d) => edges[d] === 'WATER');
}

/**
 * Traverses the connected feature graph starting from `(startX, startZ, startDir)`.
 */
export function traceFeatureChain(
  board: Record<string, PlacedTile>,
  startX: number,
  startZ: number,
  startDir: DirIndex,
): FeatureChain | null {
  const startTile = board[coordKey(startX, startZ)];
  if (!startTile) {
    return null;
  }

  const startEdges = getRotatedEdges(startTile.spec, startTile.rotation);
  const featureType = startEdges[startDir];
  if (featureType === 'GRASS') {
    return null;
  }

  const nodeKeys = new Set<string>();
  const nodes: ChainNode[] = [];
  const tileKeys = new Set<string>();
  const queue: ChainNode[] = [];

  const pushNode = (x: number, z: number, dir: DirIndex): void => {
    const key = `${x},${z},${dir}`;
    if (!nodeKeys.has(key)) {
      nodeKeys.add(key);
      const node = { x, z, dir };
      nodes.push(node);
      queue.push(node);
    }
  };

  pushNode(startX, startZ, startDir);

  let openEdges = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const tKey = coordKey(current.x, current.z);
    const tile = board[tKey];
    if (!tile) {
      continue;
    }
    tileKeys.add(tKey);

    // 1. Intra-tile connected sockets
    const intraDirs = getIntraTileConnectedEdges(tile.spec, tile.rotation, current.dir);
    for (const d of intraDirs) {
      pushNode(current.x, current.z, d);
    }

    // 2. Inter-tile connection across `current.dir`
    const offset = DIR_OFFSETS[current.dir];
    const nx = current.x + offset.dx;
    const nz = current.z + offset.dz;
    const neighbor = board[coordKey(nx, nz)];

    if (!neighbor) {
      openEdges += 1;
    } else {
      const oppDir = offset.opposite;
      const neighborEdges = getRotatedEdges(neighbor.spec, neighbor.rotation);
      if (neighborEdges[oppDir] === featureType) {
        pushNode(nx, nz, oppDir);
      } else {
        openEdges += 1;
      }
    }
  }

  const meeples: ChainMeeple[] = [];
  for (const tKey of tileKeys) {
    const tile = board[tKey];
    if (tile?.meeple && tile.meeple.featureType === featureType) {
      const mKey = `${tile.x},${tile.z},${tile.meeple.edgeIndex}`;
      if (nodeKeys.has(mKey)) {
        meeples.push({
          x: tile.x,
          z: tile.z,
          playerId: tile.meeple.playerId,
          edgeIndex: tile.meeple.edgeIndex,
        });
      }
    }
  }

  return {
    featureType,
    nodes,
    nodeKeys,
    tileKeys,
    openEdges,
    completed: openEdges === 0,
    meeples,
  };
}

export function calculateChainPoints(
  board: Record<string, PlacedTile>,
  chain: FeatureChain,
  completed: boolean,
): number {
  const numTiles = chain.tileKeys.size;
  if (completed) {
    if (chain.featureType === 'ROAD') {
      let bridgeCount = 0;
      for (const tKey of chain.tileKeys) {
        const spec = board[tKey]?.spec;
        if (
          spec &&
          (spec.id === 'WATERFALL_BRIDGE' ||
            spec.id === 'BRIDGE_FLAT' ||
            spec.id === 'BRIDGE_HILL_A' ||
            spec.special === 'WATERFALL_BRIDGE' ||
            spec.special === 'BRIDGE_FLAT' ||
            spec.special === 'BRIDGE_HILL')
        ) {
          bridgeCount += 1;
        }
      }
      return 1 * numTiles + 3 * bridgeCount;
    }

    if (chain.featureType === 'CITY') {
      return 2 * numTiles;
    }

    // WATER
    let waterfallCount = 0;
    for (const tKey of chain.tileKeys) {
      const spec = board[tKey]?.spec;
      if (
        spec &&
        (spec.id === 'WATERFALL_BRIDGE' ||
          spec.id === 'WATERFALL_BEND' ||
          spec.special === 'WATERFALL_BRIDGE' ||
          spec.special === 'WATERFALL')
      ) {
        waterfallCount += 1;
      }
    }
    return 2 * numTiles + 3 * waterfallCount;
  }

  // Incomplete chain at game over (half points)
  if (chain.featureType === 'CITY' || chain.featureType === 'WATER') {
    return 1 * numTiles;
  }
  return 0.5 * numTiles;
}

function getMajorityOwners(meeples: ChainMeeple[]): PlayerId[] {
  let count1 = 0;
  let count2 = 0;
  for (const m of meeples) {
    if (m.playerId === 1) count1 += 1;
    else if (m.playerId === 2) count2 += 1;
  }
  const max = Math.max(count1, count2);
  if (max === 0) return [];
  const winners: PlayerId[] = [];
  if (count1 === max) winners.push(1);
  if (count2 === max) winners.push(2);
  return winners;
}

export function createInitialState(): GameState {
  const startSpec = DECK[0];
  const startTile: PlacedTile = {
    x: 0,
    z: 0,
    specId: startSpec.id,
    spec: startSpec,
    rotation: 0,
    level: 0,
    crownLevel: Math.max(...startSpec.edgeLevels),
    meeple: null,
    turnPlaced: 0,
  };

  return {
    board: {
      [coordKey(0, 0)]: startTile,
    },
    deckIndex: 1,
    currentTile: DECK[1] ?? null,
    currentRotation: 0,
    activePlayer: 1,
    players: {
      1: {
        id: 1,
        name: 'Player 1',
        color: '#1e5aa8',
        score: 0,
        meeplesAvailable: 3,
      },
      2: {
        id: 2,
        name: 'Player 2',
        color: '#d96b27',
        score: 0,
        meeplesAvailable: 3,
      },
    },
    discards: 0,
    gameOver: false,
    events: [],
    completedChains: 0,
    turnNumber: 1,
  };
}

export function getLegalMovesForTile(
  board: Record<string, PlacedTile>,
  spec: TileSpec,
  meeplesAvailable: number,
  rotation?: Rotation,
): LegalMove[] {
  const rotations: Rotation[] = rotation !== undefined ? [rotation] : [0, 1, 2, 3];
  const candidateMap = new Map<string, { x: number; z: number }>();

  for (const placed of Object.values(board)) {
    for (const offset of DIR_OFFSETS) {
      const cx = placed.x + offset.dx;
      const cz = placed.z + offset.dz;
      const key = coordKey(cx, cz);
      if (!board[key] && !candidateMap.has(key)) {
        candidateMap.set(key, { x: cx, z: cz });
      }
    }
  }

  const candidates = Array.from(candidateMap.values()).sort((a, b) =>
    a.z !== b.z ? a.z - b.z : a.x - b.x,
  );

  const legalMoves: LegalMove[] = [];

  for (const { x, z } of candidates) {
    for (const rot of rotations) {
      const candEdges = getRotatedEdges(spec, rot);
      const candLevels = getRotatedEdgeLevels(spec, rot);

      let impliedLevel: number | null = null;
      let valid = true;
      let neighborCount = 0;

      for (const offset of DIR_OFFSETS) {
        const nx = x + offset.dx;
        const nz = z + offset.dz;
        const neighbor = board[coordKey(nx, nz)];
        if (!neighbor) {
          continue;
        }
        neighborCount += 1;

        const neighborEdges = getRotatedEdges(neighbor.spec, neighbor.rotation);
        const neighborLevels = getRotatedEdgeLevels(neighbor.spec, neighbor.rotation);

        if (candEdges[offset.dir] !== neighborEdges[offset.opposite]) {
          valid = false;
          break;
        }

        const expectedLevel =
          neighbor.level + neighborLevels[offset.opposite] - candLevels[offset.dir];
        if (impliedLevel === null) {
          impliedLevel = expectedLevel;
        } else if (impliedLevel !== expectedLevel) {
          valid = false;
          break;
        }
      }

      if (!valid || neighborCount === 0 || impliedLevel === null) {
        continue;
      }

      const crownLevel = impliedLevel + Math.max(...candLevels);
      const legalMeepleEdges: LegalMove['legalMeepleEdges'] = [];

      if (meeplesAvailable > 0) {
        const hypoTile: PlacedTile = {
          x,
          z,
          specId: spec.id,
          spec,
          rotation: rot,
          level: impliedLevel,
          crownLevel,
          meeple: null,
          turnPlaced: -1,
        };
        const hypoBoard: Record<string, PlacedTile> = {
          ...board,
          [coordKey(x, z)]: hypoTile,
        };

        for (const dir of [0, 1, 2, 3] as DirIndex[]) {
          const edgeType = candEdges[dir];
          if (edgeType !== 'GRASS') {
            const chain = traceFeatureChain(hypoBoard, x, z, dir);
            if (chain && chain.meeples.length === 0) {
              legalMeepleEdges.push({
                edgeIndex: dir,
                featureType: edgeType,
              });
            }
          }
        }
      }

      legalMoves.push({
        x,
        z,
        rotation: rot,
        impliedLevel,
        crownLevel,
        legalMeepleEdges,
      });
    }
  }

  return legalMoves;
}

export function getLegalMoves(state: GameState, rotation?: Rotation): LegalMove[] {
  if (state.gameOver || !state.currentTile) {
    return [];
  }
  const activePlayerState = state.players[state.activePlayer];
  return getLegalMovesForTile(
    state.board,
    state.currentTile,
    activePlayerState.meeplesAvailable,
    rotation,
  );
}

export function applyMove(state: GameState, move: Move): GameState {
  if (state.gameOver || !state.currentTile) {
    throw new Error('Cannot apply move: game is already over.');
  }

  const legalMoves = getLegalMoves(state, move.rotation);
  const matchingLegal = legalMoves.find(
    (m) => m.x === move.x && m.z === move.z && m.rotation === move.rotation,
  );

  if (!matchingLegal) {
    throw new Error(
      `Illegal move for tile ${state.currentTile.id} at (${move.x}, ${move.z}) with rotation ${move.rotation}.`,
    );
  }

  const activePlayer = state.activePlayer;
  const players: GameState['players'] = {
    1: { ...state.players[1] },
    2: { ...state.players[2] },
  };
  const board: Record<string, PlacedTile> = {};
  for (const [k, v] of Object.entries(state.board)) {
    board[k] = {
      ...v,
      meeple: v.meeple ? { ...v.meeple } : null,
    };
  }
  const events: ScoreEvent[] = [...state.events];
  let completedChains = state.completedChains;
  const spec = state.currentTile;

  // Validate optional meeple placement
  let placedMeeple: PlacedTile['meeple'] = null;
  if (move.meeple) {
    const isLegalMeeple = matchingLegal.legalMeepleEdges.some(
      (e) =>
        e.edgeIndex === move.meeple!.edgeIndex && e.featureType === move.meeple!.featureType,
    );
    if (!isLegalMeeple) {
      throw new Error(
        `Illegal meeple placement on edge ${move.meeple.edgeIndex} (${move.meeple.featureType}) at (${move.x}, ${move.z}).`,
      );
    }
    players[activePlayer].meeplesAvailable -= 1;
    placedMeeple = {
      playerId: activePlayer,
      edgeIndex: move.meeple.edgeIndex,
      featureType: move.meeple.featureType,
    };
  }

  const newTile: PlacedTile = {
    x: move.x,
    z: move.z,
    specId: spec.id,
    spec,
    rotation: move.rotation,
    level: matchingLegal.impliedLevel,
    crownLevel: matchingLegal.crownLevel,
    meeple: placedMeeple,
    turnPlaced: state.turnNumber,
  };

  board[coordKey(move.x, move.z)] = newTile;

  // Evaluate all unique feature chains touched by the newly placed tile
  // (Points are ONLY scored when a feature chain is completed, and half-points at the end of the game)
  const visitedSocketKeys = new Set<string>();
  const rotatedEdges = getRotatedEdges(spec, move.rotation);

  for (const dir of [0, 1, 2, 3] as DirIndex[]) {
    if (rotatedEdges[dir] === 'GRASS') {
      continue;
    }
    const startSocketKey = `${move.x},${move.z},${dir}`;
    if (visitedSocketKeys.has(startSocketKey)) {
      continue;
    }

    const chain = traceFeatureChain(board, move.x, move.z, dir);
    if (!chain) {
      continue;
    }

    for (const nk of chain.nodeKeys) {
      visitedSocketKeys.add(nk);
    }

    if (chain.completed) {
      completedChains += 1;

      if (chain.meeples.length > 0) {
        const points = calculateChainPoints(board, chain, true);
        const winners = getMajorityOwners(chain.meeples);

        for (const winnerId of winners) {
          players[winnerId].score += points;
          events.push({
            turn: state.turnNumber,
            playerId: winnerId,
            points,
            reason: `Completed ${chain.featureType} chain (${chain.tileKeys.size} tiles)`,
            featureType: chain.featureType,
            completed: true,
          });
        }

        // Return all meeples on this completed chain to their owners
        for (const m of chain.meeples) {
          const tileWithMeeple = board[coordKey(m.x, m.z)];
          if (tileWithMeeple && tileWithMeeple.meeple) {
            players[m.playerId].meeplesAvailable += 1;
            tileWithMeeple.meeple = null;
          }
        }
      }
    }
  }

  // 3. Advance deckIndex and auto-discard any unplayable tiles
  let nextDeckIndex = state.deckIndex + 1;
  let discards = state.discards;
  const nextActivePlayer: PlayerId = activePlayer === 1 ? 2 : 1;

  while (nextDeckIndex < DECK.length) {
    const candidateSpec = DECK[nextDeckIndex];
    const movesForCandidate = getLegalMovesForTile(
      board,
      candidateSpec,
      players[nextActivePlayer].meeplesAvailable,
    );
    if (movesForCandidate.length > 0) {
      break;
    }
    discards += 1;
    nextDeckIndex += 1;
  }

  const gameOver = nextDeckIndex >= DECK.length;
  const currentTile = gameOver ? null : DECK[nextDeckIndex];
  const turnNumber = state.turnNumber + 1;

  // 4. End-game incomplete chain scoring when deck is exhausted
  if (gameOver) {
    const scoredIncompleteSockets = new Set<string>();
    const placedTiles = Object.values(board).sort((a, b) => a.turnPlaced - b.turnPlaced);

    for (const tile of placedTiles) {
      if (!tile.meeple) {
        continue;
      }
      const socketKey = `${tile.x},${tile.z},${tile.meeple.edgeIndex}`;
      if (scoredIncompleteSockets.has(socketKey)) {
        continue;
      }

      const chain = traceFeatureChain(board, tile.x, tile.z, tile.meeple.edgeIndex);
      if (!chain || chain.completed) {
        continue;
      }

      for (const nk of chain.nodeKeys) {
        scoredIncompleteSockets.add(nk);
      }

      const points = calculateChainPoints(board, chain, false);
      const winners = getMajorityOwners(chain.meeples);

      for (const winnerId of winners) {
        players[winnerId].score += points;
        events.push({
          turn: state.turnNumber,
          playerId: winnerId,
          points,
          reason: `End-game incomplete ${chain.featureType} chain (${chain.tileKeys.size} tiles)`,
          featureType: chain.featureType,
          completed: false,
        });
      }
    }
  }

  return {
    board,
    deckIndex: nextDeckIndex,
    currentTile,
    currentRotation: 0,
    activePlayer: nextActivePlayer,
    players,
    discards,
    gameOver,
    events,
    completedChains,
    turnNumber,
  };
}

export function runReplay(moves: readonly Move[], initialState?: GameState): GameState {
  let state = initialState ?? createInitialState();
  for (const move of moves) {
    if (state.gameOver) {
      break;
    }
    state = applyMove(state, move);
  }
  return state;
}
