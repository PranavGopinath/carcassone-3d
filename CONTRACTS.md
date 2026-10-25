# Contracts & ownership

`src/contracts/` is the only code both sides depend on. **Changing it takes a small PR that the other owner approves.** Everything else is owned by one person, and only their agents edit it. Elili's Tiers game prompt is the source of truth for rules; anything below marked *added* fills a gap in it.

| Path | Owner | Notes |
|---|---|---|
| `src/contracts/` | both | Types, deck, geometry helpers, `window.__game`, renderer interface |
| `fixtures/` | both | Saved boards. The loop records against these, so don't change one during a loop run |
| `src/logic/` | Elili | Pure rules. No DOM, no THREE. `engine.ts` signatures are the contract |
| `src/ui/`, `src/bot/` | Elili | HUD, tile dock, score track, pass-and-play, demo bot |
| `tests/` | both | Each side tests its own modules; `contracts.test.ts` is shared |
| `src/render/` | Pranav | Implements `Renderer`. The audit loop may only patch files here |
| `scripts/`, `runs/` | Pranav | Recorder, audit loop, dashboard. `runs/` is gitignored |
| `src/main.ts` | Pranav | Wiring only. Keep it small |

## Glossary

- **side**: what's on one edge of a tile (grass, city, road, water). Used to check whether two tiles fit.
- **heights**: optional per-edge level step. Only waterfalls have one (outflow is `-1`). Everything else is flat.
- **special**: a whole-tile property (bridge, waterfall, spring, lake, hill). Decides the 3D model and bonus points.
- **feature / featureId**: something you can put a meeple on. A tile can have a city and a road, so `featureId` says which one.
- **rotation**: the R key turns the tile clockwise. We store "tile + number of turns" instead of a rotated copy.
- **level**: a placed tile's elevation. The engine works it out from the neighbours.
- **engine** (`src/logic/engine.ts`): the rules code (legal moves, scoring). No graphics.
- **renderer** (`src/render/`): draws the board. No rules.
- **stub**: a placeholder with the right function names but fake insides, so the other person isn't blocked.

## Placement rule

Edges are `[N, E, S, W]`. Grid `+y` is south. Two touching edges must match in **side** and in **absolute height** (`level + heights[edge]`, after rotation). See `edgesMatch` in `src/contracts/tiles.ts`. This one rule covers "normal neighbours share a level" and waterfalls (±1 depending on which side you attach from).

## Scoring (from the spec)

| Feature | Completed | Incomplete at game end (with a meeple) |
|---|---|---|
| City | 2 / tile | 1 / tile |
| Road | 1 / tile + 3 / bridge | 1 / tile |
| River | 2 / tile + 3 / waterfall | 1 / tile |

- Most meeples on a chain takes all the points. On a tie, both players score full points. Meeples return to their owners straight away.
- A bridge's road and river are separate chains.
- Rivers complete when capped at both ends (spring, lake, or a loop).
- Grass never scores. No farmers.

## Added rules (gaps in the spec)

1. A drawn tile with no legal spot is discarded and the next one is drawn.
2. "Unoccupied feature" means the whole connected chain: you can't put a meeple on a chain that already has one. Shared chains only happen when a tile later joins two claimed chains.
3. A chain scores the moment it completes, whoever placed the closing tile. Chains with no meeple score nobody.
4. A new tile must touch at least one placed tile.
5. Height steps rotate with the tile ("S is level −1" refers to the unrotated tile).

## Decided

- **Bridges** arch the road up one level over the river or chasm and back down again. Their edges stay flat, so the road continues at the same level on both sides. The arch is drawn by the renderer, and each bridge still adds +3 to its road.
- **HILL_MEADOW** has flat edges and a raised mound in the middle, drawn by the renderer.
- **Elevation changes** on the board therefore come only from waterfalls.

## URL params

- `?fixture=demo-board`: load `fixtures/demo-board.json`
- `?tile=WATERFALL_1`: workbench, renders one tile alone
- `?clock=manual`: frame-exact rendering via `window.__game.renderFrame(tMs)`
