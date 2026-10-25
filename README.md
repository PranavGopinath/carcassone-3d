# Tiers — 3D Terraced Carcassonne

Tiers is a deterministic, procedural 3D Carcassonne-style tile-placement game with multi-level elevation terraces:
- **Level `0` (Fertile Valley):** Classic Carcassonne cities, roads, and cloisters (`START_CITY_ROAD` starter).
- **Level `-1` (Sunken River Canyons):** Plunging waterfalls (`WATERFALL_BRIDGE`, `WATERFALL_BEND`), canyon river channels, and lake basins.
- **Level `+1` (Terraced Hill Plateaus):** Contoured grass hills (`GRASS_HILL_A`), high plateaus (`GRASS_PLATEAU`), and arched hill-bridges (`BRIDGE_HILL_A`).

## Quick Start
```bash
npm install
npm test
npm run build
npm run dev
```

## Multi-Agent Orchestration (Prompt 0)
- Run offline orchestrator test suite:
  ```bash
  ORCH_FAKE=1 npx vitest run tests/orchestrator.test.ts
  ```
- Run import boundary gate:
  ```bash
  npm run gate:imports
  ```
- See [`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md), [`docs/DESIGN.md`](docs/DESIGN.md), and [`docs/architecture.html`](docs/architecture.html).
