# Comprehensive Fault Analysis & Improvements for Prompt 0

This document provides a rigorous architectural, operational, and code-level critique of **TIERS: Prompt 0, the Subagent Orchestration Layer**, along with actionable improvements.

---

## 1. Syntax & Language Inconsistencies

### 1.1 Pythonism in Node.js ESM Context
* **Fault:** Section 2 states: `use background=True with max_output_tokens raised`.
* **Impact:** `True` is a Python keyword. The implementation is explicitly specified as `scripts/lib/orchestrator.mjs` (Node.js ES Modules). Passing `background=True` in JS will throw a `ReferenceError: True is not defined`.
* **Fix:** Standardize JavaScript parameters to `background: true` and `maxOutputTokens` (or camelCase properties in SDK wrappers).

### 1.2 Inconsistent Parameter Naming
* **Fault:** Section 2 uses snake_case (`previous_interaction_id`, `max_output_tokens`, `thinking_level`), whereas Section 4 defines the JS call signature as `callModel({role, model, thinking, input, background, maxOutputTokens, previousInteractionId, schema})`.
* **Fix:** Maintain strict TypeScript/JSDoc interface typing with camelCase for JS methods and map internally to the API's required payload format.

---

## 2. Git & Worktree Hazards (Critical Runtime Blockers)

### 2.1 Missing `integration` Branch Bootstrap
* **Fault:** Section 4 Step 1 dictates: `Create a git worktree wt/<task-id> on branch task/<task-id> from integration`. Step 8 merges back into `integration`.
* **Impact:** In standard or newly cloned repositories, the initial branch is `main`. Running `git checkout -b task/... integration` immediately crashes with `fatal: invalid reference: integration`.
* **Fix:** The orchestrator must ensure the base branch exists before spawning worktrees:
  ```js
  function ensureBaseBranch(base = 'integration') {
    try {
      execSync(`git rev-parse --verify ${base}`);
    } catch {
      execSync(`git branch ${base} HEAD`);
    }
  }
  ```

### 2.2 The Node Modules in Worktrees Trap
* **Fault:** `git worktree add wt/<task-id>` checks out only tracked git files into a new directory. `node_modules` is git-ignored and will NOT be present in `wt/<task-id>`.
* **Impact:** When Step 5 executes `acceptance: ["npx vitest run tests/logic"]` inside `wt/<task-id>`, Vitest and dependencies might fail to resolve or behave inconsistently across worktrees.
* **Fix:** Automate node_modules linking upon worktree creation:
  ```js
  const rootModules = path.resolve('node_modules');
  const wtModules = path.join(wtPath, 'node_modules');
  if (fs.existsSync(rootModules) && !fs.existsSync(wtModules)) {
    fs.symlinkSync(rootModules, wtModules, 'junction');
  }
  ```

### 2.3 Orphaned Worktrees and Stale Git Locks
* **Fault:** If a subagent task crashes, hits a timeout, or encounters an uncaught exception, the worktree directory `wt/<task-id>` and git branch `task/<task-id>` remain locked. Subsequent attempts to rerun the task or clean up fail with git lock errors.
* **Fix:** All worktree executions must be wrapped in a deterministic `try...finally` block:
  ```js
  try {
    // execute task in worktree
  } finally {
    execSync(`git worktree remove --force "${wtPath}"`, { stdio: 'ignore' });
    execSync(`git branch -D "${branchName}"`, { stdio: 'ignore' });
  }
  ```

---

## 3. Interactions API & SDK Protocol Fragility

### 3.1 Interactions API Availability & SDK Parity
* **Fault:** Section 2 requires `@google/genai >= 2.3.0` and mandates using the "Interactions API" (`interactions.get(id)`, `previous_interaction_id`).
* **Impact:** The Interactions API is a stateful preview agent API. Depending on environment, SDK release channel, or auth method, developers may only have access to the standard Gemini Content API (`ai.models.generateContent` / `ai.chats`).
* **Fix:** Implement a **Protocol Adapter** in `callModel`:
  - **Primary:** Stateful Interactions API (`client.interactions.create` / `client.interactions.get`).
  - **Fallback:** Standard multi-turn chat sessions with message history threading simulating `previousInteractionId`.
  - **Offline/Test:** `ORCH_FAKE=1` scripted mock responses.

### 3.2 Polling Backoff for Long Decode Jobs
* **Fault:** WF-7 dictates: `poll every 5 seconds`.
* **Impact:** Polling fixed intervals without jitter or exponential backoff during prolonged generations (e.g., 10-15 minute thinking calls) can trigger rate limits on API status polling endpoints.
* **Fix:** Use adaptive polling with backoff: start at 2s, increase to 5s, capped at 15s with 10% random jitter.

