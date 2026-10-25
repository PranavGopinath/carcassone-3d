---
name: visual-feedback-loop
description: >-
  Build and run a project-agnostic, fully autonomous visual feedback loop (Prompt 2): render a
  WebGL app deterministically, capture a cinematic timeline, scripted gameplay in every view, shots
  and full-page UI shots, have Gemini judges
  grade a rubric of defect checks and reference-fidelity gaps, let a tool-using patcher agent edit
  and test inside a git worktree, keep the best iteration, escalate when stuck, and merge the best
  result without a human gate. Each project plugs in through `loop.config.json`.
---

# Visual Feedback Loop (Prompt 2)

Prerequisites: Prompt 0 and Prompt 1 have already run and will not be re-run. Every model call goes through `scripts/lib/orchestrator.mjs` (trace, budget caps, `ORCH_FAKE=1`). The target app passes its own build gates. Anything this loop needs that those prompts didn't build, this prompt builds (see §0); never assume a capability exists without checking the code.

## 0. Upgrade the orchestrator first

Before writing loop code, read `scripts/lib/orchestrator.mjs` and add whatever of the following is missing, with offline tests in `tests/orchestrator.test.ts` (existing tests must keep passing):

1. **Deadlines.** Long or `thinking: "high"` calls run with `background: true` and poll `ai.interactions.get(id)` with exponential backoff under a hard per-call deadline (`pollTimeoutMs`, default 90s, configurable per call). A call past its deadline is cancelled and retried with backoff like a 429/5xx; it never hangs the process.
2. **Persistent spend.** Initialize cumulative cost and call counts from `runs/orchestrator/trace.jsonl`, so budget caps hold across processes.
3. **`runToolLoop({ role, tools, input, maxToolCalls, deadlineMs, previousInteractionId })`.** A function-calling loop on the Interactions API: send the tool declarations, execute each returned function call through the caller's handler, return the result, and repeat until the model calls `finish` or a cap is hit. Each turn is traced and metered. Under `ORCH_FAKE=1` it replays scripted tool-call sequences so the patcher is testable offline.
4. **Rate limits (429 / `RESOURCE_EXHAUSTED`).** Quota errors are expected on a long run and must never end it:
   - **Pace before hitting the limit.** A shared client-side limiter, per model, enforces the config's `rateLimits` (`rpm`, `tpm`, `maxConcurrent`) across every judge, pairwise, patcher and escalation call in the process, estimating input tokens before sending.
   - **Retry 429s separately from other errors.** Wait for the server's retry delay (`RetryInfo.retryDelay` in the error details, or `Retry-After`) when given, otherwise exponential backoff with jitter capped at `rateLimits.maxBackoffMs`. Keep retrying for up to `rateLimits.maxWaitMs` per call. 429 retries don't count toward the retry limit for 5xx and timeouts. When a 429 arrives, the limiter lowers that model's pace for every caller, not just the one that failed.
   - **Never downgrade** the model or thinking level to get around a quota (hard rule 6).
   - **Quota still exhausted after `maxWaitMs`** (usually a daily quota): checkpoint (§4), then **pause instead of exiting**. Send one minimal probe request every `rateLimits.probeIntervalMs`, and continue from the checkpoint as soon as a probe succeeds. Exit with a `rate_limited` status and the resume command only if the pause exceeds `rateLimits.maxPauseMs`. A slow run that finishes unattended beats a fast one that stops.
   - Trace every 429 as `status: "rate_limited"` with the wait time, and show total rate-limit wait on the dashboard.
5. **Spend quota only where it buys judgment.** The quota is fixed, so the loop must not spend Argon calls or tokens on work that can't change a verdict:
   - **Reuse unchanged verdicts.** Captures are deterministic, so before judging a shot, clip or gameplay capture, compare it with the best iteration's capture of the same thing. If it matches within the determinism tolerance, reuse that verdict (and its defects) instead of calling a judge. Mark reused verdicts on the dashboard.
   - **Lean motion input.** Send judge_a each video at `judging.videoFps` (default 6), plus full-rate filmstrips around every `frameDiff` spike and every gameplay step, so fast events are still seen in full.
   - **Lean stills.** Full shots and context frames go at medium resolution; crops, marks and filmstrips at high (hard rule 6).
   - **Pairwise only on ties** (§2 Pairwise), and out-of-scope checks by pixel comparison, not a model call.
   - **Small patcher turns.** Patcher tools return capped slices, not whole files or logs (§3.2), because every turn re-sends the conversation so far.

