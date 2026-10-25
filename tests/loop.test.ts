import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as captureMod from '../scripts/loop/capture.mjs';
import * as judgeMod from '../scripts/loop/judge.mjs';
import * as patchMod from '../scripts/loop/patch.mjs';
import * as runMod from '../scripts/loop/run.mjs';

const {
  launchHardwareBrowser,
  captureIteration,
  captureGameplayScriptOnPage,
} = captureMod as Record<string, any>;
const {
  validateRubricAndReferences,
  mergeAndResolveVerdicts,
  judgeIteration,
} = judgeMod as Record<string, any>;
const {
  createPatcherTools,
  checkWorktreeDiffSafety,
  runPatcherIteration,
} = patchMod as Record<string, any>;
const {
  compareIterations,
  runVisualLoop,
} = runMod as Record<string, any>;

const FIXTURE_HTML_PATH = path.resolve('tests/fixtures/loop-scene.html');

function createFakeConfig(urlOverride: string, extra: Record<string, any> = {}) {
  return {
    name: 'fake-loop-test',
    baseBranch: 'main',
    devCommand: '',
    url: urlOverride,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    hooks: {
      global: '__game',
      ready: null,
      loadFixture: 'loadFixture',
      renderAt: 'renderAt',
      timeUnit: 's',
      listShots: 'listShots',
      captureShot: 'captureShot',
      audit: 'audit',
      tileSheet: 'getTileSheet',
      injectDefect: null,
      playAt: 'playAt',
      botMove: 'botMove',
      showLegalMoves: 'showLegalMoves',
      setView: 'setView',
      getView: 'getView',
    },
    fixture: 'fixture-all-features',
    timeline: {
      fps: 12,
      segments: [{ id: 'flat', start: 0, end: 1.5, focus: 'Pan test' }],
      motionSegments: [],
    },
    frameDiff: { pixelThreshold: 24, spikeFactor: 4, grid: 8 },
    shots: ['board-2d', 'terrace-overview'],
    pageShots: [{ id: 'ui-2d', view: '2d', t: 0.5 }, { id: 'ui-3d', view: '3d', t: 0.5 }],
    references: ['public/reference/ref.png'],
    rubric: 'rubric/visual.json',
    protectedPaths: [
      'rubric/',
      'public/reference/',
      'scripts/loop/',
      'scripts/gates/',
      'scripts/lib/',
      'loop.config.json',
      '.agents/',
      'AGENTS.md',
    ],
    regressionTestDir: 'tests/regressions/',
    acceptance: ['node -e "process.exit(0)"'],
    model: { name: 'gemini-4-argon', thinking: 'high', mediaResolution: 'high' },
    patcher: { maxToolCalls: 15, escalatedMaxToolCalls: 30, deadlineMs: 30000 },
    limits: { maxIterations: 3, budgetUsd: 50, plateauIterations: 2 },
    views: ['2d', '3d'],
    gameplay: {
      fps: 12,
      views: ['2d', '3d'],
      scripts: [
        {
          id: 'turns',
          perView: true,
          duration: 1.5,
          steps: [
            {
              at: 0.0,
              call: 'loadFixture',
              args: ['fixture-midgame'],
              label: 'load mid-game',
              expect: 'Object.keys(after.board).length > 1',
            },
            { at: 0.5, click: '[data-testid=rotate-tile]', label: 'click rotate' },
            {
              at: 1.0,
              call: 'botMove',
              label: 'bot move',
              expect: 'after.turnNumber > before.turnNumber',
            },
          ],
          expect: 'end.completedChains >= start.completedChains',
        },
      ],
    },
    outOfScope: ['The HUD (src/ui/)'],
    outOfScopePaths: ['src/ui/'],
    ...extra,
  };
}

function createFakeRubric() {
  return {
    items: [
      {
        id: 'F1',
        kind: 'defect',
        views: ['2d', '3d'],
        shot: 'board-2d',
        text: 'Flat 2D map and 3D overview',
        source: ['judge'],
      },
      {
        id: 'S0',
        kind: 'fidelity',
        views: ['2d', '3d'],
        shot: 'terrace-overview',
        references: ['public/reference/ref.png'],
        aspect: 'Diorama realism',
        text: 'Matches reference',
        source: ['judge'],
      },
    ],
  };
}

function createGitTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-repo-'));
  fs.mkdirSync(path.join(dir, 'public/reference'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'rubric'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/render'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });

  fs.cpSync(path.resolve('agents/roles.json'), path.join(dir, 'agents/roles.json'));
  fs.cpSync(path.resolve('agents/pricing.json'), path.join(dir, 'agents/pricing.json'));
  fs.cpSync(
    path.resolve('public/reference/carcassonne-layout.jpg'),
    path.join(dir, 'public/reference/ref.png')
  );
  fs.writeFileSync(path.join(dir, 'src/render/scene.ts'), 'export const val = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src/ui/hud.ts'), 'export const hud = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'tests/baseline.test.ts'), 'export const base = true;\n', 'utf8');
  fs.cpSync(FIXTURE_HTML_PATH, path.join(dir, 'scene.html'));

  const cfg = createFakeConfig(`file://${path.join(dir, 'scene.html')}`);
  const rub = createFakeRubric();
  fs.writeFileSync(path.join(dir, 'loop.config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, 'rubric/visual.json'), JSON.stringify(rub, null, 2));

  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test Runner"', { cwd: dir, stdio: 'pipe' });
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });

  const startCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, cfg, rub, startCommit };
}

describe('Visual Feedback Loop Offline Suite (Prompt 2 §6, ORCH_FAKE=1)', () => {
  beforeEach(() => {
    process.env.ORCH_FAKE = '1';
  });

  it('1. fails fast naming missing reference file or view missing defect/fidelity item, and triggers bootstrap iteration on missing hook/selector', async () => {
    const { dir, cfg, rub } = createGitTempRepo();

    // Missing reference file
    const badCfgRef = { ...cfg, references: ['public/reference/does-not-exist.png'] };
    expect(() => validateRubricAndReferences(dir, badCfgRef, rub)).toThrow(
      /missing reference file: public\/reference\/does-not-exist\.png/
    );

    // View '2d' missing fidelity item
    const badRubView = {
      items: [
        { id: 'D_BOTH', kind: 'defect', views: ['2d', '3d'], text: 'defect', source: ['judge'] },
        { id: 'F_3D_ONLY', kind: 'fidelity', views: ['3d'], references: ['public/reference/ref.png'], aspect: 'a', text: 'f', source: ['judge'] },
      ],
    };
    expect(() => validateRubricAndReferences(dir, cfg, badRubView)).toThrow(
      /view '2d' has no fidelity item in rubric/
    );

    // Missing hook (`botMove`) triggers bootstrap iteration, and exits naming it if bootstrap doesn't fix it
    const missingHookCfg = createFakeConfig(`file://${path.join(dir, 'scene.html')}?mode=missing-hook`);
    let bootstrapCalled = false;

    await expect(
      runVisualLoop({
        rootDir: dir,
        config: missingHookCfg,
        rubric: rub,
        useWorktree: false,
        skipGolden: true,
        allowSoftwareRenderer: true,
        fakePatcherHandler: async () => {
          bootstrapCalled = true;
          return {
            interactionId: 'int_boot_fail',
            inputTokens: 100,
            outputTokens: 100,
            functionCalls: [
              {
                id: 'c_fin',
                name: 'finish',
                arguments: { summary: 'Did not add hook', addressed: [], skipped: [] },
              },
            ],
          };
        },
      })
    ).rejects.toThrow(/Bootstrap patcher failed to resolve missing hooks\/selectors:.*__game\.botMove/);

    expect(bootstrapCalled).toBe(true);
  });

  it('2. refuses patcher writes to protected paths, baseline tests, and paths outside worktree, accepts new files under regressionTestDir, and rejects diff touching protected path', async () => {
    const { dir, cfg, startCommit } = createGitTempRepo();
    const baselineTests = new Set(['tests/baseline.test.ts']);
    const tools = createPatcherTools(dir, cfg, baselineTests);
    const writeFile = tools.find((t: any) => t.name === 'write_file')!.handler;

    // Protected path refused
    const resProt = await writeFile({ path: 'rubric/visual.json', content: '{}' });
    expect(resProt.ok).toBe(false);
    expect(resProt.error).toMatch(/protected path/);

    // Baseline test refused
    const resBase = await writeFile({ path: 'tests/baseline.test.ts', content: '// hacked' });
    expect(resBase.ok).toBe(false);
    expect(resBase.error).toMatch(/baseline test/);

    // Path outside worktree refused
    const resOutside = await writeFile({ path: '../outside-hack.txt', content: 'hacked' });
    expect(resOutside.ok).toBe(false);
    expect(resOutside.error).toMatch(/outside worktree/);

    // New regression test under regressionTestDir accepted
    const resReg = await writeFile({
      path: 'tests/regressions/new-seam.test.ts',
      content: 'import { expect, it } from "vitest"; it("passes", () => expect(1).toBe(1));\n',
    });
    expect(resReg.ok).toBe(true);

    // If a protected file is modified on disk behind the tool's back, checkWorktreeDiffSafety rejects the iteration
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Tampered\n', 'utf8');
    const diffCheck = checkWorktreeDiffSafety(dir, startCommit, cfg, baselineTests);
    expect(diffCheck.ok).toBe(false);
    expect(diffCheck.violations.some((v: any) => v.file === 'AGENTS.md')).toBe(true);
  });

  it('3. a cube that pops in at a known frame while the camera pans trips frameDiff, while the same pan without pop-in does not', async () => {
    const { dir } = createGitTempRepo();
    const outSmooth = path.join(dir, 'runs/cap-smooth');
    const outPopin = path.join(dir, 'runs/cap-popin');

    const smoothCfg = createFakeConfig(`file://${FIXTURE_HTML_PATH}?mode=normal`, {
      gameplay: { fps: 12, views: ['2d'], scripts: [] },
    });
    const popinCfg = createFakeConfig(`file://${FIXTURE_HTML_PATH}?mode=pan-popin`, {
      gameplay: { fps: 12, views: ['2d'], scripts: [] },
    });

    const smoothCap = await captureIteration(dir, outSmooth, smoothCfg, {
      skipGameplay: true,
      allowSoftwareRenderer: true,
    });
    const popinCap = await captureIteration(dir, outPopin, popinCfg, {
      skipGameplay: true,
      allowSoftwareRenderer: true,
    });

    expect(smoothCap.timeline.frameDiffSpikes).toHaveLength(0);
    expect(popinCap.timeline.frameDiffSpikes.length).toBeGreaterThan(0);
    expect(popinCap.timeline.frameDiffSpikes[0].t).toBeCloseTo(1.0, 1);
  }, 30_000);

  it('4 & 5 & 12. defect IDs from two judges that both say D1 survive merging as distinct defects; uncertain after re-ask resolves to fail; failing reportOnly item appears in summary without becoming patcher defect or changing pass count', async () => {
    const rubricItems = [
      { id: 'M2', kind: 'defect', views: ['3d'], shot: 'bridge-hill-macro', text: 'Bridge arch unobstructed', source: ['judge'] },
      { id: 'O1', kind: 'defect', views: ['3d'], shot: 'underside-slab', text: 'Slab edge visible', source: ['judge'] },
      { id: 'G4', kind: 'defect', views: ['2d'], shot: 'ui-2d', text: 'HUD matches state', source: ['judge'], reportOnly: true },
    ];

    const rawJudgeVerdicts = [
      // Judge A and Judge B both invent local defect id "D1" for item M2 (#4)
      {
        judgeRole: 'judge_a',
        itemId: 'M2',
        view: '3d',
        verdict: 'fail',
        evidence: 'Arch clipped in motion',
        defects: [{ id: 'D1', itemIds: ['M2'], severity: 'high', description: 'Motion arch defect' }],
      },
      {
        judgeRole: 'judge_b',
        itemId: 'M2',
        view: '3d',
        verdict: 'fail',
        evidence: 'Arch obstructed in still',
        defects: [{ id: 'D1', itemIds: ['M2'], severity: 'medium', description: 'Still arch defect' }],
      },
      // Item O1 is uncertain initially and remains uncertain after re-ask (#5)
      {
        judgeRole: 'judge_b',
        itemId: 'O1',
        view: '3d',
        verdict: 'uncertain',
        evidence: 'Shadow obscures slab edge',
        defects: [],
      },
      // Item G4 is reportOnly and fails (#12)
      {
        judgeRole: 'judge_b',
        itemId: 'G4',
        view: '2d',
        verdict: 'fail',
        evidence: 'HUD counter off by 1',
        defects: [{ id: 'D1', itemIds: ['G4'], severity: 'low', description: 'HUD counter bug' }],
      },
    ];

    let reAskCount = 0;
    const merged = await mergeAndResolveVerdicts({
      rubricItems,
      rawJudgeVerdicts,
      hardResultsByItemView: {},
      reAskCallback: async (item: any, view: string) => {
        reAskCount += 1;
        return {
          judgeRole: 'judge_b',
          itemId: item.id,
          view,
          verdict: 'uncertain',
          evidence: 'Still uncertain on tight crop',
          defects: [],
        };
      },
    });

    // #4: Both "D1" defects survive as distinct code-assigned IDs (`motion-M2-3d-1` and `still-M2-3d-1`)
    const m2Defects = merged.openDefects.filter((d: any) => d.itemIds.includes('M2'));
    expect(m2Defects).toHaveLength(2);
    expect(m2Defects[0].id).not.toBe(m2Defects[1].id);
    expect(m2Defects.map((d: any) => d.id)).toEqual(['motion-M2-3d-1', 'still-M2-3d-1']);

    // #5: Uncertain after re-ask resolves to fail
    expect(reAskCount).toBe(1);
    expect(merged.items.O1.verdict).toBe('fail');

    // #12: Failing reportOnly item G4 is excluded from totalCount/passedCount and openDefects, but present in forTheOwner
    expect(merged.totalCount).toBe(2); // Only M2 and O1 counted
    expect(merged.passedCount).toBe(0);
    expect(merged.openDefects.some((d: any) => d.itemIds.includes('G4'))).toBe(false);
    expect(merged.forTheOwner.items).toHaveLength(1);
    expect(merged.forTheOwner.defects).toHaveLength(1);
    expect(merged.forTheOwner.defects[0].description).toBe('HUD counter bug');
  });

  it('6 & 11. worse/tied iteration resets to bestCommit; plateau triggers escalation; failed escalation stops loop; outOfScopePaths patch or pairwise outOfScopeChanged rejects/worsens iteration', async () => {
    const { dir, cfg, rub, startCommit } = createGitTempRepo();

    // Test #11 part A: Patch touching outOfScopePaths ('src/ui/') is rejected and reset
    const oosPatch = await runPatcherIteration({
      workDir: dir,
      iterNum: 1,
      startCommit,
      openDefects: [{ id: 'still-F1-2d-1', itemIds: ['F1'], severity: 'high', description: 'Fix framing' }],
      config: cfg,
      options: {
        fakePatcherHandler: async () => {
          fs.writeFileSync(path.join(dir, 'src/ui/hud.ts'), 'export const hud = 999;\n', 'utf8');
          return {
            interactionId: 'int_oos',
            inputTokens: 100,
            outputTokens: 50,
            functionCalls: [
              { id: 'f1', name: 'finish', arguments: { summary: 'Touched HUD', addressed: [] } },
            ],
          };
        },
      },
    });
    expect(oosPatch.ok).toBe(false);
    expect(oosPatch.rejected).toBe(true);
    expect(oosPatch.rejectedReason).toMatch(/outOfScopePath/);

    // Test #11 part B: Pairwise confirmed outOfScopeChanged makes iteration worse even if pass count increased
    const cmpOos = compareIterations(
      { passedCount: 1, items: {} },
      { passedCount: 2, items: {} },
      { currentWins: 2, bestWins: 0, confirmedOutOfScopeChange: true }
    );
    expect(cmpOos.outcome).toBe('worse');

    // Test #6: Run loop where Iter 1 and Iter 2 tie/worsen (plateau=2), triggering escalation before Iter 3, and Iter 3 also fails -> stops with 'escalation_failed'
    let escalationCalled = false;
    const summary = await runVisualLoop({
      rootDir: dir,
      config: {
        ...cfg,
        limits: { maxIterations: 5, budgetUsd: 50, plateauIterations: 2 },
      },
      rubric: rub,
      useWorktree: false,
      skipGolden: true,
      customCapture: async (_wDir: string, iterDir: string) => {
        fs.mkdirSync(path.join(iterDir, 'shots'), { recursive: true });
        return {
          outDir: iterDir,
          shotPaths: {},
          timeline: { blankFrames: [], frameDiffSpikes: [] },
          gameplay: {},
          audit: { ok: true },
        };
      },
      customJudge: async () => ({
        passedCount: 0,
        totalCount: 2,
        defectPassedCount: 0,
        defectTotalCount: 1,
        fidelityPassedCount: 0,
        fidelityTotalCount: 1,
        allPassed: false,
        items: {
          F1: { id: 'F1', kind: 'defect', views: ['2d', '3d'], verdict: 'fail', perView: { '2d': { verdict: 'fail', hardPass: true }, '3d': { verdict: 'fail', hardPass: true } } },
          S0: { id: 'S0', kind: 'fidelity', views: ['2d', '3d'], verdict: 'fail', perView: { '2d': { verdict: 'fail', hardPass: true }, '3d': { verdict: 'fail', hardPass: true } } },
        },
        openDefects: [{ id: 'still-F1-2d-1', itemIds: ['F1'], view: '2d', severity: 'high', description: 'Fix 2D' }],
        forTheOwner: { items: [], defects: [] },
      }),
      customPairwise: async () => ({
        currentWins: 0,
        bestWins: 0,
        ties: 1,
        confirmedOutOfScopeChange: false,
        comparisons: [],
      }),
      fakePatcherHandler: async ({ taskId }: any) => {
        fs.writeFileSync(path.join(dir, 'src/render/scene.ts'), `export const val = "${taskId}";\n`, 'utf8');
        return {
          interactionId: `int_${taskId}`,
          inputTokens: 100,
          outputTokens: 50,
          functionCalls: [
            {
              id: 'c_fin',
              name: 'finish',
              arguments: {
                summary: `Attempt ${taskId}`,
                addressed: [{ defectId: 'still-F1-2d-1', files: ['src/render/scene.ts'], change: 'tweak', verified: 'preview' }],
              },
            },
          ],
        };
      },
      fakeEscalationHandler: async () => {
        escalationCalled = true;
        return {
          interactionId: 'int_esc_1',
          inputTokens: 200,
          outputTokens: 100,
          output: {
            diagnosis: 'Repeated tie on F1',
            plan: 'Use orthographic frustum fit in renderer',
          },
        };
      },
    });

    expect(escalationCalled).toBe(true);
    expect(summary.escalations).toHaveLength(1);
    expect(summary.stopReason).toBe('escalation_failed');
    expect(summary.bestCommit).toBe(startCommit);
    const headNow = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    expect(headNow).toBe(startCommit);
  });

  it('7 & 8 & 13. gameplay steps fire at their `at`, clicks mutate state, throwing/unknown-fixture/no-op/false-expect record stepErrors, and view regressions or mid-script view switches fail', async () => {
    const { dir, cfg } = createGitTempRepo();

    // #8a: Item with views: ["2d", "3d"] that passes in 2D and fails in 3D fails overall,
    //      and a change that fixes 3D but breaks 2D counts as worse
    const mergedPartial = await mergeAndResolveVerdicts({
      rubricItems: [{ id: 'G1', kind: 'defect', views: ['2d', '3d'], text: 'Drop', source: ['judge'] }],
      rawJudgeVerdicts: [
        { judgeRole: 'judge_a', itemId: 'G1', view: '2d', verdict: 'pass', evidence: 'ok 2d', defects: [] },
        { judgeRole: 'judge_a', itemId: 'G1', view: '3d', verdict: 'fail', evidence: 'bad 3d', defects: [] },
      ],
      hardResultsByItemView: {},
    });
    expect(mergedPartial.items.G1.verdict).toBe('fail');

    const flippedToBreak2D = await mergeAndResolveVerdicts({
      rubricItems: [{ id: 'G1', kind: 'defect', views: ['2d', '3d'], text: 'Drop', source: ['judge'] }],
      rawJudgeVerdicts: [
        { judgeRole: 'judge_a', itemId: 'G1', view: '2d', verdict: 'fail', evidence: 'broke 2d', defects: [] },
        { judgeRole: 'judge_a', itemId: 'G1', view: '3d', verdict: 'pass', evidence: 'fixed 3d', defects: [] },
      ],
      hardResultsByItemView: {},
    });
    const cmpFlip = compareIterations(mergedPartial, flippedToBreak2D);
    expect(cmpFlip.outcome).toBe('worse');
    expect(cmpFlip.reasons.some((r: string) => r.includes("view '2d'"))).toBe(true);

    // #7, #8b, #13: Run gameplay script on fake scene testing:
    // - click on [data-testid=rotate-tile] mutates state
    // - unknown fixture throws and records stepErrors
    // - no-op step records stepErrors
    // - false step/script expect names its expression
    // - mid-script view switch fails script expect over `views`
    const { browser, context } = await launchHardwareBrowser(cfg, { allowSoftwareRenderer: true });
    try {
      const testScript = {
        id: 'test-errors',
        perView: false,
        startView: '2d',
        duration: 1.0,
        steps: [
          { at: 0.0, call: 'loadFixture', args: ['unknown-fixture-xyz'], label: 'bad fixture' },
          { at: 0.25, click: '[data-testid=rotate-tile]', label: 'rotate click', expect: 'after.currentRotation === 1' },
          { at: 0.5, call: 'botMove', label: 'noop botMove', expect: 'after.turnNumber > 999' },
        ],
        expect: 'views.every(v => v === startView)',
      };

      const res = await captureGameplayScriptOnPage(
        context,
        cfg,
        testScript,
        '2d',
        path.join(dir, 'runs/play-err'),
        { url: `file://${FIXTURE_HTML_PATH}?mode=noop-botmove` }
      );

      // Rotate click at 0.25s succeeded and its expect passed
      expect(res.stepErrors.some((e: any) => e.label === 'rotate click')).toBe(false);
      // Unknown fixture exception recorded
      expect(res.stepErrors.some((e: any) => e.type === 'exception' && e.message.includes('Unknown fixture'))).toBe(true);
      // No-op botMove recorded as no-op-step
      expect(res.stepErrors.some((e: any) => e.type === 'no-op-step')).toBe(true);
      // False step expect names expression 'after.turnNumber > 999'
      expect(res.stepErrors.some((e: any) => e.type === 'step-expect-failed' && e.message.includes('after.turnNumber > 999'))).toBe(true);

      // Now test mid-script view switch failing script expect over `views` (#8b)
      const viewSwitchRes = await captureGameplayScriptOnPage(
        context,
        cfg,
        {
          id: 'view-switch-script',
          perView: false,
          startView: '2d',
          duration: 1.0,
          steps: [{ at: 0.2, click: '[data-testid=rotate-tile]', label: 'rotate' }],
          expect: 'views.every(v => v === startView)',
        },
        '2d',
        path.join(dir, 'runs/play-vswitch'),
        { url: `file://${FIXTURE_HTML_PATH}?mode=switch-view-mid-script` }
      );
      expect(
        viewSwitchRes.stepErrors.some(
          (e: any) => e.type === 'script-expect-failed' && e.message.includes('views.every(v => v === startView)')
        )
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('9 & 10 & 14. 1-frame gameplay object appearance trips frameDiff while 5-frame tween does not; pairViews item detects single-view missing object naming tile; frameDiff ignores HUD text change outside canvas but catches change inside canvas', async () => {
    const { dir, cfg } = createGitTempRepo();
    const { browser, context } = await launchHardwareBrowser(cfg, { allowSoftwareRenderer: true });

    try {
      const playScript = {
        id: 'drop-test',
        perView: false,
        startView: '2d',
        duration: 1.5,
        steps: [{ at: 0.5, call: 'botMove', label: 'place object' }],
      };

      // #9a: 1-frame instant pop-in during gameplay step trips frameDiff
      const instantRes = await captureGameplayScriptOnPage(
        context,
        cfg,
        playScript,
        '2d',
        path.join(dir, 'runs/play-instant'),
        { url: `file://${FIXTURE_HTML_PATH}?mode=play-instant-popin` }
      );
      expect(instantRes.frameDiffSpikes.length).toBeGreaterThan(0);

      // #9b: Same object tweened over 5 frames does NOT trip frameDiff
      const tweenRes = await captureGameplayScriptOnPage(
        context,
        cfg,
        playScript,
        '2d',
        path.join(dir, 'runs/play-tween5'),
        { url: `file://${FIXTURE_HTML_PATH}?mode=play-tween-5` }
      );
      expect(tweenRes.frameDiffSpikes).toHaveLength(0);

      // #14a: Instant HUD text change outside canvas (in #ui-root) is ignored by frameDiff
      const hudOutsideRes = await captureGameplayScriptOnPage(
        context,
        cfg,
        { id: 'hud-out', perView: false, startView: '2d', duration: 1.5, steps: [] },
        '2d',
        path.join(dir, 'runs/hud-out'),
        { url: `file://${FIXTURE_HTML_PATH}?mode=hud-outside-canvas` }
      );
      expect(hudOutsideRes.frameDiffSpikes).toHaveLength(0);

      // #14b: Instant text box change inside the canvas is caught by frameDiff
      const hudInsideRes = await captureGameplayScriptOnPage(
        context,
        cfg,
        { id: 'hud-in', perView: false, startView: '2d', duration: 1.5, steps: [] },
        '2d',
        path.join(dir, 'runs/hud-in'),
        { url: `file://${FIXTURE_HTML_PATH}?mode=hud-inside-canvas` }
      );
      expect(hudInsideRes.frameDiffSpikes.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }

    // #10: pairViews item receives matching 2D and 3D images with the same tile marks;
    //      an object present in only one view produces a defect naming that tile ("1,0")
    const mismatchCfg = createFakeConfig(`file://${FIXTURE_HTML_PATH}?mode=mismatch-3d`, {
      gameplay: { fps: 12, views: ['2d', '3d'], scripts: [] },
    });
    const mismatchCap = await captureIteration(dir, path.join(dir, 'runs/cap-mismatch'), mismatchCfg, {
      skipGameplay: true,
      allowSoftwareRenderer: true,
    });

    let seenPairViewsInput: any[] = [];
    const pairRubric = {
      items: [
        {
          id: 'C1',
          kind: 'defect',
          views: ['2d', '3d'],
          shots: ['board-2d', 'terrace-overview'],
          pairViews: true,
          marks: 'tileLabels',
          text: 'Every tile shows the same features in 2D and 3D',
          source: ['audit:viewConsistency', 'judge'],
        },
      ],
    };

    const pairVerdicts = await judgeIteration(
      dir,
      path.join(dir, 'runs/cap-mismatch'),
      mismatchCap,
      mismatchCfg,
      {
        rubric: pairRubric,
        fakeJudgeHandler: async ({ input }: any) => {
          seenPairViewsInput = input;
          return {
            interactionId: 'int_pair_c1',
            inputTokens: 200,
            outputTokens: 100,
            output: {
              items: [{ id: 'C1', verdict: 'fail', evidence: 'Tile 1,0 house present in 2D but missing in 3D' }],
              defects: [
                {
                  id: 'D1',
                  itemIds: ['C1'],
                  severity: 'high',
                  description: 'Tile 1,0 (mark 2) has a house in 2d that is missing in 3d (3d departs from tile spec)',
                },
              ],
            },
          };
        },
      }
    );

    // Confirm both 2D and 3D marked images were sent to judge_b
    const textLabels = seenPairViewsInput.filter((p: any) => p.type === 'text').map((p: any) => p.text);
    expect(textLabels.some((t: string) => t.includes('board-2d, full shot with shared tile marks'))).toBe(true);
    expect(textLabels.some((t: string) => t.includes('terrace-overview, full shot with shared tile marks'))).toBe(true);

      // Confirm defect names tile 1,0 and both views
    expect(pairVerdicts.items.C1.verdict).toBe('fail');
    expect(pairVerdicts.openDefects.some((d: any) => d.description.includes('1,0'))).toBe(true);
  }, 30_000);
});
