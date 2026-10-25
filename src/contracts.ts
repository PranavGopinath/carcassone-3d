/**
 * Shared Contracts for Tiers (Carcassonne-3D)
 * Owned by: lead_architect (`src/contracts.ts`)
 */

export type EdgeType = 'GRASS' | 'ROAD' | 'CITY' | 'WATER';

/** 0 = North (-Z), 1 = East (+X), 2 = South (+Z), 3 = West (-X) */
export type DirIndex = 0 | 1 | 2 | 3;

/** Clockwise 90-degree increments: 0 = 0°, 1 = 90° CW, 2 = 180°, 3 = 270° CW */
export type Rotation = 0 | 1 | 2 | 3;

export const DIR_NAMES = ['N', 'E', 'S', 'W'] as const;

export const DIR_OFFSETS: ReadonlyArray<{
  dir: DirIndex;
  name: 'N' | 'E' | 'S' | 'W';
  dx: number;
  dz: number;
  opposite: DirIndex;
}> = [
  { dir: 0, name: 'N', dx: 0, dz: -1, opposite: 2 },
  { dir: 1, name: 'E', dx: 1, dz: 0, opposite: 3 },
  { dir: 2, name: 'S', dx: 0, dz: 1, opposite: 0 },
  { dir: 3, name: 'W', dx: -1, dz: 0, opposite: 1 },
];

export const LEVEL_HEIGHT = 0.5;

export type SpecialType =
  | 'NONE'
  | 'WATERFALL_BRIDGE'
  | 'BRIDGE_FLAT'
  | 'BRIDGE_HILL'
  | 'GRASS_HILL'
  | 'GRASS_PLATEAU'
  | 'LAKE'
  | 'SPRING'
  | 'CLOISTER'
  | 'WATERFALL'
  | 'CITY_GATE'
  | 'ROAD_JUNCTION'
  | 'RIVER_JUNCTION'
  | 'CITY_SEPARATE';

export interface TileSpec {
  id: string;
  name: string;
  /** Edges ordered [N, E, S, W] at rotation 0 */
  edges: readonly [EdgeType, EdgeType, EdgeType, EdgeType];
  /** Tile-local integer level offsets [N, E, S, W] at rotation 0 */
  edgeLevels: readonly [number, number, number, number];
  special: SpecialType;
  description: string;
}

export function rotateArray4<T>(arr: readonly [T, T, T, T], rotation: Rotation): [T, T, T, T] {
  const r = ((rotation % 4) + 4) % 4;
  return [
    arr[(0 - r + 4) % 4],
    arr[(1 - r + 4) % 4],
    arr[(2 - r + 4) % 4],
    arr[(3 - r + 4) % 4],
  ];
}

export function getRotatedEdges(spec: TileSpec, rotation: Rotation): [EdgeType, EdgeType, EdgeType, EdgeType] {
  return rotateArray4(spec.edges, rotation);
}

export function getRotatedEdgeLevels(spec: TileSpec, rotation: Rotation): [number, number, number, number] {
  return rotateArray4(spec.edgeLevels, rotation);
}

export function isElevationChanger(spec: TileSpec): boolean {
  return spec.edgeLevels.some((lvl) => lvl !== 0);
}

/**
 * Canonical 20-Tile Deck Specification (Prompt 1 Section 4)
 */