The loop runs with **no human in it**. Implement the whole spec; where something is hard (the golden set, the patcher's tool loop, tie-breaks), build the real thing rather than a stub that makes a check pass.

## Hard rules

1. **The evaluation is immutable; the product is not.** During a run the patcher may edit anything in the worktree **except** `protectedPaths` (rubric, references, loop scripts, gates, config, skills) and the **baseline tests** (every file under `tests/` tracked at the run's start commit). It may **add** new tests under `regressionTestDir`. After every patcher turn, `git diff --name-status <startCommit>` must show no change to a protected path or baseline test; if it does, the iteration is rejected and reset, whatever the judges say.
2. **Never record in real time.** Freeze the app's clock, render each frame by time, and screenshot it. Video is stitched from those frames.
3. **Measurements beat opinions.** A failing hard check (`audit:*`, `frameDiff`, `blankFrame`, `stepErrors`) fails its rubric item whatever a judge says. An `audit:<field>` source passes when the field is `true`, `0`, an empty array, or an object whose `ok` is `true`; anything else fails, with the field's value and the audit's `details` as evidence. If `audit()` doesn't return a field the rubric names, the item fails with a defect asking the patcher to add that measurement to the app's audit.
4. **The rubric is the goal, and it has two kinds of item** (see §2). `defect` items ask "is something broken?"; `fidelity` items ask "how far is this from the reference?". The loop is not done while either kind has open failures. Passing every defect item on art that looks nothing like the references is not success.
5. **`GEMINI_API_KEY` is read only by Node** (`node --env-file=.env`). Never use a `VITE_` prefix and never log it.
6. **High effort everywhere.** Every judge, pairwise, patcher and escalation call uses `gemini-4-argon` with `thinking: "high"`. Media goes at `media_resolution` high for crops, filmstrips and anything a judge must inspect closely, and at medium for full shots and frames that provide context (§0.5). Pass both explicitly on each call. Don't downgrade to save budget; the budget cap ends the run instead.
7. **Nothing blocks.** No stdin prompts, no waiting on a person. Every model call has a deadline (§0.1). A stalled call is cancelled and retried; it never hangs the run. Rate limits slow the run down; they never end it while a resume is possible (§0.4).
8. **Never trust model-invented IDs as keys.** Defect IDs are assigned by code when verdicts are merged: `<judge>-<itemId>-<n>` (e.g. `still-M2-1`).
9. **Every view, every iteration.** Each iteration captures and judges every view in `views` (e.g. `2d` and `3d`): the gameplay scripts in each view, and at least one canvas shot and one page shot per view. An item with `views` is judged separately in each view and passes only if it passes in all of them. Never skip a view to save time or budget.
10. **Gameplay is graded, not just the cinematic.** The loop drives real game actions and real UI clicks through scripted timelines (§1.6). A render that looks right in a fixed camera flight but breaks when a tile is placed, a score changes or the view is toggled has not passed.
11. **Scope: the board and its environment, in both views.** The loop improves the 3D board (terrain, slab, water, buildings, props, meeples, lighting and materials on them), the environment it sits in (sky, clouds, background), and its 2D counterpart. Everything listed in the config's `outOfScope` (e.g. the HUD) belongs to someone else: judges ignore it when grading other items and the patcher is told not to change it. Checks that only an out-of-scope change could fix are `reportOnly` items (§2). Enforce it two ways: a diff touching `outOfScopePaths` is rejected like a protected-path violation, and the capture compares the out-of-scope regions (the bounding boxes of out-of-scope DOM elements, plus any region the config marks) pixel by pixel against the best iteration's; a change beyond tolerance there makes the iteration worse. This needs no model call.
12. **The 2D and 3D views show the same game.** Every tile, feature and object visible in one view must exist, in the same place, in the other: a house drawn on a 2D tile must stand on that tile in 3D, and nothing may appear in 3D that the 2D tile doesn't show. The tile spec and game state are the source of truth: when the views disagree, fix whichever view departs from the spec, and if both do, fix both.
13. **Realism is the style target.** The board should read as a photographed physical miniature like `diorama-style-ref.png`: real materials with surface variation, soft natural light and shadow, believable scale and density. Flat colors, untextured primitives and low-poly game art are fidelity gaps, not acceptable style choices.

## Files

- Project adapter: `loop.config.json` at repo root. Example and field notes: [reference/loop.config.example.json](reference/loop.config.example.json).
- Rubric: `rubric/visual.json`. Example: [reference/rubric.example.json](reference/rubric.example.json).
- Model output schemas: [schemas/judge.schema.json](schemas/judge.schema.json) (judges), [schemas/patch-report.schema.json](schemas/patch-report.schema.json) (the patcher's `finish` call).
- Code: `scripts/loop/{capture,judge,patch,run}.mjs`. Output: `runs/loop/<runId>/iter-<N>/` and `runs/loop/<runId>/dashboard.html`.

On startup:
- If the loop is already built (`scripts/loop/` exists and the offline tests pass), don't rebuild it: run it. If `runs/loop/` has a run whose `state.json` isn't finished, continue it with `--resume` instead of starting over. Only fix the loop code when a test fails or the spec has changed since it was built.
- Check that every rubric `references` path exists, and that every view in `views` has at least one `defect` item and one `fidelity` item covering it. If not, exit with one error naming all gaps (these are evaluation problems, which the loop may not fix).
- Check that every non-null hook in the config exists on the page and every `click` selector in the gameplay scripts resolves. If any are missing, don't exit: run a **bootstrap patcher iteration** whose only defects are the missing hooks and selectors, with the hook contract from the config's `_fieldNotes` and the gameplay scripts as context. Re-check afterwards; exit naming what is still missing only if the bootstrap fails.

## 1. Capture: `capture.mjs`

1. Start `devCommand` once per run. Load the page fresh for every capture. **No HMR**: stale WebGL state gives wrong frames.
2. Use Playwright Chromium (`npx playwright install --only-shell chromium`) with the configured viewport and `deviceScaleFactor`, and GPU flags (macOS: `--use-angle=metal`). Read the renderer string via `WEBGL_debug_renderer_info`. **Fail** on SwiftShader or any software renderer.
3. Before frame 0, wait for fonts (`document.fonts.ready`) and textures (the `ready` hook if present). Check that `inspect` mode drives `performance.now`, `Date`, `requestAnimationFrame` and `Math.random` from `t` and the seed. Anything that animates by wall clock is a determinism defect.
4. For each `t` at `timeline.fps`, call `renderAt(t)` and take a `page.screenshot` clipped to the canvas. Don't use `toDataURL` on the WebGL canvas (it needs `preserveDrawingBuffer`); a 2D canvas returned by a hook, like the tile sheet, can be read with `toDataURL`.
5. Take the configured canvas `shots` and the tile sheet. Then take each `pageShots` entry: set its `view`, `renderAt(t)`, and take a **full-page** screenshot (not clipped), so the HUD and overlays are graded. Save `audit()` output plus page console errors to `audit.json`.
6. **Gameplay capture.** For each script in `gameplay.scripts`, and for each view in `gameplay.views` when the script has `perView: true` (otherwise once, from its `startView`):
   1. Reload the page, call `setView(view)` instantly, and reset the play clock with `playAt(0)`.
   2. Walk time from 0 to `duration` at `gameplay.fps`. Before rendering the first frame at or after a step's `at`, apply the step: `call` invokes that hook on `window[global]` with `args`; `click` dispatches a real Playwright click on the selector, so HUD wiring is tested too. Then `playAt(t)` and take a **full-page** screenshot (gameplay is graded with its HUD).
   3. After each step settles (the frame before the next step), run `audit()` and keep its fields per step, so `audit:*` sources can be checked at every step of play, not just on a static board.
   4. Record any console error or exception thrown during a step as a `stepErrors` hard-check failure, with the step and time. Also record as `stepErrors`:
      - a **no-op step**: a step after which neither `getState()` nor the frame changed (e.g. an unknown fixture name that silently loads the same board, or a bot move with no tiles left)
      - a failed **expectation**: a step's `expect` is a JS expression over `before` and `after` (`getState()` snapshots around the step, each with a `view` field from the `getView` hook); a script's `expect` is one over `start` and `end` (around the whole script), `startView`, and `views` (the `getView()` value recorded at every captured frame). Either evaluating to false is a failure naming the expression.
   5. Run `blankFrame` and `frameDiff` on the script's frames, and stitch `play-<scriptId>-<view>.webm`.
   Gameplay animation (tile drop, meeple drop, highlights, score popups, view morphs) must be driven by `playAt(t)`, never wall clock; if two captures of a script differ beyond tolerance, report a determinism defect.
7. **Hard checks:**
   - `blankFrame`: any frame that is nearly a single color.
   - `frameDiff`: compute the changed-pixel fraction per consecutive pair **globally and per cell** of a `frameDiff.grid` (e.g. 8×8). Flag a spike when either (a) a cell's fraction exceeds `spikeFactor` × that cell's segment median, or (b) the **second-order** change `|d(t) − d(t−1)|` exceeds `spikeFactor` × its segment median. Smooth camera motion raises the first-order diff everywhere but keeps the second-order diff low; pop-in and z-fighting spike both locally and in the second order. Ignore frames on either side of a segment boundary. Do **not** exempt frames after a gameplay step: an intended change (a tile dropping in) is animated over several frames and stays under the second-order threshold, while a tile that pops in at once is exactly what this check must catch.
   - `stepErrors`: any console error or exception, no-op step or failed expectation during a gameplay step.
   - Run `frameDiff`, `blankFrame` and the determinism comparison on the **canvas region with DOM overlays masked out** (the bounding boxes of elements drawn over the canvas). Full-page frames are for the judges; HUD text changing instantly when the score updates is not a pop-in, and an out-of-scope HUD timer must not make the board look nondeterministic.
8. Stitch frames with ffmpeg (`@ffmpeg-installer/ffmpeg` if there is no system ffmpeg). If stitching fails, continue with stills.
9. Two captures of the same commit must match within a small per-pixel tolerance (on the masked canvas region, as above).
10. Export `captureShot(workDir, shotId | {t} | {script, view, t})` as a cheap single-image path. Page shots and gameplay frames come back **full-page**, exactly as the judges see them, so HUD changes can be previewed. The patcher's `preview` tool uses it (§3).

## 2. Judges: `judge.mjs`

Both judges use `gemini-4-argon` and the `judge_a`/`judge_b` roles. They can't write files. Write timestamps as `MM:SS`.

**Prompt layout:** precede every image with a one-line text label (`[Image 3: waterfall-macro, full shot]`, `[Image 4: reference diorama-style-ref]`), and put all grading instructions **after** the media.

### Item kinds

- **`defect`**: pass/fail. Same as before: hard sources decide, the judge covers what can't be measured. A fail must cite a `t` or shot plus a mark or region.
- **`reportOnly: true`** (either kind): judged and shown on the dashboard and in `summary.json` under "for the owner", but never sent to the patcher and never counted in pass counts, better/worse comparisons or the stop condition. Use it for checks on out-of-scope areas, so their bugs get reported to whoever owns them.
- **`fidelity`**: send the item's shot, then each of its `references`, then the item's `aspect`. The judge returns a ranked list of **gaps** (concrete, visible differences between render and reference for that aspect, each with severity and region) and a verdict that passes only when no `high` or `medium` gap remains. Tell the judge the reference shows **style, materials, lighting and density, not layout**: ignore differences in board shape, tile arrangement and terrain elevation that come from the game's rules. Every `high`/`medium` gap becomes a defect for the patcher.

### Judges

- **judge_a (motion):** one call per motion clip: the cinematic's `timeline.motionSegments` (clipped from `flight.webm` with `start_offset`/`end_offset`) and every gameplay video (`play-<scriptId>-<view>.webm`). Upload via the Files API and poll until `ACTIVE`. Use **static** processing, set `fps` near the capture rate, `media_resolution` high. With each clip send its step list as `MM:SS` labels ("00:02 bot places a tile", "00:05 click rotate"), so the judge knows what should happen when, and a labelled filmstrip of the frames around each `frameDiff` spike. Grade only the motion items for that segment and view.
- **judge_b (stills):** one call per shot group and view. Send the shot plus a high-resolution crop for each `crop` item (`crop: true` crops to the item's marks or the region a previous verdict cited; `crop: "<css selector>"` crops a page shot to that element). An item with a `shots` list gets every listed image, labelled. Turn audit findings into **numbered marks drawn on the image**, not raw JSON: an item's `marks: "<name>"` draws the positions in `audit().marks[<name>]` (`[{ shot, x, y, label }]`). If the audit has no positions for that name, send the image unmarked and add a low-severity defect asking the patcher to expose them. Send each item's `references`. For gameplay items with `at: "after-step"`, send the settled full-page frame after each step, labelled with the step.

### Cross-view consistency items

An item with `pairViews: true` is judged on matching 2D and 3D images side by side: for a shot item, the shots in its `shots` list (e.g. `board-2d` with `terrace-overview`); for a gameplay item, the settled 2D and 3D frames after each step of its script. Draw the same numbered tile marks (from the audit's `tileLabels`, the screen position of each tile in each image) on both images so the judge can match tiles. The judge lists, per tile mark, every object or feature present in one view and missing, moved or different in the other; each mismatch is a defect naming the tile, both views, and which view departs from the tile spec.

### Views

An item with `views` is resolved once per view; its stored result is `{ view: verdict }` and it passes only if every view passes. Items whose evidence exists only once (a cinematic segment like `rise`, a script with `perView: false` like `toggle`, a `pairViews` item) are judged once; their `views` only declares which views they cover for the startup check. Each defect carries its `view`, and so does its ID (`motion-G1-3d-1`). A gameplay item's `segment` names a script; for `perView` scripts it is judged on that script's capture in each listed view. A `{view}` in an item's `shot` expands per view (`ui-{view}` → `ui-2d`, `ui-3d`).

### Merging verdicts

- Assign defect IDs in code (hard rule 8).
- If the judges disagree, or a judge says `uncertain`, re-ask once on a tighter crop and take the majority of three. **An item still uncertain after the re-ask is a fail.** Never coerce `uncertain` to `pass`.
- Both judges are the same model family: agreement corroborates, it doesn't validate. That's what the golden set is for.

### Pairwise

A separate call compares the best-so-far with the current iteration. Run it **only when it can decide the outcome**: the iteration isn't already worse, and its pass count ties the best's. Then run it on **every shot touched by this iteration's defects plus every fidelity shot**, in every view they apply to, not a single global shot. Skip any shot whose capture is unchanged from the best's (§0.5). Ask per item, never "which is better?" in general: for a `fidelity` item, send the item's `references` too and ask which render is **closer to the reference** for that item's `aspect`; for a `defect` item, ask which shows less of that defect. Randomize which is A or B, ask in **both orders**, and count a winner only if it wins both times; otherwise it's a tie.

### Golden set (real, before the first live run)

The golden set measures whether the **vision judges** catch things, so hard checks are hidden from the judges for these cases. Include a cross-view case: remove one building or feature from one view only and confirm the consistency items catch it.
1. **Injected defects.** Use the `injectDefect` hook (if the project has one) and capture-side perturbations (blank a frame, offset one mesh for one frame, duplicate a frame) to produce real broken captures: a floating prop, a blank morph frame, a hovering meeple, a frame of flicker, a pop-in, and in gameplay a tile placed with no drop animation. Run judge_a/judge_b on them, in both views.
2. **Fidelity calibration.** Grade each reference image as if it were the render (it must pass with no high gaps), and grade iteration 0's untouched draft (it must not pass if it visibly differs). A fidelity judge that passes both or fails both is broken; fix the prompt before running live.
3. Record per-case results, recall, false positives and the real `interactionId` of every judge call in `runs/loop/golden.json`, together with the commit it ran on and a hash of the rubric and the judge prompts. A judge may fail a defect item without a hard check only for defect types it caught here.
4. **Don't trust an old file.** Re-run the golden set when `golden.json` is missing, has no judge `interactionId`s (a hard-check-only file from an older loop), or its rubric or prompt hash differs from the current one. Its mere existence is never enough.

## 3. Patcher: `patch.mjs`

The patcher is a **tool-using agent working inside the run's worktree**, not a single call that returns text edits.

1. **Runtime.** `runToolLoop` from §0.3. The loop runs headless from Node, so it can't use an IDE's native subagents.
2. **Tools** (all paths resolved inside the worktree; writes to protected paths or baseline tests are refused with a reason):
   - `list_files(dir)`, `read_file(path, startLine?, endLine?)` (returns numbered lines, at most `patcher.maxReadLines` per call; asking for more returns the first slice and the file's length), `search(pattern, dir?)` (matching lines with line numbers, capped)
   - `write_file(path, content)`, `edit_file(path, search, replace)` (search must match exactly once; on 0 or 2+ matches return the matching line numbers)
   - `run(command)`: only the configured `acceptance` commands and `npx vitest run <path>`; returns exit code, the failing tests and the last `patcher.maxLogLines` lines, never the full log
   - `preview(shotId | t | {script, view, t})`: builds and returns the current render of that shot, page shot (full page, HUD included), cinematic frame or gameplay frame (running the script's steps up to `t`) as an image, so the patcher can see its change before the full capture, at medium resolution unless it asks for `high` or a crop. For fidelity defects it returns the item's reference beside the render.
   - `run_script(script, view)`: plays one gameplay script headlessly and returns its step errors, per-step audit and a filmstrip, for gameplay defects
   - `finish(report)`: ends the turn with a report per `schemas/patch-report.schema.json`
3. **Context at the start of each iteration (fresh conversation):**
   - open defects with their measurements, shot, region, and for fidelity gaps the matching reference image
   - the current image of each targeted shot
   - a file outline of `src/` (path, exported symbols, line counts); the agent reads what it needs
   - the scope and correctness rules it must respect: `outOfScope` and `outOfScopePaths`, `protectedPaths`, hard rules 11–13 (scope, 2D/3D consistency with the tile spec as source of truth, realism as the style target)
   - escalation plan and launch `--notes`, if any
   - `triedLedger`: the last 8 failed attempts, one line each (`defectId, files, ≤25-word change, outcome`), drawn from this run **and earlier runs** (the persistent ledger below)
   - lessons from `AGENTS.md` that concern the loop, and the previous run's still-open defects from its `summary.json`
   Leave out old diffs and judge prose.
   **Persistent ledger.** Append every attempt (kept or reverted) to `runs/loop/ledger.jsonl` with the run ID, iteration, defect, item, files, change summary and outcome. It survives across runs, so a fresh run doesn't retry fixes that already failed. Match defects across runs by item ID, view and shot, since defect IDs are per-run.
4. **Working loop.** Address the highest-severity defects first; several per iteration is fine. For a defect that can be measured (geometry, camera framing, a seam, a pop-in), **write a regression test first** under `regressionTestDir`, make it pass, then `preview` the shot. For a fidelity gap, iterate with `preview` against the reference. Stop at `finish` or when `patcher.maxToolCalls` / `patcher.deadlineMs` runs out.
5. **Gate.** After the agent finishes, run hard rule 1's diff check, then `acceptance` (baseline tests + new regression tests). If acceptance fails, give the agent one more bounded turn with the log. If it still fails, reset to the iteration's start and record the attempt in `triedLedger`.
6. Commit as `loop iter <N>: <defectIds> <summary>`.

## 4. Loop: `run.mjs`

```
node --env-file=.env scripts/loop/run.mjs [--max-iterations N] [--budget-usd X] [--notes "..."] [--resume <runId>]
```

1. Work in worktree `wt/loop-<runId>` on branch `loop/<runId>`, from the config's `baseBranch` at its current tip, using the orchestrator's worktree helpers. Record `startCommit`.
2. Iteration 0 captures and judges the untouched draft.
3. Each later iteration: patcher → gate → capture → judge → compare against the best so far:
   - **Worse** if any hard check newly fails or any previously passing defect item now fails **in any view**. A fix in 3D that breaks 2D is a regression.
   - **Better** if not worse and either more rubric items pass, or the same number pass and pairwise wins exceed losses.
   - **Tie or worse:** `git reset --hard <bestCommit>` and add the attempted defects to `triedLedger`. If the same defect has failed twice, tell the patcher to try a structurally different fix.
4. **Escalation, not a human gate.** After `limits.plateauIterations` non-improving iterations in a row, call `lead_architect` with the rubric history, `triedLedger`, best shots next to their references, and the file outline. It returns a diagnosis and a structural plan (refactors, new modules, a different technique). The next patcher iteration gets that plan and `patcher.escalatedMaxToolCalls`. If the escalated iteration also fails to improve, stop.
5. **Stop** when every item passes, `maxIterations` is reached, the budget is spent, or escalation fails.
   **Checkpoint and resume.** After each phase (bootstrap, golden set, patch, gate, capture, judge, compare), write `runs/loop/<runId>/state.json`: current iteration and phase, best commit and iteration, `triedLedger`, plateau count, escalation plan and verdicts so far. `--resume <runId>` reopens the worktree, restores that state, and continues from the first unfinished phase without repeating finished model calls. An exit for rate limits (§0.4) prints this command.
6. **Finish automatically.** If the best iteration is strictly better than iteration 0, merge it into `baseBranch` locally with `--no-ff` (never push) and remove the worktree. Other people may have committed to `baseBranch` during the run: if the merge conflicts, abort it, leave `loop/<runId>` unmerged and list the conflicting files in the summary. Otherwise leave the branch unmerged. Either way, write `runs/loop/<runId>/summary.json` (per-iteration rubric counts, best iteration, open defects, cost, merge result) and print it.

## 5. Dashboard

A static `dashboard.html`, regenerated after every iteration:
- a rubric grid (items × iterations, with item kind), showing pass/fail per view for items with `views`
- for each fidelity item: reference | iteration 0 | best, side by side, with the best's open gaps
- iteration 0 next to the best for every shot and page shot, and each gameplay video in each view (plus the cinematic video if available)
- each iteration's defects with timestamps, patcher report, diff stat, new regression tests, commit hash and cost; escalation plans inline

## 6. Tests: `tests/loop.test.ts` (`ORCH_FAKE=1`, offline)

Use a fake scene, `tests/fixtures/loop-scene.html`: a cube with the hooks.
1. A missing reference file, or a view with no defect or fidelity item, fails fast and names it. A missing hook or click selector triggers the bootstrap iteration, and the run exits naming it only if the bootstrap fails.
2. Patcher tools refuse writes to protected paths, baseline tests and paths outside the worktree, and accept new files under `regressionTestDir`. A diff touching a protected path rejects the iteration.
3. A cube that pops in at a known frame **while the camera pans** trips `frameDiff`. The same pan without the pop-in does not.
4. Defect IDs from two judges that both say `D1` survive merging as distinct defects.
5. `uncertain` after the re-ask resolves to fail.
6. A worse or tied iteration resets to the best commit; a plateau triggers escalation; a failed escalation stops the loop; nothing reads stdin.
7. Gameplay steps fire before the first frame at or after their `at`; a `click` on the fake scene's button changes state; a step that throws records a `stepErrors` failure.
8. An item with `views: ["2d","3d"]` that passes in 2D and fails in 3D fails overall, and a change that fixes 3D but breaks 2D counts as worse. A script `expect` over `views` fails when the fake scene switches view partway through.
9. A fake-scene object that appears in one frame during a gameplay step trips `frameDiff`; the same object tweened over 5 frames does not.
10. A `pairViews` item receives matching 2D and 3D images with the same tile marks; an object present in only one view of the fake scene produces a defect naming that tile.
11. A patch touching `outOfScopePaths` is rejected, and a pixel change in an out-of-scope region beyond tolerance makes the iteration worse.
12. A failing `reportOnly` item appears in the summary but never becomes a patcher defect and never changes the pass count.
13. Unknown fixture names and steps that change nothing are recorded as `stepErrors`; a false `expect` names its expression.
14. `frameDiff` ignores an instant HUD text change outside the canvas but catches the same change inside it.
15. A fake model returning 429 with a `retryDelay` waits that long and then succeeds; 429s don't use up the 5xx retry count; concurrent calls share one limiter; a 429 lasting past `maxWaitMs` exits with `rate_limited`, and `--resume` continues from the saved phase without repeating finished calls.
16. A capture identical to the best iteration's reuses its verdict with no judge call; a changed capture is judged.
17. Pairwise runs only when pass counts tie and the iteration isn't worse.
18. A `golden.json` without judge `interactionId`s, or with a stale rubric/prompt hash, triggers a fresh golden set.
19. Attempts land in `runs/loop/ledger.jsonl`, and a new run's patcher context includes earlier runs' failed attempts for the same item.
20. Under a persistent 429 the run checkpoints, probes, and continues after a probe succeeds, without repeating finished calls.

## Definition of done

1. The offline tests pass.
2. The real golden set has run: `golden.json` holds injected-defect results and fidelity calibration with real judge `interactionId`s.
3. A live run completes iteration 0 plus patched iterations until a stop condition, every iteration has gameplay and still verdicts for every view, and the dashboard shows the rubric and fidelity gaps changing.
4. Every call appears in `runs/orchestrator/trace.jsonl` within `budgetUsd`.
5. The run finished without human input and merged the best iteration if it beat iteration 0.
6. Append lessons learned to `AGENTS.md`, commit, and stop.
