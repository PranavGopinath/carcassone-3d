import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkImportBoundaries } from '../gates/imports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '../..');
const INTERACTIONS_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

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
 * Reads cumulative spend and call count from `tracePath` (`runs/orchestrator/trace.jsonl`)
 * so budget and call caps persist across processes.
 */
export function loadPersistentSpend(tracePath) {
  let totalCostUsd = 0;
  let totalCalls = 0;
  if (!tracePath || !fs.existsSync(tracePath)) {
    return { totalCostUsd: 0, totalCalls: 0 };
  }
  try {
    const raw = fs.readFileSync(tracePath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && entry.status === 'ok') {
          const c = Number(entry.costUsd || 0);
          if (Number.isFinite(c)) {
            totalCostUsd = Number((totalCostUsd + c).toFixed(6));
          }
          totalCalls += 1;
        }
      } catch {
        // Ignore malformed trace line
      }
    }
  } catch {
    // Ignore read error
  }
  return { totalCostUsd, totalCalls };
}

/**
 * Ensures `state` is initialized once from `tracePath` so cumulative spend holds across processes
 * without double-counting calls made within the same `state` object in the current process.
 */
export function ensurePersistentSpendState(state, tracePath) {
  const target = state || { totalCostUsd: 0, totalCalls: 0 };
  if (typeof target.totalCostUsd !== 'number' || Number.isNaN(target.totalCostUsd)) {
    target.totalCostUsd = 0;
  }
  if (typeof target.totalCalls !== 'number' || Number.isNaN(target.totalCalls)) {
    target.totalCalls = 0;
  }
  if (!target._loadedTracePaths) {
    Object.defineProperty(target, '_loadedTracePaths', {
      value: new Set(),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  if (tracePath && !target._loadedTracePaths.has(tracePath)) {
    const persisted = loadPersistentSpend(tracePath);
    target.totalCostUsd = Number((target.totalCostUsd + persisted.totalCostUsd).toFixed(6));
    target.totalCalls += persisted.totalCalls;
    target._loadedTracePaths.add(tracePath);
  }
  return target;
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

function sanitizeResponseSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$schema;
  delete clone.title;
  return clone;
}

function normalizeWireInput(input, defaultMediaResolution = 'high') {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (!item || typeof item !== 'object') return { type: 'text', text: String(item) };
      if (item.type === 'text') {
        return { type: 'text', text: String(item.text ?? '') };
      }
      if (item.type === 'image') {
        const res = item.resolution || item.media_resolution || item.mediaResolution || defaultMediaResolution;
        const out = {
          type: 'image',
          mime_type: item.mime_type || item.mimeType || 'image/png',
          ...(res ? { resolution: res } : {}),
        };
        if (item.data) out.data = item.data;
        if (item.uri) out.uri = item.uri;
        return out;
      }
      if (item.type === 'video') {
        const res = item.resolution || item.media_resolution || item.mediaResolution || defaultMediaResolution;
        const out = {
          type: 'video',
          mime_type: item.mime_type || item.mimeType || 'video/webm',
          ...(res ? { resolution: res } : {}),
        };
        if (item.uri) out.uri = item.uri;
        if (item.data) out.data = item.data;
        return out;
      }
      if (item.type === 'function_result') {
        return {
          type: 'function_result',
          call_id: item.call_id || item.callId || item.id,
          name: item.name,
          result: item.result ?? { ok: true },
        };
      }
      return item;
    });
  }
  return JSON.stringify(input);
}

