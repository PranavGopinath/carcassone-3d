---
name: subagent-orchestrator
description: >-
  Build, test, and run the multi-agent orchestration layer (Prompt 0) for Carcassonne-3D/Tiers,
  including topological wave execution, Git worktree isolation, deterministic ownership checks,
  Interactions API adapter with offline fake-model testing, and spend metering.
---

# Subagent Orchestration Skill (Prompt 0)

Build this FIRST. It is the machinery that PROMPT_1 (build) and PROMPT_2 (feedback loop) run on. It also is the "multi-agent orchestration" the judges can see live.

**Timebox: 60-90 minutes, under about 600 lines total.** It must be testable offline with a fake model (`ORCH_FAKE=1`). If it is not working at the timebox, stop and use Native or Sequential fallback. Do not gold-plate it.

You are the Lead Architect (`gemini-4-argon`, thinking_level "high" for planning, "medium" for review).

---

## 1. Execution Modes (in priority order)

1. **Native.** Your harness (Antigravity IDE/CLI, Gemini CLI, etc.) offers subagents. Use them, but still obey the roles, file ownership, contracts, and shared notes defined here.
2. **Orchestrated (default for this project).** Build `scripts/lib/orchestrator.mjs` and drive every wave through it with the Interactions API (or local fake model in test). This is portable, testable, traceable, and demoable.
3. **Sequential fallback.** Run the same tasks one at a time in the same order with the same ownership rules.

---

## 2. API & SDK Guidelines

- **Models:** `gemini-4-argon` (lead, architecture, complex modules), `gemini-3.8-flash` (parallel leaf tasks, boilerplate, fast checks), `gemini-3.5-flash-lite` (routing, classification, guardrails).
- **SDK & Protocol:** Use `@google/genai` >= 2.3.0. For multi-turn stateful subagents, leverage `previous_interaction_id` to continue context in repair loops.
- **Thinking levels:** `thinking_level` = `"low"` | `"medium"` (default) | `"high"`. Use `"high"` for multi-file debugging, upfront design, and patching; `"low"` for routing and extraction.
- **Do not pass:** `temperature`, `top_p`, `top_k`, `thinking_budget`, or explicit `cached_content` (caching is automatic).
- **Long decode jobs:** Output default is 65,536 tokens. For larger tasks, use `{ background: true, maxOutputTokens: ... }` and poll status with exponential backoff until complete.
- **Spend & Metering:** Argon is $2/1M input, $10/1M output. Flash and Flash-Lite prices are stored as `null` in `agents/pricing.json`. Always meter token volumes, and ensure null pricing never produces `NaN` in budget checks.

---

## 3. Role Registry & Path Ownership

Save to `agents/roles.json` and generate corresponding role system prompts in `agents/prompts/<role>.md`:

```json
{
  "roles": [
    {
      "name": "lead_architect",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": ["src/contracts.ts", "docs/", "AGENTS.md", "package.json", "tsconfig.json"],
      "neverTouches": ["src/logic/", "src/render/", "src/ui/", "src/tiles/"]
    },
    {
      "name": "tile_designer",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": ["docs/DESIGN.md"],
      "neverTouches": ["src/", "tests/"]
    },
    {
      "name": "logic_engineer",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": ["src/logic/", "tests/logic/"],
      "neverTouches": ["three"]
    },
    {
      "name": "tile_engineer",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": ["src/tiles/painter.ts", "src/tiles/probe.ts", "tests/tiles/"],
      "neverTouches": ["src/render/"]
    },
    {
      "name": "tile_family_worker",
      "model": "gemini-3.8-flash",
      "thinking": "medium",
      "ownsPaths": ["src/tiles/families/"],
      "neverTouches": ["src/logic/", "src/render/"]
    },
    {
      "name": "render_engineer",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": ["src/render/"],
      "neverTouches": ["src/ui/", "src/logic/"]
    },
    {
      "name": "ui_engineer",
      "model": "gemini-3.8-flash",
      "thinking": "medium",
      "ownsPaths": ["src/ui/"],
      "neverTouches": ["src/render/", "src/logic/"]
    },
    {
      "name": "boilerplate_worker",
      "model": "gemini-3.8-flash",
      "thinking": "low",
      "ownsPaths": ["README.md", "docs/", "vite.config.ts"],
      "neverTouches": ["src/"]
    },
    {
      "name": "judge_a",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": [],
      "neverTouches": ["*"]
    },
    {
      "name": "judge_b",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": [],
      "neverTouches": ["*"]
    },
    {
      "name": "patcher",
      "model": "gemini-4-argon",
      "thinking": "high",
      "ownsPaths": [],
      "neverTouches": ["tests/", "rubric/", "scripts/gates/"]
    },
    {
      "name": "router",
      "model": "gemini-3.5-flash-lite",
      "thinking": "low",
      "ownsPaths": [],
      "neverTouches": ["*"]
    },
    {
      "name": "historian",
      "model": "gemini-3.8-flash",
      "thinking": "low",
      "ownsPaths": ["runs/ledger.json", "AGENTS.md", "docs/architecture.html"],
      "neverTouches": ["src/"]
    }
  ]
}
```

