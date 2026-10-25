---
name: visual-feedback-loop
description: >-
  Build and run a project-agnostic visual feedback loop (Prompt 2): render a WebGL app
  deterministically, capture frames and shots, have Gemini judges grade a pass/fail rubric
  backed by hard measurements, patch the renderer, keep the best iteration, and stop at a
  human gate. Each project plugs in through `loop.config.json`.
---

# Visual Feedback Loop (Prompt 2)

Prerequisites: Prompt 0 is done. Every model call goes through `callModel` in `scripts/lib/orchestrator.mjs` (trace, budget caps, `ORCH_FAKE=1`). The target app passes its own build gates.
Timebox: 2 hours, about 500 lines of code. Don't gold-plate.

## Hard rules

1. **Patch only `patchAllowlist`.** Never write to `tests/`, `rubric/`, `scripts/gates/`, `loop.config.json`, or this skill.
2. **Never record in real time.** Freeze the app's clock, render each frame by time, and screenshot it. Video is stitched from those frames.
3. **Measurements beat opinions.** A failing hard check (`audit:*`, `frameDiff`, `blankFrame`) fails its rubric item whatever a judge says.
4. **The rubric is the goal.** Stop when every item passes. `aestheticScore` is shown on the dashboard and nothing else.
5. **`GEMINI_API_KEY` is read only by Node** (`node --env-file=.env`). Never use a `VITE_` prefix and never log it.
6. **High effort everywhere.** Every judge, pairwise and patcher call uses `gemini-4-argon` with `thinking: "high"`, and media at `media_resolution` high. Pass both explicitly on each `callModel` call rather than relying on role defaults. Don't downgrade either to save budget; cut iterations instead.

## Files

- Project adapter: `loop.config.json` at repo root. Example and field notes: [reference/loop.config.example.json](reference/loop.config.example.json).
- Rubric: `rubric/visual.json`. Example: [reference/rubric.example.json](reference/rubric.example.json).
- Model output schemas, passed to `callModel`: [schemas/judge.schema.json](schemas/judge.schema.json), [schemas/patch.schema.json](schemas/patch.schema.json).
- Code: `scripts/loop/{capture,judge,patch,run}.mjs`. Output: `runs/loop/<runId>/iter-<N>/` and `runs/loop/<runId>/dashboard.html`.

On startup, check that every non-null hook in the config exists on the page. If any are missing, exit with one error naming them all.

## 1. Capture: `capture.mjs`

1. Start `devCommand` once per run. Load the page fresh for every iteration. **No HMR**: stale WebGL state gives wrong frames.
2. Use Playwright Chromium with the configured viewport and `deviceScaleFactor`, and GPU flags (macOS: `--use-angle=metal`). Read the renderer string via `WEBGL_debug_renderer_info`. **Fail** if it is SwiftShader or another software renderer, because frames would look plausible but be wrong.
3. Before frame 0, wait for fonts (`document.fonts.ready`) and textures (the `ready` hook if present). Check that the app's `inspect` mode drives `performance.now`, `Date`, `requestAnimationFrame` and `Math.random` from `t` and the seed. If shaders, particles or water animate by wall clock, report it as a determinism defect.
4. For each `t` at `timeline.fps` (10–15 is enough), call `renderAt(t)` and take a `page.screenshot` clipped to the canvas. Don't use `toDataURL`: it needs `preserveDrawingBuffer`.
5. Take the configured shots and the tile sheet, and save `audit()` output plus page console errors to `audit.json`.
6. **Hard checks:**
   - `blankFrame`: any frame that is nearly a single color.
   - `frameDiff`: for each consecutive pair, the fraction of pixels whose change exceeds a threshold. Flag a spike when it exceeds `spikeFactor` × the segment median. Ignore the frames on either side of a segment boundary, since camera cuts are expected there. Mean-difference alone misses small flicker such as z-fighting.
7. Stitch frames with ffmpeg (`@ffmpeg-installer/ffmpeg` if there is no system ffmpeg). If stitching fails, continue with stills only.
8. Two captures of the same commit must match within a small per-pixel tolerance, not byte for byte, because GPUs aren't bit-exact.

## 2. Judges: `judge.mjs`

Both judges use `gemini-4-argon` and the `judge_a`/`judge_b` roles. They can't write files. **Put text instructions after the media**, and write timestamps as `MM:SS`.