function extractInteractionParts(interaction) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  const functionCalls = [];
  const textParts = [];

  for (const step of steps) {
    if (step.type === 'function_call') {
      functionCalls.push({
        id: step.id || `call_${functionCalls.length + 1}`,
        name: step.name,
        arguments: step.arguments || step.args || {},
      });
    } else if (step.type === 'model_output' && Array.isArray(step.content)) {
      for (const c of step.content) {
        if (c.type === 'text' && typeof c.text === 'string') {
          textParts.push(c.text);
        } else if (c.type === 'function_call') {
          functionCalls.push({
            id: c.id || `call_${functionCalls.length + 1}`,
            name: c.name,
            arguments: c.arguments || c.args || {},
          });
        }
      }
    }
  }

  if (Array.isArray(interaction?.functionCalls)) {
    for (const fc of interaction.functionCalls) {
      functionCalls.push({
        id: fc.id || `call_${functionCalls.length + 1}`,
        name: fc.name,
        arguments: fc.arguments || fc.args || {},
      });
    }
  }

  const combinedText =
    textParts.join('\n').trim() ||
    interaction?.output_text ||
    interaction?.text ||
    (interaction?.output ? JSON.stringify(interaction.output) : '');

  let parsed = null;
  if (combinedText) {
    try {
      const clean = combinedText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { files: [], notes: combinedText, board: [], text: combinedText };
    }
  } else if (functionCalls.length > 0) {
    parsed = { functionCalls };
  } else {
    parsed = { files: [], notes: '', board: [] };
  }

  if (parsed && typeof parsed === 'object' && functionCalls.length > 0) {
    parsed.functionCalls = functionCalls;
  }

  const usage = interaction?.usage || {};
  const inputTokens = Number(usage.total_input_tokens ?? usage.input_tokens ?? interaction?.inputTokens ?? 350);
  const outputTokens = Number(
    (usage.total_output_tokens ?? usage.output_tokens ?? interaction?.outputTokens ?? 220) +
      (usage.total_thought_tokens ?? 0)
  );

  return {
    interactionId: interaction?.id || interaction?.interactionId || `live_${Date.now()}`,
    inputTokens,
    outputTokens,
    output: parsed,
    functionCalls,
    text: combinedText,
    raw: interaction,
  };
}

