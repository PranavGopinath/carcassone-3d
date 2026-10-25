---
name: visual-feedback-loop
description: >-
  Build and run a project-agnostic visual feedback loop (Prompt 2): render a 3D/WebGL app
  deterministically, record a fly-through and named stills, have Gemini judges grade it against a
  rubric and reference images, auto-patch the renderer, keep the best iteration, and hand off to a
  human at a gate. Each project plugs in through a single `loop.config.json`.
---

# Visual Feedback Loop Skill (Prompt 2)

A single pass gives you a first draft. This skill builds the system that **renders what the app made, watches it, critiques it against the goal, and fixes it in a loop**. Nothing in it is game-specific. A project plugs in by providing deterministic render hooks and a `loop.config.json`. Tiers is the first project to use it.

**Prerequisites:** Prompt 0 (`subagent-orchestrator`) is done. Every model call goes through `callModel` in `scripts/lib/orchestrator.mjs`, so trace logging, budget caps and `ORCH_FAKE=1` apply here too. The target app passes its own build gates.

**Timebox:** 90–120 minutes, about 700 lines. If something isn't working at the timebox, ship the simpler fallback noted in that section. Don't gold-plate.

---

## 1. Principles

1. **Determinism first.** Never record wall-clock playback. Freeze the app's clock, render exact frames by time, screenshot each one, and stitch them with ffmpeg. The same commit must produce the same frames, otherwise you can't compare iterations.
2. **Hard facts beat opinions.** If the app can measure something (floating props, ungrounded meeples, stretched UVs, console errors), measure it and give the judges the numbers. A failed hard check fails its rubric item whatever the judges say.
3. **The rubric is the goal; the score is decoration.** The loop stops when every rubric item passes. The 0–100 aesthetic score only goes on the dashboard.
4. **Compare, don't just grade.** Absolute LLM scores drift between calls. Every iteration also gets a side-by-side "previous best vs. current" judgement.
5. **Keep the best version.** Every iteration is a git commit. If an iteration is worse than the best so far, revert to the best one.
6. **The patcher stays in its lane.** It may only edit paths in `patchAllowlist`. It never touches tests, the rubric, the gates or config.

---

## 2. Project Adapter: `loop.config.json`

Lives at the repo root. The loop reads it and nothing else project-specific.

```json
{
  "name": "tiers",
  "devCommand": "npm run dev -- --port 5173 --strictPort",
  "url": "http://localhost:5173/?inspect=1&seed=7&w=1280&h=720",
  "viewport": { "width": 1280, "height": 720, "deviceScaleFactor": 1 },
  "hooks": {
    "global": "__game",
    "ready": null,
    "loadFixture": "loadFixture",
    "renderAt": "renderAt",
    "timeUnit": "s",
    "listShots": "listShots",
    "captureShot": "captureShot",
    "audit": "audit",
    "tileSheet": "getTileSheet"
  },
  "fixture": "fixture-all-features",
  "timeline": {
    "fps": 30,
    "segments": [
      { "id": "flat",  "start": 0, "end": 3,  "focus": "Top-down 2D card: grid alignment, UI overlap" },
      { "id": "rise",  "start": 3, "end": 5,  "focus": "2D->3D morph: flicker, pop-in, cracks, jumps", "denseStills": 6 },
      { "id": "orbit", "start": 5, "end": 9,  "focus": "360 orbit: strata edges, cliff texture stretch, floating props" },
      { "id": "macro", "start": 9, "end": 12, "focus": "Waterfall foam/spray, bridge over water, meeple contact" }
    ]
  },
  "shots": ["board-2d", "terrace-overview", "waterfall-macro", "bridge-hill-macro",
            "cliff-closeup", "city-closeup", "meeple-ground", "underside-slab"],
  "references": ["reference/pic162877.jpg", "reference/carcassonne-layout.jpg", "docs/DESIGN.md"],
  "rubric": "rubric/visual.json",
  "patchAllowlist": ["src/render/", "src/tiles/"],
  "acceptance": ["npm run build", "npm test"],
  "limits": { "maxIterations": 4, "budgetUsd": 5, "maxPatchesPerIteration": 3 }
}
```

- A hook set to `null` is optional. `ready` falls back to waiting until `window[global]` exists and one `renderAt(0)` has been called.
- `timeUnit` is `"s"` or `"ms"`, so apps that render by milliseconds also work.
- On startup, check that every non-null hook exists. If any are missing, exit with a single error that lists them. Never guess at a hook.

## 3. Rubric: `rubric/visual.json` (protected path)

The rubric is a list of pass/fail items. Each item names where its evidence comes from (`judge`, `audit`, or both) and which segment or shot to look at. Tiers starter rubric:

