# Tiers (Carcassonne-3D) — Procedural Tile & Terrace Design Specification

This document defines the canonical procedural visual language, socket geometry contracts, color palette, 3D elevation terrace architecture, and the complete 20-tile visual and gameplay catalog for **Tiers**. All downstream modules (`src/tiles/painter.ts`, `src/tiles/probe.ts`, `src/render/`, and `src/logic/`) must adhere strictly to these invariants and contracts as exported in `src/contracts.ts`.

---

## 1. Exact Socket Geometry Rules (`[N, E, S, W]`)

Every tile is a square (default canvas size `256x256` px in 2D; `1.0 x 1.0` world units in 3D) with 4 edges ordered clockwise:
- `0`: **North (`N`, `-Z`)** — top edge (`v = 0`, `u` runs `0.0 -> 1.0` West-to-East)
- `1`: **East (`E`, `+X`)** — right edge (`u = 1`, `v` runs `0.0 -> 1.0` North-to-South)
- `2`: **South (`S`, `+Z`)** — bottom edge (`v = 1`, `u` runs `0.0 -> 1.0` West-to-East)
- `3`: **West (`W`, `-X`)** — left edge (`u = 0`, `v` runs `0.0 -> 1.0` North-to-South)

Each edge has exactly one `EdgeType`: `'GRASS' | 'ROAD' | 'CITY' | 'WATER'`.

### 1.1 Edge Socket Specifications

| Edge Type | Socket Width & Coverage | Edge Parameter `t in [0, 1]` Rules | Interior Geometry & Visual Treatment |
| :--- | :--- | :--- | :--- |
| **`ROAD`** | **16% of tile width** (`0.16 * size`, i.e., `41px` at `256px`), centered at edge midpoint (`t = 0.5`, spanning `t in [0.42, 0.58]`). | - `t = 0.5` (3px inset): **`ROAD`**<br>- `t < 0.25` and `t > 0.75` (specifically probed at `t = 0.1` and `t = 0.9`, 3px inset): **`GRASS`** | Runs from edge midpoint (`t = 0.5`) to tile center (`(0.5, 0.5)`). Straight stroke for opposite edges; quadratic Bézier curve through center for adjacent edges. Constant width, round joins, warm sand base with subtle cobble speckle. |
| **`WATER`** | **20% of tile width** (`0.20 * size`, i.e., `51.2px` at `256px`), centered at edge midpoint (`t = 0.5`, spanning `t in [0.40, 0.60]`). | - `t = 0.5` (3px inset): **`WATER`**<br>- `t < 0.25` and `t > 0.75` (specifically probed at `t = 0.1` and `t = 0.9`, 3px inset): **`GRASS`** | Runs from edge midpoint (`t = 0.5`) to tile center (`(0.5, 0.5)`). Straight or quadratic curve through center, bordered by a thin darker riverbank rim that stays strictly inside `[0.28, 0.72]` along the edge so outer probes remain `GRASS`. |
| **`CITY`** | **>= 90% of edge length** (`t in [0.05, 0.95]`) and **>= 28% of tile width depth** (`>= 0.28 * size`, i.e., `>= 72px` at `256px`) at the edge midpoint (`t = 0.5`). | - `t = 0.15, 0.50, 0.85` (3px inset): **`CITY`** | Tapers smoothly toward corners along a curved inner boundary rimmed by a fortified stone wall with crenellations. Interior filled with warm terracotta/ochre citadel ground, rows of small blue-slate roofs (kept clear of 3px edge probe insets), and tiny windows. |
| **`GRASS`** | **100% of edge length** (`t in [0.0, 1.0]`). | - `t = 0.10, 0.50, 0.90` (3px inset): **`GRASS`** | Seamless meadow base with subtle noise, diagonal mowing stripes, and (for hill/plateau tiles) contoured elevation rings. |

