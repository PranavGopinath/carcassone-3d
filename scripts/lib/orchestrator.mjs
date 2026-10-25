import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkImportBoundaries } from '../gates/imports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '../..');

export function loadRoles(rootDir = DEFAULT_ROOT) {
  const raw = fs.readFileSync(path.join(rootDir, 'agents/roles.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const map = new Map();
  for (const r of parsed.roles) map.set(r.name, r);
  return map;
}

export function loadPricing(rootDir = DEFAULT_ROOT) {
  const raw = fs.readFileSync(path.join(rootDir, 'agents/pricing.json'), 'utf8');
  return JSON.parse(raw);
}

export function computeCostUsd(model, inputTokens, outputTokens, pricing) {
  const rate = pricing?.rates?.[model];
  const inRate = typeof rate?.inputPerMillion === 'number' ? rate.inputPerMillion : 0;
  const outRate = typeof rate?.outputPerMillion === 'number' ? rate.outputPerMillion : 0;
  const cost = (Number(inputTokens || 0) / 1_000_000) * inRate + (Number(outputTokens || 0) / 1_000_000) * outRate;
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : 0;
}

const PROTECTED_PREFIXES = ['tests/', 'rubric/', 'scripts/gates/'];

export function validateOwnership(roleSpec, targetPath, rootDir = DEFAULT_ROOT) {
  if (!roleSpec) {
    return { ok: false, reason: 'Unknown role specification' };
  }
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { ok: false, reason: 'Empty target path' };
  }
  if (path.isAbsolute(targetPath)) {
    return { ok: false, reason: `Absolute path rejected: ${targetPath}` };
  }
  const resolved = path.resolve(rootDir, targetPath);
  const rel = path.relative(rootDir, resolved).replace(/\\/g, '/');
  if (rel.startsWith('..') || rel.includes('/../') || path.isAbsolute(rel)) {
    return { ok: false, reason: `Directory traversal rejected: ${targetPath}` };
  }

  const matchesRule = (rule, candidate) => {
    if (rule === '*') return true;
    const cleanRule = rule.replace(/\\/g, '/');
    if (cleanRule.endsWith('/')) {
      return candidate.startsWith(cleanRule) || candidate === cleanRule.slice(0, -1);
    }
    return candidate === cleanRule;
  };

  // Protected path check: rubric/ and scripts/gates/ are always protected;
  // tests/ is protected unless explicitly listed in roleSpec.ownsPaths.
  for (const prot of PROTECTED_PREFIXES) {
    if (matchesRule(prot, rel)) {
      const explicitlyOwnedTest =
        prot === 'tests/' &&
        Array.isArray(roleSpec.ownsPaths) &&
        roleSpec.ownsPaths.some((own) => own.startsWith('tests/') && matchesRule(own, rel));
      if (!explicitlyOwnedTest) {
        return { ok: false, reason: `Write to protected path '${rel}' rejected for role '${roleSpec.name}'` };
      }
    }
  }

  for (const forbidden of roleSpec.neverTouches || []) {
    if (matchesRule(forbidden, rel)) {
      return { ok: false, reason: `Role '${roleSpec.name}' neverTouches '${forbidden}' (attempted '${rel}')` };
    }
  }

  const allowed = (roleSpec.ownsPaths || []).some((own) => matchesRule(own, rel));
  if (!allowed) {
    return {
      ok: false,
      reason: `Path '${rel}' is outside ownsPaths [${(roleSpec.ownsPaths || []).join(', ')}] for role '${roleSpec.name}'`,
    };
  }

  return { ok: true, normalizedPath: rel };
}

export function buildWaves(tasks) {
  const byId = new Map();
  for (const t of tasks) byId.set(t.id, t);
  const completed = new Set();
  const remaining = new Set(tasks.map((t) => t.id));
  const waves = [];

  while (remaining.size > 0) {
    const ready = [];
    for (const id of remaining) {
      const t = byId.get(id);
      const deps = t.dependsOn || [];
      for (const d of deps) {
        if (!byId.has(d)) throw new Error(`Task '${id}' depends on unknown task '${d}'`);
      }
      if (deps.every((d) => completed.has(d))) {
        ready.push(t);
      }
    }
    if (ready.length === 0) {
      throw new Error(`Cycle detected in task DAG among: ${Array.from(remaining).join(', ')}`);
    }
    waves.push(ready);
    for (const t of ready) {
      remaining.delete(t.id);
      completed.add(t.id);
    }
  }
  return waves;
}

export function appendTrace(tracePath, entry) {
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.appendFileSync(tracePath, JSON.stringify(entry) + '\n', 'utf8');
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callModel({
  role,
  model,
  thinking = 'medium',
  input,
  taskId = 'adhoc',
  background = false,
  maxOutputTokens = 65536,
  previousInteractionId = undefined,
  schema = undefined,
  rootDir = DEFAULT_ROOT,
  tracePath = path.join(rootDir, 'runs/orchestrator/trace.jsonl'),
  state = { totalCostUsd: 0, totalCalls: 0 },
  budgetUsd = Infinity,
  maxCalls = Infinity,
  fakeHandler = undefined,
}) {
  const pricing = loadPricing(rootDir);

  if (state.totalCalls + 1 > maxCalls || state.totalCostUsd >= budgetUsd) {
    const resumeCmd = `node scripts/smoke-orchestrator.mjs --resume --task ${taskId}`;
    const err = new Error(
      `Spend/call cap reached before task '${taskId}' (calls=${state.totalCalls}/${maxCalls}, cost=$${state.totalCostUsd.toFixed(4)}/$${budgetUsd}). Resume with: ${resumeCmd}`
    );
    err.code = 'SPEND_CAP_EXCEEDED';
    err.resumeCommand = resumeCmd;
    throw err;
  }

  const startMs = Date.now();
  let attempt = 0;
  const maxRetries = 3;

  while (true) {
    try {
      let response;
      if (process.env.ORCH_FAKE === '1' || typeof fakeHandler === 'function') {
        const handler = fakeHandler || defaultFakeHandler;
        response = await handler({
          role,
          model,
          thinking,
          input,
          taskId,
          background,
          maxOutputTokens,
          previousInteractionId,
          schema,
          attempt,
        });
      } else {
        response = await invokeLiveInteractionsApi({
          model,
          thinking,
          input,
          background,
          maxOutputTokens,
          previousInteractionId,
          schema,
        });
      }

      const inputTokens = Number(response.inputTokens ?? 250);
      const outputTokens = Number(response.outputTokens ?? 180);
      const costUsd = computeCostUsd(model, inputTokens, outputTokens, pricing);

      if (state.totalCostUsd + costUsd > budgetUsd) {
        const resumeCmd = `node scripts/smoke-orchestrator.mjs --resume --task ${taskId}`;
        const err = new Error(
          `Budget cap ($${budgetUsd}) exceeded on task '${taskId}' (projected $${(state.totalCostUsd + costUsd).toFixed(4)}). Resume with: ${resumeCmd}`
        );
        err.code = 'SPEND_CAP_EXCEEDED';
        err.resumeCommand = resumeCmd;
        throw err;
      }

      state.totalCalls += 1;
      state.totalCostUsd = Number((state.totalCostUsd + costUsd).toFixed(6));

      const interactionId = response.interactionId || `int_${taskId}_${state.totalCalls}`;
      const traceEntry = {
        ts: new Date().toISOString(),
        taskId,
        role,
        model,
        thinking,
        inputTokens,
        outputTokens,
        costUsd,
        ms: Date.now() - startMs,
        status: 'ok',
        interactionId,
        previousInteractionId: previousInteractionId || null,
      };
      appendTrace(tracePath, traceEntry);

      return {
        output: response.output,
        interactionId,
        inputTokens,
        outputTokens,
        costUsd,
      };
    } catch (err) {
      if (err.code === 'SPEND_CAP_EXCEEDED') throw err;
      const status = err.status || err.statusCode;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(50 * Math.pow(2, attempt));
        continue;
      }
      appendTrace(tracePath, {
        ts: new Date().toISOString(),
        taskId,
        role,
        model,
        thinking,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        ms: Date.now() - startMs,
        status: 'error',
        error: err.message,
        previousInteractionId: previousInteractionId || null,
      });
      throw err;
    }
  }
}

async function defaultFakeHandler({ taskId, role, previousInteractionId }) {
  return {
    interactionId: `fake_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    inputTokens: 400,
    outputTokens: 200,
    output: {
      files: [],
      notes: `Fake execution completed for ${taskId} (${role}), prev=${previousInteractionId || 'none'}`,
      board: [],
    },
  };
}

async function invokeLiveInteractionsApi({
  model,
  thinking,
  input,
  background,
  maxOutputTokens,
  previousInteractionId,
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY / GOOGLE_API_KEY for live model call');
  }
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  // Map model alias if running against standard endpoint fallback
  const requestPayload = {
    model,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    config: {
      thinking_level: thinking,
      maxOutputTokens,
      ...(background ? { background: true } : {}),
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    },
  };

  if (ai.interactions && typeof ai.interactions.create === 'function') {
    let interaction = await ai.interactions.create(requestPayload);
    let backoff = 250;
    while (background && interaction && (interaction.status === 'in_progress' || interaction.status === 'Running')) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 4000);
      interaction = await ai.interactions.get(interaction.id);
    }
    const text = interaction?.output_text || interaction?.text || JSON.stringify(interaction?.output || {});
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { files: [], notes: text, board: [] };
    }
    return {
      interactionId: interaction?.id || `live_${Date.now()}`,
      inputTokens: interaction?.usage?.input_tokens ?? 350,
      outputTokens: interaction?.usage?.output_tokens ?? 220,
      output: parsed,
    };
  }

  // Fallback to models.generateContent if SDK version exposes generateContent
  const fallbackModel = model.startsWith('gemini-4') || model.startsWith('gemini-3') ? 'gemini-2.5-flash' : model;
  const res = await ai.models.generateContent({
    model: fallbackModel,
    contents: typeof input === 'string' ? input : JSON.stringify(input),
  });
  const text = res.text || '{}';
  let parsed;
  try {
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    parsed = { files: [], notes: text, board: [] };
  }
  return {
    interactionId: res.responseId || `gen_${Date.now()}`,
    inputTokens: res.usageMetadata?.promptTokenCount ?? 300,
    outputTokens: res.usageMetadata?.candidatesTokenCount ?? 150,
    output: parsed,
  };
}

export async function runOrchestrator(plan, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const roles = loadRoles(rootDir);
  const tracePath = options.tracePath || path.join(rootDir, 'runs/orchestrator/trace.jsonl');
  const boardPath = options.boardPath || path.join(rootDir, 'runs/board.jsonl');
  const useWorktrees = options.useWorktrees ?? false;
  const budgetUsd = options.budgetUsd ?? Infinity;
  const maxCalls = options.maxCalls ?? Infinity;
  const fakeHandler = options.fakeHandler;
  const runAcceptance =
    options.runAcceptance ||
    ((cmd, cwd) => {
      execSync(cmd, { cwd, stdio: 'pipe' });
    });

  const state = { totalCostUsd: 0, totalCalls: 0 };
  const waves = buildWaves(plan.tasks || []);
  const completedTasks = new Map();
  const executionOrder = [];
  const escalations = [];

  if (useWorktrees) {
    ensureIntegrationBranch(rootDir);
  }

  for (const wave of waves) {
    const waveResults = await Promise.all(
      wave.map(async (task) => {
        const roleSpec = roles.get(task.role);
        if (!roleSpec) throw new Error(`Unknown role '${task.role}' in task '${task.id}'`);

        const workDir = useWorktrees ? createTaskWorktree(rootDir, task.id) : rootDir;
        try {
          let prevId = undefined;
          let lastError = null;
          let succeeded = false;
          let taskOutput = null;

          const maxAttempts = 3; // Initial try + up to 2 repair retries, then escalate on 3rd failure
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const promptPayload = {
              taskId: task.id,
              goal: task.goal,
              inputs: task.inputs || [],
              repairError: lastError,
              attempt,
            };

            const callRes = await callModel({
              role: roleSpec.name,
              model: roleSpec.model,
              thinking: roleSpec.thinking,
              input: promptPayload,
              taskId: task.id,
              previousInteractionId: prevId,
              rootDir,
              tracePath,
              state,
              budgetUsd,
              maxCalls,
              fakeHandler,
            });
            prevId = callRes.interactionId;
            taskOutput = callRes.output || { files: [], notes: '', board: [] };

            // Validate ownership of all proposed file writes BEFORE touching disk
            for (const f of taskOutput.files || []) {
              const check = validateOwnership(roleSpec, f.path, workDir);
              if (!check.ok) {
                throw new Error(`Ownership violation in task '${task.id}': ${check.reason}`);
              }
            }

            // Write validated files
            for (const f of taskOutput.files || []) {
              const abs = path.resolve(workDir, f.path);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, f.content, 'utf8');
            }

            // Record blackboard notes
            if (Array.isArray(taskOutput.board) && taskOutput.board.length > 0) {
              fs.mkdirSync(path.dirname(boardPath), { recursive: true });
              for (const b of taskOutput.board) {
                fs.appendFileSync(boardPath, JSON.stringify({ ts: new Date().toISOString(), from: task.role, ...b }) + '\n');
              }
            }

            // Run acceptance commands
            try {
              for (const cmd of task.acceptance || []) {
                await runAcceptance(cmd, workDir, { task, attempt, output: taskOutput });
              }
              const gate = checkImportBoundaries(workDir);
              if (!gate.ok) {
                throw new Error(`Import gate failed: ${gate.violations.join('; ')}`);
              }
              succeeded = true;
              break;
            } catch (accErr) {
              lastError = accErr.message || String(accErr);
            }
          }

          if (!succeeded) {
            // Escalate to lead_architect (argon high) after 2 failed repair retries
            const leadSpec = roles.get('lead_architect');
            const escRes = await callModel({
              role: 'lead_architect',
              model: leadSpec.model,
              thinking: 'high',
              input: {
                escalationFor: task.id,
                failedRole: task.role,
                lastError,
              },
              taskId: `${task.id}:escalation`,
              previousInteractionId: prevId,
              rootDir,
              tracePath,
              state,
              budgetUsd,
              maxCalls,
              fakeHandler,
            });
            escalations.push({ taskId: task.id, interactionId: escRes.interactionId, error: lastError });
            taskOutput = escRes.output || taskOutput;

            for (const f of taskOutput?.files || []) {
              // Lead architect or task owner paths allowed during escalation fix
              const leadCheck = validateOwnership(leadSpec, f.path, workDir);
              const roleCheck = validateOwnership(roleSpec, f.path, workDir);
              if (!leadCheck.ok && !roleCheck.ok) {
                throw new Error(`Escalation ownership violation: ${leadCheck.reason}`);
              }
              const abs = path.resolve(workDir, f.path);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, f.content, 'utf8');
            }
          }

          if (useWorktrees) {
            commitAndMergeWorktree(rootDir, workDir, task.id);
          }

          executionOrder.push(task.id);
          completedTasks.set(task.id, taskOutput);
          return { taskId: task.id, output: taskOutput };
        } finally {
          if (useWorktrees) {
            removeTaskWorktree(rootDir, workDir, task.id);
          }
        }
      })
    );
  }

  return {
    waves: waves.map((w) => w.map((t) => t.id)),
    executionOrder,
    escalations,
    state,
    completedTasks,
  };
}

function ensureIntegrationBranch(rootDir) {
  try {
    execSync('git show-ref --verify --quiet refs/heads/integration', { cwd: rootDir });
  } catch {
    execSync('git branch integration HEAD', { cwd: rootDir });
  }
}

function createTaskWorktree(rootDir, taskId) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const wtDir = path.join(rootDir, 'wt', safeId);
  fs.rmSync(wtDir, { recursive: true, force: true });
  execSync(`git worktree add -B task/${safeId} "${wtDir}" integration`, { cwd: rootDir, stdio: 'pipe' });
  const rootModules = path.join(rootDir, 'node_modules');
  const wtModules = path.join(wtDir, 'node_modules');
  if (fs.existsSync(rootModules) && !fs.existsSync(wtModules)) {
    fs.symlinkSync(rootModules, wtModules, 'dir');
  }
  return wtDir;
}

function commitAndMergeWorktree(rootDir, wtDir, taskId) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const status = execSync('git status --porcelain', { cwd: wtDir, encoding: 'utf8' }).trim();
  if (status) {
    execSync('git add -A', { cwd: wtDir, stdio: 'pipe' });
    execSync(`git commit -m "task(${safeId}): complete subagent task"`, { cwd: wtDir, stdio: 'pipe' });
    execSync(`git merge --no-ff task/${safeId} -m "Merge task/${safeId} into integration"`, {
      cwd: rootDir,
      stdio: 'pipe',
    });
  }
}

function removeTaskWorktree(rootDir, wtDir, taskId) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: rootDir, stdio: 'pipe' });
  } catch {
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
  try {
    execSync(`git branch -D task/${safeId}`, { cwd: rootDir, stdio: 'pipe' });
  } catch {
    // ignore if branch already removed
  }
}
