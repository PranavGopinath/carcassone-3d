import type { TileDef } from './types';

/** Fixed 20-tile deck from the Tiers spec, drawn in order. DECK[0] is pre-placed at (0, 0), level 0. */
export const DECK: TileDef[] = [
  { id: 'START', name: 'Starting River', sides: ['GRASS', 'WATER', 'GRASS', 'WATER'],
    features: [{ id: 'river', kind: 'RIVER', sides: [1, 3] }] },
  { id: 'ROAD_1', name: 'Road', sides: ['ROAD', 'GRASS', 'ROAD', 'GRASS'],
    features: [{ id: 'road', kind: 'ROAD', sides: [0, 2] }] },
  { id: 'RIVER_CURV_1', name: 'River Bend', sides: ['WATER', 'WATER', 'GRASS', 'GRASS'],
    features: [{ id: 'river', kind: 'RIVER', sides: [0, 1] }] },
  { id: 'WATERFALL_1', name: 'Waterfall', sides: ['WATER', 'GRASS', 'WATER', 'GRASS'],
    heights: [0, 0, -1, 0], special: 'WATERFALL',
    features: [{ id: 'river', kind: 'RIVER', sides: [0, 2] }] },
  { id: 'CITY_1', name: 'City Wall & Road', sides: ['CITY', 'ROAD', 'GRASS', 'ROAD'],
    features: [
      { id: 'city', kind: 'CITY', sides: [0] },
      { id: 'road', kind: 'ROAD', sides: [1, 3] },
    ] },
  { id: 'BRIDGE_1', name: 'Stone Bridge', sides: ['ROAD', 'WATER', 'ROAD', 'WATER'],
    special: 'BRIDGE',
    features: [
      { id: 'road', kind: 'ROAD', sides: [0, 2] },
      { id: 'river', kind: 'RIVER', sides: [1, 3] },
    ] },
  { id: 'RIVER_SPRING', name: 'Mountain Spring', sides: ['WATER', 'GRASS', 'GRASS', 'GRASS'],
    special: 'SPRING',
    features: [{ id: 'river', kind: 'RIVER', sides: [0] }] },
  { id: 'ROAD_CURV_1', name: 'Road Curve', sides: ['GRASS', 'ROAD', 'ROAD', 'GRASS'],
    features: [{ id: 'road', kind: 'ROAD', sides: [1, 2] }] },
  { id: 'CITY_2', name: 'Dense City Block', sides: ['CITY', 'CITY', 'GRASS', 'CITY'],
    features: [{ id: 'city', kind: 'CITY', sides: [0, 1, 3] }] },
  { id: 'BRIDGE_2', name: 'Stone Bridge', sides: ['WATER', 'ROAD', 'WATER', 'ROAD'],
    special: 'BRIDGE',
    features: [
      { id: 'road', kind: 'ROAD', sides: [1, 3] },
      { id: 'river', kind: 'RIVER', sides: [0, 2] },
    ] },
  { id: 'WATERFALL_2', name: 'Corner Waterfall', sides: ['GRASS', 'WATER', 'WATER', 'GRASS'],
    heights: [0, 0, -1, 0], special: 'WATERFALL',
    features: [{ id: 'river', kind: 'RIVER', sides: [1, 2] }] },
  { id: 'ROAD_2', name: 'Road', sides: ['GRASS', 'ROAD', 'GRASS', 'ROAD'],
    features: [{ id: 'road', kind: 'ROAD', sides: [1, 3] }] },
  { id: 'CITY_ROAD_1', name: 'Road Hub & City', sides: ['CITY', 'ROAD', 'ROAD', 'ROAD'],
    features: [
      { id: 'city', kind: 'CITY', sides: [0] },
      { id: 'road_e', kind: 'ROAD', sides: [1] },
      { id: 'road_s', kind: 'ROAD', sides: [2] },
      { id: 'road_w', kind: 'ROAD', sides: [3] },
    ] },
  { id: 'RIVER_LAKE', name: 'Lake Basin', sides: ['GRASS', 'GRASS', 'WATER', 'GRASS'],
    special: 'LAKE',
    features: [{ id: 'river', kind: 'RIVER', sides: [2] }] },
  { id: 'BRIDGE_3', name: 'Chasm Bridge', sides: ['ROAD', 'GRASS', 'ROAD', 'GRASS'],
    special: 'BRIDGE',
    features: [{ id: 'road', kind: 'ROAD', sides: [0, 2] }] },
  { id: 'WATERFALL_3', name: 'Waterfall Cascade', sides: ['WATER', 'WATER', 'GRASS', 'GRASS'],
    heights: [0, -1, 0, 0], special: 'WATERFALL',
    features: [{ id: 'river', kind: 'RIVER', sides: [0, 1] }] },
  { id: 'CITY_3', name: 'Castle Keep', sides: ['CITY', 'CITY', 'CITY', 'GRASS'],
    features: [{ id: 'city', kind: 'CITY', sides: [0, 1, 2] }] },
  { id: 'RIVER_CURV_2', name: 'River Bend', sides: ['GRASS', 'WATER', 'WATER', 'GRASS'],
    features: [{ id: 'river', kind: 'RIVER', sides: [1, 2] }] },
  // "Elevated hill meadow": edges stay flat so it fits anywhere; the hill is a 3D mound in the middle.
  { id: 'HILL_MEADOW', name: 'Hill Meadow', sides: ['GRASS', 'GRASS', 'GRASS', 'GRASS'],
    special: 'HILL', features: [] },
  { id: 'CITY_ROAD_END', name: 'Grand Hub', sides: ['CITY', 'ROAD', 'GRASS', 'ROAD'],
    features: [
      { id: 'city', kind: 'CITY', sides: [0] },
      { id: 'road', kind: 'ROAD', sides: [1, 3] },
    ] },
];

export const TILES: ReadonlyMap<string, TileDef> = new Map(DECK.map((t) => [t.id, t]));

export function getTile(id: string): TileDef {
  const def = TILES.get(id);
  if (!def) throw new Error(`Unknown tile id: ${id}`);
  return def;
}