- **judge_a (motion):** upload `flight.webm` via the Files API and poll until `ACTIVE`. Use **static** processing (not agentic, which suits long videos and has no custom fps). Clip to the motion segment with `start_offset`/`end_offset`, set `fps` near the capture rate, and set `media_resolution` high. Send a second part: a labelled filmstrip of the frames around each `frameDiff` spike. Grade motion items only.
- **judge_b (stills):** one call per segment or shot group. Send the relevant shot plus a high-resolution crop for each small-object item. Turn audit findings into **numbered marks drawn on the image** ("mark 3: is this rock touching the ground?"), not raw JSON, because judges over-trust text. Include reference images only for style items.
- **Pairwise:** a separate call comparing the previous best with the current version per item. Randomize which one is labelled A or B, ask in **both orders**, and count a winner only if it wins both times. Otherwise it's a tie.
- **Merging verdicts:**
  - A fail must cite a `t` or shot, plus a mark or region.
  - If the judges disagree, the item is `uncertain`: re-ask once on a tighter crop and take the majority of three.
  - Both judges are the same model family, so their agreement corroborates a verdict but doesn't validate it.
- **Golden set:** before the first live run, inject known defects (a floating prop, a blank frame in the morph, a hovering meeple, a frame of flicker) and run the judges on them. Record recall and false positives in `runs/loop/golden.json`. A judge may fail an item without a hard check only for defect types it caught in the golden set. These results are also good demo material.

## 3. Patcher: `patch.mjs`

1. **Start a fresh conversation each iteration.** The context holds only:
   - the current contents of the files in the allowlist relevant to the open defects
   - open defects with their measurements
   - steering notes
   - `triedLedger`: the last 6 failed attempts, one line each (`defectId, file, ≤25-word change, outcome`)

   Leave out old diffs, images and judge prose. Use `previousInteractionId` only for retries within one iteration.
2. The patcher returns patches per `schemas/patch.schema.json`: at most `maxPatchesPerIteration`, **one defect per patch**, highest severity first.
3. **Validate before writing:**
   - The path is inside the allowlist after normalization, with no `..`.
   - `search` includes at least 3 lines of context and occurs **exactly once**. On 0 or 2+ matches, return the reason and the line numbers of each match, and retry once.
   - The file still parses after the edit.
4. Run `acceptance`. On failure, retry once with the log. If it fails again, drop that patch, add it to `triedLedger`, and keep the others.
5. Commit as `loop iter <N>: <defectIds> <rationale>`.

## 4. Loop: `run.mjs`

```
node --env-file=.env scripts/loop/run.mjs [--max-iterations 4] [--budget-usd 5] [--notes "..."]
```

1. Work in worktree `wt/loop-<runId>` on branch `loop/<runId>`, starting from `integration`, using the orchestrator's worktree helpers.
2. Iteration 0 captures and judges the untouched draft.
3. Each later iteration runs patch → acceptance → capture → judge, then compares against the best so far:
   - **Better** (new best): strictly more rubric items pass, or the same number with more pairwise wins than losses. Any newly failing hard check makes it worse.
   - **Tie or worse:** run `git reset --hard <bestCommit>` and add the patches' defects to `triedLedger`. If the same defect has failed twice, tell the patcher to try a structurally different fix.
4. **Stop** on any of: every item passes, `maxIterations` reached, budget spent, or 2 iterations in a row with no improvement (a revert counts as no improvement).
5. **Human gate:** print the per-iteration rubric counts, the best iteration and the cost, then offer:
   - `[1] Continue`
   - `[2] Steer` (notes go into the next judge and patcher prompts)
   - `[3] Approve` (merge the best iteration into `integration` with `--no-ff`)

## 5. Dashboard

A static `dashboard.html`, regenerated after every iteration. It needs only:
- a rubric grid (items × iterations, pass/fail)
- iteration 0 next to the best iteration (stills, plus video if available)
- each iteration's defects with timestamps, patch diff, commit hash and cost

## 6. Tests: `tests/loop.test.ts` (`ORCH_FAKE=1`, offline)

Use a fake scene, `tests/fixtures/loop-scene.html`: a cube with the hooks.
1. A missing hook fails fast and names the hook.
2. The patcher rejects paths outside the allowlist, protected paths, and search blocks matching 0 or 2+ times.
3. A cube injected to pop in at a known frame trips `frameDiff`.
4. A worse or tied iteration resets to the best commit, and 2 non-improving iterations stop the loop.

## Definition of done

1. The offline tests pass.
2. The golden set has run and `golden.json` exists.
3. A live run on the target completes iteration 0 plus at least 2 patched iterations, and its dashboard shows the rubric changing.
4. Every call appears in `runs/orchestrator/trace.jsonl` within `budgetUsd`.
5. Approve merges the best iteration into `integration`.
6. Append lessons learned to `AGENTS.md`, commit, and stop.
