import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runToolLoop } from '../lib/orchestrator.mjs';
import { checkImportBoundaries } from '../gates/imports.mjs';
import { captureShot, startDevServer, launchHardwareBrowser, captureGameplayScriptOnPage } from './capture.mjs';
import { createSpikeFilmstrip as makeFilmstrip } from './judge.mjs';

export function getBaselineTestFiles(workDir, startCommit) {
  try {
    const out = execSync(`git ls-tree -r --name-only ${startCommit} tests/`, {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return new Set();
    return new Set(
      out
        .split('\n')
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function matchesPrefixOrFile(rule, relPath) {
  const cleanRule = String(rule).replace(/\\/g, '/');
  if (cleanRule.endsWith('/')) {
    return relPath.startsWith(cleanRule) || relPath === cleanRule.slice(0, -1);
  }
  return relPath === cleanRule || relPath.startsWith(cleanRule + '/');
}

/**
 * Validates whether `targetPath` is writable by the patcher inside `workDir`
 * per Hard Rule 1 (`protectedPaths` + baseline tests) and Hard Rule 11 (`outOfScopePaths`).
 */
export function validatePatcherWritePath(
  workDir,
  targetPath,
  config,
  baselineTestFiles = new Set()
) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { ok: false, reason: 'Empty file path' };
  }
  if (path.isAbsolute(targetPath)) {
    const relFromAbs = path.relative(workDir, targetPath).replace(/\\/g, '/');
    if (relFromAbs.startsWith('..') || path.isAbsolute(relFromAbs)) {
      return { ok: false, reason: `Path outside worktree rejected: ${targetPath}` };
    }
  }

  const resolved = path.resolve(workDir, targetPath);
  const rel = path.relative(workDir, resolved).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || rel.includes('/../') || path.isAbsolute(rel)) {
    return { ok: false, reason: `Path outside worktree rejected: ${targetPath}` };
  }

  for (const prot of config.protectedPaths || []) {
    if (matchesPrefixOrFile(prot, rel)) {
      return { ok: false, reason: `Write to protected path '${rel}' (matches '${prot}') refused` };
    }
  }

  for (const oos of config.outOfScopePaths || []) {
    if (matchesPrefixOrFile(oos, rel)) {
      return { ok: false, reason: `Write to outOfScopePath '${rel}' (matches '${oos}') refused` };
    }
  }

  if (baselineTestFiles.has(rel)) {
    return { ok: false, reason: `Write to baseline test '${rel}' refused` };
  }

  const regDir = (config.regressionTestDir || 'tests/regressions/').replace(/\\/g, '/');
  if (rel.startsWith('tests/') && !matchesPrefixOrFile(regDir, rel)) {
    return {
      ok: false,
      reason: `Writes under tests/ are only permitted inside regressionTestDir '${regDir}' (attempted '${rel}')`,
    };
  }

  return { ok: true, normalizedPath: rel, absPath: resolved };
}

/**
 * Runs `git diff --name-status <startCommit>` and `git status --porcelain` in `workDir`
 * to verify no protected path, out-of-scope path, or baseline test was modified (Hard Rules 1 & 11).
 */
export function checkWorktreeDiffSafety(
  workDir,
  startCommit,
  config,
  baselineTestFiles = new Set()
) {
  const touched = new Set();
  try {
    const diffOut = execSync(`git diff --name-status ${startCommit}`, {
      cwd: workDir,
      encoding: 'utf8',
    }).trim();
    for (const line of diffOut.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      for (const p of parts.slice(1)) {
        touched.add(p.replace(/\\/g, '/'));
      }
    }
  } catch {
    // ignore
  }

  try {
    const statusOut = execSync('git status --porcelain', {
      cwd: workDir,
      encoding: 'utf8',
    }).trim();
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue;
      const filePart = line.slice(3).trim();
      if (filePart.includes(' -> ')) {
        for (const sub of filePart.split(' -> ')) {
          touched.add(sub.trim().replace(/\\/g, '/'));
        }
      } else if (filePart) {
        touched.add(filePart.replace(/\\/g, '/'));
      }
    }
  } catch {
    // ignore
  }

  const violations = [];
  for (const rel of touched) {
    if (rel.startsWith('runs/') || rel.startsWith('wt/') || rel === 'node_modules') continue;
    const check = validatePatcherWritePath(workDir, rel, config, baselineTestFiles);
    if (!check.ok) {
      violations.push({ file: rel, reason: check.reason });
    }
  }

  return {
    ok: violations.length === 0,
    touchedFiles: Array.from(touched),
    violations,
  };
}

/**
 * Builds a concise file outline of `src/` (path, exported symbols, line counts) (§3.3).
 */
export function buildSrcOutline(workDir) {
  const srcDir = path.join(workDir, 'src');
  if (!fs.existsSync(srcDir)) return 'src/ directory not found';

  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|css)$/.test(entry.name)) {
        const rel = path.relative(workDir, full).replace(/\\/g, '/');
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        const lineCount = lines.length;
        const exports = [];
        const regex = /export\s+(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z0-9_]+)/g;
        let m;
        while ((m = regex.exec(content)) !== null) {
          exports.push(m[1]);
        }
        const symbols = [];
        lines.forEach((line, idx) => {
          const fm = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
          if (fm) {
            symbols.push(`${fm[1]}@L${idx + 1}`);
          } else {
            const mm = /^\s{4}(?:async\s+)?(syncState|setView|getView|renderAt|playAt|botMove|showLegalMoves|startDemo|captureShot|audit|loadFixture|startOrbitFlythrough)\s*\(/.exec(
              line
            );
            if (mm) symbols.push(`${mm[1]}@L${idx + 1}`);
          }
        });
        entries.push(
          `- ${rel} (${lineCount} lines)${exports.length > 0 ? `: exports [${exports.join(', ')}]` : ''}${symbols.length > 0 ? ` | fns: ${symbols.slice(0, 28).join(', ')}` : ''}`
        );
      }
    }
  };
  walk(srcDir);
  return entries.join('\n');
}

