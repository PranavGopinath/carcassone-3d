---
name: subagent-orchestrator
description: >-
  Use this skill to build, configure, test, and run the multi-agent orchestration layer (Prompt 0)
  for project waves, role-based subagent execution, worktree isolation, deterministic ownership checks,
  and offline fake-model testing.
---

# Subagent Orchestration Skill (Prompt 0)

This skill guides the design, implementation, and execution of the **Subagent Orchestration Layer** (`Prompt 0`). It provides the runtime environment on which subsequent build waves (`PROMPT_1`) and autonomous feedback loops (`PROMPT_2`) operate.

---

## 1. Overview & Core Philosophy

The orchestration layer coordinates specialized AI roles (Lead Architect, Tile Designer, Logic Engineer, etc.) through topological task DAGs, strict write-path boundaries, and isolated Git worktrees.

Key references:
- [Original User Prompt](./references/original-prompt.md) - Unaltered base prompt.
- [Fault Analysis & Improvements](./references/critique-and-improvements.md) - Deep dive into syntax fixes, worktree hazards, and API fallbacks.
- [Refined Specification (v2)](./references/spec-v2.md) - Bulletproof production spec.

---

## 2. Directory Structure

When implementing this skill, generate or maintain the following structure:

```
carcassone-3d/
├── .agents/
│   └── skills/
│       └── subagent-orchestrator/ # This skill package
├── scripts/
│   ├── lib/
│   │   ├── orchestrator.mjs       # Main DAG wave dispatcher & runner (<600 lines)
│   │   ├── adapter.mjs            # Interactions API / offline mock adapter
│   │   └── ownership.mjs          # Path normalization & ownership validation
│   └── gates/
│       └── imports.mjs            # Architectural boundaries gate
├── agents/
│   ├── roles.json                 # Role definitions & path permissions
│   ├── pricing.json               # Cost tables & unmetered token handling
│   └── prompts/                   # System prompt markdown files per role
├── runs/
│   ├── orchestrator/
│   │   └── trace.jsonl            # Execution audit log
│   ├── board.jsonl                # Cross-subagent requests
│   └── ledger.json                # Run memory
├── tests/
│   └── orchestrator.test.ts       # Vitest offline mock suite
└── docs/
    ├── ORCHESTRATION.md           # Usage and CLI documentation
    └── architecture.html          # Interactive timeline / Gantt chart
```

---

## 3. Step-by-Step Implementation Procedure

### Step 1: Environment & Base Branch Setup
Run the environment verification script:
```bash
./.agents/skills/subagent-orchestrator/scripts/verify-setup.sh
```
Ensure git branch `integration` exists. If not, branch from current `HEAD`:
```bash
git branch integration HEAD
```

### Step 2: Initialize Configuration & Role Registry
Populate `agents/roles.json` and `agents/pricing.json` using the provided templates:
- [roles.json](./templates/roles.json)
- [pricing.json](./templates/pricing.json)

Populate `agents/prompts/` with role-specific system prompts enforcing path boundaries and output schemas.

### Step 3: Implement Deterministic Ownership Checker
In `scripts/lib/ownership.mjs`:
- Normalize target paths against worktree root.
- Block path traversal (`..` or absolute paths).
- Block writes to `PROTECTED_PATHS` (`tests/`, `rubric/`, `scripts/gates/`).
- Reject any write outside task `ownsPaths`.

### Step 4: Implement Protocol Adapter (`scripts/lib/adapter.mjs`)
- Support `ORCH_FAKE=1` offline mock model for instant unit testing.
- Support `@google/genai` Interactions API with automatic exponential backoff on 429/5xx.
- Thread `previousInteractionId` across repair attempts.
- Handle `null` pricing safely in spend calculations.

### Step 5: Implement Core Orchestrator (`scripts/lib/orchestrator.mjs`)
- Keep total line count under 600 lines.
- Implement topological wave execution (`runPlan(plan, { concurrency })`).
- Wrap task execution in worktree lifecycles with guaranteed cleanup in `finally`.
- Symlink `node_modules` into worktrees to enable `npx vitest` without overhead.
- Centralize appends to `runs/orchestrator/trace.jsonl` and `runs/board.jsonl`.

### Step 6: Verify Offline with Vitest
Run offline test suite:
```bash
ORCH_FAKE=1 npx vitest run tests/orchestrator.test.ts
```
The test suite must verify:
1. Topological DAG order (tasks run only when dependencies complete).
2. Write ownership rejection before touching disk.
3. Repair loop with `previousInteractionId`.
4. Escalation to Lead Architect upon 2 consecutive failures.
5. Spend cap and call cap stops.
6. Trace file generation.

### Step 7: Documentation & Commit
1. Document CLI flags and modes in `docs/ORCHESTRATION.md`.
2. Append execution notes and lessons learned to `AGENTS.md`.
3. Commit clean baseline to `integration`.

---

## 4. Operational Guardrails

- **No Remote Side Effects:** The orchestrator never pushes to remotes or deploys without explicit interactive confirmation.
- **Strict Worktree Teardown:** Never leave orphaned `wt/*` directories or dangling branches.
- **Budget Protection:** Terminate immediately when `--budget-usd` or `--max-calls` is reached, leaving a resumable command.
