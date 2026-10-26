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

/**
 * Reads cumulative spend and call count from an existing trace.jsonl file
 * so budget and call caps persist across processes.
 */
export function loadTraceState(tracePath) {
  let totalCostUsd = 0;
  let totalCalls = 0;
  if (tracePath && fs.existsSync(tracePath)) {
    const raw = fs.readFileSync(tracePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && entry.status === 'ok') {
          totalCalls += 1;
          const c = Number(entry.costUsd || 0);
          if (Number.isFinite(c)) {
            totalCostUsd = Number((totalCostUsd + c).toFixed(6));
          }
        }
      } catch {
        // Ignore malformed trace line
      }
    }
  }
  return { totalCostUsd, totalCalls, _initializedFromTrace: tracePath };
}

export function ensureTraceStateInitialized(state, tracePath) {
  if (!state) {
    return loadTraceState(tracePath);
  }
  if (tracePath && state._initializedFromTrace !== tracePath) {
    const persisted = loadTraceState(tracePath);
    state.totalCostUsd = Number(((state.totalCostUsd || 0) + persisted.totalCostUsd).toFixed(6));
    state.totalCalls = (state.totalCalls || 0) + persisted.totalCalls;
    state._initializedFromTrace = tracePath;
  }
  return state;
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

function withTimeout(promise, ms, label = 'operation') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Deadline exceeded (${ms}ms) during ${label}`);
      err.code = 'DEADLINE_EXCEEDED';
      err.retryable = true;
      reject(err);
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function callModel({
  role,
  model = 'gemini-4-argon',
  thinking = 'medium',
  input,
  tools = undefined,
  systemInstruction = undefined,
  taskId = 'adhoc',
  background = false,
  maxOutputTokens = 65536,
  previousInteractionId = undefined,
  schema = undefined,
  pollTimeoutMs = 90_000,
  pollInitialMs = 250,
  maxRetries = 3,
  retryBaseMs = 50,
  rootDir = DEFAULT_ROOT,
  tracePath = path.join(rootDir, 'runs/orchestrator/trace.jsonl'),
  state = undefined,
  budgetUsd = Infinity,
  maxCalls = Infinity,
  fakeHandler = undefined,
  aiClient = undefined,
}) {
  const pricing = loadPricing(rootDir);
  const activeState = ensureTraceStateInitialized(state || { totalCostUsd: 0, totalCalls: 0 }, tracePath);

  // Long or thinking: "high" calls always run with background: true
  const effectiveBackground = Boolean(background || thinking === 'high');

  if (activeState.totalCalls + 1 > maxCalls || activeState.totalCostUsd >= budgetUsd) {
    const resumeCmd = `node scripts/smoke-orchestrator.mjs --resume --task ${taskId}`;
    const err = new Error(
      `Spend/call cap reached before task '${taskId}' (calls=${activeState.totalCalls}/${maxCalls}, cost=$${activeState.totalCostUsd.toFixed(4)}/$${budgetUsd}). Resume with: ${resumeCmd}`
    );
    err.code = 'SPEND_CAP_EXCEEDED';
    err.resumeCommand = resumeCmd;
    throw err;
  }

  const startMs = Date.now();
  let attempt = 0;

  while (true) {
    try {
      let response;
      if ((process.env.ORCH_FAKE === '1' && !aiClient) || typeof fakeHandler === 'function') {
        const handler = fakeHandler || defaultFakeHandler;
        response = await withTimeout(
          Promise.resolve(
            handler({
              role,
              model,
              thinking,
              input,
              tools,
              systemInstruction,
              taskId,
              background: effectiveBackground,
              maxOutputTokens,
              previousInteractionId,
              schema,
              pollTimeoutMs,
              attempt,
            })
          ),
          pollTimeoutMs,
          `fakeHandler(${taskId})`
        );
      } else {
        response = await invokeLiveInteractionsApi({
          model,
          thinking,
          input,
          tools,
          systemInstruction,
          background: effectiveBackground,
          maxOutputTokens,
          previousInteractionId,
          schema,
          pollTimeoutMs,
          pollInitialMs,
          aiClient,
        });
      }

      const inputTokens = Number(response.inputTokens ?? 250);
      const outputTokens = Number(response.outputTokens ?? 180);
      const costUsd = computeCostUsd(model, inputTokens, outputTokens, pricing);

      if (activeState.totalCostUsd + costUsd > budgetUsd) {
        const resumeCmd = `node scripts/smoke-orchestrator.mjs --resume --task ${taskId}`;
        const err = new Error(
          `Budget cap ($${budgetUsd}) exceeded on task '${taskId}' (projected $${(activeState.totalCostUsd + costUsd).toFixed(4)}). Resume with: ${resumeCmd}`
        );
        err.code = 'SPEND_CAP_EXCEEDED';
        err.resumeCommand = resumeCmd;
        throw err;
      }

      activeState.totalCalls += 1;
      activeState.totalCostUsd = Number((activeState.totalCostUsd + costUsd).toFixed(6));

      const interactionId = response.interactionId || `int_${taskId}_${activeState.totalCalls}`;
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
        rawText: response.rawText ?? '',
        functionCalls: response.functionCalls || [],
        status: response.status || 'completed',
        interactionId,
        inputTokens,
        outputTokens,
        costUsd,
      };
    } catch (err) {
      if (err.code === 'SPEND_CAP_EXCEEDED') throw err;
      const status = err.status || err.statusCode;
      const retryable =
        err.retryable === true ||
        err.code === 'DEADLINE_EXCEEDED' ||
        status === 429 ||
        (status >= 500 && status < 600);
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(retryBaseMs * Math.pow(2, attempt));
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
    functionCalls: [],
    status: 'completed',
  };
}

function cleanJsonSchemaForApi(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = JSON.parse(JSON.stringify(schema));
  delete copy.$schema;
  delete copy.title;
  return copy;
}

function extractInteractionOutputs(interaction) {
  const functionCalls = [];
  const textParts = [];

  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps) {
      if (step.type === 'function_call') {
        functionCalls.push({
          id: step.id,
          name: step.name,
          arguments: step.arguments || {},
        });
      } else if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item.type === 'text' && typeof item.text === 'string') {
            textParts.push(item.text);
          } else if (item.type === 'function_call') {
            functionCalls.push({
              id: item.id,
              name: item.name,
              arguments: item.arguments || {},
            });
          }
        }
      }
    }
  }

  if (Array.isArray(interaction?.outputs)) {
    for (const out of interaction.outputs) {
      if (out.type === 'function_call') {
        functionCalls.push({
          id: out.id,
          name: out.name,
          arguments: out.arguments || {},
        });
      } else if (out.type === 'text' && typeof out.text === 'string') {
        textParts.push(out.text);
      }
    }
  }

  const rawText =
    interaction?.output_text ||
    interaction?.text ||
    (textParts.length > 0 ? textParts.join('\n') : '');

  let parsed = null;
  if (rawText) {
    try {
      const clean = rawText
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { files: [], notes: rawText, board: [] };
    }
  } else if (interaction?.output && typeof interaction.output === 'object') {
    parsed = interaction.output;
  } else {
    parsed = { files: [], notes: '', board: [] };
  }

  return { parsed, rawText, functionCalls };
}

async function invokeLiveInteractionsApi({
  model,
  thinking,
  input,
  tools,
  systemInstruction,
  background,
  maxOutputTokens,
  previousInteractionId,
  schema,
  pollTimeoutMs = 90_000,
  pollInitialMs = 250,
  aiClient = undefined,
}) {
  let ai = aiClient;
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY / GOOGLE_API_KEY for live model call');
    }
    const { GoogleGenAI } = await import('@google/genai');
    ai = new GoogleGenAI({ apiKey });
  }

  let formattedInput;
  if (typeof input === 'string' || Array.isArray(input)) {
    formattedInput = input;
  } else if (input && typeof input === 'object' && typeof input.type === 'string') {
    formattedInput = input;
  } else {
    formattedInput = JSON.stringify(input);
  }

  const requestPayload = {
    model,
    input: formattedInput,
    generation_config: {
      thinking_level: thinking,
      max_output_tokens: maxOutputTokens,
    },
    ...(background ? { background: true } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    ...(schema
      ? {
          response_mime_type: 'application/json',
          response_format: cleanJsonSchemaForApi(schema),
        }
      : {}),
  };

  if (ai.interactions && typeof ai.interactions.create === 'function') {
    const callStartMs = Date.now();
    let interaction = await withTimeout(
      ai.interactions.create(requestPayload),
      pollTimeoutMs,
      'interactions.create'
    );

    let backoff = pollInitialMs;
    while (
      interaction &&
      (interaction.status === 'in_progress' || interaction.status === 'Running')
    ) {
      const elapsed = Date.now() - callStartMs;
      if (elapsed >= pollTimeoutMs) {
        if (typeof ai.interactions.cancel === 'function' && interaction.id) {
          try {
            await ai.interactions.cancel(interaction.id);
          } catch {
            // Ignore errors during cancellation
          }
        }
        const err = new Error(
          `Interaction '${interaction.id}' exceeded deadline of ${pollTimeoutMs}ms and was cancelled`
        );
        err.code = 'DEADLINE_EXCEEDED';
        err.retryable = true;
        err.cancelledInteractionId = interaction.id;
        throw err;
      }

      const sleepTime = Math.min(backoff, Math.max(10, pollTimeoutMs - elapsed));
      await sleep(sleepTime);
      backoff = Math.min(backoff * 2, 4000);

      const remainingMs = Math.max(50, pollTimeoutMs - (Date.now() - callStartMs));
      try {
        interaction = await withTimeout(
          ai.interactions.get(interaction.id),
          remainingMs,
          `interactions.get(${interaction.id})`
        );
      } catch (pollErr) {
        if (pollErr.code === 'DEADLINE_EXCEEDED' && typeof ai.interactions.cancel === 'function') {
          try {
            await ai.interactions.cancel(interaction.id);
          } catch {
            // Ignore cancel error
          }
          pollErr.cancelledInteractionId = interaction.id;
        }
        throw pollErr;
      }
    }

    if (interaction?.status === 'failed' || interaction?.status === 'cancelled') {
      const err = new Error(`Interaction ${interaction.id} ended with status '${interaction.status}'`);
      err.status = 500;
      err.retryable = true;
      throw err;
    }

    const { parsed, rawText, functionCalls } = extractInteractionOutputs(interaction);
    const usage = interaction?.usage || {};
    const inputTokens = Number(usage.total_input_tokens ?? usage.input_tokens ?? 350);
    const outputTokens = Number(
      (usage.total_output_tokens ?? usage.output_tokens ?? 220) +
        (usage.total_thought_tokens ?? 0)
    );

    return {
      interactionId: interaction?.id || `live_${Date.now()}`,
      inputTokens,
      outputTokens,
      output: parsed,
      rawText,
      functionCalls,
      status: interaction?.status || 'completed',
    };
  }

  throw new Error('Interactions API is required on the @google/genai client');
}

function formatToolResultForApi(res) {
  if (typeof res === 'string') return res;
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object' && Array.isArray(res.content)) {
    return res.content;
  }
  return JSON.stringify(res ?? {});
}

/**
 * Runs a multi-turn function-calling tool loop on the Interactions API.
 * Repeats until the model calls `finish` or `maxToolCalls` / `deadlineMs` is reached.
 * Under `ORCH_FAKE=1`, replays `fakeToolScript` if provided.
 */
export async function runToolLoop({
  role = 'patcher',
  model = 'gemini-4-argon',
  thinking = 'high',
  tools = [],
  input,
  systemInstruction = undefined,
  taskId = 'tool_loop',
  maxToolCalls = 60,
  deadlineMs = 1_200_000,
  pollTimeoutMs = 90_000,
  previousInteractionId = undefined,
  executeTool,
  fakeToolScript = undefined,
  rootDir = DEFAULT_ROOT,
  tracePath = path.join(rootDir, 'runs/orchestrator/trace.jsonl'),
  state = undefined,
  budgetUsd = Infinity,
  maxCalls = Infinity,
  fakeHandler = undefined,
  aiClient = undefined,
}) {
  if (typeof executeTool !== 'function') {
    throw new Error('runToolLoop requires an executeTool(call) handler function');
  }

  const activeState = ensureTraceStateInitialized(state || { totalCostUsd: 0, totalCalls: 0 }, tracePath);
  const loopStartMs = Date.now();
  let currentInput = input;
  let prevId = previousInteractionId;
  let toolCallsCount = 0;
  let turnIndex = 0;
  const toolHistory = [];

  const scriptedTurns =
    fakeToolScript ||
    (process.env.ORCH_FAKE === '1' && Array.isArray(globalThis.__ORCH_FAKE_TOOL_SCRIPT)
      ? globalThis.__ORCH_FAKE_TOOL_SCRIPT
      : null);

  const effectiveFakeHandler =
    fakeHandler ||
    (scriptedTurns
      ? async ({ taskId: tId, previousInteractionId: pId }) => {
          const turnSpec = scriptedTurns[turnIndex] ?? [];
          const normalizedCalls = (Array.isArray(turnSpec) ? turnSpec : [turnSpec]).map(
            (c, idx) => ({
              id: c.id || `fake_call_${turnIndex}_${idx}`,
              name: c.name,
              arguments: c.arguments || c.args || {},
            })
          );
          return {
            interactionId: `fake_tool_${tId}_${turnIndex}`,
            inputTokens: 300,
            outputTokens: 150,
            output: {},
            rawText: '',
            functionCalls: normalizedCalls,
            status: normalizedCalls.length > 0 ? 'requires_action' : 'completed',
            previousInteractionId: pId,
          };
        }
      : undefined);

  while (true) {
    const elapsedMs = Date.now() - loopStartMs;
    if (elapsedMs >= deadlineMs) {
      return {
        finished: false,
        finishReason: 'deadline',
        report: null,
        toolCalls: toolHistory,
        toolCallsCount,
        interactionId: prevId,
        state: activeState,
      };
    }

    if (toolCallsCount >= maxToolCalls) {
      return {
        finished: false,
        finishReason: 'max_tool_calls',
        report: null,
        toolCalls: toolHistory,
        toolCallsCount,
        interactionId: prevId,
        state: activeState,
      };
    }

    const remainingLoopMs = Math.max(100, deadlineMs - elapsedMs);
    const effectivePollTimeout = Math.min(pollTimeoutMs, remainingLoopMs);

    const callRes = await callModel({
      role,
      model,
      thinking,
      input: currentInput,
      tools,
      systemInstruction,
      taskId: `${taskId}:turn${turnIndex}`,
      background: true,
      previousInteractionId: prevId,
      pollTimeoutMs: effectivePollTimeout,
      rootDir,
      tracePath,
      state: activeState,
      budgetUsd,
      maxCalls,
      fakeHandler: effectiveFakeHandler,
      aiClient,
    });

    turnIndex += 1;
    prevId = callRes.interactionId;
    const fnCalls = callRes.functionCalls || [];

    if (fnCalls.length === 0) {
      return {
        finished: false,
        finishReason: 'no_tool_call',
        report: callRes.output || null,
        toolCalls: toolHistory,
        toolCallsCount,
        interactionId: prevId,
        state: activeState,
      };
    }

    const nextResults = [];
    for (const fnCall of fnCalls) {
      if (Date.now() - loopStartMs >= deadlineMs) {
        return {
          finished: false,
          finishReason: 'deadline',
          report: null,
          toolCalls: toolHistory,
          toolCallsCount,
          interactionId: prevId,
          state: activeState,
        };
      }
      if (toolCallsCount >= maxToolCalls) {
        return {
          finished: false,
          finishReason: 'max_tool_calls',
          report: null,
          toolCalls: toolHistory,
          toolCallsCount,
          interactionId: prevId,
          state: activeState,
        };
      }

      toolCallsCount += 1;
      const callId = fnCall.id || `call_${turnIndex}_${toolCallsCount}`;

      if (fnCall.name === 'finish') {
        let finishResult = fnCall.arguments || {};
        try {
          const maybeHandled = await executeTool({
            id: callId,
            name: 'finish',
            arguments: fnCall.arguments || {},
          });
          if (maybeHandled !== undefined) {
            finishResult = maybeHandled;
          }
        } catch {
          // Use raw arguments if executeTool doesn't handle finish
        }
        toolHistory.push({
          id: callId,
          name: 'finish',
          arguments: fnCall.arguments || {},
          result: finishResult,
        });
        return {
          finished: true,
          finishReason: 'finish',
          report: fnCall.arguments?.report || fnCall.arguments || finishResult,
          toolCalls: toolHistory,
          toolCallsCount,
          interactionId: prevId,
          state: activeState,
        };
      }

      let toolResult;
      let isError = false;
      try {
        toolResult = await executeTool({
          id: callId,
          name: fnCall.name,
          arguments: fnCall.arguments || {},
        });
        if (toolResult && typeof toolResult === 'object' && toolResult.isError === true) {
          isError = true;
        }
      } catch (toolErr) {
        isError = true;
        toolResult = { error: toolErr.message || String(toolErr) };
      }

      toolHistory.push({
        id: callId,
        name: fnCall.name,
        arguments: fnCall.arguments || {},
        result: toolResult,
        isError,
      });

      nextResults.push({
        type: 'function_result',
        call_id: callId,
        name: fnCall.name,
        result: formatToolResultForApi(toolResult),
        ...(isError ? { is_error: true } : {}),
      });
    }

    currentInput = nextResults;
  }
}

/**
 * Uploads a video or media file via the Gemini Files API and polls until ACTIVE.
 * Under ORCH_FAKE=1 returns a deterministic fake URI.
 */
export async function uploadMediaFile({
  filePath,
  mimeType = 'video/webm',
  pollTimeoutMs = 90_000,
  aiClient = undefined,
}) {
  if (process.env.ORCH_FAKE === '1' && !aiClient) {
    return {
      name: `files/fake_${path.basename(filePath)}`,
      uri: `https://generativelanguage.googleapis.com/v1beta/files/fake_${path.basename(filePath)}`,
      mimeType,
      state: 'ACTIVE',
    };
  }

  let ai = aiClient;
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY / GOOGLE_API_KEY for file upload');
    }
    const { GoogleGenAI } = await import('@google/genai');
    ai = new GoogleGenAI({ apiKey });
  }

  const startMs = Date.now();
  let uploaded = await withTimeout(
    ai.files.upload({ file: filePath, config: { mimeType } }),
    pollTimeoutMs,
    `files.upload(${path.basename(filePath)})`
  );

  let backoff = 500;
  while (uploaded.state === 'PROCESSING' || uploaded.state === 'STATE_UNSPECIFIED') {
    if (Date.now() - startMs >= pollTimeoutMs) {
      const err = new Error(`File upload polling exceeded deadline (${pollTimeoutMs}ms) for ${filePath}`);
      err.code = 'DEADLINE_EXCEEDED';
      throw err;
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 1.5, 4000);
    uploaded = await withTimeout(
      ai.files.get({ name: uploaded.name }),
      Math.max(1000, pollTimeoutMs - (Date.now() - startMs)),
      `files.get(${uploaded.name})`
    );
  }

  if (uploaded.state !== 'ACTIVE') {
    throw new Error(`Uploaded file ${uploaded.name} failed processing with state: ${uploaded.state}`);
  }

  return uploaded;
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

  const state = ensureTraceStateInitialized(
    options.state || { totalCostUsd: 0, totalCalls: 0 },
    tracePath
  );
  const waves = buildWaves(plan.tasks || []);
  const completedTasks = new Map();
  const executionOrder = [];
  const escalations = [];

  if (useWorktrees) {
    ensureIntegrationBranch(rootDir);
  }

  for (const wave of waves) {
    await Promise.all(
      wave.map(async (task) => {
        const roleSpec = roles.get(task.role);
        if (!roleSpec) throw new Error(`Unknown role '${task.role}' in task '${task.id}'`);

        const workDir = useWorktrees ? createTaskWorktree(rootDir, task.id) : rootDir;
        try {
          let prevId = undefined;
          let lastError = null;
          let succeeded = false;
          let taskOutput = null;

          const maxAttempts = 3;
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

            for (const f of taskOutput.files || []) {
              const check = validateOwnership(roleSpec, f.path, workDir);
              if (!check.ok) {
                throw new Error(`Ownership violation in task '${task.id}': ${check.reason}`);
              }
            }

            for (const f of taskOutput.files || []) {
              const abs = path.resolve(workDir, f.path);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, f.content, 'utf8');
            }

            if (Array.isArray(taskOutput.board) && taskOutput.board.length > 0) {
              fs.mkdirSync(path.dirname(boardPath), { recursive: true });
              for (const b of taskOutput.board) {
                fs.appendFileSync(
                  boardPath,
                  JSON.stringify({ ts: new Date().toISOString(), from: task.role, ...b }) + '\n'
                );
              }
            }

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

export function createTaskWorktree(rootDir, taskId, baseBranch = 'integration') {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const wtDir = path.join(rootDir, 'wt', safeId);
  fs.rmSync(wtDir, { recursive: true, force: true });
  execSync(`git worktree add -B task/${safeId} "${wtDir}" ${baseBranch}`, { cwd: rootDir, stdio: 'pipe' });
  const rootModules = path.join(rootDir, 'node_modules');
  const wtModules = path.join(wtDir, 'node_modules');
  if (fs.existsSync(rootModules) && !fs.existsSync(wtModules)) {
    fs.symlinkSync(rootModules, wtModules, 'dir');
  }
  return wtDir;
}

export function commitAndMergeWorktree(rootDir, wtDir, taskId, targetBranch = 'integration') {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const status = execSync('git status --porcelain', { cwd: wtDir, encoding: 'utf8' }).trim();
  if (status) {
    execSync('git add -A', { cwd: wtDir, stdio: 'pipe' });
    execSync(`git commit -m "task(${safeId}): complete subagent task"`, { cwd: wtDir, stdio: 'pipe' });
    execSync(`git merge --no-ff task/${safeId} -m "Merge task/${safeId} into ${targetBranch}"`, {
      cwd: rootDir,
      stdio: 'pipe',
    });
  }
}

export function removeTaskWorktree(rootDir, wtDir, taskId) {
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

/**
 * Worktree helpers for the Visual Feedback Loop (Prompt 2):
 * Creates worktree `wt/loop-<runId>` on branch `loop/<runId>` from `baseBranch`.
 */
export function createLoopWorktree(rootDir, runId, baseBranch = 'main') {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const wtDir = path.join(rootDir, 'wt', `loop-${safeId}`);
  const branchName = `loop/${safeId}`;
  fs.rmSync(wtDir, { recursive: true, force: true });
  try {
    execSync('git worktree prune', { cwd: rootDir, stdio: 'pipe' });
  } catch {
    // ignore
  }
  execSync(`git worktree add -B "${branchName}" "${wtDir}" "${baseBranch}"`, {
    cwd: rootDir,
    stdio: 'pipe',
  });
  const rootModules = path.join(rootDir, 'node_modules');
  const wtModules = path.join(wtDir, 'node_modules');
  if (fs.existsSync(rootModules) && !fs.existsSync(wtModules)) {
    fs.symlinkSync(rootModules, wtModules, 'dir');
  }
  const startCommit = execSync('git rev-parse HEAD', { cwd: wtDir, encoding: 'utf8' }).trim();
  return { wtDir, branchName, startCommit };
}

export function removeLoopWorktree(rootDir, wtDir) {
  try {
    const wtModules = path.join(wtDir, 'node_modules');
    if (fs.existsSync(wtModules) && fs.lstatSync(wtModules).isSymbolicLink()) {
      fs.unlinkSync(wtModules);
    }
  } catch {
    // ignore
  }
  try {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: rootDir, stdio: 'pipe' });
  } catch {
    fs.rmSync(wtDir, { recursive: true, force: true });
    try {
      execSync('git worktree prune', { cwd: rootDir, stdio: 'pipe' });
    } catch {
      // ignore
    }
  }
}
