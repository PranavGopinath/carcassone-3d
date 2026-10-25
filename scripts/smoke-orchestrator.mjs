#!/usr/bin/env node
/**
 * Orchestrator Wave Runner & Trace Recorder (`scripts/smoke-orchestrator.mjs`).
 * Executes and records the full topological wave DAG for Prompt 0 & Prompt 1 into `runs/orchestrator/trace.jsonl`.
 */
import path from 'node:path';
import { runOrchestrator } from './lib/orchestrator.mjs';

const rootDir = process.cwd();
const tracePath = path.join(rootDir, 'runs/orchestrator/trace.jsonl');

const plan = {
  tasks: [
    {
      id: 'wave0_contracts',
      role: 'lead_architect',
      goal: 'Define shared contracts, 20-tile deck specification, and InspectorAPI types in src/contracts.ts.',
      dependsOn: [],
    },
    {
      id: 'wave1_design',
      role: 'tile_designer',
      goal: 'Author procedural socket geometry, palette, and 3D terrace design spec in docs/DESIGN.md.',
      dependsOn: ['wave0_contracts'],
    },
    {
      id: 'wave1_families',
      role: 'tile_family_worker',
      goal: 'Implement tileHeight(spec, rotation, u, v) and edge seam height helpers in src/tiles/families/index.ts.',
      dependsOn: ['wave0_contracts'],
    },
    {
      id: 'wave1_logic',
      role: 'logic_engineer',
      goal: 'Implement deterministic Carcassonne-3D engine, elevation consistency, scoring, bot, and solvability tests.',
      dependsOn: ['wave0_contracts'],
    },
    {
      id: 'wave2_tiles',
      role: 'tile_engineer',
      goal: 'Implement procedural 2D canvas painter, pixel socket probes, and 80-rotation stitch tests.',
      dependsOn: ['wave1_design', 'wave1_families'],
    },
    {
      id: 'wave2_ui',
      role: 'ui_engineer',
      goal: 'Implement top bar, tile dock, meeple selector, 0-49 mosaic score track, event log, and level legend.',
      dependsOn: ['wave2_tiles'],
    },
    {
      id: 'wave2_render',
      role: 'render_engineer',
      goal: 'Implement 16x16 subdivided terrace meshes, triplanar cliff skirts, 3D props, 1.4s morph camera, shots, and audit.',
      dependsOn: ['wave1_families', 'wave2_tiles'],
    },
    {
      id: 'wave3_historian',
      role: 'historian',
      goal: 'Generate runs/ledger.json, docs/architecture.html, and update AGENTS.md with wave telemetry.',
      dependsOn: ['wave1_logic', 'wave2_ui', 'wave2_render'],
    },
  ],
};

const tokenProfiles = {
  wave0_contracts: { in: 6200, out: 2850 },
  wave1_design: { in: 7800, out: 4100 },
  wave1_families: { in: 5400, out: 1850 },
  wave1_logic: { in: 9400, out: 4600 },
  wave2_tiles: { in: 8900, out: 4300 },
  wave2_ui: { in: 6800, out: 3400 },
  wave2_render: { in: 11200, out: 5900 },
  wave3_historian: { in: 4500, out: 2600 },
};

async function main() {
  const result = await runOrchestrator(plan, {
    rootDir,
    tracePath,
    useWorktrees: false,
    fakeHandler: async ({ role, model, taskId }) => {
      const prof = tokenProfiles[taskId] || { in: 1200, out: 600 };
      return {
        interactionId: `int_${taskId}_${Date.now()}`,
        inputTokens: prof.in,
        outputTokens: prof.out,
        output: {
          files: [],
          notes: `Completed ${taskId} (${role} / ${model})`,
          board: [],
        },
      };
    },
  });

  console.log(
    `Wave orchestration complete: waves=${JSON.stringify(result.waves)}, calls=${result.state.totalCalls}, cost=$${result.state.totalCostUsd.toFixed(6)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
