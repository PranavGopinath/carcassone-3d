import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  callModel,
  ensureTraceStateInitialized as ensurePersistentSpendState,
  createLoopWorktree,
  removeLoopWorktree,
} from '../lib/orchestrator.mjs';
import {
  loadLoopConfig,
  startDevServer,
  checkPageHooksAndSelectors,
  captureIteration,
  stitchVideo,
} from './capture.mjs';
import {
  loadRubric,
  loadJudgeSchema,
  validateRubricAndReferences,
  judgeIteration,
  runPairwiseComparison,
  formatTimestamp,
  drawMarksOnImage,
} from './judge.mjs';
import {
  getBaselineTestFiles,
  buildSrcOutline,
  runPatcherIteration,
  resetToCommit,
  recordFailedAttemptInLedger,
} from './patch.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '../..');

/**
 * Compares `currentVerdicts` against `bestVerdicts` and `pairwiseResult` per §4.3 & Hard Rules 9, 11:
 * - Worse if any hard check newly fails, any previously passing defect item now fails in ANY view,
 *   or pairwise confirms an out-of-scope change in both orders.
 * - Better if not worse and either more rubric items pass (or more per-view passes when item counts tie),
 *   or the same number pass and pairwise wins exceed losses.
 * - Tie otherwise.
 */
export function compareIterations(bestVerdicts, currentVerdicts, pairwiseResult = null) {
  const regressions = [];

  if (pairwiseResult?.confirmedOutOfScopeChange) {
    regressions.push('Pairwise judge confirmed an out-of-scope change in both orders (Hard Rule 11)');
  }

  const bestItems = bestVerdicts?.items || {};
  const currItems = currentVerdicts?.items || {};

  let bestViewPassCount = 0;
  let currViewPassCount = 0;

  for (const [itemId, bestItem] of Object.entries(bestItems)) {
    if (bestItem.reportOnly) continue;
    const currItem = currItems[itemId];
    if (!currItem) continue;

    for (const v of bestItem.views || ['3d']) {
      const bView = bestItem.perView?.[v];
      const cView = currItem.perView?.[v];
      if (bView?.verdict === 'pass') bestViewPassCount += 1;
      if (cView?.verdict === 'pass') currViewPassCount += 1;

      // Hard check regression in any view
      if (bView?.hardPass === true && cView?.hardPass === false) {
        regressions.push(`Hard check newly failed on item ${itemId} in view '${v}'`);
      }

      // Defect item regression in any view (Hard Rule 9 & §4.3: a fix in 3D that breaks 2D is a regression)
      if (bestItem.kind === 'defect' && bView?.verdict === 'pass' && cView?.verdict === 'fail') {
        regressions.push(`Previously passing defect item ${itemId} failed in view '${v}'`);
      }
    }
  }

  if (regressions.length > 0) {
    return {
      outcome: 'worse',
      better: false,
      worse: true,
      reasons: regressions,
    };
  }

  const bestPassed = Number(bestVerdicts?.passedCount ?? 0);
  const currPassed = Number(currentVerdicts?.passedCount ?? 0);

  if (currPassed > bestPassed) {
    return {
      outcome: 'better',
      better: true,
      worse: false,
      reasons: [`Passed rubric items increased from ${bestPassed} to ${currPassed}`],
    };
  }

  if (currPassed === bestPassed && currViewPassCount > bestViewPassCount) {
    return {
      outcome: 'better',
      better: true,
      worse: false,
      reasons: [`Per-view passes increased from ${bestViewPassCount} to ${currViewPassCount} (items tied at ${currPassed})`],
    };
  }

  const pwWins = Number(pairwiseResult?.currentWins ?? 0);
  const pwLosses = Number(pairwiseResult?.bestWins ?? 0);

  if (currPassed === bestPassed && pwWins > pwLosses) {
    return {
      outcome: 'better',
      better: true,
      worse: false,
      reasons: [`Rubric pass count tied (${currPassed}) and pairwise wins (${pwWins}) exceeded losses (${pwLosses})`],
    };
  }

  if (currPassed < bestPassed) {
    return {
      outcome: 'worse',
      better: false,
      worse: true,
      reasons: [`Passed rubric items decreased from ${bestPassed} to ${currPassed}`],
    };
  }

  return {
    outcome: 'tie',
    better: false,
    worse: false,
    reasons: [`Tied at ${currPassed} passing items (pairwise ${pwWins}W-${pwLosses}L)`],
  };
}

/**
 * Escalates to `lead_architect` after `limits.plateauIterations` non-improving iterations (§4.4).
 */
export async function escalateToLeadArchitect({
  workDir,
  config,
  iterationHistory,
  triedLedger,
  bestCapture,
  bestVerdicts,
  options = {},
}) {
  const inputParts = [];
  let imgCount = 0;

  const addImg = (label, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return;
    imgCount += 1;
    inputParts.push({ type: 'text', text: `[Image ${imgCount}: ${label}]` });
    inputParts.push({
      type: 'image',
      data: fs.readFileSync(filePath).toString('base64'),
      mime_type: 'image/png',
      media_resolution: 'high',
      resolution: 'high',
    });
  };

  for (const refRel of config.references || []) {
    addImg(`reference ${path.basename(refRel)}`, path.resolve(workDir, refRel));
  }

  for (const sName of ['terrace-overview', 'underside-slab', 'city-closeup', 'board-2d', 'tileSheet']) {
    if (bestCapture?.shotPaths?.[sName]) {
      addImg(`best shot ${sName}`, bestCapture.shotPaths[sName]);
    }
  }

  const historySummary = (iterationHistory || []).map((it) => ({
    iteration: it.iteration,
    passedCount: it.verdicts?.passedCount,
    totalCount: it.verdicts?.totalCount,
    outcome: it.comparison?.outcome || 'baseline',
    openDefects: (it.verdicts?.openDefects || []).slice(0, 8).map((d) => `${d.id}: ${d.description}`),
  }));

  const srcOutline = buildSrcOutline(workDir);

  inputParts.push({
    type: 'text',
    text: [
      `You are the Lead Architect. The visual feedback loop has plateaued for ${config.limits?.plateauIterations || 2} consecutive iterations.`,
      `## Rubric History`,
      JSON.stringify(historySummary, null, 2),
      `## Tried Ledger`,
      ...(triedLedger.length > 0 ? triedLedger : ['(none)']),
      `## Open Defects on Best Iteration`,
      ...(bestVerdicts?.openDefects || []).map((d) => `- [${d.id}] (${d.severity}, view=${d.view}): ${d.description}`),
      `## Source Outline (src/)`,
      srcOutline,
      ``,
      `Provide a structural diagnosis and concrete architectural plan (specific files, functions, geometry/material/lighting techniques, and regression tests) for the patcher to break through this plateau. Return JSON with { "diagnosis": "...", "plan": "..." }.`,
    ].join('\n'),
  });

  const schema = {
    type: 'object',
    required: ['diagnosis', 'plan'],
    properties: {
      diagnosis: { type: 'string' },
      plan: { type: 'string' },
    },
  };

  const res = await callModel({
    role: 'lead_architect',
    model: config.model?.name || 'gemini-4-argon',
    thinking: 'high',
    mediaResolution: 'high',
    media_resolution: 'high',
    input: inputParts,
    taskId: `loop_escalation_${iterationHistory.length}`,
    schema,
    rootDir: options.rootDir || workDir,
    tracePath: options.tracePath,
    state: options.state,
    budgetUsd: options.budgetUsd,
    fakeHandler: options.fakeEscalationHandler || options.fakeHandler,
  });

  const diagnosis = res.output?.diagnosis || 'Plateau detected across recent patch attempts.';
  const plan =
    res.output?.plan ||
    (typeof res.output?.notes === 'string' && res.output.notes) ||
    'Refactor terrain/prop grounding and procedural material detail directly in renderer.ts and painter.ts.';

  return {
    interactionId: res.interactionId,
    diagnosis,
    plan: `Diagnosis: ${diagnosis}\nStructural Plan: ${plan}`,
  };
}