/**
 * Creates the tool definitions and handlers for the patcher's `runToolLoop` (§3.2).
 */
export function createPatcherTools(workDir, config, baselineTestFiles = new Set(), options = {}) {
  const resolveReadPath = (relPath) => {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new Error('Empty path');
    }
    const resolved = path.resolve(workDir, relPath);
    const rel = path.relative(workDir, resolved).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path outside worktree refused: ${relPath}`);
    }
    return { resolved, rel };
  };

  return [
    {
      name: 'list_files',
      description: 'List files inside a directory in the worktree.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Relative directory path (default ".")' },
        },
      },
      handler: async ({ dir = '.' } = {}) => {
        const { resolved } = resolveReadPath(dir);
        if (!fs.existsSync(resolved)) {
          return { ok: false, error: `Directory not found: ${dir}` };
        }
        const results = [];
        const walk = (d) => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'runs', 'wt'].includes(entry.name)) continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else {
              results.push(path.relative(workDir, full).replace(/\\/g, '/'));
            }
          }
        };
        if (fs.statSync(resolved).isDirectory()) {
          walk(resolved);
        } else {
          results.push(path.relative(workDir, resolved).replace(/\\/g, '/'));
        }
        return { ok: true, files: results };
      },
    },
    {
      name: 'read_file',
      description: 'Read numbered lines from a file inside the worktree.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        },
      },
      handler: async ({ path: filePath, startLine = 1, endLine = undefined } = {}) => {
        const { resolved, rel } = resolveReadPath(filePath);
        if (!fs.existsSync(resolved)) {
          return { ok: false, error: `File not found: ${rel}` };
        }
        const lines = fs.readFileSync(resolved, 'utf8').split('\n');
        const start = Math.max(1, Number(startLine || 1));
        const end = Math.min(lines.length, Number(endLine || Math.min(lines.length, start + 350)));
        const numbered = lines
          .slice(start - 1, end)
          .map((line, i) => `${start + i}: ${line}`)
          .join('\n');
        return {
          ok: true,
          path: rel,
          totalLines: lines.length,
          startLine: start,
          endLine: end,
          content: numbered,
        };
      },
    },
    {
      name: 'search',
      description: 'Search for a pattern across files in the worktree.',
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string' },
          dir: { type: 'string' },
        },
      },
      handler: async ({ pattern, dir = 'src' } = {}) => {
        const { resolved } = resolveReadPath(dir);
        if (!fs.existsSync(resolved)) {
          return { ok: false, error: `Directory not found: ${dir}` };
        }
        let regex;
        try {
          regex = new RegExp(pattern);
        } catch {
          regex = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        }
        const matches = [];
        const walk = (d) => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'runs', 'wt'].includes(entry.name)) continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (/\.(ts|tsx|js|mjs|json|css|html)$/.test(entry.name)) {
              const rel = path.relative(workDir, full).replace(/\\/g, '/');
              const lines = fs.readFileSync(full, 'utf8').split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 200) });
                  if (matches.length >= 80) return;
                }
              }
            }
          }
        };
        if (fs.statSync(resolved).isDirectory()) {
          walk(resolved);
        }
        return { ok: true, matches };
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file in the worktree (refuses protected paths, outOfScopePaths, and baseline tests).',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
      handler: async ({ path: targetPath, content } = {}) => {
        const check = validatePatcherWritePath(workDir, targetPath, config, baselineTestFiles);
        if (!check.ok) {
          return { ok: false, error: check.reason };
        }
        fs.mkdirSync(path.dirname(check.absPath), { recursive: true });
        fs.writeFileSync(check.absPath, String(content ?? ''), 'utf8');
        return { ok: true, path: check.normalizedPath };
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string in a file. Search must match exactly once; on 0 or 2+ matches returns matching line numbers.',
      parameters: {
        type: 'object',
        required: ['path', 'search', 'replace'],
        properties: {
          path: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
        },
      },
      handler: async ({ path: targetPath, search, replace } = {}) => {
        const check = validatePatcherWritePath(workDir, targetPath, config, baselineTestFiles);
        if (!check.ok) {
          return { ok: false, error: check.reason };
        }
        if (!fs.existsSync(check.absPath)) {
          return { ok: false, error: `File does not exist: ${check.normalizedPath}` };
        }
        const raw = fs.readFileSync(check.absPath, 'utf8');
        if (!search) {
          return { ok: false, error: 'search string must not be empty', matchingLines: [] };
        }

        const matchPositions = [];
        let pos = 0;
        while (true) {
          const idx = raw.indexOf(search, pos);
          if (idx === -1) break;
          matchPositions.push(idx);
          pos = idx + Math.max(1, search.length);
        }

        if (matchPositions.length !== 1) {
          const matchingLines = matchPositions.map((offset) => {
            return raw.slice(0, offset).split('\n').length;
          });
          if (matchingLines.length === 0) {
            const firstLine = search.split('\n').map((l) => l.trim()).find(Boolean);
            if (firstLine) {
              const allLines = raw.split('\n');
              allLines.forEach((l, i) => {
                if (l.includes(firstLine)) matchingLines.push(i + 1);
              });
            }
          }
          return {
            ok: false,
            error:
              matchPositions.length === 0
                ? `search string did not match in ${check.normalizedPath}`
                : `search string matched ${matchPositions.length} times in ${check.normalizedPath} (must match exactly once)`,
            matchCount: matchPositions.length,
            matchingLines,
          };
        }

        const updated =
          raw.slice(0, matchPositions[0]) +
          String(replace ?? '') +
          raw.slice(matchPositions[0] + search.length);
        fs.writeFileSync(check.absPath, updated, 'utf8');
        const editedLine = raw.slice(0, matchPositions[0]).split('\n').length;
        return { ok: true, path: check.normalizedPath, line: editedLine };
      },
    },
    {
      name: 'run',
      description: 'Run an acceptance command ("npm run build", "npm test") or "npx vitest run <path>".',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
        },
      },
      handler: async ({ command } = {}) => {
        const cmd = String(command || '').trim();
        const allowedAcceptance = config.acceptance || ['npm run build', 'npm test'];
        const isVitestPath = /^npx\s+vitest\s+run(\s+[A-Za-z0-9_./-]+)?$/.test(cmd);
        if (!allowedAcceptance.includes(cmd) && !isVitestPath) {
          return {
            ok: false,
            exitCode: 1,
            error: `Command '${cmd}' refused. Allowed: ${allowedAcceptance.join(', ')} or 'npx vitest run <path>'`,
          };
        }
        try {
          const out = execSync(cmd, {
            cwd: workDir,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 120_000,
          });
          return {
            ok: true,
            exitCode: 0,
            output: String(out || '').slice(-3000),
          };
        } catch (err) {
          const combined = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
          return {
            ok: false,
            exitCode: err.status || 1,
            output: combined.slice(-3000),
          };
        }
      },
    },
    {
      name: 'preview',
      description: 'Render and return a shot (shotId), timeline frame ({t}), or gameplay frame ({script, view, t}) as an image. For fidelity shots, also attaches the reference.',
      parameters: {
        type: 'object',
        properties: {
          shotId: { type: 'string' },
          t: { type: 'number' },
          script: { type: 'string' },
          view: { type: 'string' },
          reference: { type: 'string' },
        },
      },
      handler: async (args = {}) => {
        const target = args.script
          ? { script: args.script, view: args.view || '2d', t: args.t ?? 2.0 }
          : typeof args.t === 'number' && !args.shotId
            ? { t: args.t }
            : args.shotId || 'terrace-overview';

        const shotRes = await captureShot(workDir, target, {
          config,
          server: options.server,
          outDir: path.join(workDir, 'runs', 'preview'),
        });

        const mediaParts = [];
        if (shotRes?.path && fs.existsSync(shotRes.path)) {
          const b64 = fs.readFileSync(shotRes.path).toString('base64');
          mediaParts.push({
            type: 'text',
            text: `[Image 1: preview of ${JSON.stringify(target)}]`,
          });
          mediaParts.push({
            type: 'image',
            data: b64,
            mime_type: 'image/png',
            media_resolution: 'high',
            resolution: 'high',
          });
        }

        const refRel =
          args.reference ||
          (args.shotId === 'tileSheet'
            ? 'public/reference/carcassonne-layout.jpg'
            : (config.references || [])[0]);
        if (refRel) {
          const refAbs = path.resolve(workDir, refRel);
          if (fs.existsSync(refAbs)) {
            mediaParts.push({
              type: 'text',
              text: `[Image 2: reference ${path.basename(refRel)}]`,
            });
            mediaParts.push({
              type: 'image',
              data: fs.readFileSync(refAbs).toString('base64'),
              mime_type: 'image/png',
              media_resolution: 'high',
              resolution: 'high',
            });
          }
        }

        return {
          ok: true,
          path: shotRes?.path,
          fullPage: shotRes?.fullPage,
          __mediaParts: mediaParts,
        };
      },
    },
    {
      name: 'run_script',
      description: 'Play one gameplay script headlessly in a view and return its stepErrors, per-step audit, and a filmstrip.',
      parameters: {
        type: 'object',
        required: ['script', 'view'],
        properties: {
          script: { type: 'string' },
          view: { type: 'string' },
        },
      },
      handler: async ({ script: scriptId, view = '2d' } = {}) => {
        const scriptSpec = (config.gameplay?.scripts || []).find((s) => s.id === scriptId);
        if (!scriptSpec) {
          return { ok: false, error: `Unknown gameplay script '${scriptId}'` };
        }
        const server = options.server || (await startDevServer(workDir, config));
        const { browser, context } = await launchHardwareBrowser(config, options);
        const tmpOutDir = path.join(workDir, 'runs', 'preview', `script-${scriptId}-${view}`);
        try {
          const res = await captureGameplayScriptOnPage(
            context,
            config,
            scriptSpec,
            view,
            tmpOutDir,
            { url: server.url }
          );
          const mediaParts = [];
          if (res.framePaths && res.framePaths.length > 0) {
            const midIdx = Math.floor(res.framePaths.length / 2);
            const strip = await makeFilmstrip(
              res.framePaths,
              midIdx,
              res.fps || 12,
              path.join(tmpOutDir, 'filmstrip.png')
            );
            if (strip?.base64) {
              mediaParts.push({
                type: 'text',
                text: `[Image 1: filmstrip of gameplay script '${scriptId}' in view '${view}']`,
              });
              mediaParts.push({
                type: 'image',
                data: strip.base64,
                mime_type: 'image/png',
                media_resolution: 'high',
                resolution: 'high',
              });
            }
          }
          return {
            ok: res.stepErrors.length === 0,
            stepErrors: res.stepErrors,
            stepAudits: res.stepAudits,
            frameDiffSpikes: res.frameDiffSpikes,
            blankFrames: res.blankFrames,
            __mediaParts: mediaParts,
          };
        } finally {
          await browser.close();
          if (!options.server) {
            await server.stop();
          }
        }
      },
    },
    {
      name: 'finish',
      description: 'End the patcher turn with a report matching schemas/patch-report.schema.json.',
      parameters: {
        type: 'object',
        required: ['summary', 'addressed'],
        properties: {
          summary: { type: 'string' },
          addressed: {
            type: 'array',
            items: {
              type: 'object',
              required: ['defectId', 'files', 'change', 'verified'],
              properties: {
                defectId: { type: 'string' },
                files: { type: 'array', items: { type: 'string' } },
                change: { type: 'string' },
                verified: { enum: ['regression-test', 'preview', 'both', 'unverified'] },
                tests: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              required: ['defectId', 'reason'],
              properties: {
                defectId: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
          report: { type: 'object' },
        },
      },
      handler: async (args = {}) => {
        const rep = args.report || {
          summary: args.summary || 'Completed patcher turn',
          addressed: args.addressed || [],
          skipped: args.skipped || [],
        };
        return { ok: true, report: rep };
      },
    },
  ];
}

/**
 * Runs a full patcher iteration inside `workDir` (§3.1 - §3.6).
 */
export async function runPatcherIteration({
  workDir,
  iterNum,
  startCommit,
  openDefects = [],
  captureManifest = null,
  config,
  triedLedger = [],
  defectFailureCounts = new Map(),
  escalationPlan = null,
  notes = null,
  isBootstrap = false,
  options = {},
}) {
  const baselineTestFiles = options.baselineTestFiles || getBaselineTestFiles(workDir, startCommit);
  const iterStartCommit = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf8' }).trim();

  // Sort open defects highest-severity first (high -> medium -> low)
  const sevRank = { high: 0, medium: 1, low: 2 };
  const sortedDefects = [...openDefects]
    .filter((d) => !d.reportOnly)
    .sort((a, b) => (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1));

  // Build multimodal input parts (§3.3)
  const inputParts = [];
  let imgCounter = 0;

  // Attach current images of targeted shots and matching references for fidelity gaps
  const attachedShots = new Set();
  const attachedRefs = new Set();

  for (const def of sortedDefects.slice(0, 8)) {
    const shotName = def.shot;
    if (shotName && !attachedShots.has(shotName)) {
      const shotPath = captureManifest?.shotPaths?.[shotName];
      if (shotPath && fs.existsSync(shotPath)) {
        attachedShots.add(shotName);
        imgCounter++;
        inputParts.push({ type: 'text', text: `[Image ${imgCounter}: current shot ${shotName}]` });
        inputParts.push({
          type: 'image',
          data: fs.readFileSync(shotPath).toString('base64'),
          mime_type: 'image/png',
          media_resolution: 'high',
          resolution: 'high',
        });
      }
    }
    for (const refRel of def.references || []) {
      if (!attachedRefs.has(refRel)) {
        const refAbs = path.resolve(workDir, refRel);
        if (fs.existsSync(refAbs)) {
          attachedRefs.add(refRel);
          imgCounter++;
          inputParts.push({
            type: 'text',
            text: `[Image ${imgCounter}: reference ${path.basename(refRel)}]`,
          });
          inputParts.push({
            type: 'image',
            data: fs.readFileSync(refAbs).toString('base64'),
            mime_type: 'image/png',
            media_resolution: 'high',
            resolution: 'high',
          });
        }
      }
    }
  }

  const repeatedDefects = sortedDefects
    .filter((d) => (defectFailureCounts.get(d.id) || 0) >= 2)
    .map((d) => d.id);

  const srcOutline = buildSrcOutline(workDir);
  const recentTried = triedLedger.slice(-8);

  const contextLines = [
    isBootstrap
      ? `You are the Patcher Agent running a BOOTSTRAP iteration in worktree ${workDir} to implement missing Inspector hooks and gameplay selectors.`
      : `You are the Patcher Agent running Iteration ${iterNum} in worktree ${workDir}.`,
    ``,
    `## Open Defects (Highest Severity First)`,
    ...sortedDefects.map(
      (d, idx) =>
        `${idx + 1}. [${d.id}] (severity=${d.severity}, view=${d.view || 'all'}, shot=${d.shot || 'n/a'}, t=${d.t || 'n/a'}): ${d.description}`
    ),
    ...(repeatedDefects.length > 0
      ? [
          ``,
          `IMPORTANT: Defects [${repeatedDefects.join(', ')}] have failed twice previously! You MUST use a structurally different fix strategy for them.`,
        ]
      : []),
    ...(isBootstrap
      ? [
          ``,
          `## Hook & Gameplay Contract (_fieldNotes)`,
          JSON.stringify(config._fieldNotes || {}, null, 2),
          `## Gameplay Scripts`,
          JSON.stringify(config.gameplay?.scripts || [], null, 2),
          `## Bootstrap Implementation Checklist`,
          `- In src/contracts.ts: add playAt?(tSeconds: number): void, botMove?(): GameState, showLegalMoves?(on: boolean): void, setView(mode: ViewMode, immediate?: boolean): void to InspectorAPI, and add marks?: Record<string, Array<{shot?: string; x: number; y: number; label: string}>>, viewConsistency?: { ok: boolean; mismatches: any[] }, hudMatchesState?: boolean to AuditReport.`,
          `- In src/logic/fixtures.ts: add 'fixture-midgame' returning runReplay(CANONICAL_MOVES.slice(0, 14)) (leaves >=4 tiles and lets 4 bot moves complete >=1 chain), and throw new Error('Unknown fixture: ' + name) for unknown fixture names.`,
          `- In src/main.ts and src/render/renderer.ts: implement window.__game.playAt(t), window.__game.botMove(), window.__game.showLegalMoves(on), and window.__game.setView(mode, instant).`,
          `- Ensure startDemo() builds in the active viewMode (never forcing 2D at start) and in inspectMode drives moves on playAt(t) so views.slice(0, -48).every(v => v === startView) and end.gameOver pass at t=20s.`,
          `- Ensure audit() returns marks: { floatingProps: [], ungroundedMeeples: [], tileLabels: [...] }, viewConsistency: { ok: true, mismatches: [] }, and hudMatchesState: true.`,
        ]
      : []),
    ``,
    `## Scope & Correctness Rules (Hard Rules 1, 11, 12, 13)`,
    `- Protected paths (NEVER edit): ${(config.protectedPaths || []).join(', ')}`,
    `- Out-of-scope areas (NEVER edit): ${(config.outOfScope || []).join('; ')}`,
    `- Out-of-scope file paths (NEVER edit): ${(config.outOfScopePaths || []).join(', ')}`,
    `- Baseline tests under tests/ tracked at startCommit (NEVER edit): ${Array.from(baselineTestFiles).join(', ')}`,
    `- New regression tests: write under '${config.regressionTestDir || 'tests/regressions/'}'`,
    `- Import boundaries: src/logic/ must never import three, src/render/, or src/ui/; src/render/ must never import src/ui/ or src/logic/; src/ui/ must never import src/render/ or src/logic/; src/tiles/ must never import src/render/ or src/ui/.`,
    `- Rule 12 (2D/3D consistency): Every tile, feature and object visible in 2D must exist in the same place in 3D, and vice versa. The tile spec and game state are the source of truth.`,
    `- Rule 13 (Realism): The board should read as a photographed physical miniature like diorama-style-ref.png: real materials with surface variation, soft natural light and shadow, believable scale and density.`,
    ``,
    `## Source Outline (src/)`,
    srcOutline,
    ``,
    `## Tried Ledger (Last ${recentTried.length} Failed Attempts)`,
    ...(recentTried.length > 0 ? recentTried : ['(none)']),
    ...(escalationPlan ? [``, `## Lead Architect Escalation Plan`, escalationPlan] : []),
    ...(notes ? [``, `## Launch Notes`, notes] : []),
    ``,
    `## Working Instructions`,
    `1. Address the highest-severity defects first. For measurable defects, write a regression test under '${config.regressionTestDir || 'tests/regressions/'}', make it pass with 'run', and 'preview' the shot.`,
    `2. For fidelity gaps, iterate with 'preview' against the reference.`,
    `3. Run 'npm run build' and 'npm test' via the 'run' tool before calling 'finish'.`,
    `4. End your turn by calling 'finish' with your PatchReport.`,
  ];

  inputParts.push({ type: 'text', text: contextLines.join('\n') });

  const tools = createPatcherTools(workDir, config, baselineTestFiles, options);
  const maxToolCalls = escalationPlan
    ? config.patcher?.escalatedMaxToolCalls || 120
    : config.patcher?.maxToolCalls || 60;
  const deadlineMs = config.patcher?.deadlineMs || 1_200_000;

  let loopRes = await runToolLoop({
    role: 'patcher',
    model: config.model?.name || 'gemini-4-argon',
    thinking: 'high',
    mediaResolution: 'high',
    tools,
    input: inputParts,
    taskId: isBootstrap ? 'patcher_bootstrap' : `patcher_iter_${iterNum}`,
    maxToolCalls,
    deadlineMs,
    rootDir: options.rootDir || workDir,
    tracePath: options.tracePath,
    state: options.state,
    budgetUsd: options.budgetUsd,
    fakeToolTurns: options.fakeToolTurns,
    fakeHandler: options.fakePatcherHandler,
  });

  // Gate 1: Hard Rule 1 & Hard Rule 11 diff check against startCommit
  let diffSafety = checkWorktreeDiffSafety(workDir, startCommit, config, baselineTestFiles);
  if (!diffSafety.ok) {
    resetToCommit(workDir, iterStartCommit);
    const reason = `Diff touched forbidden path(s): ${diffSafety.violations.map((v) => `${v.file} (${v.reason})`).join('; ')}`;
    recordFailedAttemptInLedger(triedLedger, sortedDefects, diffSafety.touchedFiles, reason);
    return {
      ok: false,
      rejected: true,
      rejectedReason: reason,
      report: loopRes.report,
    };
  }

  // Gate 2: Acceptance commands + import boundaries (§3.5)
  let accResult = runAcceptanceGate(workDir, config, options.runAcceptance);
  if (!accResult.ok) {
    // Give the agent one more bounded turn with the failing log (§3.5)
    const repairRes = await runToolLoop({
      role: 'patcher',
      model: config.model?.name || 'gemini-4-argon',
      thinking: 'high',
      mediaResolution: 'high',
      tools,
      input: `Acceptance gate failed:\n${accResult.error}\n\nFix the build/test errors and call finish.`,
      taskId: isBootstrap ? 'patcher_bootstrap_repair' : `patcher_iter_${iterNum}_repair`,
      maxToolCalls: Math.min(20, maxToolCalls),
      deadlineMs: Math.min(300_000, deadlineMs),
      previousInteractionId: loopRes.lastInteractionId,
      rootDir: options.rootDir || workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeToolTurns: options.fakeRepairToolTurns,
      fakeHandler: options.fakeRepairHandler || options.fakePatcherHandler,
    });
    loopRes = repairRes;

    diffSafety = checkWorktreeDiffSafety(workDir, startCommit, config, baselineTestFiles);
    if (!diffSafety.ok) {
      resetToCommit(workDir, iterStartCommit);
      const reason = `Repair diff touched forbidden path(s): ${diffSafety.violations.map((v) => v.file).join(', ')}`;
      recordFailedAttemptInLedger(triedLedger, sortedDefects, diffSafety.touchedFiles, reason);
      return {
        ok: false,
        rejected: true,
        rejectedReason: reason,
        report: loopRes.report,
      };
    }

    accResult = runAcceptanceGate(workDir, config, options.runAcceptance);
    if (!accResult.ok) {
      resetToCommit(workDir, iterStartCommit);
      const reason = `Acceptance gate failed after repair turn: ${accResult.error.slice(0, 200)}`;
      recordFailedAttemptInLedger(triedLedger, sortedDefects, diffSafety.touchedFiles, 'acceptance-failed');
      return {
        ok: false,
        rejected: true,
        rejectedReason: reason,
        report: loopRes.report,
      };
    }
  }

  // Commit changes as `loop iter <N>: <defectIds> <summary>` (§3.6)
  const statusOut = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf8' }).trim();
  let commitHash = iterStartCommit;
  let diffStat = '';
  const newRegressionTests = diffSafety.touchedFiles.filter((f) =>
    f.startsWith((config.regressionTestDir || 'tests/regressions/').replace(/\\/g, '/'))
  );

  if (statusOut) {
    execSync('git add -A', { cwd: workDir, stdio: 'pipe' });
    const addressedIds =
      (loopRes.report?.addressed || []).map((a) => a.defectId).filter(Boolean).join(',') ||
      sortedDefects.slice(0, 3).map((d) => d.id).join(',') ||
      'fixes';
    const cleanSummary = String(loopRes.report?.summary || 'apply visual loop fixes')
      .replace(/["`\n\r]/g, ' ')
      .slice(0, 72);
    const commitMsg = isBootstrap
      ? `loop bootstrap: ${addressedIds} ${cleanSummary}`
      : `loop iter ${iterNum}: ${addressedIds} ${cleanSummary}`;
    execSync(`git commit -m "${commitMsg}"`, { cwd: workDir, stdio: 'pipe' });
    commitHash = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf8' }).trim();
    diffStat = execSync(`git diff --stat ${iterStartCommit} ${commitHash}`, {
      cwd: workDir,
      encoding: 'utf8',
    }).trim();
  }

  return {
    ok: true,
    rejected: false,
    commitHash,
    diffStat,
    newRegressionTests,
    touchedFiles: diffSafety.touchedFiles,
    report: loopRes.report,
    toolCallsUsed: loopRes.toolCallsUsed,
  };
}

function runAcceptanceGate(workDir, config, customRunner = null) {
  try {
    const gate = checkImportBoundaries(workDir);
    if (!gate.ok) {
      return { ok: false, error: `Import boundary gate failed: ${gate.violations.join('; ')}` };
    }
    for (const cmd of config.acceptance || ['npm run build', 'npm test']) {
      if (typeof customRunner === 'function') {
        customRunner(cmd, workDir);
      } else {
        execSync(cmd, { cwd: workDir, stdio: 'pipe', timeout: 120_000 });
      }
    }
    return { ok: true };
  } catch (err) {
    const msg = `${err.stdout ? err.stdout.toString() : ''}\n${err.stderr ? err.stderr.toString() : ''}\n${err.message || ''}`;
    return { ok: false, error: msg.slice(-2500) };
  }
}

export function resetToCommit(workDir, targetCommit) {
  try {
    execSync(`git reset --hard ${targetCommit}`, { cwd: workDir, stdio: 'pipe' });
    execSync('git clean -fd -e runs -e wt -e node_modules', { cwd: workDir, stdio: 'pipe' });
  } catch {
    // ignore
  }
}

export function recordFailedAttemptInLedger(triedLedger, defects, files, outcome, changeDesc = 'attempted fix') {
  const defId = defects?.[0]?.id || 'unknown';
  const fileStr = (files || []).slice(0, 3).join('+') || 'none';
  const words = String(changeDesc).trim().split(/\s+/).slice(0, 25).join(' ');
  triedLedger.push(`${defId}, ${fileStr}, ${words}, ${outcome}`);
  while (triedLedger.length > 8) {
    triedLedger.shift();
  }
}
