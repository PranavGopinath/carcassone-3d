// Shared data model for logic, render, UI and the audit loop.
// Changes here need sign-off from both owners (see CONTRACTS.md).

/** What's on one edge of a tile. Used to check whether two tiles fit. */
export type Side = 'GRASS' | 'CITY' | 'ROAD' | 'WATER';

/** Edge index: 0 = N, 1 = E, 2 = S, 3 = W. Arrays of four are always in this order. */
export type Dir = 0 | 1 | 2 | 3;

/** Clockwise quarter turns (the R key). */
export type Rotation = 0 | 1 | 2 | 3;

export type FeatureKind = 'CITY' | 'ROAD' | 'RIVER';

/** Something a meeple can stand on. `sides` are in the tile's unrotated frame. */
export interface Feature {
  id: string;
  kind: FeatureKind;
  sides: Dir[];
}

/** Whole-tile property: picks the 3D model and the bonus points. */
export type Special = 'BRIDGE' | 'WATERFALL' | 'SPRING' | 'LAKE' | 'HILL';

export interface TileDef {
  id: string;
  name: string;
  sides: [Side, Side, Side, Side];
  /**
   * Level step per edge, relative to the tile's level; omitted = all 0.
   * Only waterfalls use it (outflow is -1). Bridges arch up and come back down, so
   * their edges stay flat. Touching edges must match in side and in absolute height
   * (placement.level + step).
   */
  heights?: [number, number, number, number];
  features: Feature[];
  special?: Special;
}

export type PlayerId = 0 | 1;

export interface MeeplePlacement {
  player: PlayerId;
  featureId: string;
}

/** Grid coords: +x is east, +y is south (so N of (x, y) is (x, y - 1)). */
export interface Placement {
  tileId: string;
  x: number;
  y: number;
  rotation: Rotation;
  level: number;
  meeple?: MeeplePlacement;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  score: number;
  meeplesLeft: number;
}

export interface ChainRef {
  x: number;
  y: number;
  featureId: string;
}

export interface ScoreEvent {
  turn: number;
  players: PlayerId[];
  kind: FeatureKind;
  tiles: number;
  /** Number of BRIDGE tiles (roads) or WATERFALL tiles (rivers) in the chain. */
  bonusTiles: number;
  points: number;
  chain: ChainRef[];
  /** True for the end-of-game pass over incomplete chains. */
  final: boolean;
}

export interface GameState {
  placements: Placement[];
  players: [PlayerState, PlayerState];
  current: PlayerId;
  turn: number;
  /** Index into DECK of the tile in the dock. The game is over when this reaches DECK.length. */
  deckIndex: number;
  log: ScoreEvent[];
}

/** A full turn: place the docked tile, optionally put a meeple on one of its features. */
export interface Move {
  x: number;
  y: number;
  rotation: Rotation;
  meepleFeatureId: string | null;
}

/** A legal tile spot. `level` is derived by the engine from the neighbours. */
export interface LegalPlacement {
  x: number;
  y: number;
  rotation: Rotation;
  level: number;
  meepleOptions: string[];
}
