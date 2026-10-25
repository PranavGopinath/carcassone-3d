# Tiers Multi-Agent Orchestration (`docs/ORCHESTRATION.md`)

## Overview
Tiers (Carcassonne-3D) uses a hybrid **Native + Orchestrated** multi-agent architecture designed in Prompt 0 (`subagent-orchestrator`). Work is decomposed into topological DAG waves where each specialized role operates under strict path ownership (`agents/roles.json`), import boundary gates (`scripts/gates/imports.mjs`), and spend/call metering (`agents/pricing.json`, `runs/orchestrator/trace.jsonl`).

## Execution Modes
1. **Native Parallel Subagents:** Antigravity IDE/CLI subagents (`lead_architect`, `tile_designer`, `logic_engineer`, `tile_engineer`, `tile_family_worker`, `render_engineer`, `ui_engineer`, `boilerplate_worker`, `historian`) execute waves in parallel while respecting `ownsPaths` and `neverTouches`.
2. **Orchestrated Engine (`scripts/lib/orchestrator.mjs`):**
   - Topological wave builder (`buildWaves`) with cycle detection.
   - Deterministic path ownership validator (`validateOwnership`) blocking directory traversal (`..`), absolute paths, writes outside `ownsPaths`, and unauthorized edits to protected paths (`tests/`, `rubric/`, `scripts/gates/`).
   - Git worktree lifecycle (`wt/<task-id>` on `task/<task-id>`, `node_modules` symlink, `--no-ff` merge to `integration`, guaranteed `try...finally` teardown).
   - Multi-turn repair loop threading `previousInteractionId` up to 2 retries before escalating to `lead_architect` (`gemini-4-argon`, `thinking: "high"`).
   - Offline test harness (`ORCH_FAKE=1 npx vitest run tests/orchestrator.test.ts`).

## Wave Topology (Prompt 1 Build)
- **Wave 0 (Lead Architect):** Shared TypeScript contracts (`src/contracts.ts`), project configuration (`package.json`, `tsconfig.json`, `vite.config.ts`).
- **Wave 1 (Parallel Leaf Streams):**
  - `tile_designer` -> `docs/DESIGN.md`
  - `logic_engineer` -> `src/logic/*`, `tests/logic/*`
  - `tile_family_worker` -> `src/tiles/families/*`
  - `ui_engineer` -> `src/ui/*`
- **Wave 2 (Parallel Integration Streams):**
  - `tile_engineer` -> `src/tiles/painter.ts`, `src/tiles/probe.ts`, `tests/tiles/sockets.test.ts`
  - `render_engineer` -> `src/render/*`
- **Wave 3 (Assembly & Telemetry):**
  - `lead_architect` -> `src/main.ts`, `index.html`, Inspector API wiring (`window.__game`)
  - `historian` -> `runs/ledger.json`, `docs/architecture.html`, `AGENTS.md`
