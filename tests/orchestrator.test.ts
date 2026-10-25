import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as orchestratorMod from '../scripts/lib/orchestrator.mjs';

const {
  loadRoles,
  loadPricing,
  computeCostUsd,
  validateOwnership,
  buildWaves,
  callModel,
  runToolLoop,
  loadPersistentSpend,
  runOrchestrator,
} = orchestratorMod as Record<string, any>;

function createTempWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-orch-test-'));
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
  fs.cpSync(path.resolve('agents/roles.json'), path.join(tmp, 'agents/roles.json'));
  fs.cpSync(path.resolve('agents/pricing.json'), path.join(tmp, 'agents/pricing.json'));
  return tmp;
}

describe('Subagent Orchestrator (Prompt 0 & Prompt 2 §0 Upgrades)', () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env.ORCH_FAKE = '1';
    tmpDir = createTempWorkspace();
  });

  it('orders DAG tasks into topological waves so dependents wait for upstream outputs', async () => {
    const started: string[] = [];
    const plan = {
      tasks: [
        { id: 'ui_task', role: 'ui_engineer', goal: 'Build HUD', dependsOn: ['contracts_task'] },
        { id: 'render_task', role: 'render_engineer', goal: 'Build 3D scene', dependsOn: ['contracts_task', 'tiles_task'] },
        { id: 'contracts_task', role: 'lead_architect', goal: 'Define contracts', dependsOn: [] },
        { id: 'tiles_task', role: 'tile_engineer', goal: 'Build painter', dependsOn: ['contracts_task'] },
      ],
    };

    const waves = buildWaves(plan.tasks);
    expect(waves.map((w: any[]) => w.map((t) => t.id))).toEqual([
      ['contracts_task'],
      ['ui_task', 'tiles_task'],
      ['render_task'],
    ]);

    const res = await runOrchestrator(plan, {
      rootDir: tmpDir,
      fakeHandler: async ({ taskId }: any) => {
        started.push(taskId);
        return {
          interactionId: `int_${taskId}`,
          inputTokens: 100,
          outputTokens: 50,
          output: { files: [], notes: 'ok', board: [] },
        };
      },
    });

    expect(started[0]).toBe('contracts_task');
    expect(started.indexOf('contracts_task')).toBeLessThan(started.indexOf('tiles_task'));
    expect(started.indexOf('tiles_task')).toBeLessThan(started.indexOf('render_task'));
    expect(res.executionOrder).toHaveLength(4);
  });

  it('rejects ownership violations, path traversal, and protected paths before modifying disk', async () => {
    const roles = loadRoles(tmpDir);
    const uiRole = roles.get('ui_engineer');
    const patcherRole = roles.get('patcher');

    expect(validateOwnership(uiRole, '../secret.txt', tmpDir).ok).toBe(false);
    expect(validateOwnership(uiRole, '/etc/passwd', tmpDir).ok).toBe(false);
    expect(validateOwnership(uiRole, 'src/render/scene.ts', tmpDir).ok).toBe(false);
    expect(validateOwnership(uiRole, 'tests/ui.test.ts', tmpDir).ok).toBe(false);
    expect(validateOwnership(patcherRole, 'scripts/gates/imports.mjs', tmpDir).ok).toBe(false);
    expect(validateOwnership(uiRole, 'src/ui/hud.ts', tmpDir).ok).toBe(true);

    const forbiddenTarget = path.join(tmpDir, 'src/render/hacked.ts');
    await expect(
      runOrchestrator(
        {
          tasks: [{ id: 'bad_write', role: 'ui_engineer', goal: 'Try writing render file' }],
        },
        {
          rootDir: tmpDir,
          fakeHandler: async () => ({
            interactionId: 'int_bad',
            inputTokens: 100,
            outputTokens: 100,
            output: {
              files: [{ path: 'src/render/hacked.ts', content: 'export const x = 1;' }],
              notes: '',
              board: [],
            },
          }),
        }
      )
    ).rejects.toThrow(/Ownership violation/);

    expect(fs.existsSync(forbiddenTarget)).toBe(false);
  });

  it('threads previousInteractionId across repair retries and escalates to lead_architect after 2 failed retries', async () => {
    const seenCalls: Array<{ role: string; taskId: string; previousInteractionId?: string }> = [];

    const res = await runOrchestrator(
      {
        tasks: [
          {
            id: 'flaky_logic',
            role: 'logic_engineer',
            goal: 'Implement rule',
            acceptance: ['npm test'],
          },
        ],
      },
      {
        rootDir: tmpDir,
        fakeHandler: async ({ role, taskId, previousInteractionId, input }: any) => {
          const repairIdx = input?.attempt ?? 0;
          seenCalls.push({ role, taskId, previousInteractionId });
          return {
            interactionId: `id_${role}_${repairIdx}`,
            inputTokens: 500,
            outputTokens: 250,
            output: {
              files:
                role === 'lead_architect'
                  ? [{ path: 'src/contracts.ts', content: 'export const FIXED = true;\n' }]
                  : [{ path: 'src/logic/rule.ts', content: `export const attempt = ${repairIdx};\n` }],
              notes: 'attempt',
              board: [],
            },
          };
        },
        runAcceptance: () => {
          throw new Error('Test failed: expected true');
        },
      }
    );

    // 3 attempts by logic_engineer (initial + 2 repair retries) + 1 escalation call to lead_architect
    expect(seenCalls).toHaveLength(4);
    expect(seenCalls[0]).toEqual({ role: 'logic_engineer', taskId: 'flaky_logic', previousInteractionId: undefined });
    expect(seenCalls[1]).toEqual({ role: 'logic_engineer', taskId: 'flaky_logic', previousInteractionId: 'id_logic_engineer_0' });
    expect(seenCalls[2]).toEqual({ role: 'logic_engineer', taskId: 'flaky_logic', previousInteractionId: 'id_logic_engineer_1' });
    expect(seenCalls[3]).toEqual({
      role: 'lead_architect',
      taskId: 'flaky_logic:escalation',
      previousInteractionId: 'id_logic_engineer_2',
    });
    expect(res.escalations).toHaveLength(1);
    expect(res.escalations[0].taskId).toBe('flaky_logic');
  });

  it('handles null Flash pricing without NaN, enforces spend caps, prints resume command, and writes trace.jsonl', async () => {
    const pricing = loadPricing(tmpDir);
    const flashCost = computeCostUsd('gemini-3.8-flash', 100_000, 50_000, pricing);
    expect(flashCost).toBe(0);
    expect(Number.isNaN(flashCost)).toBe(false);

    const argonCost = computeCostUsd('gemini-4-argon', 1_000_000, 1_000_000, pricing);
    expect(argonCost).toBe(12.0);

    const tracePath = path.join(tmpDir, 'runs/orchestrator/trace.jsonl');

    let caughtError: any = null;
    try {
      await runOrchestrator(
        {
          tasks: [
            { id: 't1', role: 'lead_architect', goal: 'Step 1', dependsOn: [] },
            { id: 't2', role: 'lead_architect', goal: 'Step 2', dependsOn: ['t1'] },
          ],
        },
        {
          rootDir: tmpDir,
          tracePath,
          budgetUsd: 0.05,
          fakeHandler: async ({ taskId }: any) => ({
            interactionId: `int_${taskId}`,
            inputTokens: 10_000, // $0.02
            outputTokens: 2_000, // $0.02 -> total $0.04 per call; second call reaches $0.08 > $0.05
            output: { files: [], notes: 'ok', board: [] },
          }),
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeTruthy();
    expect(caughtError.code).toBe('SPEND_CAP_EXCEEDED');
    expect(caughtError.message).toContain('--resume');

    expect(fs.existsSync(tracePath)).toBe(true);
    const lines = fs
      .readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatchObject({
      taskId: 't1',
      role: 'lead_architect',
      model: 'gemini-4-argon',
      thinking: 'high',
      status: 'ok',
    });
  });

  it('runs thinking="high" calls with background=true, polls interactions.get with backoff, and cancels + retries stalled calls past pollTimeoutMs (§0.1)', async () => {
    const tracePath = path.join(tmpDir, 'runs/orchestrator/trace.jsonl');
    const createPayloads: any[] = [];
    const polledIds: string[] = [];
    const cancelledIds: string[] = [];
    let createCount = 0;
    let secondAttemptPolls = 0;

    const fakeInteractionsClient = {
      async create(payload: any) {
        createCount += 1;
        createPayloads.push(payload);
        if (createCount === 1) {
          // Stalls in_progress past deadline
          return { id: 'int_stalled_1', status: 'in_progress' };
        }
        return { id: 'int_recovered_2', status: 'in_progress' };
      },
      async get(id: string) {
        polledIds.push(id);
        if (id === 'int_stalled_1') {
          return { id, status: 'in_progress' };
        }
        secondAttemptPolls += 1;
        if (secondAttemptPolls < 2) {
          return { id, status: 'in_progress' };
        }
        return {
          id,
          status: 'completed',
          usage: { total_input_tokens: 500, total_output_tokens: 200 },
          steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"recovered":true}' }] }],
        };
      },
      async cancel(id: string) {
        cancelledIds.push(id);
        return { id, status: 'cancelled' };
      },
    };

    const res = await callModel({
      role: 'judge_a',
      model: 'gemini-4-argon',
      thinking: 'high',
      input: 'Grade clip',
      taskId: 'deadline_test',
      pollTimeoutMs: 60,
      pollIntervalMs: 15,
      retryBackoffMs: 10,
      rootDir: tmpDir,
      tracePath,
      interactionsClient: fakeInteractionsClient,
    });

    expect(createPayloads[0].background).toBe(true);
    expect(cancelledIds).toContain('int_stalled_1');
    expect(polledIds).toContain('int_stalled_1');
    expect(polledIds).toContain('int_recovered_2');
    expect(res.interactionId).toBe('int_recovered_2');
    expect(res.output).toEqual({ recovered: true });
  });

  it('initializes cumulative spend and call count from runs/orchestrator/trace.jsonl across processes (§0.2)', async () => {
    const tracePath = path.join(tmpDir, 'runs/orchestrator/trace.jsonl');

    // Process 1 spends $0.04 (10k input = $0.02, 2k output = $0.02)
    await callModel({
      role: 'lead_architect',
      model: 'gemini-4-argon',
      thinking: 'high',
      input: 'First process call',
      taskId: 'proc1_call',
      rootDir: tmpDir,
      tracePath,
      budgetUsd: 0.06,
      fakeHandler: async () => ({
        interactionId: 'int_proc1',
        inputTokens: 10_000,
        outputTokens: 2_000,
        output: { ok: 1 },
      }),
    });

    const persisted = loadPersistentSpend(tracePath);
    expect(persisted.totalCalls).toBe(1);
    expect(persisted.totalCostUsd).toBe(0.04);

    // Process 2 starts with a fresh state object, inherits $0.04 from trace.jsonl, and hits $0.06 cap on next $0.04 call
    await expect(
      callModel({
        role: 'lead_architect',
        model: 'gemini-4-argon',
        thinking: 'high',
        input: 'Second process call',
        taskId: 'proc2_call',
        rootDir: tmpDir,
        tracePath,
        budgetUsd: 0.06,
        fakeHandler: async () => ({
          interactionId: 'int_proc2',
          inputTokens: 10_000,
          outputTokens: 2_000,
          output: { ok: 2 },
        }),
      })
    ).rejects.toThrow(/Budget cap/);
  });

  it('runs a multi-turn function-calling loop via runToolLoop under ORCH_FAKE=1 and meters each turn (§0.3)', async () => {
    const tracePath = path.join(tmpDir, 'runs/orchestrator/trace.jsonl');
    const executedTools: Array<{ name: string; args: any }> = [];

    const tools = [
      {
        name: 'list_files',
        description: 'List files',
        parameters: { type: 'object', properties: { dir: { type: 'string' } } },
        handler: async (args: any) => {
          executedTools.push({ name: 'list_files', args });
          return { files: ['src/main.ts', 'src/render/renderer.ts'] };
        },
      },
      {
        name: 'edit_file',
        description: 'Edit file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        handler: async (args: any) => {
          executedTools.push({ name: 'edit_file', args });
          return { ok: true };
        },
      },
      {
        name: 'finish',
        description: 'Finish patcher turn',
        parameters: { type: 'object', properties: { report: { type: 'object' } } },
        handler: async (args: any) => {
          executedTools.push({ name: 'finish', args });
          return { ok: true, report: args.report };
        },
      },
    ];

    const result = await runToolLoop({
      role: 'patcher',
      model: 'gemini-4-argon',
      thinking: 'high',
      tools,
      input: 'Fix defect still-O3-3d-1',
      taskId: 'patch_iter_1',
      maxToolCalls: 10,
      deadlineMs: 30_000,
      rootDir: tmpDir,
      tracePath,
      fakeToolTurns: [
        [{ id: 'c1', name: 'list_files', arguments: { dir: 'src' } }],
        [{ id: 'c2', name: 'edit_file', arguments: { path: 'src/render/renderer.ts' } }],
        [
          {
            id: 'c3',
            name: 'finish',
            arguments: {
              report: {
                summary: 'Grounded floating props in renderer.ts',
                addressed: [
                  {
                    defectId: 'still-O3-3d-1',
                    files: ['src/render/renderer.ts'],
                    change: 'Grounded tree props on terrain elevation',
                    verified: 'both',
                  },
                ],
                skipped: [],
              },
            },
          },
        ],
      ],
    });

    expect(result.finished).toBe(true);
    expect(result.turns).toBe(3);
    expect(result.toolCallsUsed).toBe(3);
    expect(executedTools.map((t) => t.name)).toEqual(['list_files', 'edit_file', 'finish']);
    expect(result.report.summary).toBe('Grounded floating props in renderer.ts');

    const traceLines = fs
      .readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(traceLines).toHaveLength(3);
    expect(traceLines[1].previousInteractionId).toBe(traceLines[0].interactionId);
    expect(traceLines[2].previousInteractionId).toBe(traceLines[1].interactionId);
  });
});