### 1.2 Corner Rules (`4px` Inset)
- **Default Corner Invariant:** All 4 corners of a tile (`(4, 4)`, `(size - 4, 4)`, `(size - 4, size - 4)`, `(4, size - 4)`) **MUST classify as `GRASS`** unless **BOTH** edges meeting at that corner are `'CITY'`.
- **Corner City Wrap:** When two adjacent edges are both `'CITY'` (e.g., `N` and `E` on `CITY_CORNER_A`, `E` and `S` on `CITY_CORNER_B`, or `N-E` and `E-S` on `CITY_BIG_3EDGE`), the city fill continuously wraps the shared corner (`4px` inset classifies as `'CITY'`), and the fortified wall rim forms a single concave arc across the tile interior.
- **No Floating Features:** Every road, river, or city must connect to at least one edge socket. The only permitted center terminations are:
  1. End-caps joined to their single edge (`LAKE`, `SPRING`, `CITY_GATE`).
  2. `CLOISTER` centered in a meadow (`CLOISTER_MEADOW` with south road).
  3. 3-way junctions (`ROAD_JUNCTION`, `RIVER_JUNCTION`).

### 1.3 Automated Probe & Seam Stitch Verification (`src/tiles/probe.ts`)
- **Nearest-Palette Classifier:** Any pixel `(r, g, b)` is classified into `PaletteClass` (`'GRASS' | 'ROAD' | 'CITY' | 'WATER'`) by minimum Euclidean RGB distance to `PALETTE`.
- **Seam Stitch Invariant:** For any two tiles placed edge-to-edge on a legal shared socket (`EdgeType` matches), 8 evenly spaced sample points along the shared seam (`inset = 3px` from each tile's border) must classify to the identical `PaletteClass` and match RGB values within tolerance.
- **Rotation Equivariance:** Calling `paintTile(ctx, spec, rotation, size)` for `rotation in {0, 1, 2, 3}` (clockwise `90°` steps) must produce socket classifications identical to `getRotatedEdges(spec, rotation)`.

---

## 2. Color Palette & Surface Accents

### 2.1 Canonical Primary `PALETTE` (`src/contracts.ts`)

The 4 primary terrain classes are anchored by exact RGB centroids in `src/contracts.ts`:

| `PaletteClass` | RGB Centroid (`src/contracts.ts`) | Hex | Visual Role & Classifier Guardrail |
| :--- | :--- | :--- | :--- |
| **`GRASS`** | `{ r: 108, g: 166, b: 76 }` | `#6CA64C` | Fertile valley meadow, hill terraces, and corner regions. Mowing stripes and hill contour bands vary lightness by `±8%` so every grass pixel remains unambiguously closest to `PALETTE.GRASS`. |
| **`ROAD`** | `{ r: 214, g: 196, b: 156 }` | `#D6C49C` | Limestone dirt & cobble roads. Speckles and wheel ruts stay within `±12` RGB units near the edge (`3px` inset) to guarantee clean `ROAD` classification. |
| **`CITY`** | `{ r: 196, g: 138, b: 92 }` | `#C48A5C` | Warm terracotta/ochre citadel plaza and fortified masonry. Within `6px` of any `CITY` edge or wrapped city corner, only base `CITY` terracotta and warm masonry variations are drawn so edge probes never misclassify as `WATER` or `ROAD`. |
| **`WATER`** | `{ r: 62, g: 142, b: 208 }` | `#3E8ED0` | Deep azure rivers, plunge pools, and canyon lakes. Flow ripples stay close to `#3E8ED0` near edge sockets. |

### 2.2 Accent Colors (Interior Details, Roofs, Bridges, Foam & UI Tabs)

To preserve deterministic pixel probing (`inset = 3px` on edges, `4px` on corners), all high-contrast accent colors are restricted to interior zones (`> 8px` inset from tile edges) or dedicated overlay markers:

| Accent Element | RGB Value | Hex | Placement & Usage Rules |
| :--- | :--- | :--- | :--- |
| **Grass Mowing Stripe (Light)** | `{ r: 118, g: 176, b: 84 }` | `#76B054` | Subtle alternating diagonal bands across `GRASS` regions. |
| **Grass Hill Contour (Dark)** | `{ r: 92, g: 146, b: 64 }` | `#5C9240` | Stepped elevation contour lines on `GRASS_HILL` and `GRASS_PLATEAU`. |
| **Blue-Slate City Roofs** | `{ r: 74, g: 98, b: 128 }` | `#4A6280` | Pitched roof clusters inside `CITY` polygons (`>= 12px` inset from tile border so they never trigger `WATER` false positives on `3px` probes). |
| **City Wall Rim & Merlons** | `{ r: 142, g: 96, b: 62 }` | `#8E603E` | Curved inner fortification wall and battlements separating `CITY` from `GRASS`. |
| **Cloister Terracotta Roof** | `{ r: 188, g: 76, b: 56 }` | `#BC4C38` | Cruciform monastery roof at the center of `CLOISTER_MEADOW`. |
| **Stone Bridge Deck & Parapet**| `{ r: 168, g: 162, b: 152 }` | `#A8A298` | Arched stone masonry and side parapets in the center `[0.30, 0.70]` of `BRIDGE_FLAT`, `BRIDGE_HILL_A`, and `WATERFALL_BRIDGE`. |
| **Waterfall Crest & Foam** | `{ r: 232, g: 244, b: 252 }` | `#E8F4FC` | Whitewater foam band, mist gradient, and plunge pool spray across the interior cliff line of `WATERFALL_BRIDGE` and `WATERFALL_BEND`. |
| **Cliff Strata Rock (3D)** | `{ r: 112, g: 104, b: 96 }` | `#706860` | Triplanar-mapped sedimentary rock layers (`#706860` to `#544D46`) on vertical cliff skirts and underside slabs. |
| **Level `-1` Cue Tab (`L-1`)** | `{ r: 56, g: 189, b: 248 }` | `#38BDF8` | Thin cyan/blue elevation indicator tab (`2px` thick, centered in `[0.30, 0.70]` outside the `3px` probe line or rendered as subtle inner badge) on edges with `edgeLevel < 0`. |
| **Level `+1` Cue Tab (`L+1`)** | `{ r: 245, g: 158, b: 11 }` | `#F59E0B` | Warm amber/gold elevation indicator tab on edges with `edgeLevel > 0`. |
| **Player 1 Meeple (Deep Blue)** | `{ r: 37, g: 99, b: 235 }` | `#2563EB` | Player 1 wooden meeple token and UI badge. |
| **Player 2 Meeple (Amber)** | `{ r: 217, g: 119, b: 6 }` | `#D97706` | Player 2 terracotta/amber wooden meeple token and UI badge. |

---

## 3. Elevation & 3D Terrace Architecture

### 3.1 World Elevation Constants & Implied Level Formula

- **Tile Dimensions:** `1.0` world unit wide (`X in [-0.5, +0.5]`) by `1.0` world unit deep (`Z in [-0.5, +0.5]`).
- **Level Step Height (`LEVEL_HEIGHT`):** `0.5` world units per integer elevation level (`src/contracts.ts`).
- **Edge World Height:** For a placed tile at integer world `level` and rotation `r`, the world Y height at side `s in {0, 1, 2, 3}` is:
  $$\text{edgeWorldY}(s) = (\text{tile.level} + \text{rotatedEdgeLevels}[s]) \times \text{LEVEL\_HEIGHT}$$
- **Implied Level Formula (Placement Legality):**
  When testing a candidate tile with rotated `edgeLevels` at empty cell `(x, z)` adjacent to a placed neighbor on side `s`:
  $$\text{impliedLevel}(s) = \text{neighbor.level} + \text{neighbor.rotatedEdgeLevels}[\text{opposite}(s)] - \text{rotatedEdgeLevels}[s]$$
  All present neighbors must yield the exact same integer `impliedLevel`, which becomes the placed tile's base `level`.
- **Crown Level (`crownLevel`):**
  $$\text{crownLevel} = \text{tile.level} + \max_{s \in \{0,1,2,3\}}(\text{rotatedEdgeLevels}[s])$$
  Used by the 3D camera controller for **Top-Point Crown Framing**, orienting the 35° isometric view so the highest plateau tiles (`L+1`) crown the top of the diorama while waterfalls cascade down to the lower canyon (`L-1`).

### 3.2 Procedural Terrain Heightfield: `tileHeight(spec, rotation, u, v)`

Each tile surface in 3D is a `16 x 16` subdivided grid mesh over normalized coordinates `(u, v) in [0, 1]^2` (`u = 0` West to `u = 1` East; `v = 0` North to `v = 1` South). To handle rotation cleanly, transform `(u, v)` into unrotated tile-local coordinates `(u0, v0)` according to `rotation`, evaluate the canonical profile below, and multiply by `LEVEL_HEIGHT * morphScale` (`morphScale = 0` in 2D view, `1` in 3D view):

$$\text{worldY}(u, v) = \left(\text{tile.level} + \text{localHeight}(u_0, v_0)\right) \times \text{LEVEL\_HEIGHT} \times \text{morphScale}$$

#### Canonical `localHeight(u0, v0)` Profiles (at `rotation = 0`, in level units where `1.0 = LEVEL_HEIGHT = 0.5` world units):

1. **`NONE`, `BRIDGE_FLAT`, `LAKE`, `SPRING`, `CLOISTER`, `CITY_GATE`, `ROAD_JUNCTION`, `RIVER_JUNCTION`, `CITY_SEPARATE` (Flat Tiles, `edgeLevels = [0, 0, 0, 0]`):**
   - $\text{localHeight}(u_0, v_0) = 0.0$ everywhere on the base terrain mesh.
   - *(Note: On `BRIDGE_FLAT`, the river channel is slightly recessed `-0.04` level units along `v0 in [0.42, 0.58]` while a separate arched 3D stone bridge deck mesh rises `+0.18` level units over the center along `u0 in [0.42, 0.58]`, meeting `0.0` flush at the N and S edges.)*

2. **`GRASS_HILL` (`GRASS_HILL_A`, `edgeLevels = [1, 0, 0, 0]`):**
   - Raises the North edge (`v0 = 0`) to `+1.0` (`+0.5` world Y) while keeping East (`u0 = 1`), South (`v0 = 1`), and West (`u0 = 0`) edges anchored at `0.0`, with terraced hill contours across the interior:
   - Let $s_N(v_0) = \text{smoothstep}(0.75, 0.0, v_0)$ be the primary North-rising slope, modulated by lateral edge-pinning envelope $e_{EW}(u_0, v_0) = \text{smoothstep}(0.0, 0.18, u_0) \cdot \text{smoothstep}(1.0, 0.82, u_0)$ for $v_0 > 0.08$, transitioning smoothly to full width `1.0` right along the North seam ($v_0 \to 0$).
   - Apply a 3-tier soft terrace function $\text{terrace}(h) = 0.7 \cdot h + 0.3 \cdot \frac{\lfloor 3h \rfloor + \text{smoothstep}(0.3, 0.7, 3h - \lfloor 3h \rfloor)}{3}$ so the slope shows distinct stepped grass terraces while guaranteeing exact boundary heights:
     - North edge ($v_0 = 0$): $\text{localHeight}(u_0, 0) = 1.0$
     - South edge ($v_0 = 1$): $\text{localHeight}(u_0, 1) = 0.0$
     - East & West edges ($u_0 \in \{0, 1\}$ for $v_0 \ge 0.15$): $\text{localHeight} = 0.0$, ramping smoothly between $v_0 \in [0, 0.15]$ to meet the North corner at $1.0$.

3. **`GRASS_PLATEAU` (`GRASS_PLATEAU`, `edgeLevels = [1, 1, 1, 1]`):**
   - All 4 edges sit at `edgeLevel = +1` ($\text{localHeight} = 1.0$ on all boundaries $u_0 \in \{0, 1\}$ or $v_0 \in \{0, 1\}$).
   - Interior forms a gentle crowned alpine meadow dome:
     $$\text{localHeight}(u_0, v_0) = 1.0 + 0.12 \cdot \sin(\pi u_0) \cdot \sin(\pi v_0)$$
   - Guarantees seamless `L+1` edge matching with adjacent hill or plateau tiles while crowning visually at `+1.12` levels in the center.

4. **`WATERFALL_BRIDGE` (`WATERFALL_BRIDGE`, `edgeLevels = [0, 0, -1, 0]`):**
   - North (`v0 = 0`, `WATER`), East (`u0 = 1`, `ROAD`), and West (`u0 = 0`, `ROAD`) edges are at level `0.0`.
   - South (`v0 = 1`, `WATER`) edge is at level `-1.0` (`-0.5` world Y).
   - **Terrain Base Profile:**
     - Northern half ($v_0 \in [0.0, 0.45]$): Flat upper shelf at $\text{localHeight} = 0.0$.
     - Cliff Drop ($v_0 \in [0.45, 0.60]$): Steep waterfall escarpment dropping from `0.0` down to `-1.0` via $\text{localHeight}(u_0, v_0) = -\text{smoothstep}(0.45, 0.60, v_0) \cdot \text{canyonMask}(u_0, v_0)$, where the East and West road embankments ($u_0 < 0.18$ or $u_0 > 0.82$ near $v_0 = 0.5$) remain supported at `0.0` and taper to `-1.0` along the Southern gorge walls.
     - Southern Lower Canyon ($v_0 \in [0.60, 1.0]$): Sunken river floor at $\text{localHeight} = -1.0$ across the South edge ($v_0 = 1$).
   - **3D Arch Bridge & Waterfall Sheet Props:**
     - An elevated 3D stone arch bridge mesh spans East-West ($u_0 \in [0, 1]$, centered at $v_0 = 0.5$, width `0.18`), starting at `0.0` at East/West sockets and arching to `+0.16` level units over the waterfall chasm.
     - A vertical/sloped water sheet mesh with animated/scrolling foam crest and base plunge mist spans the cliff drop at $v_0 \in [0.45, 0.60]$, $u_0 \in [0.40, 0.60]$.

5. **`WATERFALL` (`WATERFALL_BEND`, `edgeLevels = [0, -1, 0, 0]`):**
   - River enters from North (`v0 = 0`) at level `0.0`, curves 90° through the tile center, and plunges over a diagonal/vertical cliff face to exit East (`u0 = 1`) at level `-1.0`.
   - North (`v0 = 0`), South (`v0 = 1`), and West (`u0 = 0`) edges sit at `0.0`; East edge (`u0 = 1`) sits at `-1.0`.
   - **Profile:**
     $$\text{localHeight}(u_0, v_0) = -\text{smoothstep}(0.38, 0.62, u_0) \cdot \text{smoothstep}(0.0, 0.20, v_0) \cdot \text{smoothstep}(1.0, 0.80, v_0)$$
     with the entire East boundary ($u_0 = 1$) clamped to `-1.0` across its socket width so the Eastern neighbor at `L-1` stitches flush without gaps.

6. **`BRIDGE_HILL` (`BRIDGE_HILL_A`, `edgeLevels = [1, 0, 0, 0]`):**
   - East (`u0 = 1`, `WATER`), West (`u0 = 0`, `WATER`), and South (`v0 = 1`, `ROAD`) edges sit at `0.0`.
   - North (`v0 = 0`, `ROAD`) edge sits at `+1.0` (`+0.5` world Y).
   - **Terrain & Bridge Ramp Profile:**
     - The river flows flat East-West across $v_0 \in [0.40, 0.60]$ at level `0.0`.
     - The northern bank ($v_0 \in [0.0, 0.35]$) rises smoothly to `1.0` at the North edge ($v_0 = 0$):
       $$\text{localHeight}(u_0, v_0) = \text{smoothstep}(0.35, 0.0, v_0)$$
     - The 3D stone bridge deck mesh begins at the South edge ($v_0 = 1$, height `0.0`), arches up over the level-`0` river at $v_0 = 0.5$ (height `+0.55` level units), and continues climbing as a stone viaduct ramp to meet the North socket ($v_0 = 0$) flush at height `+1.0`.

### 3.3 Triplanar Cliff Skirts & Underside Slabs

- **Perimeter & Seam Cliff Skirts:** Whenever a tile edge or internal terrace boundary sits above a lower neighbor or an empty board cell, a vertical/sloped cliff skirt mesh connects the upper surface edge down to a common base slab height (`baseY = -1.0` world units, i.e., `2 * LEVEL_HEIGHT` below level 0).
- **Triplanar UV / Procedural Rock Shading:** Cliff skirt triangles must never stretch vertical UVs. Vertex/fragment shading or procedural UVs map coordinates using world-space triplanar projection (`(worldX, worldY)` on N/S faces, `(worldZ, worldY)` on E/W faces) with horizontal sedimentary strata bands (`#706860`, `#5E564E`, `#4A433C`). This guarantees `uvStretchOutliers === 0` in `window.__game.audit()`.
- **Underside Slab:** Every placed tile group includes a sealed underside cap at `baseY = -1.0` (`underside-slab` shot) so looking beneath the diorama reveals a solid carved stone plinth.

---

## 4. Complete 20-Tile Visual & Gameplay Catalog (`DECK`)

All 20 tiles in `DECK` (`src/contracts.ts`) are played in deterministic sequence (`index 0 .. 19`).
- **Immediate Elevation Bonus:** Any tile where `isElevationChanger(spec)` is true (`edgeLevels.some(lvl => lvl !== 0)`) immediately awards **+2 points** upon placement.

| # | `id` | `name` | `edges` `[N, E, S, W]` | `edgeLevels` `[N, E, S, W]` | `special` | 2D Procedural Painter Recipe | 3D Mesh, Props & Gameplay Role |
| :- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `START_CITY_ROAD` | Starter City & Road | `['CITY', 'ROAD', 'GRASS', 'ROAD']` | `[0, 0, 0, 0]` | `'NONE'` | North city band (`>=28%` depth) with curved wall rim, merlons, and 3 blue-slate roofs; straight E-W cobble road across center; South meadow. | Flat `L0` starter placed at `(0, 0)` on game init. Extruded 3D city wall & roof cluster on N; slightly raised road ribbon E-W. |
| **2** | `ROAD_CURVE_A` | Road Curve | `['GRASS', 'ROAD', 'ROAD', 'GRASS']` | `[0, 0, 0, 0]` | `'NONE'` | Quadratic Bézier road curving from East midpoint (`(1.0, 0.5)`) through `(0.5, 0.5)` to South midpoint (`(0.5, 1.0)`), bordered by meadow. | Flat `L0` terrain with curved 3D road overlay (`polygonOffset`) and roadside milestone pebble prop. Connects to starter road. |
| **3** | `CITY_CORNER_A` | Corner Citadel A | `['CITY', 'CITY', 'GRASS', 'GRASS']` | `[0, 0, 0, 0]` | `'NONE'` | Continuous `CITY` polygon covering North and East edges, wrapping the NE corner (`(size-4, 4)` is `CITY`), concave wall arc from NW to SE, clustered blue-slate roofs. | Flat `L0` corner citadel with continuous L-shaped 3D battlement wall and corner watchtower. Connects to starter city. |
| **4** | `GRASS_HILL_A` | Terraced Grass Hill | `['GRASS', 'GRASS', 'GRASS', 'GRASS']` | `[1, 0, 0, 0]` | `'GRASS_HILL'` | Meadow base with 3 curved darker-green elevation contour bands stepping upward toward North edge; amber `L+1` level tab on North edge. | **Elevation Changer (+2 pts):** `GRASS_HILL` heightfield rising smoothly/terraced from `L0` (E, S, W) to `L+1` on North with triplanar rock skirts on E/W flanks. |
| **5** | `WATERFALL_BRIDGE` | Waterfall Arch Bridge | `['WATER', 'ROAD', 'WATER', 'ROAD']` | `[0, 0, -1, 0]` | `'WATERFALL_BRIDGE'` | N-S river with horizontal cliff line & whitewater foam band at center, plunge pool in South half (`L-1` cyan tab on S), crossed by E-W arched stone bridge with parapets. | **Elevation Changer (+2 pts):** Upper shelf N (`0`), cliff drop at center with animated waterfall sheet & mist, lower canyon floor S (`-1`), spanned by 3D stone arch bridge E-W (`0`). |
| **6** | `RIVER_STRAIGHT_LOW` | Canyon River Straight | `['GRASS', 'WATER', 'GRASS', 'WATER']` | `[0, 0, 0, 0]` | `'NONE'` | Straight E-W river channel (`20%` width) with dark bank lines, water ripples, and grassy banks on North and South. | Flat terrain (typically placed at world `level = -1` in the sunken river canyon) with slightly recessed water ribbon (`polygonOffset`) and shoreline reeds. |
| **7** | `BRIDGE_FLAT` | Stone Arch Bridge | `['ROAD', 'WATER', 'ROAD', 'WATER']` | `[0, 0, 0, 0]` | `'BRIDGE_FLAT'` | Straight E-W river channel underneath a N-S stone arch bridge at center (`[0.32, 0.68]`) with grey stone parapets and cobble road approaches. | Flat terrain with E-W water channel and a 3D arched stone bridge mesh carrying the N-S road over the water (+3 bonus pts when road completes). |
| **8** | `ROAD_STRAIGHT_A` | Highway Straight | `['ROAD', 'GRASS', 'ROAD', 'GRASS']` | `[0, 0, 0, 0]` | `'NONE'` | Straight N-S road (`16%` width) from `(0.5, 0.0)` to `(0.5, 1.0)` with cobble texture and flanking meadow stripes. | Flat terrain with straight N-S road ribbon and small cypress/shrub prop in meadow. |
| **9** | `CITY_TWO_EDGES_STRAIGHT` | Twin City Gates | `['CITY', 'GRASS', 'CITY', 'GRASS']` | `[0, 0, 0, 0]` | `'CITY_SEPARATE'` | Two **separate** city segments on North and South edges (each `>=28%` deep with its own curved wall rim and roofs), separated by an open E-W grass corridor (`v in [0.32, 0.68]`). | Flat terrain with two independent 3D city wall/building clusters on N and S (does **not** connect N and S cities internally). |
| **10** | `BRIDGE_HILL_A` | Climbing Hill Bridge | `['ROAD', 'WATER', 'ROAD', 'WATER']` | `[1, 0, 0, 0]` | `'BRIDGE_HILL'` | E-W river at `L0` crossed by a N-S stone bridge with upward slope chevrons pointing North, contoured northern bank, and amber `L+1` tab on North edge. | **Elevation Changer (+2 pts):** `BRIDGE_HILL` profile where E-W river flows at `0` while the 3D stone viaduct climbs from `S (0)` over the river up to `N (+1)`. |
| **11** | `RIVER_BEND_A` | River Bend | `['WATER', 'WATER', 'GRASS', 'GRASS']` | `[0, 0, 0, 0]` | `'NONE'` | Quadratic Bézier river (`20%` width) curving smoothly from North midpoint to East midpoint through `(0.5, 0.5)`, with darker bank rims and SW meadow. | Flat terrain with curved 3D water channel and pebble bank details. |
| **12** | `CITY_CORNER_B` | Corner Citadel B | `['GRASS', 'CITY', 'CITY', 'GRASS']` | `[0, 0, 0, 0]` | `'NONE'` | Continuous `CITY` polygon covering East and South edges, wrapping the SE corner (`(size-4, size-4)` is `CITY`), concave wall arc from NE to SW, blue-slate roofs. | Flat corner citadel rotated to E-S at `rotation = 0`, featuring 3D battlements and dense medieval roofs. |
| **13** | `ROAD_BRANCH_3WAY` | Crossroads Village | `['GRASS', 'ROAD', 'ROAD', 'ROAD']` | `[0, 0, 0, 0]` | `'ROAD_JUNCTION'` | 3 road arms from East, South, and West midpoints meeting at a central cobbled village plaza (`(0.5, 0.5)`) with a small wayside signpost/hut marker. | Flat terrain with 3-way road junction (`ROAD_JUNCTION` terminates all 3 road chains at center) and central signpost/well prop. |
| **14** | `RIVER_LAKE_LOW` | Canyon Lake Basin | `['GRASS', 'GRASS', 'WATER', 'GRASS']` | `[0, 0, 0, 0]` | `'LAKE'` | River entering from South midpoint (`(0.5, 1.0)`) and expanding into a circular/elliptical azure lake basin (`radius ~ 0.24`) at tile center, ringed by sandy shore and grass. | Flat terrain with recessed central lake basin (`LAKE` end-cap completes river chains) and shoreline rocks. |
| **15** | `CLOISTER_MEADOW` | Hilltop Monastery | `['GRASS', 'GRASS', 'ROAD', 'GRASS']` | `[0, 0, 0, 0]` | `'CLOISTER'` | Meadow surrounding a central red-roofed cruciform monastery (`CLOISTER`) enclosed by a low stone garden wall, with a road exiting from center to South midpoint. | Flat terrain with 3D monastery chapel & bell tower grounded at center, terminating the South road. |
| **16** | `WATERFALL_BEND` | Plunging Waterfall Bend | `['WATER', 'WATER', 'GRASS', 'GRASS']` | `[0, -1, 0, 0]` | `'WATERFALL'` | River entering North (`L0`), curving East and plunging over a rocky cliff band with whitewater foam and mist toward East midpoint (`L-1` cyan tab on E). | **Elevation Changer (+2 pts):** `WATERFALL` heightfield where N/S/W sit at `0` and E drops to `-1`, with a 3D cascading water sheet & foam pool (+3 bonus pts when river completes). |
| **17** | `CITY_BIG_3EDGE` | Grand Stronghold | `['CITY', 'CITY', 'CITY', 'GRASS']` | `[0, 0, 0, 0]` | `'NONE'` | Massive citadel covering North, East, and South edges, wrapping both NE and SE corners (`CITY`), with a curved western wall leaving a grass meadow notch on West. | Flat terrain with large 3-sided 3D fortress keep, inner courtyard, and multi-tiered blue-slate roofs. |
| **18** | `GRASS_PLATEAU` | High Crown Plateau | `['GRASS', 'GRASS', 'GRASS', 'GRASS']` | `[1, 1, 1, 1]` | `'GRASS_PLATEAU'` | High alpine meadow with concentric sunlit contour rings at center and amber `L+1` elevation tabs on all 4 edges. | **Elevation Changer (+2 pts):** `GRASS_PLATEAU` resting entirely at local `+1` (`crownLevel = level + 1`), forming the visual top-point crown of the 3D amphitheater. |
| **19** | `RIVER_FORK_DELTA` | River Delta Fork | `['WATER', 'WATER', 'GRASS', 'WATER']` | `[0, 0, 0, 0]` | `'RIVER_JUNCTION'` | 3 river channels from North, East, and West midpoints meeting in a central braided delta pool (`(0.5, 0.5)`) with a small sandbar islet; meadow on South. | Flat terrain with 3-way river delta (`RIVER_JUNCTION` splits/terminates river branches at center). |
| **20** | `CITY_GATE_ROAD` | Fortified City Gate | `['CITY', 'GRASS', 'ROAD', 'GRASS']` | `[0, 0, 0, 0]` | `'CITY_GATE'` | North `CITY` section (`>=28%` depth) with a grand arched stone gatehouse at the center of its wall; South `ROAD` runs from `(0.5, 1.0)` up to the gatehouse portcullis. | Flat terrain with 3D twin-towered gatehouse on the North city wall where the South road terminates (`CITY_GATE` caps the road chain). |