---

## 4. Scope, Timebox, and Architecture Balance

### 4.1 600-Line Budget vs 9 Complex Workflows
* **Fault:** The prompt demands a 60-90 minute timebox and <600 lines total, yet lists:
  - 13 distinct roles
  - 9 named workflows (including Three.js painter core, Carcassonne socket probes, Best-of-N 3-way branching, dual judge panels, Antigravity sandbox execution, Gantt timeline generation).
* **Impact:** Trying to build all 9 workflows into `scripts/lib/orchestrator.mjs` directly violates the line count and timebox.
* **Fix: Clean Separation of Concerns:**
  - **Prompt 0 Core Engine (`scripts/lib/orchestrator.mjs`):**
    1. DAG scheduler & topological waves
    2. Worktree sandbox manager
    3. Deterministic ownership enforcer
    4. Spend meter & trace logger (`trace.jsonl`)
    5. Repair loop with escalation
    6. Pluggable model driver (Real Interactions API + `ORCH_FAKE=1`)
  - **Domain Workflows (WF-2 Carcassonne tiles, WF-4 Best-of-N, WF-5 Judges):** These belong as task definitions executed *by* the orchestrator in PROMPT_1 and PROMPT_2, rather than hardcoded logic inside the core engine.

---

## 5. Security & Deterministic Ownership Guardrails

### 5.1 Path Traversal & Normalization Attacks
* **Fault:** Prompt simply states: `reject any write outside ownsPaths before touching disk`.
* **Vulnerability:** Without rigorous path normalization, a subagent returning `src/logic/../../package.json` or absolute paths (`/etc/...`) could bypass prefix checks.
* **Fix:** Strict path normalization against the worktree root:
  ```js
  function validateOwnership(filePath, ownsPaths, rootDir) {
    const resolvedPath = path.resolve(rootDir, filePath);
    const rel = path.relative(rootDir, resolvedPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Directory traversal blocked: ${filePath}`);
    }
    const isOwned = ownsPaths.some(allowed => {
      const allowedNorm = path.normalize(allowed);
      return rel === allowedNorm || rel.startsWith(allowedNorm.endsWith('/') ? allowedNorm : allowedNorm + '/');
    });
    if (!isOwned) {
      throw new Error(`Ownership violation: ${filePath} is outside [${ownsPaths.join(', ')}]`);
    }
    // Check global protected paths
    const PROTECTED = ['tests/', 'rubric/', 'scripts/gates/'];
    if (PROTECTED.some(p => rel.startsWith(p))) {
      throw new Error(`Protected path violation: ${filePath}`);
    }
  }
  ```

---

## 6. Spend Metering & Token Cost Math

### 6.1 `null` Price Calculations Causing `NaN`
* **Fault:** Section 2 instructs placing Flash and Flash-Lite prices as `null` in `agents/pricing.json`.
* **Impact:** In JavaScript, `1000 * null === 0`, but `1000 * undefined === NaN`, and arithmetic with missing keys can produce `NaN`, breaking spend cap checks (`currentSpendUsd >= budgetCap`).
* **Fix:** Safe cost calculation helper:
  ```js
  function calculateCost(tokens, ratePerMillion) {
    if (typeof ratePerMillion !== 'number' || isNaN(ratePerMillion)) return null;
    return (tokens / 1_000_000) * ratePerMillion;
  }
  ```
  Keep separate accumulators for `knownSpendUsd` and `unmeteredTokens`.

---

## 7. Sandbox Runner (WF-6) Pragmatism

### 7.1 Undocumented Patch Extraction
* **Fault:** Prompt notes: "My docs do not describe exporting files from the sandbox, so require the sandbox agent to print a final unified diff... Skip this workflow if it is not working within 15 minutes."
* **Fix:** Decouple WF-6 into an optional plugin/flag (`--sandbox=antigravity`), keeping local git worktree isolation as the reliable default. Ensure diff parsing is backed by a robust unified diff parser (`diff` or `patch-package` format).

---

## 8. Blackboard Concurrency (WF-8)

### 8.1 Concurrent File Appends
* **Fault:** Multiple subagents running in parallel write to `runs/board.jsonl` and `AGENTS.md`.
* **Impact:** Parallel writes can interleave characters and produce malformed JSON lines.
* **Fix:** The orchestrator must handle all writes to shared state centrally on task completion, rather than letting parallel worktree processes write concurrently to the root files.
