# TIERS: Prompt 0, the Subagent Orchestration Layer

Build this FIRST. It is the machinery that PROMPT_1 (build) and PROMPT_2 (feedback loop) run on. It also is the "multi-agent orchestration" the judges can see live.

**Timebox: 60-90 minutes, under about 600 lines total.** It must be testable offline with a fake model. If it is not working at the timebox, stop and use Mode 1 or Mode 3 below. Do not gold-plate it.

You are the Lead Architect (`gemini-4-argon`, thinking_level "high" for planning, "medium" for review).

## 1. Execution modes (pick the best available, in this order)

1. **Native.** Your harness (Antigravity IDE/CLI, Gemini CLI, etc.) offers subagents. Use them, but still obey the roles, file ownership, contracts, and shared notes defined here.
2. **Orchestrated (default for this project).** Build `scripts/lib/orchestrator.mjs` and drive every wave through it with the Interactions API. This is portable, testable, traceable, and demoable.
3. **Sequential fallback.** Run the same tasks one at a time in the same order with the same ownership rules.

## 2. Facts from the Argon docs that the code must respect

- Models: `gemini-4-argon` (lead, hard work), `gemini-3.8-flash` (parallel leaf tasks, boilerplate, fast checks), `gemini-3.5-flash-lite` (routing, classification, guardrails), Antigravity managed agent `antigravity-preview-09-2026` (Google-hosted Linux sandbox that can run code, tests, and tools).
- Use the **Interactions API** with `@google/genai` >= 2.3.0. **Do not guess call shapes.** Install and follow the skill: `npx skills add google-gemini/gemini-skills --skill gemini-api-dev`.
- Reasoning depth: `thinking_level` = "low" | "medium" (default) | "high". "high" for multi-file debugging, upfront design, and patching; "low" for routing and extraction.
- Do not pass `temperature`, `top_p`, `top_k`, `thinking_budget`, or explicit `cached_content` (caching is automatic).
- Output: the default limit is 65,536 tokens. Above that, use `background=True` with `max_output_tokens` raised, and poll `interactions.get(id)` until the status is no longer `queued`/`in_progress`. Input, thinking, and output share one 1M-token window.
- Server-side state: `previous_interaction_id` continues a prior interaction.
- Client timeouts: 15-20 minutes for "high" thinking calls, or use background mode.
- Sandboxes: `agent="antigravity-preview-09-2026"`, `agent_config={"type":"antigravity","model":"gemini-4-argon"}`, `environment` remote with a network allowlist. Register tokens with the Credentials API so secrets never enter model context.
- Pricing (introductory through 30 Nov 2026): Argon $2 per 1M input, $10 per 1M output. Flash and Flash-Lite prices are not in my docs: put them in `agents/pricing.json` as `null`, warn at startup, and meter tokens even when cost is unknown.

## 3. Role registry (`agents/roles.json` plus one system prompt file per role in `agents/prompts/`)

| Role | Model | thinking | Owns (write access) | Never touches |
|---|---|---|---|---|
| lead_architect | argon | high (plan) / medium (review) | `src/contracts.ts`, `docs/`, `AGENTS.md`, integration files | role-owned dirs (except via review) |
| tile_designer | argon (multimodal) | high | `docs/DESIGN.md` | code |
| logic_engineer | argon | high | `src/logic/`, `tests/logic/` | `three` imports |
| tile_engineer | argon | high | `src/tiles/painter.ts`, `src/tiles/probe.ts`, `tests/tiles/` | `src/render/` |
| tile_family_worker | flash (argon for city and specials) | medium | one file in `src/tiles/families/` | everything else |
| render_engineer | argon | medium / high for water and structures | `src/render/` (sub-owned per task) | `src/ui/`, `src/logic/` |
| ui_engineer | flash | medium | `src/ui/` | `src/render/`, `src/logic/` |
| boilerplate_worker | flash | low | configs, scaffolds, README | source modules |
| judge_a, judge_b | argon | high | read-only | all |
| patcher | argon | high | paths allowed per stage | `tests/`, `rubric/`, `scripts/gates/` |
| router | flash-lite | low | read-only | all (JSON repair, defect-to-owner routing) |
| historian | flash | low | `runs/ledger.json`, `AGENTS.md` (append only), dashboard | code |
| sandbox_runner | antigravity + argon | high | sandbox only | local files |

## 4. Orchestrator library (`scripts/lib/orchestrator.mjs`)

**Core calls**
- `callModel({role, model, thinking, input, background, maxOutputTokens, previousInteractionId, schema})`: wraps the SDK; retries with exponential backoff on 429 and 5xx; enforces timeouts; supports structured JSON output; returns `{text, json, interactionId, usage, ms}`; appends a line to `runs/orchestrator/trace.jsonl` (`ts, taskId, role, model, thinking, inputTokens, outputTokens, costUsd|null, ms, status`).
- Spend meter: `--budget-usd` and `--max-calls` caps; on cap, finish in-flight calls, stop scheduling, print a resume command.

**Plan and DAG**
- The Lead emits `plan.json`:
```json
{"tasks":[{"id":"logic-engine","role":"logic_engineer","goal":"...",
  "inputs":["src/contracts.ts","docs/CONTRACTS.md"],
  "ownsPaths":["src/logic/","tests/logic/"],
  "acceptance":["npx vitest run tests/logic"],
  "dependsOn":["contracts"],
  "decode":{"background":false,"maxOutputTokens":65536}}]}
```
- `runPlan(plan, {concurrency: 4})`: topological waves, parallel inside a wave, adaptive concurrency down on 429s.