```json
{
  "items": [
    { "id": "F1", "segment": "flat",  "text": "Board reads as a flat 2D map: no perspective skew, tiles edge-to-edge with no gaps", "source": "judge" },
    { "id": "F2", "segment": "flat",  "text": "UI panels do not cover the board", "source": "judge" },
    { "id": "R1", "segment": "rise",  "text": "No frame where geometry vanishes or flickers", "source": ["judge", "frameDiff"] },
    { "id": "R2", "segment": "rise",  "text": "Props rise with the terrain; nothing pops in at once", "source": ["judge", "frameDiff"] },
    { "id": "R3", "segment": "rise",  "text": "No cracks open between tiles during the morph", "source": "judge" },
    { "id": "O1", "segment": "orbit", "shot": "underside-slab", "text": "Layered soil/stone slab edge visible under the board", "source": "judge" },
    { "id": "O2", "segment": "orbit", "shot": "cliff-closeup", "text": "Cliff textures are not stretched", "source": ["judge", "audit:uvStretch"] },
    { "id": "O3", "segment": "orbit", "text": "No floating trees, rocks or props", "source": ["judge", "audit:floatingProps"] },
    { "id": "O4", "segment": "orbit", "text": "Water surfaces meet at shared tile edges", "source": ["judge", "audit:waterHeights"] },
    { "id": "M1", "segment": "macro", "shot": "waterfall-macro", "text": "Foam at waterfall crest and base; water flows downhill", "source": "judge" },
    { "id": "M2", "segment": "macro", "shot": "bridge-hill-macro", "text": "Bridge arch spans the river with water visibly flowing under it", "source": "judge" },
    { "id": "M3", "segment": "macro", "shot": "meeple-ground", "text": "Meeples sit on their features, not floating", "source": ["judge", "audit:meeplesGrounded"] },
    { "id": "T1", "shot": "tileSheet", "text": "Every tile feature meets its edge midpoint; style matches the references", "source": "judge" }
  ]
}
```

An item passes only if every source in its list passes.

---

## 4. Capture: `scripts/loop/capture.mjs`

`capture({ config, outDir })` writes:

```
runs/loop/<runId>/iter-<N>/
  frames/000000.png …        every frame of the timeline at timeline.fps
  flight.webm                frames stitched with ffmpeg (VP9, CRF 30)
  stills/<segment>-<t>.png   3 evenly spaced stills per segment, plus `denseStills` for the rise
  shots/<name>.png           each configured shot
  tilesheet.png              when the tileSheet hook exists
  audit.json                 hooks.audit() output, plus console errors and warnings from the page
  framediff.json             frame-to-frame pixel-difference spikes
```

Steps:
1. Start `devCommand` once per run and wait for the port. Load the page fresh for every iteration. **Do not rely on HMR**, because stale WebGL state gives misleading frames.
2. Launch Playwright Chromium with the configured viewport and `deviceScaleFactor`. Use GPU-backed WebGL where the OS supports it (on macOS: `--use-angle=metal`). Software rendering is a fallback, and the run should log a warning when it falls back.
3. Load the fixture, then for `t` from `0` to the timeline end in steps of `1/fps`, call `renderAt(t)` and screenshot the canvas.
4. **Frame diff:** compute the mean absolute pixel difference between consecutive frames (`pngjs`). Record any frame whose difference is more than 4× the segment's median as a spike, with its timestamp. Spikes count as hard evidence for the `frameDiff` source, and the spike frames are added to the judges' stills.
5. Stitch the frames with ffmpeg. If ffmpeg is missing, use `@ffmpeg-installer/ffmpeg`. If that also fails, skip the video and send only stills; the loop still works without it.
6. Always close the browser in a `finally` block.

## 5. Judges: `scripts/loop/judge.mjs`

Two independent judges, using the `judge_a` and `judge_b` roles from Prompt 0. Neither can write files.

- **judge_a (motion):** gets `flight.webm` uploaded with `ai.files.upload` (poll until the file is `ACTIVE`), the segment list, and the frame-diff spikes. It grades the motion items (`R*`) and anything that needs a sense of timing. Request a higher video sampling rate if the API supports it. The dense rise stills cover it either way, because a 1.4 s morph sampled at 1 fps is close to invisible.
- **judge_b (stills):** gets the stills, the shots, the tile sheet, the reference images, `audit.json`, and **the previous best iteration's stills, side by side**. It grades the static items and answers which version is better (prev or current) for each item.

Both judges return strict JSON (pass a schema to `callModel`):

```json
{
  "aestheticScore": 0,
  "summary": "",
  "items": [{ "id": "M3", "pass": false, "evidence": "meeple at 10.4s hovers ~2px above road", "t": 10.4, "shot": "meeple-ground" }],
  "defects": [{ "id": "D1", "itemIds": ["M3"], "severity": "high", "t": 10.4, "description": "", "suspectedArea": "meeple placement height" }],
  "pairwise": [{ "id": "M3", "better": "current" }]
}
```