Save to `agents/pricing.json`:
```json
{
  "currency": "USD",
  "rates": {
    "gemini-4-argon": { "inputPerMillion": 2.0, "outputPerMillion": 10.0 },
    "gemini-3.8-flash": { "inputPerMillion": null, "outputPerMillion": null },
    "gemini-3.5-flash-lite": { "inputPerMillion": null, "outputPerMillion": null }
  }
}
```

---

## 4. Orchestrator Library Implementation (`scripts/lib/orchestrator.mjs`)

### 4.1 Core Model Call
- Signature: `callModel({ role, model, thinking, input, background = false, maxOutputTokens = 65536, previousInteractionId, schema })`.
- Handles retry with exponential backoff on 429 and 5xx.
- When `process.env.ORCH_FAKE === '1'`, returns scripted mock responses without network access.
- Logs every interaction to `runs/orchestrator/trace.jsonl` with `{ ts, taskId, role, model, thinking, inputTokens, outputTokens, costUsd, ms, status }`.
- Enforces `--budget-usd` and `--max-calls` caps.

### 4.2 Worktree Lifecycle & Isolation Guardrails
Before running tasks:
1. Ensure the `integration` branch exists (create from `HEAD` if needed).
2. For each task, create a worktree `wt/<task-id>` on branch `task/<task-id>`.
3. Symlink root `node_modules` into `wt/<task-id>/node_modules` so acceptance commands (`npx vitest`) run seamlessly without reinstalling.
4. Inject role system prompt + task goal + full contents of `inputs` + shared blackboard notes (`AGENTS.md`, `runs/board.jsonl`).
5. Subagents return JSON: `{ files: [{ path, content }], diff?, notes, board: [{ to, request }] }`.
6. **Deterministic Ownership Enforcement:**
   - Normalize target paths using `path.resolve` and `path.relative`.
   - Reject any directory traversal (`..`) or absolute paths.
   - Strictly reject any write outside `ownsPaths` or within protected paths (`tests/`, `rubric/`, `scripts/gates/`).
7. Execute `acceptance` commands inside the worktree.
8. **Repair & Escalation Loop:**
   - On acceptance failure, re-invoke with failing test log and `previousInteractionId` (up to 2 retry rounds).
   - On 3rd failure, escalate to `lead_architect` (argon high) to patch, relax an unreasonable command, or re-plan.
9. **Review Gate:** Lead reviews interface diffs against `src/contracts.ts` and runs `scripts/gates/imports.mjs` (logic cannot import `three`; render cannot import `ui`; ui cannot import `render`).
10. Merge `task/<task-id>` into `integration` with `--no-ff`.
11. **Guaranteed Teardown:** Wrap in `try...finally` to always run `git worktree remove --force` and clean up task branches.

---

## 5. Offline Testing Harness (`ORCH_FAKE=1`)

Implement `tests/orchestrator.test.ts` to run under Vitest offline:
```bash
ORCH_FAKE=1 npx vitest run tests/orchestrator.test.ts
```
The fake model suite must verify:
- DAG topological wave ordering (dependent tasks wait for upstream outputs).
- Ownership violations rejected before disk modification.
- Repair loop threads `previousInteractionId` across retries.
- Escalation to Lead triggers after 2 failed attempts.
- Spend caps halt scheduling and print resume command.
- Trace lines are written cleanly to `runs/orchestrator/trace.jsonl`.

---

## 6. Definition of Done (Prompt 0)

1. `npm test` passes orchestrator tests offline using `ORCH_FAKE=1`.
2. A live smoke test runs a simple 2-task wave (one Argon, one Flash) and records trace in `trace.jsonl`.
3. `agents/roles.json`, `agents/pricing.json`, and `docs/ORCHESTRATION.md` exist.
4. Append lessons learned to `AGENTS.md`, commit on `integration`, and stop. **Do not start the game.**
