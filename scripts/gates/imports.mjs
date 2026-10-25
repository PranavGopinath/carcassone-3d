#!/usr/bin/env node
/**
 * Import Boundary Gate (`scripts/gates/imports.mjs`)
 * Enforces:
 * - src/logic/ cannot import `three`, `src/render/`, or `src/ui/`
 * - src/render/ cannot import `src/ui/` or `src/logic/`
 * - src/ui/ cannot import `src/render/` or `src/logic/`
 * - src/tiles/ cannot import `src/render/` or `src/ui/`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GATE_ROOT
  ? path.resolve(process.env.GATE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

function extractImports(source) {
  const imports = [];
  const regex = /(?:import|export)\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    imports.push(match[1] || match[2]);
  }
  return imports;
}

export function checkImportBoundaries(rootDir = ROOT) {
  const srcDir = path.join(rootDir, 'src');
  const files = walkFiles(srcDir);
  const violations = [];

  for (const file of files) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const specs = extractImports(content);

    for (const spec of specs) {
      const resolvedRel = spec.startsWith('.')
        ? path.relative(rootDir, path.resolve(path.dirname(file), spec)).replace(/\\/g, '/')
        : spec;

      if (rel.startsWith('src/logic/')) {
        if (spec === 'three' || spec.startsWith('three/')) {
          violations.push(`${rel} imports forbidden module '${spec}' (logic cannot import three)`);
        }
        if (resolvedRel.startsWith('src/render') || resolvedRel.startsWith('src/ui')) {
          violations.push(`${rel} imports forbidden path '${spec}' (logic cannot import render/ui)`);
        }
      } else if (rel.startsWith('src/render/')) {
        if (resolvedRel.startsWith('src/ui') || resolvedRel.startsWith('src/logic')) {
          violations.push(`${rel} imports forbidden path '${spec}' (render cannot import ui/logic)`);
        }
      } else if (rel.startsWith('src/ui/')) {
        if (resolvedRel.startsWith('src/render') || resolvedRel.startsWith('src/logic')) {
          violations.push(`${rel} imports forbidden path '${spec}' (ui cannot import render/logic)`);
        }
      } else if (rel.startsWith('src/tiles/')) {
        if (resolvedRel.startsWith('src/render') || resolvedRel.startsWith('src/ui')) {
          violations.push(`${rel} imports forbidden path '${spec}' (tiles cannot import render/ui)`);
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkImportBoundaries(ROOT);
  if (!result.ok) {
    console.error('Import gate failed:\n' + result.violations.map((v) => `  - ${v}`).join('\n'));
    process.exit(1);
  }
  console.log('Import gate passed.');
}