export const DECK: readonly TileSpec[] = [
  {
    id: 'START_CITY_ROAD',
    name: 'Starter City & Road',
    edges: ['CITY', 'ROAD', 'GRASS', 'ROAD'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'Classic Carcassonne starter at level 0. City on North, straight Road East-West, Meadow South.',
  },
  {
    id: 'ROAD_CURVE_A',
    name: 'Road Curve',
    edges: ['GRASS', 'ROAD', 'ROAD', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'Road covers 2 adjacent edges (E-S), connects to starter road.',
  },
  {
    id: 'CITY_CORNER_A',
    name: 'Corner Citadel A',
    edges: ['CITY', 'CITY', 'GRASS', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'City covers 2 adjacent edges (N-E) with wall and corner wrap.',
  },
  {
    id: 'GRASS_HILL_A',
    name: 'Terraced Grass Hill',
    edges: ['GRASS', 'GRASS', 'GRASS', 'GRASS'],
    edgeLevels: [1, 0, 0, 0],
    special: 'GRASS_HILL',
    description: 'First Elevation (+2 pts): Grass hill slopes upward from level 0 to Level +1 on North.',
  },
  {
    id: 'WATERFALL_BRIDGE',
    name: 'Waterfall Arch Bridge',
    edges: ['WATER', 'ROAD', 'WATER', 'ROAD'],
    edgeLevels: [0, 0, -1, 0],
    special: 'WATERFALL_BRIDGE',
    description: 'Waterfall & River Intro (+2 pts): Road crosses E-W on bridge; river plunges S into sunken canyon (L-1).',
  },
  {
    id: 'RIVER_STRAIGHT_LOW',
    name: 'Canyon River Straight',
    edges: ['GRASS', 'WATER', 'GRASS', 'WATER'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'River continues straight in sunken canyon (L-1).',
  },
  {
    id: 'BRIDGE_FLAT',
    name: 'Stone Arch Bridge',
    edges: ['ROAD', 'WATER', 'ROAD', 'WATER'],
    edgeLevels: [0, 0, 0, 0],
    special: 'BRIDGE_FLAT',
    description: 'Flat arch bridge: Road N-S over River E-W.',
  },
  {
    id: 'ROAD_STRAIGHT_A',
    name: 'Highway Straight',
    edges: ['ROAD', 'GRASS', 'ROAD', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'Road covers 2 opposite edges (N-S).',
  },
  {
    id: 'CITY_TWO_EDGES_STRAIGHT',
    name: 'Twin City Gates',
    edges: ['CITY', 'GRASS', 'CITY', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'CITY_SEPARATE',
    description: 'Two parallel city walls on N and S with grass corridor between.',
  },
  {
    id: 'BRIDGE_HILL_A',
    name: 'Climbing Hill Bridge',
    edges: ['ROAD', 'WATER', 'ROAD', 'WATER'],
    edgeLevels: [1, 0, 0, 0],
    special: 'BRIDGE_HILL',
    description: 'Hill Bridge (+2 pts): Road climbs S(0) to N(+1) over River E-W.',
  },
  {
    id: 'RIVER_BEND_A',
    name: 'River Bend',
    edges: ['WATER', 'WATER', 'GRASS', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'River covers 2 adjacent edges (N-E).',
  },
  {
    id: 'CITY_CORNER_B',
    name: 'Corner Citadel B',
    edges: ['GRASS', 'CITY', 'CITY', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'City covers 2 adjacent edges (E-S).',
  },
  {
    id: 'ROAD_BRANCH_3WAY',
    name: 'Crossroads Village',
    edges: ['GRASS', 'ROAD', 'ROAD', 'ROAD'],
    edgeLevels: [0, 0, 0, 0],
    special: 'ROAD_JUNCTION',
    description: '3-way road intersection branching East, South, West.',
  },
  {
    id: 'RIVER_LAKE_LOW',
    name: 'Canyon Lake Basin',
    edges: ['GRASS', 'GRASS', 'WATER', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'LAKE',
    description: 'Lake basin end-cap terminating river in canyon (L-1).',
  },
  {
    id: 'CLOISTER_MEADOW',
    name: 'Hilltop Monastery',
    edges: ['GRASS', 'GRASS', 'ROAD', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'CLOISTER',
    description: 'Monastery centered in meadow with road exiting South.',
  },
  {
    id: 'WATERFALL_BEND',
    name: 'Plunging Waterfall Bend',
    edges: ['WATER', 'WATER', 'GRASS', 'GRASS'],
    edgeLevels: [0, -1, 0, 0],
    special: 'WATERFALL',
    description: 'River N(0) plunges over cliff out East(-1) (+2 pts).',
  },
  {
    id: 'CITY_BIG_3EDGE',
    name: 'Grand Stronghold',
    edges: ['CITY', 'CITY', 'CITY', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'NONE',
    description: 'Large city covering 3 edges (N, E, S) with grass notch on W.',
  },
  {
    id: 'GRASS_PLATEAU',
    name: 'High Crown Plateau',
    edges: ['GRASS', 'GRASS', 'GRASS', 'GRASS'],
    edgeLevels: [1, 1, 1, 1],
    special: 'GRASS_PLATEAU',
    description: 'High plateau meadow resting entirely at level +1 (+2 pts).',
  },
  {
    id: 'RIVER_FORK_DELTA',
    name: 'River Delta Fork',
    edges: ['WATER', 'WATER', 'GRASS', 'WATER'],
    edgeLevels: [0, 0, 0, 0],
    special: 'RIVER_JUNCTION',
    description: 'River delta branching into 3 directions (N, E, W).',
  },
  {
    id: 'CITY_GATE_ROAD',
    name: 'Fortified City Gate',
    edges: ['CITY', 'GRASS', 'ROAD', 'GRASS'],
    edgeLevels: [0, 0, 0, 0],
    special: 'CITY_GATE',
    description: 'Road from South terminates at fortified city gate.',
  },
];

export const TILE_BY_ID: ReadonlyMap<string, TileSpec> = new Map(DECK.map((t) => [t.id, t]));

/**
 * Palette classification used by `painter.ts` and `probe.ts`
 */
export type PaletteClass = 'GRASS' | 'ROAD' | 'CITY' | 'WATER';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const PALETTE: Record<PaletteClass, RGB> = {
  GRASS: { r: 108, g: 166, b: 76 },
  ROAD: { r: 214, g: 196, b: 156 },
  CITY: { r: 196, g: 138, b: 92 },
  WATER: { r: 62, g: 142, b: 208 },
};

export type PlayerId = 1 | 2;

export interface MeeplePlacement {
  playerId: PlayerId;
  /** Rotated side index (0=N, 1=E, 2=S, 3=W) identifying the feature segment on this tile */
  edgeIndex: DirIndex;
  featureType: Exclude<EdgeType, 'GRASS'>;
}

export interface PlacedTile {
  x: number;
  z: number;
  specId: string;
  spec: TileSpec;
  rotation: Rotation;
  /** World base level of the tile (integer, e.g., -1, 0, +1) */
  level: number;
  /** Effective max surface elevation (level + max(edgeLevels)) for Top-Point Crown Framing */
  crownLevel: number;
  meeple: MeeplePlacement | null;
  turnPlaced: number;
}

export interface Move {
  x: number;
  z: number;
  rotation: Rotation;
  meeple?: {
    edgeIndex: DirIndex;
    featureType: Exclude<EdgeType, 'GRASS'>;
  } | null;
}

export interface LegalMove {
  x: number;
  z: number;
  rotation: Rotation;
  impliedLevel: number;
  crownLevel: number;
  legalMeepleEdges: Array<{
    edgeIndex: DirIndex;
    featureType: Exclude<EdgeType, 'GRASS'>;
  }>;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  score: number;
  meeplesAvailable: number;
}

export interface ScoreEvent {
  turn: number;
  playerId: PlayerId;
  points: number;
  reason: string;
  featureType?: Exclude<EdgeType, 'GRASS'> | 'ELEVATION';
  completed: boolean;
}

export interface GameState {
  board: Record<string, PlacedTile>;
  deckIndex: number;
  currentTile: TileSpec | null;
  currentRotation: Rotation;
  activePlayer: PlayerId;
  players: Record<PlayerId, PlayerState>;
  discards: number;
  gameOver: boolean;
  events: ScoreEvent[];
  completedChains: number;
  turnNumber: number;
}

export type ViewMode = '2d' | '3d';
export type ThemeMode = 'day' | 'golden' | 'overcast';
export type QualityMode = 'high' | 'low';

export const REQUIRED_SHOTS = [
  'board-2d',
  'terrace-overview',
  'waterfall-macro',
  'bridge-hill-macro',
  'cliff-closeup',
  'city-closeup',
  'meeple-ground',
  'underside-slab',
] as const;

export type ShotName = (typeof REQUIRED_SHOTS)[number];

export interface AuditMark {
  shot: string;
  x: number;
  y: number;
  label: string;
}

export interface ViewConsistencyEntry {
  tileKey: string;
  specId: string;
  rotation: Rotation;
  features2d: string[];
  features3d: string[];
  mismatches: string[];
}

export interface AuditReport {
  ok: boolean;
  floatingProps: number;
  missingPolygonOffset: number;
  uvStretchOutliers: number;
  ungroundedMeeples: number;
  waterSeamMismatches: number;
  webglWarnings: number;
  hudMatchesState?: boolean;
  viewConsistency?: {
    ok: boolean;
    tiles: ViewConsistencyEntry[];
    mismatches: string[];
  };
  marks?: {
    floatingProps: AuditMark[];
    ungroundedMeeples: AuditMark[];
    tileLabels: AuditMark[];
    [key: string]: AuditMark[];
  };
  details: string[];
}

export interface InspectorAPI {
  ready: boolean;
  getState(): GameState;
  getLegalMoves(rotation?: Rotation): LegalMove[];
  applyMove(move: Move): GameState;
  botMove(): GameState;
  showLegalMoves(on: boolean): void;
  runReplay(moves: Move[]): GameState;
  setView(mode: ViewMode, instant?: boolean): void;
  getView(): ViewMode;
  setQuality(quality: QualityMode): void;
  setTheme(theme: ThemeMode): void;
  startDemo(): Promise<void>;
  renderAt(tSeconds: number): void;
  playAt(tSeconds: number): void;
  injectDefect(name: string | null): void;
  listShots(): ShotName[];
  captureShot(name: ShotName): string;
  getTileSheet(): HTMLCanvasElement;
  loadFixture(name: string): GameState;
  audit(): AuditReport;
}

declare global {
  interface Window {
    __game?: InspectorAPI;
  }
}