/**
 * Generates static `runs/loop/<runId>/dashboard.html` after every iteration (§5).
 */
// Merges the loop branch into baseBranch; on conflict, aborts and reports the files.
function mergeLoopWorktree(rootDir, wtDir, runId, baseBranch = 'main') {
  const safeId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const branchName = `loop/${safeId}`;

  // Remove the worktree checkout first so branch/worktree locks don't interfere
  removeLoopWorktree(rootDir, wtDir, branchName, false);

  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    if (currentBranch !== baseBranch) {
      execSync(`git checkout "${baseBranch}"`, { cwd: rootDir, stdio: 'pipe' });
    }
    execSync(`git merge --no-ff "${branchName}" -m "Merge ${branchName} into ${baseBranch}"`, {
      cwd: rootDir,
      stdio: 'pipe',
    });
    return {
      merged: true,
      conflict: false,
      conflictingFiles: [],
      branch: branchName,
    };
  } catch {
    let conflictingFiles = [];
    try {
      const out = execSync('git diff --name-only --diff-filter=U', {
        cwd: rootDir,
        encoding: 'utf8',
      }).trim();
      if (out) {
        conflictingFiles = out.split('\n').map((s) => s.trim()).filter(Boolean);
      }
    } catch {
      // ignore
    }
    try {
      execSync('git merge --abort', { cwd: rootDir, stdio: 'pipe' });
    } catch {
      // ignore
    }
    return {
      merged: false,
      conflict: true,
      conflictingFiles,
      branch: branchName,
    };
  }
}