export async function callModel({
  role,
  model = 'gemini-4-argon',
  thinking = 'medium',
  mediaResolution = undefined,
  media_resolution = undefined,
  input,
  tools = undefined,
  taskId = 'adhoc',
  background = false,
  pollTimeoutMs = 90_000,
  pollIntervalMs = 250,
  retryBackoffMs = 50,
  maxRetries = 3,
  maxOutputTokens = 65536,
  previousInteractionId = undefined,
  schema = undefined,
  rootDir = DEFAULT_ROOT,
  tracePath = path.join(rootDir, 'runs/orchestrator/trace.jsonl'),
  state = undefined,
  budgetUsd = Infinity,
  maxCalls = Infinity,
  fakeHandler = undefined,
  interactionsClient = undefined,
}) {
  const pricing = loadPricing(rootDir);
  const spendState = ensurePersistentSpendState(state, tracePath);
  const effectiveMediaResolution = mediaResolution || media_resolution || (thinking === 'high' ? 'high' : undefined);
  const effectiveBackground = Boolean(background || thinking === 'high');

  if (spendState.totalCalls + 1 > maxCalls || spendState.totalCostUsd >= budgetUsd) {
    const resumeCmd = `node scripts/smoke-orchestrator.mjs --resume --task ${taskId}`;
    const err = new Error(
      `Spend/call cap reached before task '${taskId}' (calls=${spendState.totalCalls}/${maxCalls}, cost=$${spendState.totalCostUsd.toFixed(4)}/$${budgetUsd}). Resume with: ${resumeCmd}`
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
      if (
        !interactionsClient &&
        (process.env.ORCH_FAKE === '1' || typeof fakeHandler === 'function')
      ) {
        const handler = fakeHandler || defaultFakeHandler;
        response = await runWithDeadline(
          () =>
            handler({
              role,
              model,
              thinking,
              mediaResolution: effectiveMediaResolution,
              media_resolution: effectiveMediaResolution,
              input,
              tools,
              taskId,
              background: effectiveBackground,
              pollTimeoutMs,
              maxOutputTokens,
              previousInteractionId,
              schema,
              attempt,
            }),
          pollTimeoutMs,
          `fake_${taskId}_${attempt}`
        );
      } else {
        response = await invokeLiveInteractionsApi({
          model,
          thinking,
          mediaResolution: effectiveMediaResolution,
          input,
          tools,
          background: effectiveBackground,
          pollTimeoutMs,
          pollIntervalMs,
          maxOutputTokens,
          previousInteractionId,
          schema,
          interactionsClient,
        });
      }

      const inputTokens = Number(response.inputTokens ?? 250);
      const outputTokens = Number(response.outputTokens ?? 180);
      const costUsd = computeCostUsd(model, inputTokens, outputTokens, pricing);

      if (spendState.totalCostUsd + costUsd > budgetUsd) {
        const resumeCmd = `node scripts/smoke-orchestrator.mjs --resume --task ${taskId}`;
        const err = new Error(
          `Budget cap ($${budgetUsd}) exceeded on task '${taskId}' (projected $${(spendState.totalCostUsd + costUsd).toFixed(4)}). Resume with: ${resumeCmd}`
        );
        err.code = 'SPEND_CAP_EXCEEDED';
        err.resumeCommand = resumeCmd;
        throw err;
      }

      spendState.totalCalls += 1;
      spendState.totalCostUsd = Number((spendState.totalCostUsd + costUsd).toFixed(6));

      const interactionId = response.interactionId || `int_${taskId}_${spendState.totalCalls}`;
      const functionCalls =
        response.functionCalls ||
        response.output?.functionCalls ||
        [];

      const traceEntry = {
        ts: new Date().toISOString(),
        taskId,
        role,
        model,
        thinking,
        ...(effectiveMediaResolution ? { mediaResolution: effectiveMediaResolution } : {}),
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
        functionCalls,
        text: response.text,
        interactionId,
        inputTokens,
        outputTokens,
        costUsd,
      };
    } catch (err) {
      if (err.code === 'SPEND_CAP_EXCEEDED') throw err;
      const status = err.status || err.statusCode;
      const retryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        err.code === 'DEADLINE_EXCEEDED' ||
        err.retryable === true;
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(retryBackoffMs * Math.pow(2, attempt));
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

async function runWithDeadline(fn, deadlineMs, label = 'call') {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return fn();
  }
  let timer = null;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Call '${label}' exceeded deadline of ${deadlineMs}ms`);
          err.code = 'DEADLINE_EXCEEDED';
          err.status = 504;
          err.retryable = true;
          reject(err);
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultFakeHandler({ taskId, role, previousInteractionId, tools }) {
  const hasFinishTool = Array.isArray(tools) && tools.some((t) => t.name === 'finish');
  if (hasFinishTool) {
    return {
      interactionId: `fake_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      inputTokens: 400,
      outputTokens: 200,
      functionCalls: [
        {
          id: 'call_finish_1',
          name: 'finish',
          arguments: {
            report: {
              summary: `Completed fake patcher turn for ${taskId}`,
              addressed: [],
              skipped: [],
            },
          },
        },
      ],
      output: {
        summary: `Completed fake patcher turn for ${taskId}`,
        addressed: [],
        skipped: [],
      },
    };
  }
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

function createRestInteractionsClient(apiKey) {
  return {
    async create(payload, timeoutMs = 90_000) {
      const res = await fetch(`${INTERACTIONS_BASE_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawText: text };
      }
      if (!res.ok) {
        const err = new Error(
          `Interactions API create failed (${res.status}): ${data?.error?.message || text.slice(0, 300)}`
        );
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return data;
    },
    async get(id, timeoutMs = 30_000) {
      const res = await fetch(
        `${INTERACTIONS_BASE_URL}/${encodeURIComponent(id)}?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'GET',
          signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
        }
      );
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawText: text };
      }
      if (!res.ok) {
        const err = new Error(
          `Interactions API get(${id}) failed (${res.status}): ${data?.error?.message || text.slice(0, 300)}`
        );
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return data;
    },
    async cancel(id) {
      try {
        const res = await fetch(
          `${INTERACTIONS_BASE_URL}/${encodeURIComponent(id)}/cancel?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(10_000),
          }
        );
        return await res.json().catch(() => ({ id, status: 'cancelled' }));
      } catch {
        return { id, status: 'cancelled' };
      }
    },
  };
}

async function invokeLiveInteractionsApi({
  model,
  thinking,
  mediaResolution = 'high',
  input,
  tools,
  background,
  pollTimeoutMs = 90_000,
  pollIntervalMs = 250,
  previousInteractionId,
  schema,
  interactionsClient,
}) {
  let client = interactionsClient;
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY / GOOGLE_API_KEY for live model call');
    }
    client = createRestInteractionsClient(apiKey);
  }

  const wireInput = normalizeWireInput(input, mediaResolution);
  const cleanSchema = sanitizeResponseSchema(schema);
  const wireTools = Array.isArray(tools)
    ? tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: sanitizeResponseSchema(t.parameters) || { type: 'object', properties: {} },
      }))
    : undefined;

  const requestPayload = {
    model,
    input: wireInput,
    ...(background ? { background: true } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    ...(wireTools && wireTools.length > 0 ? { tools: wireTools } : {}),
    ...(cleanSchema ? { response_format: cleanSchema } : {}),
    generation_config: {
      thinking_level: thinking || 'high',
    },
  };

  const deadlineAt = Date.now() + pollTimeoutMs;
  let interaction = await runWithDeadline(
    () => client.create(requestPayload, pollTimeoutMs),
    pollTimeoutMs,
    `interactions.create(${model})`
  );

  let backoff = pollIntervalMs;
  while (
    background &&
    interaction &&
    (interaction.status === 'in_progress' ||
      interaction.status === 'Running' ||
      interaction.status === 'processing')
  ) {
    const now = Date.now();
    const remaining = deadlineAt - now;
    if (remaining <= 0) {
      if (typeof client.cancel === 'function' && interaction.id) {
        await client.cancel(interaction.id);
      }
      const err = new Error(
        `Interaction '${interaction.id}' exceeded pollTimeoutMs (${pollTimeoutMs}ms) and was cancelled`
      );
      err.code = 'DEADLINE_EXCEEDED';
      err.status = 504;
      err.retryable = true;
      err.cancelledInteractionId = interaction.id;
      throw err;
    }

    const waitMs = Math.min(backoff, remaining);
    await sleep(waitMs);
    backoff = Math.min(backoff * 2, 4000);

    if (Date.now() >= deadlineAt) {
      if (typeof client.cancel === 'function' && interaction.id) {
        await client.cancel(interaction.id);
      }
      const err = new Error(
        `Interaction '${interaction.id}' exceeded pollTimeoutMs (${pollTimeoutMs}ms) and was cancelled`
      );
      err.code = 'DEADLINE_EXCEEDED';
      err.status = 504;
      err.retryable = true;
      err.cancelledInteractionId = interaction.id;
      throw err;
    }

    interaction = await runWithDeadline(
      () => client.get(interaction.id, Math.max(500, deadlineAt - Date.now())),
      Math.max(50, deadlineAt - Date.now()),
      `interactions.get(${interaction.id})`
    );
  }

  if (interaction?.status === 'failed' || interaction?.status === 'cancelled') {
    const err = new Error(
      `Interaction '${interaction.id}' ended with status '${interaction.status}': ${JSON.stringify(interaction.error || {})}`
    );
    err.status = 500;
    err.retryable = true;
    throw err;
  }

  return extractInteractionParts(interaction);
}

/**
 * Uploads a video or media file via the Gemini Files API and polls until `state === 'ACTIVE'`.
 * Under `ORCH_FAKE=1`, returns a deterministic fake URI without network access.
 */
export async function uploadMediaFile(filePath, mimeType = 'video/webm', pollTimeoutMs = 90_000) {
  if (process.env.ORCH_FAKE === '1') {
    return {
      name: `files/fake_${path.basename(filePath).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      uri: `https://generativelanguage.googleapis.com/v1beta/files/fake_${path.basename(filePath)}`,
      mimeType,
      state: 'ACTIVE',
    };
  }
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY for Files API upload');
  }
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const deadline = Date.now() + pollTimeoutMs;
  let fileObj = await ai.files.upload({ file: filePath, mimeType });
  let backoff = 500;
  while (fileObj && (fileObj.state === 'PROCESSING' || fileObj.state === 'STATE_UNSPECIFIED')) {
    if (Date.now() >= deadline) {
      throw new Error(`Files API upload timed out waiting for ACTIVE state on ${filePath}`);
    }
    await sleep(Math.min(backoff, Math.max(100, deadline - Date.now())));
    backoff = Math.min(backoff * 1.5, 3000);
    fileObj = await ai.files.get({ name: fileObj.name });
  }
  if (!fileObj || fileObj.state !== 'ACTIVE') {
    throw new Error(`Files API upload failed for ${filePath}: state=${fileObj?.state}`);
  }
  return fileObj;
}

/**
 * Multi-turn function-calling tool loop on the Interactions API (§0.3).
 * Sends tool declarations, executes each returned function call through the caller's handler,
 * returns the `function_result` (plus any media attachments), and repeats until the model calls
 * `finish` or `maxToolCalls` / `deadlineMs` is reached. Every turn is traced and metered.
 */
function capToolResult(result, maxChars) {
  if (!result || typeof result !== 'object') return result;
  if (JSON.stringify(result).length <= maxChars) return result;
  const capped = { ...result, truncated: true };
  // Logs keep their tail (where errors are); everything else keeps its head.
  const tailKeys = new Set(['output', 'log', 'stdout', 'stderr', 'error']);
  const stringKeys = Object.keys(capped)
    .filter((k) => typeof capped[k] === 'string')
    .sort((a, b) => capped[b].length - capped[a].length);
  for (const k of stringKeys) {
    if (JSON.stringify(capped).length <= maxChars) break;
    const keep = Math.max(500, capped[k].length - (JSON.stringify(capped).length - maxChars) - 100);
    capped[k] = tailKeys.has(k) ? `…${capped[k].slice(-keep)}` : `${capped[k].slice(0, keep)}…`;
  }
  if (JSON.stringify(capped).length <= maxChars) return capped;
  return { ok: result.ok, truncated: true, preview: JSON.stringify(result).slice(0, maxChars) };
}

function summarizeToolCall(entry) {
  const args = JSON.stringify(entry.arguments || {}).slice(0, 100);
  const r = entry.result || {};
  let outcome;
  if (r.ok === false) outcome = `error: ${String(r.error || '').slice(0, 100)}`;
  else if (entry.name === 'read_file') outcome = `lines ${r.startLine}-${r.endLine} of ${r.totalLines}`;
  else if (entry.name === 'search') outcome = `${(r.matches || []).length} matches`;
  else if (entry.name === 'run') outcome = `exit ${r.exitCode ?? r.code ?? '?'}`;
  else outcome = 'ok';
  return `${entry.name}(${args}) -> ${outcome}`;
}

function buildRolloverInput({ input, history, latestInputs, toolCallsUsed, maxToolCalls }) {
  const taskParts = Array.isArray(input) ? input : [{ type: 'text', text: String(input) }];
  const changed = [
    ...new Set(
      history
        .filter((h) => ['write_file', 'edit_file'].includes(h.name) && h.result?.ok !== false)
        .map((h) => h.arguments?.path)
        .filter(Boolean)
    ),
  ];
  const progress = [
    'CONTEXT RESET: your earlier conversation was dropped to save quota. The original task is above; your progress so far is below.',
    `Tool calls used: ${toolCallsUsed} of ${maxToolCalls}.`,
    `Files you have changed (already saved in the worktree): ${changed.length ? changed.join(', ') : 'none yet'}.`,
    'Every tool call so far, oldest first:',
    ...history.map((h, i) => `${i + 1}. ${summarizeToolCall(h)}`),
    'File contents you read earlier are no longer in context; re-read only the line ranges you need. The results of your most recent calls follow.',
  ].join('\n');
  const latest = latestInputs.map((part) =>
    part.type === 'function_result'
      ? { type: 'text', text: `[Result of ${part.name}]: ${JSON.stringify(part.result)}` }
      : part
  );
  return [...taskParts, { type: 'text', text: progress }, ...latest];
}

export async function runToolLoop({
  role = 'patcher',
  model = 'gemini-4-argon',
  thinking = 'high',
  mediaResolution = 'high',
  tools = [],
  toolHandlers = {},
  input,
  taskId = 'tool_loop',
  maxToolCalls = 60,
  deadlineMs = 1_200_000,
  pollTimeoutMs = 90_000,
  previousInteractionId = undefined,
  rootDir = DEFAULT_ROOT,
  tracePath = path.join(rootDir, 'runs/orchestrator/trace.jsonl'),
  state = undefined,
  budgetUsd = Infinity,
  maxCalls = Infinity,
  fakeToolTurns = undefined,
  fakeHandler = undefined,
  interactionsClient = undefined,
  contextTokenBudget = 60_000,
  maxToolResultChars = 8_000,
}) {
  const spendState = ensurePersistentSpendState(state, tracePath);
  const startMs = Date.now();
  const loopDeadline = startMs + deadlineMs;

  const toolMap = new Map();
  for (const t of tools) {
    toolMap.set(t.name, t);
  }

  const scriptedTurns =
    fakeToolTurns ||
    (Array.isArray(globalThis.__ORCH_FAKE_TOOL_TURNS) ? globalThis.__ORCH_FAKE_TOOL_TURNS : null);

  let turnIndex = 0;
  let toolCallsUsed = 0;
  let prevId = previousInteractionId;
  let currentInput = input;
  let finished = false;
  let finishReport = null;
  const history = [];
  let rollovers = 0;

  while (!finished && toolCallsUsed < maxToolCalls && Date.now() < loopDeadline) {
    const remainingMs = loopDeadline - Date.now();
    if (remainingMs <= 0) break;

    const turnTaskId = `${taskId}:turn-${turnIndex}`;
    const turnFakeHandler =
      scriptedTurns && !fakeHandler
        ? async ({ previousInteractionId: pId }) => {
            const scriptedCalls = scriptedTurns[turnIndex] || [
              {
                id: `call_finish_auto_${turnIndex}`,
                name: 'finish',
                arguments: {
                  report: {
                    summary: 'Finished scripted sequence',
                    addressed: [],
                    skipped: [],
                  },
                },
              },
            ];
            return {
              interactionId: `fake_tool_${taskId}_${turnIndex}_${pId ? 'cont' : 'init'}`,
              inputTokens: 450,
              outputTokens: 160,
              functionCalls: scriptedCalls.map((c, idx) => ({
                id: c.id || `call_${turnIndex}_${idx + 1}`,
                name: c.name,
                arguments: c.arguments || c.args || {},
              })),
              output: { functionCalls: scriptedCalls },
            };
          }
        : fakeHandler;

    const callRes = await callModel({
      role,
      model,
      thinking,
      mediaResolution,
      media_resolution: mediaResolution,
      input: currentInput,
      tools,
      taskId: turnTaskId,
      background: true,
      pollTimeoutMs: Math.min(pollTimeoutMs, remainingMs),
      previousInteractionId: prevId,
      rootDir,
      tracePath,
      state: spendState,
      budgetUsd,
      maxCalls,
      fakeHandler: turnFakeHandler,
      interactionsClient,
    });

    prevId = callRes.interactionId;
    turnIndex += 1;

    const functionCalls =
      Array.isArray(callRes.functionCalls) && callRes.functionCalls.length > 0
        ? callRes.functionCalls
        : Array.isArray(callRes.output?.functionCalls)
          ? callRes.output.functionCalls
          : [];

    if (functionCalls.length === 0) {
      if (callRes.output && (callRes.output.summary || callRes.output.addressed)) {
        finishReport = callRes.output;
        finished = true;
      }
      break;
    }

    const nextTurnInputs = [];

    for (const fc of functionCalls) {
      if (toolCallsUsed >= maxToolCalls || Date.now() >= loopDeadline) {
        break;
      }
      toolCallsUsed += 1;
      const callId = fc.id || `call_${turnIndex}_${toolCallsUsed}`;
      const args = fc.arguments || fc.args || {};
      const toolSpec = toolMap.get(fc.name);
      const handler = toolSpec?.handler || toolHandlers?.[fc.name];

      if (process.env.ORCH_FAKE !== '1') {
        const argPreview = JSON.stringify(args).slice(0, 140);
        console.error(`  [tool:${taskId}] #${toolCallsUsed} ${fc.name}(${argPreview})`);
      }

      let rawResult;
      try {
        if (typeof handler === 'function') {
          rawResult = await handler(args, { id: callId, name: fc.name, turn: turnIndex, toolCallsUsed });
        } else {
          rawResult = { ok: false, error: `Unknown tool '${fc.name}'` };
        }
      } catch (toolErr) {
        rawResult = { ok: false, error: toolErr.message || String(toolErr) };
      }

      const mediaParts =
        rawResult && typeof rawResult === 'object'
          ? rawResult.__mediaParts || rawResult.mediaParts || []
          : [];

      let cleanResult = rawResult;
      if (rawResult && typeof rawResult === 'object' && ('__mediaParts' in rawResult || 'mediaParts' in rawResult)) {
        const { __mediaParts, mediaParts: _mp, ...rest } = rawResult;
        cleanResult = rest;
      }
      cleanResult = capToolResult(cleanResult, maxToolResultChars);

      history.push({
        id: callId,
        name: fc.name,
        arguments: args,
        result: cleanResult,
        interactionId: prevId,
      });

      nextTurnInputs.push({
        type: 'function_result',
        call_id: callId,
        name: fc.name,
        result: cleanResult ?? { ok: true },
      });

      if (Array.isArray(mediaParts) && mediaParts.length > 0) {
        for (const mp of mediaParts) {
          nextTurnInputs.push(mp);
        }
      }

      if (fc.name === 'finish' && cleanResult?.ok !== false) {
        finished = true;
        finishReport = cleanResult?.report || args?.report || args || cleanResult;
        break;
      }
    }

    currentInput = nextTurnInputs;

    // Every turn re-sends the whole server-side conversation, so once it passes the budget,
    // start a fresh interaction holding the task, a one-line log of past calls and only the
    // latest results.
    if (!finished && Number(callRes.inputTokens) > contextTokenBudget) {
      rollovers += 1;
      if (process.env.ORCH_FAKE !== '1') {
        console.error(`  [tool:${taskId}] context ${callRes.inputTokens} tokens > ${contextTokenBudget}; rolling over (#${rollovers})`);
      }
      currentInput = buildRolloverInput({ input, history, latestInputs: nextTurnInputs, toolCallsUsed, maxToolCalls });
      prevId = undefined;
    }
  }

  return {
    finished,
    report: finishReport || {
      summary: finished ? 'Completed patcher turn' : 'Stopped at tool-call or deadline cap',
      addressed: [],
      skipped: [],
    },
    toolCallsUsed,
    turns: turnIndex,
    rollovers,
    history,
    lastInteractionId: prevId,
    state: spendState,
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

  const state = ensurePersistentSpendState(options.state, tracePath);
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

/**
 * Worktree helpers for the Visual Feedback Loop (Prompt 2 §4.1 & §4.6).
 */
export function createLoopWorktree(rootDir, runId, baseBranch = 'main') {
  const safeId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const branchName = `loop/${safeId}`;
  const wtDir = path.join(rootDir, 'wt', `loop-${safeId}`);

  try {
    execSync(`git show-ref --verify --quiet refs/heads/${baseBranch}`, { cwd: rootDir, stdio: 'pipe' });
  } catch {
    execSync(`git branch ${baseBranch} HEAD`, { cwd: rootDir, stdio: 'pipe' });
  }

  try {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: rootDir, stdio: 'pipe' });
  } catch {
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
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
  return { workDir: wtDir, branchName, startCommit };
}

export function removeLoopWorktree(rootDir, wtDir, branchName, deleteBranch = false) {
  try {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: rootDir, stdio: 'pipe' });
  } catch {
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
  try {
    execSync('git worktree prune', { cwd: rootDir, stdio: 'pipe' });
  } catch {
    // ignore
  }
  if (deleteBranch && branchName) {
    try {
      execSync(`git branch -D "${branchName}"`, { cwd: rootDir, stdio: 'pipe' });
    } catch {
      // ignore
    }
  }
}

export function mergeLoopWorktree(rootDir, wtDir, runId, baseBranch = 'main') {
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
