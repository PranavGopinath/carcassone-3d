# AGENTS.md — Shared Blackboard & Lessons Learned

## Active Role Registry
See [`agents/roles.json`](agents/roles.json) and prompts in [`agents/prompts/`](agents/prompts/).

## Architectural Invariants
1. **Import Boundaries (`scripts/gates/imports.mjs`):**
   - `src/logic/` MUST NEVER import `three`, `src/render/`, or `src/ui/`.
   - `src/render/` MUST NEVER import `src/ui/` or `src/logic/`.
   - `src/ui/` MUST NEVER import `src/render/` or `src/logic/`.
   - `src/tiles/` MUST NEVER import `src/render/` or `src/ui/`.
   - All cross-module communication flows through `src/contracts.ts` and `src/main.ts`.
2. **Edge-First Socket Contract:**
   - Every tile has 4 edges `[N, E, S, W]` of type `GRASS | ROAD | CITY | WATER` and `edgeLevels: [number, number, number, number]`.
   - `ROAD` is 16% tile width centered at edge midpoint (`t=0.5`); `t < 0.25` and `t > 0.75` along the edge are `GRASS`.
   - `WATER` is 20% tile width centered at edge midpoint (`t=0.5`); `t < 0.25` and `t > 0.75` along the edge are `GRASS`.
   - `CITY` covers >=90% of edge length (`t=0.15, 0.5, 0.85` at 3px inset are `CITY`) and >=28% depth at midpoint.
   - Corners (4px inset) are `GRASS` unless BOTH adjacent edges are `CITY`.
3. **Orchestrator Lessons Learned (Prompt 0):**
   - Null pricing for `gemini-3.8-flash` and `gemini-3.5-flash-lite` in `agents/pricing.json` must default to `0` before arithmetic so budget checks never evaluate to `NaN`.
   - Ownership validation must run on normalized relative paths before any file is written to disk.
   - Repair loops preserve context via `previousInteractionId` and escalate to `lead_architect` on the 3rd consecutive failure.
4. **Prompt 1 Build Lessons Learned:**
   - **Seam Height Invariance on `[0.25, 0.75]`**: Tile elevation transitions must maintain height invariance along edge midsections (`t ∈ [0.25, 0.75]`) so adjacent terrace levels align smoothly with zero vertical gaps.
   - **Outer 6px Palette Collar**: Canvas procedural texture generation requires an outer 6px palette collar pre-stenciled with socket colors (`GRASS`, `ROAD`, `CITY`, `WATER`) to achieve zero-delta seam stitching across neighboring tiles.
   - **3-Chain Canonical Solvability**: Deck generation algorithms must verify a 3-chain canonical solvability sequence spanning both `L-1` canyon depressions and `L+1` plateau elevations, guaranteeing every placed tile maintains valid downstream placements.
   - **Headless WebGL Fallback**: Inspection hooks (`window.__game`) must provide a software canvas/CPU rendering fallback when running in WebGL-disabled headless test environments for deterministic automated evaluation.