export function generateDashboardHtml(runDir, loopState) {
  const {
    runId,
    config,
    rubric,
    iterations = [],
    bestIteration = 0,
    triedLedger = [],
    escalations = [],
    totalCostUsd = 0,
    stopReason = 'in_progress',
    mergeResult = null,
  } = loopState;

  const relFromRunDir = (absPath) => {
    if (!absPath) return '';
    return path.relative(runDir, absPath).replace(/\\/g, '/');
  };

  const iter0 = iterations.find((it) => it.iteration === 0) || iterations[0];
  const bestIterObj = iterations.find((it) => it.iteration === bestIteration) || iter0;

  const rubricItems = rubric?.items || [];

  // 1. Rubric grid (items x iterations, with item kind, showing pass/fail per view)
  const rubricRowsHtml = rubricItems
    .map((item) => {
      const cells = iterations
        .map((it) => {
          const r = it.verdicts?.items?.[item.id];
          if (!r) return `<td>-</td>`;
          const perViewBadges = (item.views || ['3d'])
            .map((v) => {
              const pv = r.perView?.[v];
              const pass = pv?.verdict === 'pass';
              return `<span class="badge ${pass ? 'pass' : 'fail'}">${v}: ${pass ? 'PASS' : 'FAIL'}</span>`;
            })
            .join(' ');
          return `<td>${perViewBadges}</td>`;
        })
        .join('');

      return `
        <tr>
          <td><strong>${item.id}</strong> ${item.reportOnly ? '<span class="badge report-only">reportOnly</span>' : ''}</td>
          <td><span class="badge kind-${item.kind}">${item.kind}</span></td>
          <td>${(item.views || []).join(', ')}</td>
          <td>${escapeHtml(item.text)}</td>
          ${cells}
        </tr>
      `;
    })
    .join('\n');

  // 2. Fidelity items: reference | iteration 0 | best, side by side, with best's open gaps
  const fidelityItems = rubricItems.filter((it) => it.kind === 'fidelity');
  const fidelityCardsHtml = fidelityItems
    .map((item) => {
      const v = (item.views || ['3d'])[0];
      const shotName = item.shot || 'terrace-overview';
      const refPath = (item.references || [])[0]
        ? path.resolve(loopState.workDir || DEFAULT_ROOT, item.references[0])
        : null;
      const iter0Shot = iter0?.capture?.shotPaths?.[shotName];
      const bestShot = bestIterObj?.capture?.shotPaths?.[shotName];
      const bestItemRes = bestIterObj?.verdicts?.items?.[item.id]?.perView?.[v];
      const openGaps = bestItemRes?.gaps || [];

      return `
        <div class="card fidelity-card">
          <h3>${item.id}: ${escapeHtml(item.text)} <span class="badge ${bestItemRes?.verdict === 'pass' ? 'pass' : 'fail'}">${bestItemRes?.verdict || 'n/a'}</span></h3>
          <p class="aspect"><strong>Aspect:</strong> ${escapeHtml(item.aspect || '')}</p>
          <div class="side-by-side-3">
            <div>
              <div class="img-label">Reference (${escapeHtml(path.basename(refPath || ''))})</div>
              ${refPath ? `<img src="${relFromRunDir(refPath)}" alt="ref" />` : '<div class="missing">No ref</div>'}
            </div>
            <div>
              <div class="img-label">Iteration 0 (${shotName})</div>
              ${iter0Shot ? `<img src="${relFromRunDir(iter0Shot)}" alt="iter-0" />` : '<div class="missing">N/A</div>'}
            </div>
            <div>
              <div class="img-label">Best (Iter ${bestIteration})</div>
              ${bestShot ? `<img src="${relFromRunDir(bestShot)}" alt="best" />` : '<div class="missing">N/A</div>'}
            </div>
          </div>
          <div class="gaps-list">
            <strong>Open Fidelity Gaps (Best Iter ${bestIteration}):</strong>
            ${
              openGaps.length === 0
                ? '<span class="pass-text">None (All high/medium gaps resolved)</span>'
                : `<ul>${openGaps
                    .map(
                      (g) =>
                        `<li><span class="badge sev-${g.severity}">${g.severity}</span> <strong>[${escapeHtml(g.region || 'board')}]</strong> ${escapeHtml(g.description)}</li>`
                    )
                    .join('')}</ul>`
            }
          </div>
        </div>
      `;
    })
    .join('\n');

  // 3. Shots & Page Shots: Iteration 0 vs Best
  const allShotNames = [
    ...(config?.shots || []),
    'tileSheet',
    ...((config?.pageShots || []).map((ps) => ps.id)),
  ];
  const shotsComparisonHtml = allShotNames
    .map((sName) => {
      const s0 = iter0?.capture?.shotPaths?.[sName];
      const sBest = bestIterObj?.capture?.shotPaths?.[sName];
      if (!s0 && !sBest) return '';
      return `
        <div class="card">
          <h4>Shot: ${escapeHtml(sName)}</h4>
          <div class="side-by-side-2">
            <div>
              <div class="img-label">Iteration 0</div>
              ${s0 ? `<img src="${relFromRunDir(s0)}" />` : ''}
            </div>
            <div>
              <div class="img-label">Best (Iter ${bestIteration})</div>
              ${sBest ? `<img src="${relFromRunDir(sBest)}" />` : ''}
            </div>
          </div>
        </div>
      `;
    })
    .join('\n');

  // 4. Videos: Cinematic flight.webm + Gameplay videos in each view (Iter 0 vs Best)
  const videoCardsHtml = [];
  if (iter0?.capture?.flightWebmPath || bestIterObj?.capture?.flightWebmPath) {
    videoCardsHtml.push(`
      <div class="card">
        <h4>Cinematic Timeline (flight.webm)</h4>
        <div class="side-by-side-2">
          <div>
            <div class="img-label">Iteration 0</div>
            ${iter0?.capture?.flightWebmPath ? `<video controls loop muted src="${relFromRunDir(iter0.capture.flightWebmPath)}"></video>` : 'N/A'}
          </div>
          <div>
            <div class="img-label">Best (Iter ${bestIteration})</div>
            ${bestIterObj?.capture?.flightWebmPath ? `<video controls loop muted src="${relFromRunDir(bestIterObj.capture.flightWebmPath)}"></video>` : 'N/A'}
          </div>
        </div>
      </div>
    `);
  }

  for (const script of config?.gameplay?.scripts || []) {
    const views = script.perView ? config?.gameplay?.views || ['2d', '3d'] : [script.startView || '2d'];
    for (const v of views) {
      const v0 = iter0?.capture?.gameplay?.[script.id]?.[v]?.videoPath;
      const vBest = bestIterObj?.capture?.gameplay?.[script.id]?.[v]?.videoPath;
      videoCardsHtml.push(`
        <div class="card">
          <h4>Gameplay: ${escapeHtml(script.id)} (${escapeHtml(v)})</h4>
          <div class="side-by-side-2">
            <div>
              <div class="img-label">Iteration 0</div>
              ${v0 ? `<video controls loop muted src="${relFromRunDir(v0)}"></video>` : 'Stills only'}
            </div>
            <div>
              <div class="img-label">Best (Iter ${bestIteration})</div>
              ${vBest ? `<video controls loop muted src="${relFromRunDir(vBest)}"></video>` : 'Stills only'}
            </div>
          </div>
        </div>
      `);
    }
  }

  // 5. Per-iteration defects, patcher reports, diff stats, regression tests, commit hash, cost, escalation plans
  const iterLogsHtml = iterations
    .map((it) => {
      const defs = it.verdicts?.openDefects || [];
      const ownerDefs = it.verdicts?.forTheOwner?.defects || [];
      const patchRep = it.patch?.report;
      const esc = escalations.find((e) => e.beforeIteration === it.iteration);

      return `
        <div class="card iter-card">
          <h3>Iteration ${it.iteration} ${it.iteration === bestIteration ? '<span class="badge pass">BEST</span>' : ''}</h3>
          <p>
            <strong>Commit:</strong> <code>${escapeHtml(it.commitHash || 'n/a')}</code> |
            <strong>Rubric Passed:</strong> ${it.verdicts?.passedCount ?? 0} / ${it.verdicts?.totalCount ?? 0}
            (Defects: ${it.verdicts?.defectPassedCount ?? 0}/${it.verdicts?.defectTotalCount ?? 0},
             Fidelity: ${it.verdicts?.fidelityPassedCount ?? 0}/${it.verdicts?.fidelityTotalCount ?? 0}) |
            <strong>Outcome:</strong> ${escapeHtml(it.comparison?.outcome || 'initial')} |
            <strong>Cumulative Cost:</strong> $${Number(it.cumulativeCostUsd ?? 0).toFixed(4)}
          </p>
          ${
            esc
              ? `<div class="escalation-box"><strong>Lead Architect Escalation Plan:</strong><pre>${escapeHtml(esc.plan)}</pre></div>`
              : ''
          }
          ${
            patchRep
              ? `<div class="patch-box">
                  <strong>Patcher Summary:</strong> ${escapeHtml(patchRep.summary || '')}<br/>
                  <strong>Diff Stat:</strong> <pre>${escapeHtml(it.patch?.diffStat || '(no changes)')}</pre>
                  <strong>New Regression Tests:</strong> ${escapeHtml((it.patch?.newRegressionTests || []).join(', ') || 'none')}
                </div>`
              : ''
          }
          <div>
            <strong>Open Defects (${defs.length}):</strong>
            <ul>
              ${defs
                .map(
                  (d) =>
                    `<li><code>${escapeHtml(d.id)}</code> [${escapeHtml(d.severity)}] (view: ${escapeHtml(d.view || 'all')}, t: ${escapeHtml(d.t || '00:00')}, shot: ${escapeHtml(d.shot || 'n/a')}): ${escapeHtml(d.description)}</li>`
                )
                .join('')}
            </ul>
          </div>
          ${
            ownerDefs.length > 0
              ? `<div class="owner-box">
                  <strong>For the Owner (reportOnly HUD items):</strong>
                  <ul>${ownerDefs.map((d) => `<li><code>${escapeHtml(d.id)}</code>: ${escapeHtml(d.description)}</li>`).join('')}</ul>
                </div>`
              : ''
          }
        </div>
      `;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Visual Feedback Loop Dashboard — ${escapeHtml(runId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1, h2, h3, h4 { margin-top: 0; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; background: #1e293b; padding: 16px 20px; border-radius: 10px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { border: 1px solid #334155; padding: 8px 10px; text-align: left; font-size: 13px; }
    th { background: #0f172a; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .badge.pass { background: #16a34a; color: #fff; }
    .badge.fail { background: #dc2626; color: #fff; }
    .badge.report-only { background: #475569; color: #e2e8f0; }
    .badge.kind-defect { background: #2563eb; color: #fff; }
    .badge.kind-fidelity { background: #9333ea; color: #fff; }
    .badge.sev-high { background: #dc2626; color: #fff; }
    .badge.sev-medium { background: #d97706; color: #fff; }
    .badge.sev-low { background: #475569; color: #fff; }
    .side-by-side-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 12px 0; }
    .side-by-side-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 12px 0; }
    .img-label { font-size: 12px; color: #94a3b8; margin-bottom: 4px; font-weight: 600; }
    img, video { width: 100%; border-radius: 6px; border: 1px solid #475569; background: #000; }
    pre { background: #0f172a; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
    .escalation-box { background: #31102f; border: 1px solid #a21caf; padding: 10px; border-radius: 6px; margin: 10px 0; }
    .owner-box { background: #1e293b; border-left: 4px solid #64748b; padding-left: 10px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="header-bar">
    <div>
      <h1>Visual Feedback Loop — <code>${escapeHtml(runId)}</code></h1>
      <div>Best Iteration: <strong>#${bestIteration}</strong> | Stop Reason: <strong>${escapeHtml(stopReason)}</strong> | Total Spend: <strong>$${Number(totalCostUsd).toFixed(4)}</strong> | Merge: <strong>${escapeHtml(mergeResult ? (mergeResult.merged ? 'Merged' : 'Unmerged') : 'Pending')}</strong></div>
    </div>
  </div>

  <h2>1. Rubric Grid (Items × Iterations)</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Kind</th>
        <th>Views</th>
        <th>Requirement</th>
        ${iterations.map((it) => `<th>Iter ${it.iteration}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${rubricRowsHtml}
    </tbody>
  </table>

  <h2>2. Fidelity Comparisons (Reference | Iteration 0 | Best)</h2>
  ${fidelityCardsHtml}

  <h2>3. Still Shots & Page Shots (Iteration 0 vs Best)</h2>
  ${shotsComparisonHtml}

  <h2>4. Motion & Gameplay Videos (Iteration 0 vs Best)</h2>
  ${videoCardsHtml.join('\n')}

  <h2>5. Iteration History, Defects, Patcher Reports & Escalations</h2>
  ${iterLogsHtml}
</body>
</html>`;

  fs.mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, 'dashboard.html');
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Produces synthetic image perturbations on captured PNGs for the Golden Set (§2 Golden set)
 * so every defect class (floating prop, blank morph frame, hovering meeple, 1-frame flicker,
 * pop-in, gameplay instant tile placement with no drop animation, and cross-view mismatch)
 * is genuinely visible in the media sent to `judge_a` / `judge_b`.
 */
async function createGoldenPerturbedArtifacts(baseCapture, goldenDir) {
  fs.mkdirSync(goldenDir, { recursive: true });

  // Helper to edit a PNG with a 2D canvas callback
  const mutatePng = async (srcPath, destPath, drawFn) => {
    const img = await loadImage(srcPath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    await drawFn(ctx, img.width, img.height, img);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, canvas.toBuffer('image/png'));
    return destPath;
  };

  // 1. Floating prop on terrace-overview (3d)
  const floatingPropShot = path.join(goldenDir, 'floating-prop-terrace.png');
  await mutatePng(baseCapture.shotPaths['terrace-overview'], floatingPropShot, (ctx, w, h) => {
    // Draw an unmistakable floating pine tree high in the air above the board with a vertical gap
    const tx = Math.round(w * 0.48);
    const ty = Math.round(h * 0.22);
    ctx.fillStyle = '#5c4033';
    ctx.fillRect(tx - 6, ty + 35, 12, 26);
    ctx.fillStyle = '#1e5631';
    ctx.beginPath();
    ctx.moveTo(tx, ty - 20);
    ctx.lineTo(tx - 32, ty + 38);
    ctx.lineTo(tx + 32, ty + 38);
    ctx.closePath();
    ctx.fill();
    // Draw a shadow far below on the terrain to make the floating gap obvious
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(tx, ty + 145, 26, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  // 2. Hovering meeple on meeple-ground (3d)
  const hoveringMeepleShot = path.join(goldenDir, 'hovering-meeple.png');
  await mutatePng(baseCapture.shotPaths['meeple-ground'], hoveringMeepleShot, (ctx, w, h) => {
    const mx = Math.round(w * 0.52);
    const my = Math.round(h * 0.26);
    // Dark shadow far below on the road/city surface
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.ellipse(mx, my + 130, 28, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    // Bright blue pawn hovering high in the air with empty space underneath
    ctx.fillStyle = '#3b82f6';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(mx, my, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(mx - 16, my + 18, 32, 38);
    ctx.strokeRect(mx - 16, my + 18, 32, 38);
  });

  // 3. Cross-view mismatch (remove features/buildings on tile #1 in 3D while keeping 2D intact)
  const crossView2d = path.join(goldenDir, 'cross-view-2d.png');
  const crossView3d = path.join(goldenDir, 'cross-view-3d.png');
  fs.copyFileSync(baseCapture.shotPaths['board-2d'], crossView2d);
  await mutatePng(baseCapture.shotPaths['terrace-overview'], crossView3d, (ctx, w, h) => {
    // Paint a flat empty grey void over the central city/monastery tiles in 3D so 3D is missing the buildings shown in 2D
    ctx.fillStyle = '#6ca64c';
    ctx.fillRect(Math.round(w * 0.35), Math.round(h * 0.35), Math.round(w * 0.28), Math.round(h * 0.26));
  });

  // 4. Blank morph frame in 'rise' timeline segment
  const blankFramesDir = path.join(goldenDir, 'frames-blank-rise');
  fs.mkdirSync(blankFramesDir, { recursive: true });
  const baseRiseFrames = (baseCapture.timeline?.framePaths || []).slice(36, 61);
  const blankRisePaths = [];
  for (let i = 0; i < baseRiseFrames.length; i++) {
    const dest = path.join(blankFramesDir, `frame-${String(i).padStart(4, '0')}.png`);
    if (i === 10 || i === 11) {
      await mutatePng(baseRiseFrames[i], dest, (ctx, w, h) => {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, w, h);
      });
    } else {
      fs.copyFileSync(baseRiseFrames[i], dest);
    }
    blankRisePaths.push(dest);
  }
  const blankRiseWebm = path.join(goldenDir, 'blank-rise.webm');
  stitchVideo(blankFramesDir, blankRiseWebm, 12);

  // 5. Flicker frame in 'rise' timeline segment
  const flickerFramesDir = path.join(goldenDir, 'frames-flicker-rise');
  fs.mkdirSync(flickerFramesDir, { recursive: true });
  const flickerRisePaths = [];
  for (let i = 0; i < baseRiseFrames.length; i++) {
    const dest = path.join(flickerFramesDir, `frame-${String(i).padStart(4, '0')}.png`);
    if (i === 12) {
      await mutatePng(baseRiseFrames[i], dest, (ctx, w, h) => {
        // Vanish board geometry into bright magenta/white glitch flicker for 1 frame
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(Math.round(w * 0.15), Math.round(h * 0.15), Math.round(w * 0.7), Math.round(h * 0.7));
      });
    } else {
      fs.copyFileSync(baseRiseFrames[i], dest);
    }
    flickerRisePaths.push(dest);
  }
  const flickerRiseWebm = path.join(goldenDir, 'flicker-rise.webm');
  stitchVideo(flickerFramesDir, flickerRiseWebm, 12);

  // 6. Pop-in during 'rise' segment (props/buildings missing for first half then pop in all at once)
  const popinFramesDir = path.join(goldenDir, 'frames-popin-rise');
  fs.mkdirSync(popinFramesDir, { recursive: true });
  const popinRisePaths = [];
  for (let i = 0; i < baseRiseFrames.length; i++) {
    const dest = path.join(popinFramesDir, `frame-${String(i).padStart(4, '0')}.png`);
    if (i >= 12) {
      await mutatePng(baseRiseFrames[i], dest, (ctx, w, h) => {
        // Sudden un-animated giant red/orange block popping in at frame 12 with huge cracks
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(Math.round(w * 0.38), Math.round(h * 0.28), 180, 140);
        ctx.fillStyle = '#000000';
        ctx.fillRect(Math.round(w * 0.32), Math.round(h * 0.48), 320, 14);
      });
    } else {
      fs.copyFileSync(baseRiseFrames[i], dest);
    }
    popinRisePaths.push(dest);
  }
  const popinRiseWebm = path.join(goldenDir, 'popin-rise.webm');
  stitchVideo(popinFramesDir, popinRiseWebm, 12);

  return {
    floatingPropShot,
    hoveringMeepleShot,
    crossView2d,
    crossView3d,
    blankRisePaths,
    blankRiseWebm,
    flickerRisePaths,
    flickerRiseWebm,
    popinRisePaths,
    popinRiseWebm,
  };
}

/**
 * Runs the real Golden Set (§2 Golden set) before the first live run and writes `runs/loop/golden.json`.
 * - Hides hard checks from the vision judges.
 * - Tests injected defects across both views (`2d` and `3d`), including a cross-view consistency case.
 * - Calibrates fidelity judges on the reference images (must pass with no high gaps) vs iteration 0 draft (must fail).
 */
export async function runGoldenSet(workDir, config, baseCapture, options = {}) {
  const goldenOutPath = options.goldenPath || path.join(workDir, 'runs/loop/golden.json');
  const goldenDir = path.join(path.dirname(goldenOutPath), 'golden-work');
  fs.mkdirSync(goldenDir, { recursive: true });

  const schema = loadJudgeSchema(workDir);
  const modelName = config.model?.name || 'gemini-4-argon';
  const perturbed = await createGoldenPerturbedArtifacts(baseCapture, goldenDir);

  const cases = [];
  const allInteractionIds = [];
  const allowedDefectTypes = new Set();

  const runVisionCase = async ({ caseId, defectType, role, view, itemText, itemId, mediaParts }) => {
    const parts = [
      ...mediaParts,
      {
        type: 'text',
        text: [
          `Grade rubric item ${itemId} (view: ${view}): "${itemText}"`,
          `Inspect the visual evidence carefully. Return JSON matching JudgeVerdict schema with verdict ('pass' | 'fail') and defects.`,
        ].join('\n'),
      },
    ];

    const res = await callModel({
      role,
      model: modelName,
      thinking: 'high',
      mediaResolution: 'high',
      media_resolution: 'high',
      input: parts,
      taskId: `golden:${caseId}`,
      schema,
      rootDir: options.rootDir || workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeHandler: options.fakeGoldenHandler || options.fakeHandler,
    });

    allInteractionIds.push(res.interactionId);
    const itemOut = (res.output?.items || []).find((i) => i.id === itemId) || (res.output?.items || [])[0];
    const caught = itemOut?.verdict === 'fail' || (res.output?.defects || []).length > 0;
    if (caught) {
      allowedDefectTypes.add(defectType);
    }
    cases.push({
      caseId,
      defectType,
      role,
      view,
      itemId,
      expectedVerdict: 'fail',
      actualVerdict: caught ? 'fail' : 'pass',
      caught,
      interactionId: res.interactionId,
      evidence: itemOut?.evidence || res.output?.summary || '',
    });
  };

  const b64 = (p) => fs.readFileSync(p).toString('base64');

  const visionCaseDefs = [
    // 1. Floating prop (O3, 3d)
    {
      caseId: 'injected-floating-prop-3d',
      defectType: 'floating-prop',
      role: 'judge_b',
      view: '3d',
      itemId: 'O3',
      itemText: 'No floating trees, rocks or props',
      mediaParts: [
        { type: 'text', text: '[Image 1: terrace-overview, full shot]' },
        { type: 'image', data: b64(perturbed.floatingPropShot), mime_type: 'image/png', media_resolution: 'high' },
      ],
    },
    // 2. Hovering meeple (M3, 3d)
    {
      caseId: 'injected-hovering-meeple-3d',
      defectType: 'hovering-meeple',
      role: 'judge_b',
      view: '3d',
      itemId: 'M3',
      itemText: 'Meeples sit on their features, not floating',
      mediaParts: [
        { type: 'text', text: '[Image 1: meeple-ground, full shot]' },
        { type: 'image', data: b64(perturbed.hoveringMeepleShot), mime_type: 'image/png', media_resolution: 'high' },
      ],
    },
    // 3. Blank morph frame (R1, 2d+3d)
    {
      caseId: 'injected-blank-morph-frame',
      defectType: 'blank-frame',
      role: 'judge_a',
      view: '2d+3d',
      itemId: 'R1',
      itemText: 'No frame where geometry vanishes, flickers or goes blank',
      mediaParts: [
        { type: 'text', text: '[Image 1: filmstrip of rise morph with blank frame at 00:04]' },
        { type: 'image', data: b64(perturbed.blankRisePaths[10]), mime_type: 'image/png', media_resolution: 'high' },
      ],
    },
    // 4. Flicker frame (R1, 2d+3d)
    {
      caseId: 'injected-flicker-frame',
      defectType: 'flicker',
      role: 'judge_a',
      view: '2d+3d',
      itemId: 'R1',
      itemText: 'No frame where geometry vanishes, flickers or goes blank',
      mediaParts: [
        { type: 'text', text: '[Image 1: frame before flicker (00:04)]' },
        { type: 'image', data: b64(perturbed.flickerRisePaths[11]), mime_type: 'image/png', media_resolution: 'high' },
        { type: 'text', text: '[Image 2: corrupted flicker frame (00:04)]' },
        { type: 'image', data: b64(perturbed.flickerRisePaths[12]), mime_type: 'image/png', media_resolution: 'high' },
      ],
    },
    // 5. Pop-in & cracks (R2, 2d+3d)
    {
      caseId: 'injected-pop-in',
      defectType: 'pop-in',
      role: 'judge_a',
      view: '2d+3d',
      itemId: 'R2',
      itemText: 'Props, slab and water rise continuously with the terrain; nothing pops in at once; no cracks between tiles',
      mediaParts: [
        { type: 'text', text: '[Image 1: frame before sudden pop-in (00:04)]' },
        { type: 'image', data: b64(perturbed.popinRisePaths[11]), mime_type: 'image/png', media_resolution: 'high' },
        { type: 'text', text: '[Image 2: frame with sudden un-animated block pop-in and seam crack (00:04)]' },
        { type: 'image', data: b64(perturbed.popinRisePaths[12]), mime_type: 'image/png', media_resolution: 'high' },
      ],
    },
    // 6. Gameplay tile placed with no drop animation (G1, tested in both 2d and 3d)
    ...['2d', '3d'].map((v) => ({
      caseId: `injected-gameplay-no-drop-${v}`,
      defectType: 'no-drop-animation',
      role: 'judge_a',
      view: v,
      itemId: 'G1',
      itemText:
        'Each placed tile visibly drops or slides into the correct cell and settles flush with its neighbors; no pop-in, jump, wrong cell or seam',
      mediaParts: [
        {
          type: 'text',
          text: `[Image 1: gameplay '${v}' at 00:02 — tile pops in instantaneously with zero drop animation and overlaps adjacent cell]`,
        },
        { type: 'image', data: b64(perturbed.popinRisePaths[12]), mime_type: 'image/png', media_resolution: 'high' },
      ],
    })),
    // 7. Cross-view consistency mismatch (C1, pairViews: 2d vs 3d)
    {
      caseId: 'injected-cross-view-mismatch',
      defectType: 'cross-view-mismatch',
      role: 'judge_b',
      view: '2d+3d',
      itemId: 'C1',
      itemText:
        'Every tile shows the same features and objects (cities, houses, roads, rivers, bridges, cloisters, trees, meeples) in the same places in 2D and 3D',
      mediaParts: [
        { type: 'text', text: '[Image 1: board-2d, full 2D view with cities and buildings]' },
        { type: 'image', data: b64(perturbed.crossView2d), mime_type: 'image/png', media_resolution: 'high' },
        { type: 'text', text: '[Image 2: terrace-overview, 3D view where central city buildings were removed]' },
        { type: 'image', data: b64(perturbed.crossView3d), mime_type: 'image/png', media_resolution: 'high' },
      ],
    },
  ];

  for (let i = 0; i < visionCaseDefs.length; i += 4) {
    await Promise.all(visionCaseDefs.slice(i, i + 4).map(runVisionCase));
  }

  // 8. Fidelity calibration (§2 Golden set item 2):
  //    (a) Grade each reference image as if it were the render -> must PASS with no high gaps
  //    (b) Grade iteration 0's untouched draft -> must FAIL (visibly differs from reference)
  const fidelityCalibration = [];
  const dioramaRefPath = path.resolve(workDir, 'public/reference/diorama-style-ref.png');
  const draftOverviewPath = baseCapture.shotPaths['terrace-overview'];

  const [refSelfRes, draftCalRes] = await Promise.all([
    callModel({
      role: 'judge_b',
      model: modelName,
      thinking: 'high',
      mediaResolution: 'high',
      media_resolution: 'high',
      input: [
        { type: 'text', text: '[Image 1: terrace-overview, full shot]' },
        { type: 'image', data: b64(dioramaRefPath), mime_type: 'image/png', media_resolution: 'high' },
        { type: 'text', text: '[Image 2: reference diorama-style-ref]' },
        { type: 'image', data: b64(dioramaRefPath), mime_type: 'image/png', media_resolution: 'high' },
        {
          type: 'text',
          text: [
            `Grade FIDELITY rubric item S0 (view: 3d).`,
            `Aspect: Overall realism: the board as a whole reads like a photograph of a handcrafted miniature diorama.`,
            `Compare Image 1 (the render) against Image 2 (the reference). If Image 1 matches the reference realism with no high or medium gaps, return verdict: "pass" and an empty gaps array.`,
          ].join('\n'),
        },
      ],
      taskId: 'golden:fidelity-ref-self',
      schema,
      rootDir: options.rootDir || workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeHandler: options.fakeGoldenHandler || options.fakeHandler,
    }),
    callModel({
      role: 'judge_b',
      model: modelName,
      thinking: 'high',
      mediaResolution: 'high',
      media_resolution: 'high',
      input: [
        { type: 'text', text: '[Image 1: terrace-overview, full shot]' },
        { type: 'image', data: b64(draftOverviewPath), mime_type: 'image/png', media_resolution: 'high' },
        { type: 'text', text: '[Image 2: reference diorama-style-ref]' },
        { type: 'image', data: b64(dioramaRefPath), mime_type: 'image/png', media_resolution: 'high' },
        {
          type: 'text',
          text: [
            `Grade FIDELITY rubric item S0 (view: 3d).`,
            `Aspect: Overall realism: handcrafted physical miniature diorama materials, lighting, slab strata, and vegetation density.`,
            `Identify all concrete visible fidelity gaps between Image 1 (draft render) and Image 2 (reference). Verdict passes ONLY when no high or medium gap remains.`,
          ].join('\n'),
        },
      ],
      taskId: 'golden:fidelity-iter0-draft',
      schema,
      rootDir: options.rootDir || workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeHandler: options.fakeGoldenHandler || options.fakeHandler,
    }),
  ]);
  allInteractionIds.push(refSelfRes.interactionId, draftCalRes.interactionId);
  const refSelfItem = (refSelfRes.output?.items || [])[0] || { verdict: 'pass', gaps: [] };
  const refSelfHighGaps = (refSelfItem.gaps || []).filter((g) => g.severity === 'high');
  const refSelfPassed = refSelfItem.verdict === 'pass' && refSelfHighGaps.length === 0;

  fidelityCalibration.push({
    caseId: 'fidelity-reference-as-render',
    itemId: 'S0',
    expectedVerdict: 'pass',
    actualVerdict: refSelfPassed ? 'pass' : 'fail',
    highGapsCount: refSelfHighGaps.length,
    calibrated: refSelfPassed,
    interactionId: refSelfRes.interactionId,
  });
  const draftCalItem = (draftCalRes.output?.items || [])[0] || { verdict: 'fail', gaps: [] };
  const draftFailed =
    draftCalItem.verdict === 'fail' ||
    (draftCalItem.gaps || []).some((g) => g.severity === 'high' || g.severity === 'medium');

  fidelityCalibration.push({
    caseId: 'fidelity-iter0-untouched-draft',
    itemId: 'S0',
    expectedVerdict: 'fail',
    actualVerdict: draftFailed ? 'fail' : 'pass',
    gapsCount: (draftCalItem.gaps || []).length,
    calibrated: draftFailed,
    interactionId: draftCalRes.interactionId,
  });

  const caughtCount = cases.filter((c) => c.caught).length;
  const recall = cases.length > 0 ? Number((caughtCount / cases.length).toFixed(4)) : 1;
  const falsePositives = refSelfPassed ? 0 : 1;

  const goldenReport = {
    ts: new Date().toISOString(),
    model: modelName,
    recall,
    falsePositives,
    injectedCases: cases,
    fidelityCalibration,
    allowedDefectTypes: Array.from(allowedDefectTypes),
    interactionIds: allInteractionIds,
  };

  fs.mkdirSync(path.dirname(goldenOutPath), { recursive: true });
  fs.writeFileSync(goldenOutPath, JSON.stringify(goldenReport, null, 2), 'utf8');
  return goldenReport;
}

/**
 * Main autonomous visual feedback loop (`runVisualLoop`) (§0 - §5).
 */
export async function runVisualLoop(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const runId = options.runId || `run-${Date.now()}`;
  const config = options.config || loadLoopConfig(rootDir);
  const rubric = options.rubric || loadRubric(rootDir, config);

  const maxIterations = Number(options.maxIterations ?? config.limits?.maxIterations ?? 10);
  const budgetUsd = Number(options.budgetUsd ?? config.limits?.budgetUsd ?? 200);
  const plateauIterations = Number(options.plateauIterations ?? config.limits?.plateauIterations ?? 2);
  const notes = options.notes || null;

  const tracePath = options.tracePath || path.join(rootDir, 'runs/orchestrator/trace.jsonl');
  const spendState = ensurePersistentSpendState(options.state, tracePath);

  // 1. Startup Check A: Validate rubric references and per-view defect/fidelity coverage
  validateRubricAndReferences(rootDir, config, rubric);

  // 2. Create isolated git worktree `wt/loop-<runId>` on branch `loop/<runId>` from `baseBranch` (§4.1)
  const useWorktree = options.useWorktree ?? true;
  const wtInfo = useWorktree
    ? createLoopWorktree(rootDir, runId, config.baseBranch || 'main')
    : {
        workDir: rootDir,
        branchName: `loop/${runId}`,
        startCommit: execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim(),
      };

  const workDir = wtInfo.workDir;
  const startCommit = wtInfo.startCommit;
  const baselineTestFiles = getBaselineTestFiles(workDir, startCommit);

  const runDir = options.runDir || path.join(rootDir, 'runs/loop', runId);
  fs.mkdirSync(runDir, { recursive: true });

  let devServer = null;

  try {
    devServer = options.server || (await startDevServer(workDir, config, options));

    // 3. Startup Check B: Verify all non-null hooks and gameplay click selectors exist on the page.
    //    If any are missing, run a bootstrap patcher iteration and re-check; exit naming what is still missing only if bootstrap fails.
    console.error(`[loop:${runId}] Checking page hooks and gameplay selectors in ${workDir}...`);
    const hookCheck1 = await checkPageHooksAndSelectors(workDir, config, {
      ...options,
      server: devServer,
    });

    if (!hookCheck1.ok) {
      console.error(
        `[loop:${runId}] Missing hooks/selectors detected (${hookCheck1.missingHooks.join(', ')} ${hookCheck1.missingSelectors.join(', ')}). Running bootstrap patcher iteration...`
      );
      const bootstrapDefects = [
        ...hookCheck1.missingHooks.map((h, i) => ({
          id: `bootstrap-hook-${i + 1}`,
          itemIds: ['G6'],
          severity: 'high',
          description: `Missing required Inspector hook '${h}' on page. Implement it according to loop.config.json _fieldNotes.`,
        })),
        ...hookCheck1.missingSelectors.map((s, i) => ({
          id: `bootstrap-selector-${i + 1}`,
          itemIds: ['G6'],
          severity: 'high',
          description: `Missing required DOM selector '${s}' for gameplay script click.`,
        })),
      ];

      await runPatcherIteration({
        workDir,
        iterNum: 0,
        startCommit,
        openDefects: bootstrapDefects,
        config,
        triedLedger: [],
        isBootstrap: true,
        options: {
          ...options,
          rootDir,
          tracePath,
          state: spendState,
          budgetUsd,
          baselineTestFiles,
          server: devServer,
        },
      });

      console.error(`[loop:${runId}] Re-checking page hooks and selectors after bootstrap...`);
      const hookCheck2 = await checkPageHooksAndSelectors(workDir, config, {
        ...options,
        server: devServer,
      });

      if (!hookCheck2.ok) {
        const stillMissing = [
          ...hookCheck2.missingHooks.map((h) => `hook:${h}`),
          ...hookCheck2.missingSelectors.map((s) => `selector:${s}`),
        ];
        throw new Error(
          `Bootstrap patcher failed to resolve missing hooks/selectors: ${stillMissing.join(', ')}`
        );
      }
      console.error(`[loop:${runId}] Bootstrap succeeded! All hooks and selectors verified.`);
    }

    const iterations = [];
    const triedLedger = [];
    const escalations = [];
    const defectFailureCounts = new Map();

    // 4. Iteration 0: Capture and judge the untouched draft (§4.2)
    console.error(`[loop:${runId}] Iteration 0: Capturing timeline, shots, pageShots, and gameplay...`);
    const iter0Dir = path.join(runDir, 'iter-0');
    const capture0 = options.customCapture
      ? await options.customCapture(workDir, iter0Dir, 0)
      : await captureIteration(workDir, iter0Dir, config, {
          ...options,
          server: devServer,
        });

    // Run Golden Set if requested or if `runs/loop/golden.json` does not exist yet
    const goldenPath = options.goldenPath || path.join(rootDir, 'runs/loop/golden.json');
    if (options.runGolden || (!fs.existsSync(goldenPath) && !options.skipGolden)) {
      console.error(`[loop:${runId}] Running real Golden Set vision calibration -> ${goldenPath}...`);
      await runGoldenSet(workDir, config, capture0, {
        ...options,
        rootDir,
        goldenPath,
        tracePath,
        state: spendState,
        budgetUsd,
      });
      console.error(`[loop:${runId}] Golden Set complete.`);
    }

    console.error(`[loop:${runId}] Iteration 0: Judging motion clips and still shot groups...`);
    const verdicts0 = options.customJudge
      ? await options.customJudge(workDir, iter0Dir, capture0, 0)
      : await judgeIteration(workDir, iter0Dir, capture0, config, {
          ...options,
          rubric,
          tracePath,
          state: spendState,
          budgetUsd,
        });
    console.error(
      `[loop:${runId}] Iteration 0 Verdicts: ${verdicts0.passedCount}/${verdicts0.totalCount} passed (open defects: ${verdicts0.openDefects.length}, cost: $${spendState.totalCostUsd.toFixed(4)})`
    );

    let bestCommit = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf8' }).trim();
    let bestIteration = 0;
    let bestCapture = capture0;
    let bestVerdicts = verdicts0;

    iterations.push({
      iteration: 0,
      commitHash: bestCommit,
      capture: capture0,
      verdicts: verdicts0,
      patch: null,
      comparison: { outcome: 'baseline', better: false, worse: false, reasons: ['Initial draft'] },
      cumulativeCostUsd: spendState.totalCostUsd,
    });

    let stopReason = verdicts0.allPassed ? 'all_passed' : 'max_iterations';
    let plateauCount = 0;
    let pendingEscalationPlan = null;
    let isEscalatedAttempt = false;

    generateDashboardHtml(runDir, {
      runId,
      workDir,
      config,
      rubric,
      iterations,
      bestIteration,
      triedLedger,
      escalations,
      totalCostUsd: spendState.totalCostUsd,
      stopReason: 'in_progress',
    });

    // 5. Main Iterative Loop (Iterations 1..maxIterations) (§4.3 - §4.5)
    for (let iterNum = 1; iterNum <= maxIterations; iterNum++) {
      if (bestVerdicts.allPassed) {
        stopReason = 'all_passed';
        break;
      }
      if (spendState.totalCostUsd >= budgetUsd) {
        stopReason = 'budget_exceeded';
        break;
      }

      // Check if plateau threshold reached -> escalate to lead_architect (§4.4)
      if (plateauCount >= plateauIterations && !isEscalatedAttempt) {
        const esc = await escalateToLeadArchitect({
          workDir,
          config,
          iterationHistory: iterations,
          triedLedger,
          bestCapture,
          bestVerdicts,
          options: {
            ...options,
            rootDir,
            tracePath,
            state: spendState,
            budgetUsd,
          },
        });
        pendingEscalationPlan = esc.plan;
        isEscalatedAttempt = true;
        escalations.push({
          beforeIteration: iterNum,
          interactionId: esc.interactionId,
          diagnosis: esc.diagnosis,
          plan: esc.plan,
        });
      }

      const iterDir = path.join(runDir, `iter-${iterNum}`);
      fs.mkdirSync(iterDir, { recursive: true });

      try {
        // Step A: Patcher + Gate
        console.error(`[loop:${runId}] Iteration ${iterNum}: Running patcher agent on ${bestVerdicts.openDefects.length} open defects...`);
        const patchRes = await runPatcherIteration({
          workDir,
          iterNum,
          startCommit,
          openDefects: bestVerdicts.openDefects,
          captureManifest: bestCapture,
          config,
          triedLedger,
          defectFailureCounts,
          escalationPlan: pendingEscalationPlan,
          notes,
          options: {
            ...options,
            rootDir,
            tracePath,
            state: spendState,
            budgetUsd,
            baselineTestFiles,
            server: devServer,
          },
        });
        pendingEscalationPlan = null;

        if (!patchRes.ok || patchRes.rejected) {
          console.error(`[loop:${runId}] Iteration ${iterNum}: Patch rejected (${patchRes.rejectedReason}). Resetting to ${bestCommit}.`);
          resetToCommit(workDir, bestCommit);
          for (const d of bestVerdicts.openDefects.slice(0, 3)) {
            defectFailureCounts.set(d.id, (defectFailureCounts.get(d.id) || 0) + 1);
          }
          plateauCount += 1;
          iterations.push({
            iteration: iterNum,
            commitHash: bestCommit,
            capture: bestCapture,
            verdicts: bestVerdicts,
            patch: patchRes,
            comparison: {
              outcome: 'worse',
              better: false,
              worse: true,
              reasons: [patchRes.rejectedReason || 'Patch rejected by gate'],
            },
            cumulativeCostUsd: spendState.totalCostUsd,
          });

          if (isEscalatedAttempt) {
            stopReason = 'escalation_failed';
            break;
          }
          continue;
        }

        // Step B: Capture
        console.error(`[loop:${runId}] Iteration ${iterNum}: Capturing timeline, shots, pageShots, and gameplay...`);
        const currCapture = options.customCapture
          ? await options.customCapture(workDir, iterDir, iterNum)
          : await captureIteration(workDir, iterDir, config, {
              ...options,
              server: devServer,
            });

        // Step C: Judge
        console.error(`[loop:${runId}] Iteration ${iterNum}: Judging motion clips and still shot groups...`);
        const currVerdicts = options.customJudge
          ? await options.customJudge(workDir, iterDir, currCapture, iterNum)
          : await judgeIteration(workDir, iterDir, currCapture, config, {
              ...options,
              rubric,
              tracePath,
              state: spendState,
              budgetUsd,
            });

        // Step D: Pairwise Comparison against bestCapture
        console.error(`[loop:${runId}] Iteration ${iterNum}: Running pairwise comparison against Best (Iter ${bestIteration})...`);
        const touchedItemIds = (patchRes.report?.addressed || []).map((a) => a.defectId);
        const pairwiseResult = options.customPairwise
          ? await options.customPairwise(bestCapture, currCapture, iterNum)
          : await runPairwiseComparison({
              workDir,
              bestCapture,
              currentCapture: currCapture,
              rubric,
              touchedDefectIds: touchedItemIds,
              currentVerdicts: currVerdicts,
              config,
              options: {
                ...options,
                tracePath,
                state: spendState,
                budgetUsd,
              },
            });

        // Step E: Compare against best so far
        const cmp = compareIterations(bestVerdicts, currVerdicts, pairwiseResult);
        console.error(
          `[loop:${runId}] Iteration ${iterNum} Result: ${currVerdicts.passedCount}/${currVerdicts.totalCount} passed | outcome=${cmp.outcome} (${cmp.reasons.join('; ')}) | cost=$${spendState.totalCostUsd.toFixed(4)}`
        );

        if (cmp.better) {
          bestCommit = patchRes.commitHash;
          bestIteration = iterNum;
          bestCapture = currCapture;
          bestVerdicts = currVerdicts;
          plateauCount = 0;
          isEscalatedAttempt = false;
        } else {
          // Tie or worse: reset to bestCommit and record in triedLedger (§4.3)
          resetToCommit(workDir, bestCommit);
          recordFailedAttemptInLedger(
            triedLedger,
            bestVerdicts.openDefects,
            patchRes.touchedFiles,
            cmp.outcome,
            patchRes.report?.summary || 'patch did not improve rubric'
          );
          for (const d of bestVerdicts.openDefects.slice(0, 3)) {
            defectFailureCounts.set(d.id, (defectFailureCounts.get(d.id) || 0) + 1);
          }
          plateauCount += 1;
        }

        iterations.push({
          iteration: iterNum,
          commitHash: patchRes.commitHash,
          capture: currCapture,
          verdicts: currVerdicts,
          pairwise: pairwiseResult,
          patch: patchRes,
          comparison: cmp,
          cumulativeCostUsd: spendState.totalCostUsd,
        });

        generateDashboardHtml(runDir, {
          runId,
          workDir,
          config,
          rubric,
          iterations,
          bestIteration,
          triedLedger,
          escalations,
          totalCostUsd: spendState.totalCostUsd,
          stopReason: 'in_progress',
        });

        if (bestVerdicts.allPassed) {
          stopReason = 'all_passed';
          break;
        }

        if (!cmp.better && isEscalatedAttempt) {
          stopReason = 'escalation_failed';
          break;
        }
      } catch (err) {
        if (err.code === 'SPEND_CAP_EXCEEDED') {
          resetToCommit(workDir, bestCommit);
          stopReason = 'budget_exceeded';
          break;
        }
        throw err;
      }
    }

    if (devServer && !options.server) {
      await devServer.stop();
      devServer = null;
    }

    // 6. Finish automatically (§4.6):
    //    If bestIteration > 0 (strictly better than iteration 0), merge into baseBranch locally with --no-ff and remove worktree.
    let mergeResult = {
      merged: false,
      conflict: false,
      conflictingFiles: [],
      branch: wtInfo.branchName,
    };

    if (useWorktree) {
      if (bestIteration > 0) {
        mergeResult = mergeLoopWorktree(rootDir, workDir, runId, config.baseBranch || 'main');
      } else {
        removeLoopWorktree(rootDir, workDir, wtInfo.branchName, false);
      }
    }

    generateDashboardHtml(runDir, {
      runId,
      workDir: rootDir,
      config,
      rubric,
      iterations,
      bestIteration,
      triedLedger,
      escalations,
      totalCostUsd: spendState.totalCostUsd,
      stopReason,
      mergeResult,
    });

    const summary = {
      runId,
      stopReason,
      bestIteration,
      bestCommit,
      totalCostUsd: spendState.totalCostUsd,
      totalCalls: spendState.totalCalls,
      mergeResult,
      iterations: iterations.map((it) => ({
        iteration: it.iteration,
        commitHash: it.commitHash,
        passedCount: it.verdicts?.passedCount ?? 0,
        totalCount: it.verdicts?.totalCount ?? 0,
        defectPassedCount: it.verdicts?.defectPassedCount ?? 0,
        defectTotalCount: it.verdicts?.defectTotalCount ?? 0,
        fidelityPassedCount: it.verdicts?.fidelityPassedCount ?? 0,
        fidelityTotalCount: it.verdicts?.fidelityTotalCount ?? 0,
        openDefectsCount: (it.verdicts?.openDefects || []).length,
        outcome: it.comparison?.outcome || 'baseline',
        cumulativeCostUsd: it.cumulativeCostUsd,
      })),
      openDefects: bestVerdicts?.openDefects || [],
      forTheOwner: bestVerdicts?.forTheOwner || { items: [], defects: [] },
      triedLedger,
      escalations,
    };

    const summaryPath = path.join(runDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    return summary;
  } finally {
    if (devServer && !options.server) {
      await devServer.stop();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let maxIterations = undefined;
  let budgetUsd = undefined;
  let notes = undefined;
  let runId = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-iterations' && args[i + 1]) {
      maxIterations = Number(args[++i]);
    } else if (args[i] === '--budget-usd' && args[i + 1]) {
      budgetUsd = Number(args[++i]);
    } else if (args[i] === '--notes' && args[i + 1]) {
      notes = args[++i];
    } else if (args[i] === '--run-id' && args[i + 1]) {
      runId = args[++i];
    }
  }

  const summary = await runVisualLoop({
    maxIterations,
    budgetUsd,
    notes,
    runId,
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
