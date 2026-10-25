# TIERS: Prompt 0 (v2 Refined), the Subagent Orchestration Layer

This is the refined, defect-free specification for Prompt 0. It preserves all original design principles, roles, and workflows, while resolving runtime traps, syntax bugs, and worktree isolation issues.

---

## 1. Quick-Start Architecture

```
carcassone-3d/
├── scripts/
│   ├── lib/
│   │   ├── orchestrator.mjs       # Core DAG engine, worktree runner & spend meter (<550 lines)
│   │   ├── adapter.mjs            # Interactions API / Fake model protocol adapter
│   │   └── ownership.mjs          # Deterministic path & boundary validator
│   └── gates/
│       └── imports.mjs            # Layer boundary checker (logic vs three vs ui)
├── agents/
│   ├── roles.json                 # Role definitions & path ownership
│   ├── pricing.json               # Cost tables with safe null handling
│   └── prompts/                   # System prompts per role (*.md)
├── runs/
│   ├── orchestrator/
│   │   └── trace.jsonl            # Execution trace & token audit log
│   ├── board.jsonl                # Cross-subagent requests & queries
│   └── ledger.json                # Project memory & run history
├── tests/
│   └── orchestrator.test.ts       # Offline DAG, repair, ownership & fake model tests
└── docs/
    ├── ORCHESTRATION.md           # CLI flags, modes, and run guide
    └── architecture.html          # Interactive timeline & Gantt chart
```

---

## 2. Core Execution Engine (`scripts/lib/orchestrator.mjs`)

### 2.1 Model Invocation Contract
```ts
interface CallModelOptions {
  role: string;
  model: string;
  thinking: 'low' | 'medium' | 'high';
  input: string;
  background?: boolean;
  maxOutputTokens?: number;
  previousInteractionId?: string;
  schema?: object;
}

interface CallModelResult {
  text: string;
  json?: any;
  interactionId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd: number | null;
  ms: number;
  status: 'completed' | 'failed';
}
```

### 2.2 Worktree Lifecycle & Isolation Guardrails
For every task in the DAG:
1. **Base verification:** Ensure `integration` branch exists (create from `HEAD` if initial run).
2. **Worktree creation:** Create `wt/<task-id>` at branch `task/<task-id>`.
3. **Dependency link:** Symlink root `node_modules` into `wt/<task-id>/node_modules` so acceptance tests run without reinstalling.
4. **Input assembly:** Inject role prompt + task goal + inputs + current blackboard state (`AGENTS.md`, `runs/board.jsonl`).
5. **Output validation:**
   - Parse subagent response JSON `{ files: [...], diff, notes, board: [...] }`.
   - **Deterministic Ownership Check:** Normalize all target file paths. Reject any path outside `ownsPaths` or inside `PROTECTED_PATHS` (`tests/`, `rubric/`, `scripts/gates/`).
6. **Execution & Acceptance:** Run `acceptance` commands in the worktree.
7. **Repair Loop:**
   - On error: Re-invoke with `previousInteractionId` up to 2 attempts.
   - On 3rd failure: Escalate to `lead_architect` with context to patch or re-plan.
8. **Review & Merge:** Run `scripts/gates/imports.mjs`. If passed, merge `--no-ff` into `integration`.
9. **Guaranteed Teardown:** In a `finally` block, clean up worktree (`git worktree remove --force`) and branch.

### 2.3 Spend & Cap Metering
- Supports `--budget-usd <amount>` and `--max-calls <count>`.
- Gracefully handles `null` prices in `agents/pricing.json`:
  - `knownCostUsd` tracks priced models (e.g., Argon at $2/1M input, $10/1M output).
  - `unmeteredTokens` tracks Flash / Flash-Lite calls where pricing is unknown.
- Halts new wave dispatching when cap is reached; prints resumption instructions.

### 2.4 Offline Test Mode (`ORCH_FAKE=1`)
- Bypasses external network calls completely.
- Returns deterministic mock subagent responses to test:
  - Wave dependency ordering.
  - Ownership violation rejection before disk modification.
  - Multi-round repair loops with `previousInteractionId` preservation.
  - Budget stop enforcement.
  - Accurate `trace.jsonl` generation.

---

## 3. Role Registry Summary

| Role | Default Model | Thinking | Write Paths | Restricted Paths |
|---|---|---|---|---|
| `lead_architect` | `gemini-4-argon` | High / Med | `src/contracts.ts`, `docs/`, `AGENTS.md`, integration config | Role dirs (direct) |
| `tile_designer` | `gemini-4-argon` | High | `docs/DESIGN.md` | Any code |
| `logic_engineer` | `gemini-4-argon` | High | `src/logic/`, `tests/logic/` | Three.js imports |
| `tile_engineer` | `gemini-4-argon` | High | `src/tiles/painter.ts`, `src/tiles/probe.ts`, `tests/tiles/` | `src/render/` |
| `tile_family_worker` | `gemini-3.8-flash` | Medium | `src/tiles/families/<family>.ts` | Everything else |
| `render_engineer` | `gemini-4-argon` | Med / High | `src/render/` | `src/ui/`, `src/logic/` |
| `ui_engineer` | `gemini-3.8-flash` | Medium | `src/ui/` | `src/render/`, `src/logic/` |
| `boilerplate_worker` | `gemini-3.8-flash` | Low | Scaffolds, config, README | Core source logic |
| `judge_a`, `judge_b` | `gemini-4-argon` | High | None (read-only) | All code |
| `patcher` | `gemini-4-argon` | High | Scoped per bug ticket | Tests, rubric, gates |
| `router` | `gemini-3.5-flash-lite` | Low | None (read-only) | All |
| `historian` | `gemini-3.8-flash` | Low | `runs/ledger.json`, `AGENTS.md` (append only) | Source code |

---

## 4. Definition of Done Checklist

1. [ ] `npm test` runs offline (`ORCH_FAKE=1`) and verifies DAG waves, ownership rejection, repair loop, and spend meter.
2. [ ] `trace.jsonl` written with timestamps, token counts, model tags, and latency.
3. [ ] `agents/roles.json`, `agents/pricing.json`, and role prompts in `agents/prompts/` generated.
4. [ ] `docs/ORCHESTRATION.md` written explaining flags, workflows, and offline execution.
5. [ ] Base commit created on `integration`.