Merge the two verdicts. A hard check (`audit:*`, `frameDiff`) overrides both judges. If the judges disagree on an item, it counts as failed, and both pieces of evidence go to the patcher.

## 6. Patcher: `scripts/loop/patch.mjs`

1. **Route:** the `router` role maps each defect to 1–3 candidate files inside `patchAllowlist`, using the file list and `suspectedArea`. Send the patcher those files' full contents, nothing more.
2. **Patch:** the `patcher` role returns `{ patches: [{ path, search, replace }], rationale }`, with at most `maxPatchesPerIteration` patches, fixing high-severity defects first.
3. **Validate before writing:** the path must be in `patchAllowlist` (normalized, no `..`). `search` must occur **exactly once** in the file. Anything else is rejected and sent back to the patcher once, with the reason, via `previousInteractionId`.
4. **Apply, then run `acceptance`.** On failure, send the log back to the patcher once. If it fails again, drop that patch and keep the rest.
5. Commit as `loop iter <N>: <rationale>`.

If the orchestrator requires static ownership, set the `patcher` role's `ownsPaths` to `patchAllowlist`. Protected paths (`tests/`, `rubric/`, `scripts/gates/`, `loop.config.json`) are never writable.

## 7. Loop Driver: `scripts/loop/run.mjs`

```
node --env-file=.env scripts/loop/run.mjs [--max-iterations 4] [--budget-usd 5] [--notes "..."] [--resume <runId>]
```

1. Create a worktree `wt/loop-<runId>` on branch `loop/<runId>`, starting from `integration`.
2. **Iteration 0** is the untouched first draft: capture and judge only, no patch.
3. Each iteration after that: patch → acceptance → capture → judge → decide:
   - **Better or equal:** more rubric items pass, or the same number with pairwise wins ≥ losses. This becomes the new best.
   - **Worse:** run `git reset --hard <bestCommit>` on the loop branch, record the regression, and pass the failed patch's rationale to the next patcher call as "already tried".
4. **Stop** when all rubric items pass, `maxIterations` is reached, the budget runs out, or two iterations in a row fail to improve. Then go to the gate.
5. Steering notes from `--notes` or the gate go into every judge and patcher prompt for the next round.
6. Write `runs/loop/<runId>/ledger.json` after every step, so `--resume` can continue from it.

`GEMINI_API_KEY` is read only by Node scripts. Never expose it to the browser bundle (no `VITE_` prefix).

## 8. Human Gate

When the loop stops, print a table: iterations, rubric items passed per iteration, the best iteration, and cost so far. Then prompt with `readline`:

```
[1] Continue    run N more iterations toward the rubric
[2] Steer       type notes (e.g. "cliffs too dark, soften the sun") -> continue with notes
[3] Revert      check out iteration K as the new best
[4] Approve     merge the best iteration into integration (--no-ff) and exit
[5] Abort       leave integration untouched and exit
```

## 9. Dashboard: `runs/loop/<runId>/dashboard.html`

A self-contained static page, regenerated after every iteration. This is the demo's centerpiece.

- **Top:** iteration 0 and the best iteration side by side (video, plus a before/after slider on one key shot).
- **Rubric grid:** one row per rubric item, one column per iteration, each cell pass or fail. Hovering a cell shows the evidence.
- **Per iteration:** the video, with the defect list under it; clicking a defect's timestamp jumps the video there. Also the stills, the shots, the audit numbers, the patch diff (inline, with the commit hash), and the cost.
- **Timeline of human gate decisions** and steering notes.

## 10. Offline Tests: `tests/loop.test.ts` (`ORCH_FAKE=1`)

Run against a tiny fixture page (`tests/fixtures/loop-scene.html`: a spinning cube with fake hooks), so the tests need neither the real app nor the network:
- `capture` produces the right frame count. Two captures of the same commit produce byte-identical frames.
- Frame diff flags a cube that's injected to pop in at a known frame.
- A missing hook fails fast with the hook's name in the error.
- The patcher rejects paths outside the allowlist, search blocks that match 0 or 2+ times, and protected paths.
- A worse iteration is reverted to the best commit. Two non-improving iterations stop the loop.
- A hard check failing overrides a judge's pass.
- The dashboard renders from a ledger without network access.

---

## 11. Definition of Done (Prompt 2)

1. `ORCH_FAKE=1 npm test` passes the loop tests offline.
2. A live run on Tiers completes iteration 0 plus at least 2 patched iterations, and its `dashboard.html` shows the rubric moving.
3. Every model call appears in `runs/orchestrator/trace.jsonl` with its cost, and the run stays within `budgetUsd`.
4. Approving at the gate merges the best iteration into `integration`. Aborting leaves `integration` untouched.
5. Append lessons learned to `AGENTS.md`, commit, and stop.