**Per-task execution**
1. Create a git worktree `wt/<task-id>` on branch `task/<task-id>` from `integration`.
2. Build the subagent input: role system prompt, the task, the full contents of `inputs`, the shared notes (`AGENTS.md`, `docs/CONTRACT_LOG.md`, open items on `runs/board.jsonl`).
3. The subagent returns JSON: `{files:[{path, content}], diff?, notes, board:[{to, request}]}`. New modules use full files; patches use unified diffs.
4. **Ownership enforcement (deterministic):** reject any write outside `ownsPaths` before touching disk.
5. Run `acceptance` commands in the worktree.
6. **Repair loop:** on failure, send the error output back with `previousInteractionId` (the subagent keeps its context), up to 2 rounds. Then **escalate**: the Lead (argon high) receives the task, the last diff, and the failing output, and decides to patch it, relax an unreasonable acceptance command (logged), or re-plan.
7. **Review gate:** the Lead (argon medium) reviews a diff stat plus interface changes against `src/contracts.ts`. The import-boundary gate (`scripts/gates/imports.mjs`: logic cannot import `three`; render cannot import ui; ui cannot import render) must pass.
8. Merge `task/<id>` into `integration` with `--no-ff`. Delete the worktree. Conflicts should be impossible given ownership; if one occurs, the Lead resolves it and logs why ownership failed.

**Offline testing:** `ORCH_FAKE=1` swaps in a scripted fake model so `tests/orchestrator.test.ts` can verify the DAG order, ownership rejection, the repair loop (including `previousInteractionId` threading), escalation, budget stop, and trace output with no API access.

## 5. Named workflows

**WF-1: Plan, Contract, Fan-out, Review, Merge** (build waves). The Lead writes the plan and contracts, then `runPlan` fans out tasks wave by wave. Agree the plan with me before long runs (see section 6, step 1).

**WF-2: Design-first.** (a) `tile_designer` (multimodal) reads `reference/carcassonne-layout.png` and writes `docs/DESIGN.md`: edge-socket geometry as fractions of tile width, palette hex codes, feature proportions, a drawing recipe per feature, and 6 worked ASCII socket diagrams. Pause for my 30-second sign-off on this document. (b) `tile_engineer` implements the painter core, probes, and tests against DESIGN.md. (c) Fan out family workers in parallel, one file each (`families/city.ts`, `families/road.ts`, `families/river.ts`, `families/special.ts`), each accepted by the socket tests filtered to its family. (d) The Lead integrates and hands off to Stage 1 of the loop.

**WF-3: Repair loop.** The per-task loop above, using server-side state. The same pattern is reused by the feedback loop for patch repair.

**WF-4: Best-of-N patching** (used by PROMPT_2). Run N=3 patcher variants in separate worktrees with different strategy briefs: V1 minimal local fix at the suspect site, V2 fix at the shared abstraction (root cause), V3 alternative hypothesis in a different file. Run the cheap deterministic gates on all three in parallel. Only survivors go to the expensive capture and judge. Pick the winner by targeted-item improvement, then smallest diff. Log losers as REJECTED with their strategy so the ledger learns which strategy works. N is configurable (`--variants`; 1 disables).

**WF-5: Judge panel.** `judge_a` and `judge_b` run in parallel on the same evidence with different framing. `router` (flash-lite) repairs malformed JSON and routes each defect to the owning role and files by path taxonomy.

**WF-6: Sandbox verification (optional).** `runInSandbox({commands, files})` uses the Antigravity managed agent with Argon, a network allowlist (`registry.npmjs.org`, `github.com` and your GEMINI endpoints only), and credentials via the Credentials API (never in prompts). My docs do not describe exporting files from the sandbox, so require the sandbox agent to print a final unified diff and the test log in its output, and apply the diff locally. Skip this workflow if it is not working within 15 minutes.

**WF-7: Long decode jobs.** For large generations (for example the logic engine plus its tests), call with `background=true` and a raised `max_output_tokens`, poll every 5 seconds, and show progress in the trace.

**WF-8: Shared blackboard.** Subagents are peers coordinating through files: `AGENTS.md` (lessons, conventions, append-only), `docs/CONTRACT_LOG.md`, `runs/ledger.json`, and `runs/board.jsonl` for cross-cutting requests (for example `{"from":"render","to":"logic","request":"expose getHeightAt(x,z)"}`). The Lead resolves open board items between waves. Every subagent call receives the current blackboard contents.

**WF-9: Pre-demo explainer.** Before the demo, generate `docs/architecture.html` (self-contained, interactive): the agent roles, the workflow DAG, and an **agent timeline** drawn from `trace.jsonl` (a Gantt of calls by role and model with duration and cost). This is the visible proof of orchestration for judges.

## 6. Human control and safety

1. **Align first.** Before any long run, print the plan and open questions; wait for my reply in interactive mode.
2. **No external side effects without confirmation:** the orchestrator never pushes to a remote, deploys, or calls hosts outside the allowlist. `--dry-run` prints what would happen.
3. **Secrets** live only in environment variables or the Credentials API, never in prompts, logs, or traces.
4. **Spend caps** are enforced in code, and the current spend prints after every wave.
5. **Protected paths:** no subagent may edit `tests/`, `rubric/`, `scripts/gates/`, or threshold files unless the Lead is writing a new test and logs it.

## 7. Definition of done

1. `npm test` passes the orchestrator tests (fake model): DAG order, ownership rejection, repair with `previousInteractionId`, escalation, budget stop, trace file written.
2. A live smoke test runs one real two-task plan (one Argon task, one Flash task) and shows both in `trace.jsonl` with usage.
3. `agents/roles.json`, `agents/prompts/*`, `agents/pricing.json`, `docs/ORCHESTRATION.md` (how to run, flags, modes) exist.
4. Append lessons to `AGENTS.md`, commit on `integration`, then stop. Do not start the game.
