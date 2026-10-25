import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createCanvas, loadImage } from '@napi-rs/canvas';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function loadLoopConfig(workDir) {
  const cfgPath = path.join(workDir, 'loop.config.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Missing loop.config.json in ${workDir}`);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

async function isUrlReachable(url, timeoutMs = 1000) {
  if (!url || url.startsWith('file://')) return true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function killPortIfBusy(url) {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (!port) return;
    const pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // ignore
      }
    }
  } catch {
    // No process listening on port
  }
}

/**
 * Starts `config.devCommand` inside `workDir` once per run and waits until `config.url` responds.
 */
export async function startDevServer(workDir, config, options = {}) {
  const url = config.url;
  if (!config.devCommand || url.startsWith('file://')) {
    return {
      url,
      stop: async () => {},
    };
  }

  if (options.forceRestart) {
    killPortIfBusy(url);
    await sleep(200);
  } else if (await isUrlReachable(url, 800)) {
    if (options.reuseExistingServer) {
      return { url, stop: async () => {} };
    }
    killPortIfBusy(url);
    await sleep(200);
  }

  const child = spawn(config.devCommand, {
    cwd: workDir,
    shell: true,
    detached: true,
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
  });

  let stderrLog = '';
  child.stderr?.on('data', (chunk) => {
    stderrLog += chunk.toString();
  });

  const deadline = Date.now() + (options.startupTimeoutMs || 25_000);
  while (Date.now() < deadline) {
    if (await isUrlReachable(url, 1000)) {
      break;
    }
    await sleep(200);
  }

  if (!(await isUrlReachable(url, 1500))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ignore
    }
    throw new Error(`Dev server failed to start at ${url} within timeout. Log: ${stderrLog.slice(-500)}`);
  }

  return {
    url,
    child,
    stop: async () => {
      try {
        if (child.pid) {
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch {
        // ignore
      }
      await sleep(100);
      try {
        if (child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // ignore
      }
    },
  };
}

export async function launchHardwareBrowser(config, options = {}) {
  const gpuArgs =
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling']
      : ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling'];

  const browser = await chromium.launch({
    headless: true,
    args: gpuArgs,
  });

  const viewport = config.viewport || { width: 1280, height: 720, deviceScaleFactor: 1 };
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
  });

  // Check WebGL renderer string via WEBGL_debug_renderer_info (§1.2)
  const probePage = await context.newPage();
  const glInfo = await probePage.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, renderer: 'none', vendor: 'none' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
  await probePage.close();

  const rendererStr = String(glInfo.renderer || '');
  if (!options.allowSoftwareRenderer) {
    if (!glInfo.ok || /swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(rendererStr)) {
      await browser.close();
      throw new Error(
        `Hardware WebGL renderer check failed: got software/unavailable renderer '${rendererStr}' (vendor: '${glInfo.vendor}')`
      );
    }
  }

  return { browser, context, glInfo };
}

/**
 * Installs the deterministic inspect-mode clock/seed tracker before page scripts load (§1.3).
 */
async function prepareFreshPage(context, config, options = {}) {
  const page = await context.newPage();

  // Block Vite HMR WebSocket updates while keeping updateStyle/createHotContext functional (§1.1)
  await page.route('**/*', (route) => {
    const reqUrl = route.request().url();
    if (reqUrl.includes('__vite_ping') || reqUrl.includes('@vite/client')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
export function createHotContext() {
  return { accept() {}, dispose() {}, prune() {}, decline() {}, invalidate() {}, on() {}, off() {}, send() {}, data: {} };
}
export function updateStyle(id, content) {
  let s = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (!s) {
    s = document.createElement('style');
    s.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(s);
  }
  s.textContent = content;
}
export function removeStyle(id) {
  const s = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (s) s.remove();
}
export function injectQuery(url) { return url; }
`,
      });
    }
    return route.continue();
  });

  const consoleErrors = [];
  const webglWarnings = [];

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      if (!text.includes('favicon.ico')) {
        consoleErrors.push(text);
      }
    } else if (type === 'warning' && /webgl|three\.webgl/i.test(text)) {
      webglWarnings.push(text);
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message || String(err));
  });

  await page.addInitScript(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('inspect') === '1') {
      const seedParam = Number(params.get('seed') ?? 7) || 7;
      let s = seedParam >>> 0;
      const seededRandom = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      Math.random = seededRandom;

      let virtualNowMs = 0;
      const baseEpochMs = 1761436800000;
      window.__setVirtualTimeSeconds = (sec) => {
        virtualNowMs = Number(sec || 0) * 1000;
      };
      window.__getVirtualTimeSeconds = () => virtualNowMs / 1000;
      performance.now = () => virtualNowMs;
      Date.now = () => baseEpochMs + Math.round(virtualNowMs);
    }
  });

  await page.goto(options.url || config.url, { waitUntil: 'load', timeout: 25_000 });

  // Wait for document.fonts.ready and optional ready hook (§1.3)
  const globalName = config.hooks?.global || '__game';
  const readyHook = config.hooks?.ready;
  await page.evaluate(
    async ({ globalName: gName, readyHook: rHook }) => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
      // Wait up to 3s for window[globalName] to attach
      const deadline = Date.now() + 3000;
      while (!window[gName] && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const api = window[gName];
      if (api && rHook && typeof api[rHook] === 'function') {
        await api[rHook]();
      } else if (api && api.ready && typeof api.ready.then === 'function') {
        await api.ready;
      }
    },
    { globalName, readyHook }
  );

  return { page, consoleErrors, webglWarnings };
}

/**
 * Checks that every non-null hook in `config.hooks` exists on `window[global]`
 * and every `click` selector in `config.gameplay.scripts` resolves on the page.
 */
export async function checkPageHooksAndSelectors(workDir, config, options = {}) {
  const server = options.server || (await startDevServer(workDir, config, options));
  const { browser, context } = await launchHardwareBrowser(config, options);

  try {
    const { page } = await prepareFreshPage(context, config, { url: server.url });
    const globalName = config.hooks?.global || '__game';
    const hooksObj = config.hooks || {};
    const requiredHooks = Object.entries(hooksObj)
      .filter(([k, v]) => k !== 'global' && k !== 'timeUnit' && v !== null && v !== undefined)
      .map(([k, v]) => ({ key: k, fnName: String(v) }));

    const selectors = new Set();
    for (const script of config.gameplay?.scripts || []) {
      for (const step of script.steps || []) {
        if (step.click) selectors.add(step.click);
      }
    }

    const checkResult = await page.evaluate(
      ({ gName, reqHooks, reqSelectors }) => {
        const api = window[gName];
        const missingHooks = [];
        for (const h of reqHooks) {
          if (!api || typeof api[h.fnName] !== 'function') {
            missingHooks.push(`${gName}.${h.fnName}`);
          }
        }
        const missingSelectors = [];
        for (const sel of reqSelectors) {
          if (!document.querySelector(sel)) {
            missingSelectors.push(sel);
          }
        }
        return {
          ok: missingHooks.length === 0 && missingSelectors.length === 0,
          missingHooks,
          missingSelectors,
        };
      },
      {
        gName: globalName,
        reqHooks: requiredHooks,
        reqSelectors: Array.from(selectors),
      }
    );

    await page.close();
    return checkResult;
  } finally {
    await browser.close();
    if (!options.server) {
      await server.stop();
    }
  }
}

/**
 * Queries the bounding box of the main WebGL/board canvas and all visible DOM overlays drawn over/outside it.
 */
async function getMaskAndCropRects(page, config, cropSelectors = []) {
  return page.evaluate(
    ({ selectors }) => {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;

      // Find the main board canvas (#viewport canvas or largest canvas outside [data-testid=tile-dock])
      const allCanvases = Array.from(document.querySelectorAll('canvas'));
      let mainCanvas = document.querySelector('#viewport canvas');
      if (!mainCanvas && allCanvases.length > 0) {
        mainCanvas = allCanvases.reduce((best, cur) => {
          const rBest = best.getBoundingClientRect();
          const rCur = cur.getBoundingClientRect();
          return rCur.width * rCur.height > rBest.width * rBest.height ? cur : best;
        }, allCanvases[0]);
      }

      const canvasRect = mainCanvas
        ? (() => {
            const r = mainCanvas.getBoundingClientRect();
            return {
              x: Math.max(0, Math.floor(r.left)),
              y: Math.max(0, Math.floor(r.top)),
              width: Math.min(vw, Math.ceil(r.width)),
              height: Math.min(vh, Math.ceil(r.height)),
            };
          })()
        : { x: 0, y: 0, width: vw, height: vh };

      // Collect bounding boxes of visible DOM overlays drawn over the canvas
      const overlayCandidates = Array.from(
        document.querySelectorAll(
          '.ui-top-left-turn, .ui-top-center-bar, .ui-demo-pill, .ui-sidebar-card, .ui-turn-banner.visible, .ui-modal-backdrop, [data-hud], [data-overlay], #ui-root > * > *'
        )
      );
      const overlayRects = [];
      for (const el of overlayCandidates) {
        if (mainCanvas && (el === mainCanvas || el.contains(mainCanvas))) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) {
          overlayRects.push({
            x: Math.max(0, Math.floor(r.left)),
            y: Math.max(0, Math.floor(r.top)),
            width: Math.ceil(r.width),
            height: Math.ceil(r.height),
          });
        }
      }

      const selectorRects = {};
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1) {
            selectorRects[sel] = {
              x: Math.max(0, Math.floor(r.left)),
              y: Math.max(0, Math.floor(r.top)),
              width: Math.ceil(r.width),
              height: Math.ceil(r.height),
            };
          }
        }
      }

      return { canvasRect, overlayRects, selectorRects };
    },
    { selectors: cropSelectors }
  );
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isPixelMasked(x, y, maskInfo) {
  if (!maskInfo) return false;
  const cr = maskInfo.canvasRect;
  if (cr) {
    if (x < cr.x || x >= cr.x + cr.width || y < cr.y || y >= cr.y + cr.height) {
      return true;
    }
  }
  for (const r of maskInfo.overlayRects || []) {
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
      return true;
    }
  }
  return false;
}

async function decodePngBuffer(pngPath) {
  const img = await loadImage(pngPath);
  const w = img.width;
  const h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { width: w, height: h, data };
}

/**
 * Compares two frame PNGs on the unmasked canvas region for determinism verification (§1.3, §1.6, §1.9).
 */
export async function compareFramesMasked(pngPathA, pngPathB, maskInfo = null, pixelThreshold = 12) {
  const [imgA, imgB] = await Promise.all([decodePngBuffer(pngPathA), decodePngBuffer(pngPathB)]);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return { match: false, diffFraction: 1 };
  }
  const w = imgA.width;
  const h = imgA.height;
  let totalUnmasked = 0;
  let diffPixels = 0;

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (isPixelMasked(x, y, maskInfo)) continue;
      totalUnmasked++;
      const idx = (y * w + x) * 4;
      const dr = Math.abs(imgA.data[idx] - imgB.data[idx]);
      const dg = Math.abs(imgA.data[idx + 1] - imgB.data[idx + 1]);
      const db = Math.abs(imgA.data[idx + 2] - imgB.data[idx + 2]);
      if (Math.max(dr, dg, db) > pixelThreshold) {
        diffPixels++;
      }
    }
  }

  const diffFraction = totalUnmasked > 0 ? diffPixels / totalUnmasked : 0;
  return {
    match: diffFraction <= 0.002,
    diffFraction: Number(diffFraction.toFixed(6)),
  };
}

/**
 * Runs `blankFrame` and `frameDiff` hard checks across a sequence of frames (§1.7).
 * Masks out DOM overlays and regions outside the canvas.
 */
export async function analyzeFrameSequence(framePaths, options = {}) {
  const fps = options.fps || 12;
  const grid = options.grid || 8;
  const pixelThreshold = options.pixelThreshold ?? 24;
  const spikeFactor = options.spikeFactor ?? 4;
  const segments = options.segments || [{ id: 'all', start: 0, end: framePaths.length / fps }];
  const maskInfos = options.maskInfos || [];

  const decoded = [];
  for (let i = 0; i < framePaths.length; i++) {
    decoded.push(await decodePngBuffer(framePaths[i]));
  }

  const blankFrames = [];
  for (let i = 0; i < decoded.length; i++) {
    const { width, height, data } = decoded[i];
    const mask = maskInfos[i] || maskInfos[0] || null;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (isPixelMasked(x, y, mask)) continue;
        const idx = (y * width + x) * 4;
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        count++;
      }
    }

    if (count > 0) {
      const meanR = sumR / count;
      const meanG = sumG / count;
      const meanB = sumB / count;
      let nearMean = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          if (isPixelMasked(x, y, mask)) continue;
          const idx = (y * width + x) * 4;
          const d =
            Math.abs(data[idx] - meanR) +
            Math.abs(data[idx + 1] - meanG) +
            Math.abs(data[idx + 2] - meanB);
          if (d <= 12) nearMean++;
        }
      }
      const uniformRatio = nearMean / count;
      if (uniformRatio >= 0.985) {
        const t = Number((i / fps).toFixed(3));
        blankFrames.push({ frameIndex: i, t, uniformRatio: Number(uniformRatio.toFixed(4)) });
      }
    }
  }

  // Compute consecutive frame diffs globally and per cell of grid x grid
  const pairDiffs = [];
  for (let i = 1; i < decoded.length; i++) {
    const prev = decoded[i - 1];
    const curr = decoded[i];
    const maskPrev = maskInfos[i - 1] || maskInfos[0] || null;
    const maskCurr = maskInfos[i] || maskInfos[0] || null;
    const w = curr.width;
    const h = curr.height;
    const cr = maskCurr?.canvasRect || { x: 0, y: 0, width: w, height: h };

    let globalChanged = 0;
    let globalTotal = 0;
    const cellChanged = new Array(grid * grid).fill(0);
    const cellTotal = new Array(grid * grid).fill(0);

    for (let y = cr.y; y < cr.y + cr.height; y++) {
      const gy = Math.min(grid - 1, Math.max(0, Math.floor(((y - cr.y) / Math.max(1, cr.height)) * grid)));
      for (let x = cr.x; x < cr.x + cr.width; x++) {
        if (isPixelMasked(x, y, maskPrev) || isPixelMasked(x, y, maskCurr)) continue;
        const gx = Math.min(grid - 1, Math.max(0, Math.floor(((x - cr.x) / Math.max(1, cr.width)) * grid)));
        const cellIdx = gy * grid + gx;
        const idx = (y * w + x) * 4;

        const dr = Math.abs(curr.data[idx] - prev.data[idx]);
        const dg = Math.abs(curr.data[idx + 1] - prev.data[idx + 1]);
        const db = Math.abs(curr.data[idx + 2] - prev.data[idx + 2]);
        const changed = Math.max(dr, dg, db) > pixelThreshold;

        globalTotal++;
        cellTotal[cellIdx]++;
        if (changed) {
          globalChanged++;
          cellChanged[cellIdx]++;
        }
      }
    }

    const globalFrac = globalTotal > 0 ? globalChanged / globalTotal : 0;
    const cellFracs = cellChanged.map((c, idx) => (cellTotal[idx] > 20 ? c / cellTotal[idx] : 0));
    const maxCellFrac = Math.max(0, ...cellFracs);
    const maxCellIdx = cellFracs.indexOf(maxCellFrac);
    const t = Number((i / fps).toFixed(3));
    const tPrev = Number(((i - 1) / fps).toFixed(3));

    pairDiffs.push({
      pairIndex: i - 1,
      frameIndex: i,
      t,
      tPrev,
      d: globalFrac,
      cells: cellFracs,
      maxCellFrac,
      maxCellIdx,
      d2: 0,
      cellD2: new Array(grid * grid).fill(0),
    });
  }

  for (let p = 0; p < pairDiffs.length; p++) {
    if (p > 0) {
      pairDiffs[p].d2 = Math.abs(pairDiffs[p].d - pairDiffs[p - 1].d);
      pairDiffs[p].cellD2 = pairDiffs[p].cells.map((v, c) => Math.abs(v - pairDiffs[p - 1].cells[c]));
    }
  }

  // Segment boundary times (ignore frames on either side of an internal segment boundary, §1.7)
  const internalBoundaries = [];
  if (segments.length > 1) {
    for (let s = 0; s < segments.length - 1; s++) {
      internalBoundaries.push(segments[s].end);
    }
  }
  const isNearBoundary = (t) => {
    const tol = 1.05 / fps;
    return internalBoundaries.some((b) => Math.abs(t - b) <= tol);
  };

  const spikes = [];

  for (const seg of segments) {
    const segPairs = pairDiffs.filter(
      (p) => p.t >= seg.start - 1e-6 && p.t <= seg.end + 1e-6 && !isNearBoundary(p.t) && !isNearBoundary(p.tPrev)
    );
    if (segPairs.length < 2) continue;

    const segMedD = median(segPairs.map((p) => p.d));
    const segMedD2 = median(segPairs.slice(1).map((p) => p.d2));
    const segMedMaxCell = median(segPairs.map((p) => p.maxCellFrac));

    const cellMedians = new Array(grid * grid).fill(0);
    const cellD2Medians = new Array(grid * grid).fill(0);
    for (let c = 0; c < grid * grid; c++) {
      cellMedians[c] = median(segPairs.map((p) => p.cells[c]));
      cellD2Medians[c] = median(segPairs.slice(1).map((p) => p.cellD2[c]));
    }

    for (let idx = 0; idx < segPairs.length; idx++) {
      const p = segPairs[idx];
      const prevPair = idx > 0 ? segPairs[idx - 1] : null;
      const nextPair = idx + 1 < segPairs.length ? segPairs[idx + 1] : null;

      if (p.maxCellFrac < 0.012 && p.d < 0.002) {
        continue;
      }

      const cIdx = p.maxCellIdx;
      const cellVal = p.cells[cIdx];

      // (a) Continuous motion segment: compare against segment medians
      let isCellMedianSpike = false;
      let isSecondOrderSpike = false;

      if (segMedD > 0.0005) {
        const effCellBaseline = Math.max(cellMedians[cIdx], segMedMaxCell * 0.45, 0.012);
        const effCellD2Baseline = Math.max(cellD2Medians[cIdx], segMedMaxCell * 0.22, 0.008);
        if (
          cellVal > spikeFactor * effCellBaseline ||
          (cellVal > 0.04 && p.cellD2[cIdx] > spikeFactor * effCellD2Baseline)
        ) {
          isCellMedianSpike = true;
        }
        const effD2Baseline = Math.max(segMedD2, segMedD * 0.18, 0.0015);
        if (idx > 0 && p.d2 > spikeFactor * effD2Baseline && p.d > segMedD * 1.35) {
          isSecondOrderSpike = true;
        }
      }

      // (b) Isolated 1-frame impulse (pop-in / flicker during gameplay or pan)
      // A multi-frame tween has sustained change in prevPair or nextPair; a 1-frame pop-in jumps and drops in 1 frame
      const prevCell = prevPair ? prevPair.cells[cIdx] : 0;
      const nextCell = nextPair ? nextPair.cells[cIdx] : 0;
      const prevMax = prevPair ? prevPair.maxCellFrac : 0;
      const nextMax = nextPair ? nextPair.maxCellFrac : 0;
      const neighborCellRef = Math.max(prevCell, nextCell, prevMax * 0.5, nextMax * 0.5, 0.003);
      const isIsolatedImpulse = cellVal > 0.025 && cellVal > spikeFactor * neighborCellRef;

      if (isCellMedianSpike || isSecondOrderSpike || isIsolatedImpulse) {
        spikes.push({
          segment: seg.id,
          frameIndex: p.frameIndex,
          t: p.t,
          d: Number(p.d.toFixed(5)),
          d2: Number(p.d2.toFixed(5)),
          maxCellFrac: Number(cellVal.toFixed(5)),
          cellIndex: cIdx,
          reason: isIsolatedImpulse
            ? 'isolated-pop-in-spike'
            : isSecondOrderSpike
              ? 'second-order-spike'
              : 'cell-median-spike',
        });
      }
    }
  }

  return {
    blankFrames,
    spikes,
    pairs: pairDiffs.map((p) => ({
      frameIndex: p.frameIndex,
      t: p.t,
      d: Number(p.d.toFixed(5)),
      d2: Number(p.d2.toFixed(5)),
      maxCellFrac: Number(p.maxCellFrac.toFixed(5)),
    })),
  };
}

/**
 * Stitches frames in `framesDir` (`frame-%04d.png`) into a WebM video using `ffmpeg` (§1.8).
 */
export function stitchVideo(framesDir, outWebmPath, fps = 12) {
  fs.mkdirSync(path.dirname(outWebmPath), { recursive: true });
  const pattern = path.join(framesDir, 'frame-%04d.png');
  try {
    execSync(
      `ffmpeg -y -framerate ${fps} -i "${pattern}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -pix_fmt yuv420p -b:v 2M "${outWebmPath}"`,
      { stdio: 'pipe', timeout: 30_000 }
    );
    return { ok: true, path: outWebmPath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Clips a segment `[startSec, endSec]` from `inputWebm` into `outWebm` using `ffmpeg`.
 */
export function clipVideoSegment(inputWebm, outWebm, startSec, endSec) {
  if (!fs.existsSync(inputWebm)) return { ok: false };
  fs.mkdirSync(path.dirname(outWebm), { recursive: true });
  try {
    execSync(
      `ffmpeg -y -ss ${startSec} -to ${endSec} -i "${inputWebm}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -pix_fmt yuv420p -b:v 2M "${outWebm}"`,
      { stdio: 'pipe', timeout: 20_000 }
    );
    return { ok: true, path: outWebm };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Applies optional Golden Set perturbation (`options.perturbation`) to the page or frame.
 */
async function applyGoldenPerturbationOnPage(page, globalName, perturbation, contextInfo = {}) {
  if (!perturbation) return;
  await page.evaluate(
    ({ gName, pert, ctx }) => {
      const api = window[gName];
      if (api && typeof api.injectDefect === 'function') {
        try {
          api.injectDefect(pert.type, ctx);
        } catch {
          // ignore
        }
      }
      if (typeof window.__applyGoldenPerturbation === 'function') {
        window.__applyGoldenPerturbation(pert, ctx);
      }
    },
    { gName: globalName, pert: perturbation, ctx: contextInfo }
  );
}

/**
 * Captures a single gameplay script in a specific view (`2d` or `3d`) (§1.6).
 */
export async function captureGameplayScriptOnPage(
  context,
  config,
  script,
  view,
  outDir,
  options = {}
) {
  const fps = config.gameplay?.fps || 12;
  const globalName = config.hooks?.global || '__game';
  const timeUnit = config.hooks?.timeUnit || 's';
  const toTimeVal = (sec) => (timeUnit === 'ms' ? sec * 1000 : sec);

  const scriptId = script.id;
  const framesDir = path.join(outDir, 'frames', `play-${scriptId}-${view}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const { page, consoleErrors, webglWarnings } = await prepareFreshPage(context, config, options);

  const stepErrors = [];
  const stepAudits = [];
  const stepFrames = [];
  const recordedViews = [];
  const maskInfos = [];

  try {
    // 1. Call setView(view, true) instantly and reset play clock with playAt(0)
    await page.evaluate(
      ({ gName, hSetView, hPlayAt, targetView }) => {
        const api = window[gName];
        if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(0);
        if (api && hSetView && typeof api[hSetView] === 'function') {
          api[hSetView](targetView, true);
        }
        if (api && hPlayAt && typeof api[hPlayAt] === 'function') {
          api[hPlayAt](0);
        }
      },
      {
        gName: globalName,
        hSetView: config.hooks?.setView || 'setView',
        hPlayAt: config.hooks?.playAt || 'playAt',
        targetView: view,
      }
    );

    const startState = await page.evaluate(
      ({ gName, hGetView }) => {
        const api = window[gName];
        const st = api && typeof api.getState === 'function' ? JSON.parse(JSON.stringify(api.getState())) : {};
        const v = api && hGetView && typeof api[hGetView] === 'function' ? api[hGetView]() : null;
        return { ...st, view: v };
      },
      { gName: globalName, hGetView: config.hooks?.getView || 'getView' }
    );

    const sortedSteps = [...(script.steps || [])].sort((a, b) => a.at - b.at);
    const appliedStepIndices = new Set();
    const pendingSettlements = [];

    const totalFrames = Math.round(script.duration * fps);
    const framePaths = [];

    for (let fIdx = 0; fIdx <= totalFrames; fIdx++) {
      const tSec = Number((fIdx / fps).toFixed(4));

      // Check if any pending step settles on the frame immediately before the next step's `at`
      for (const pending of pendingSettlements) {
        if (!pending.settled && pending.nextStepAt !== null && tSec + 1e-6 >= pending.nextStepAt) {
          pending.settled = true;
          await finalizeStepSettlement(
            page,
            globalName,
            config,
            pending,
            framePaths[framePaths.length - 1],
            maskInfos[maskInfos.length - 1],
            outDir,
            scriptId,
            view,
            stepAudits,
            stepFrames,
            stepErrors
          );
        }
      }

      // Apply any steps whose `at <= tSec` before rendering this frame
      for (let sIdx = 0; sIdx < sortedSteps.length; sIdx++) {
        if (appliedStepIndices.has(sIdx)) continue;
        const step = sortedSteps[sIdx];
        if (tSec + 1e-6 >= step.at) {
          appliedStepIndices.add(sIdx);
          const nextStep = sortedSteps[sIdx + 1] || null;
          const prevFramePath = framePaths.length > 0 ? framePaths[framePaths.length - 1] : null;
          const prevMask = maskInfos.length > 0 ? maskInfos[maskInfos.length - 1] : null;

          const beforeSnapshot = await page.evaluate(
            ({ gName, hGetView }) => {
              const api = window[gName];
              const st = api && typeof api.getState === 'function' ? JSON.parse(JSON.stringify(api.getState())) : {};
              const v = api && hGetView && typeof api[hGetView] === 'function' ? api[hGetView]() : null;
              return { ...st, view: v };
            },
            { gName: globalName, hGetView: config.hooks?.getView || 'getView' }
          );

          const errCountBefore = consoleErrors.length;
          try {
            await page.evaluate(
              ({ sec }) => {
                if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
              },
              { sec: tSec }
            );

            if (step.call) {
              const fnName = config.hooks?.[step.call] || step.call;
              await page.evaluate(
                async ({ gName, fn, args }) => {
                  const api = window[gName];
                  if (!api || typeof api[fn] !== 'function') {
                    throw new Error(`Missing gameplay hook ${gName}.${fn}`);
                  }
                  return await api[fn](...(args || []));
                },
                { gName: globalName, fn: fnName, args: step.args || [] }
              );
            } else if (step.click) {
              await page.locator(step.click).click({ timeout: 2000 });
            }
          } catch (stepErr) {
            stepErrors.push({
              script: scriptId,
              view,
              stepIndex: sIdx,
              at: step.at,
              label: step.label || step.call || step.click,
              type: 'exception',
              message: stepErr.message || String(stepErr),
            });
          }

          if (consoleErrors.length > errCountBefore) {
            for (const cErr of consoleErrors.slice(errCountBefore)) {
              stepErrors.push({
                script: scriptId,
                view,
                stepIndex: sIdx,
                at: step.at,
                label: step.label || step.call || step.click,
                type: 'console-error',
                message: cErr,
              });
            }
          }

          pendingSettlements.push({
            stepIndex: sIdx,
            step,
            beforeSnapshot,
            prevFramePath,
            prevMask,
            nextStepAt: nextStep ? nextStep.at : null,
            settled: false,
          });
        }
      }

      // Advance playAt(t) and render frame
      const errBeforePlayAt = consoleErrors.length;
      try {
        await page.evaluate(
          ({ gName, hPlayAt, tVal, sec }) => {
            if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
            const api = window[gName];
            if (api && hPlayAt && typeof api[hPlayAt] === 'function') {
              api[hPlayAt](tVal);
            }
          },
          {
            gName: globalName,
            hPlayAt: config.hooks?.playAt || 'playAt',
            tVal: toTimeVal(tSec),
            sec: tSec,
          }
        );
      } catch (playErr) {
        stepErrors.push({
          script: scriptId,
          view,
          at: tSec,
          type: 'playAt-exception',
          message: playErr.message || String(playErr),
        });
      }
      if (consoleErrors.length > errBeforePlayAt) {
        for (const cErr of consoleErrors.slice(errBeforePlayAt)) {
          stepErrors.push({
            script: scriptId,
            view,
            at: tSec,
            type: 'console-error',
            message: cErr,
          });
        }
      }

      const activeView = await page.evaluate(
        ({ gName, hGetView }) => {
          const api = window[gName];
          return api && hGetView && typeof api[hGetView] === 'function' ? api[hGetView]() : null;
        },
        { gName: globalName, hGetView: config.hooks?.getView || 'getView' }
      );
      recordedViews.push(activeView);

      const maskInfo = await getMaskAndCropRects(page, config);
      maskInfos.push(maskInfo);

      const framePath = path.join(framesDir, `frame-${String(fIdx).padStart(4, '0')}.png`);
      // Full-page screenshot for gameplay (§1.6.2)
      await page.screenshot({ path: framePath, fullPage: false });
      framePaths.push(framePath);
    }

    // Settle any remaining steps at the end of the script
    for (const pending of pendingSettlements) {
      if (!pending.settled && framePaths.length > 0) {
        pending.settled = true;
        await finalizeStepSettlement(
          page,
          globalName,
          config,
          pending,
          framePaths[framePaths.length - 1],
          maskInfos[maskInfos.length - 1],
          outDir,
          scriptId,
          view,
          stepAudits,
          stepFrames,
          stepErrors
        );
      }
    }

    // Evaluate script-level `expect` over (start, end, startView, views) (§1.6.4)
    const endState = await page.evaluate(
      ({ gName, hGetView }) => {
        const api = window[gName];
        const st = api && typeof api.getState === 'function' ? JSON.parse(JSON.stringify(api.getState())) : {};
        const v = api && hGetView && typeof api[hGetView] === 'function' ? api[hGetView]() : null;
        return { ...st, view: v };
      },
      { gName: globalName, hGetView: config.hooks?.getView || 'getView' }
    );

    if (script.expect) {
      let scriptExpectOk = false;
      try {
        const fn = new Function('start', 'end', 'startView', 'views', `return Boolean(${script.expect});`);
        scriptExpectOk = Boolean(fn(startState, endState, view, recordedViews));
      } catch {
        scriptExpectOk = false;
      }
      if (!scriptExpectOk) {
        stepErrors.push({
          script: scriptId,
          view,
          at: script.duration,
          type: 'script-expect-failed',
          expect: script.expect,
          message: `Script '${scriptId}' (${view}) expectation failed: ${script.expect}`,
        });
      }
    }

    // Run blankFrame and frameDiff on the script's frames (masked to canvas without DOM overlays)
    const diffAnalysis = await analyzeFrameSequence(framePaths, {
      fps,
      grid: config.frameDiff?.grid || 8,
      pixelThreshold: config.frameDiff?.pixelThreshold ?? 24,
      spikeFactor: config.frameDiff?.spikeFactor ?? 4,
      segments: [{ id: scriptId, start: 0, end: script.duration }],
      maskInfos,
    });

    const videoPath = path.join(outDir, `play-${scriptId}-${view}.webm`);
    const stitchRes = stitchVideo(framesDir, videoPath, fps);

    return {
      scriptId,
      view,
      fps,
      duration: script.duration,
      framePaths,
      stepFrames,
      stepAudits,
      stepErrors,
      recordedViews,
      blankFrames: diffAnalysis.blankFrames,
      frameDiffSpikes: diffAnalysis.spikes,
      videoPath: stitchRes.ok ? videoPath : null,
      consoleErrors,
      webglWarnings,
    };
  } finally {
    await page.close();
  }
}

async function finalizeStepSettlement(
  page,
  globalName,
  config,
  pending,
  settledFramePath,
  settledMask,
  outDir,
  scriptId,
  view,
  stepAudits,
  stepFrames,
  stepErrors
) {
  const { stepIndex, step, beforeSnapshot, prevFramePath, prevMask } = pending;

  // Copy settled frame to shots/play-<scriptId>-<view>-step-<stepIndex>.png
  const settledShotDir = path.join(outDir, 'shots');
  fs.mkdirSync(settledShotDir, { recursive: true });
  const settledCopyPath = path.join(
    settledShotDir,
    `play-${scriptId}-${view}-step-${stepIndex}.png`
  );
  if (settledFramePath && fs.existsSync(settledFramePath)) {
    fs.copyFileSync(settledFramePath, settledCopyPath);
  }

  const afterData = await page.evaluate(
    ({ gName, hGetView, hAudit }) => {
      const api = window[gName];
      const st = api && typeof api.getState === 'function' ? JSON.parse(JSON.stringify(api.getState())) : {};
      const v = api && hGetView && typeof api[hGetView] === 'function' ? api[hGetView]() : null;
      const aud = api && hAudit && typeof api[hAudit] === 'function' ? api[hAudit]() : {};
      return { afterSnapshot: { ...st, view: v }, audit: aud };
    },
    {
      gName: globalName,
      hGetView: config.hooks?.getView || 'getView',
      hAudit: config.hooks?.audit || 'audit',
    }
  );

  stepAudits.push({
    stepIndex,
    at: step.at,
    label: step.label || step.call || step.click,
    audit: afterData.audit,
  });

  stepFrames.push({
    stepIndex,
    at: step.at,
    label: step.label || step.call || step.click,
    path: settledCopyPath,
  });

  // Check for no-op step: neither getState() nor the masked canvas frame changed (§1.6.4)
  const stateSame = JSON.stringify(beforeSnapshot) === JSON.stringify(afterData.afterSnapshot);
  let frameSame = false;
  if (prevFramePath && settledFramePath && fs.existsSync(prevFramePath) && fs.existsSync(settledFramePath)) {
    const cmp = await compareFramesMasked(prevFramePath, settledFramePath, settledMask || prevMask, 8);
    frameSame = cmp.diffFraction === 0;
  } else if (!prevFramePath && stateSame) {
    // For step at t=0.0, if getState() is completely identical before and after the step, it's a no-op!
    frameSame = true;
  }

  if (stateSame && frameSame) {
    stepErrors.push({
      script: scriptId,
      view,
      stepIndex,
      at: step.at,
      label: step.label || step.call || step.click,
      type: 'no-op-step',
      message: `No-op step at t=${step.at}s (${step.label || step.call || step.click}): neither getState() nor frame changed`,
    });
  }

  // Check step `expect` over (before, after) (§1.6.4)
  if (step.expect) {
    let expectOk = false;
    try {
      const fn = new Function('before', 'after', `return Boolean(${step.expect});`);
      expectOk = Boolean(fn(beforeSnapshot, afterData.afterSnapshot));
    } catch {
      expectOk = false;
    }
    if (!expectOk) {
      stepErrors.push({
        script: scriptId,
        view,
        stepIndex,
        at: step.at,
        label: step.label || step.call || step.click,
        type: 'step-expect-failed',
        expect: step.expect,
        message: `Step expectation failed at t=${step.at}s (${step.label || step.call || step.click}): ${step.expect}`,
      });
    }
  }
}

/**
 * Full iteration capture (`captureIteration`) (§1.1 - §1.9).
 * Captures:
 * - Cinematic timeline frames & `flight.webm` + motion segment clips
 * - Canvas `shots` (`board-2d`, `terrace-overview`, etc.) and `tileSheet`
 * - Full-page `pageShots` (`ui-2d`, `ui-3d`)
 * - Static `audit.json` (plus per-shot marks if returned by `audit()`)
 * - All gameplay scripts in `config.gameplay.scripts` across `config.gameplay.views`
 * - Determinism verification on masked canvas region
 */
export async function captureIteration(workDir, outDir, config = null, options = {}) {
  const cfg = config || loadLoopConfig(workDir);
  fs.mkdirSync(outDir, { recursive: true });
  const shotsDir = path.join(outDir, 'shots');
  const timelineFramesDir = path.join(outDir, 'frames', 'timeline');
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(timelineFramesDir, { recursive: true });

  const server = options.server || (await startDevServer(workDir, cfg, options));
  const { browser, context, glInfo } = await launchHardwareBrowser(cfg, options);

  try {
    const globalName = cfg.hooks?.global || '__game';
    const timeUnit = cfg.hooks?.timeUnit || 's';
    const toTimeVal = (sec) => (timeUnit === 'ms' ? sec * 1000 : sec);

    // Collect any CSS crop selectors from rubric if present
    const cropSelectors = [];
    const rubricPath = path.join(workDir, cfg.rubric || 'rubric/visual.json');
    if (fs.existsSync(rubricPath)) {
      try {
        const rub = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
        for (const item of rub.items || []) {
          if (typeof item.crop === 'string') cropSelectors.push(item.crop);
        }
      } catch {
        // ignore
      }
    }

    // 1. Cinematic timeline + canvas shots + pageShots + audit
    const { page, consoleErrors, webglWarnings } = await prepareFreshPage(context, cfg, { url: server.url });

    if (cfg.fixture && cfg.hooks?.loadFixture) {
      await page.evaluate(
        ({ gName, fn, fix }) => {
          const api = window[gName];
          if (api && typeof api[fn] === 'function') {
            api[fn](fix);
          }
        },
        { gName: globalName, fn: cfg.hooks.loadFixture, fix: cfg.fixture }
      );
    }

    if (options.perturbation) {
      await applyGoldenPerturbationOnPage(page, globalName, options.perturbation, { phase: 'timeline' });
    }

    const maskAndCrops = await getMaskAndCropRects(page, cfg, cropSelectors);
    const canvasClip = maskAndCrops.canvasRect;

    const fps = cfg.timeline?.fps || 12;
    const segments = cfg.timeline?.segments || [{ id: 'flat', start: 0, end: 3 }];
    const maxEnd = Math.max(...segments.map((s) => s.end));
    const totalTimelineFrames = Math.round(maxEnd * fps);
    const timelineFramePaths = [];
    const timelineMasks = [];

    for (let i = 0; i <= totalTimelineFrames; i++) {
      const tSec = Number((i / fps).toFixed(4));
      await page.evaluate(
        ({ gName, hRenderAt, tVal, sec }) => {
          if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
          const api = window[gName];
          if (api && hRenderAt && typeof api[hRenderAt] === 'function') {
            api[hRenderAt](tVal);
          }
        },
        {
          gName: globalName,
          hRenderAt: cfg.hooks?.renderAt || 'renderAt',
          tVal: toTimeVal(tSec),
          sec: tSec,
        }
      );

      const fPath = path.join(timelineFramesDir, `frame-${String(i).padStart(4, '0')}.png`);
      await page.screenshot({ path: fPath, clip: canvasClip });
      timelineFramePaths.push(fPath);
      timelineMasks.push({ canvasRect: { x: 0, y: 0, width: canvasClip.width, height: canvasClip.height }, overlayRects: [] });
    }

    const timelineDiff = await analyzeFrameSequence(timelineFramePaths, {
      fps,
      grid: cfg.frameDiff?.grid || 8,
      pixelThreshold: cfg.frameDiff?.pixelThreshold ?? 24,
      spikeFactor: cfg.frameDiff?.spikeFactor ?? 4,
      segments,
      maskInfos: timelineMasks,
    });

    const flightWebmPath = path.join(outDir, 'flight.webm');
    const flightStitch = stitchVideo(timelineFramesDir, flightWebmPath, fps);

    const motionSegmentClips = {};
    for (const segId of cfg.timeline?.motionSegments || []) {
      const seg = segments.find((s) => s.id === segId);
      if (seg && flightStitch.ok) {
        const segOut = path.join(outDir, `segment-${segId}.webm`);
        const clipRes = clipVideoSegment(flightWebmPath, segOut, seg.start, seg.end);
        motionSegmentClips[segId] = {
          id: segId,
          start: seg.start,
          end: seg.end,
          path: clipRes.ok ? segOut : flightWebmPath,
        };
      }
    }

    // 2. Canvas shots (`config.shots`) and `tileSheet` (§1.5)
    const shotPaths = {};
    for (const shotName of cfg.shots || []) {
      await page.evaluate(
        ({ gName, hCaptureShot, sName }) => {
          const api = window[gName];
          if (api && hCaptureShot && typeof api[hCaptureShot] === 'function') {
            api[hCaptureShot](sName);
          }
        },
        {
          gName: globalName,
          hCaptureShot: cfg.hooks?.captureShot || 'captureShot',
          sName: shotName,
        }
      );
      if (options.perturbation) {
        await applyGoldenPerturbationOnPage(page, globalName, options.perturbation, { phase: 'shot', shotName });
      }
      const sPath = path.join(shotsDir, `${shotName}.png`);
      await page.screenshot({ path: sPath, clip: canvasClip });
      shotPaths[shotName] = sPath;
    }

    if (cfg.hooks?.tileSheet) {
      const tileSheetDataUrl = await page.evaluate(
        ({ gName, hTileSheet }) => {
          const api = window[gName];
          if (api && typeof api[hTileSheet] === 'function') {
            const c = api[hTileSheet]();
            if (c && typeof c.toDataURL === 'function') {
              return c.toDataURL('image/png');
            }
          }
          return null;
        },
        { gName: globalName, hTileSheet: cfg.hooks.tileSheet }
      );
      if (tileSheetDataUrl && tileSheetDataUrl.startsWith('data:image/png;base64,')) {
        const tsPath = path.join(shotsDir, 'tileSheet.png');
        fs.writeFileSync(
          tsPath,
          Buffer.from(tileSheetDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
        );
        shotPaths.tileSheet = tsPath;
      }
    }

    // 3. Full-page `pageShots` (`ui-2d`, `ui-3d`) (§1.5)
    const selectorRectsByShot = {};
    for (const ps of cfg.pageShots || []) {
      await page.evaluate(
        ({ gName, hSetView, hRenderAt, v, tVal, sec }) => {
          if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
          const api = window[gName];
          if (api && hSetView && typeof api[hSetView] === 'function') {
            api[hSetView](v, true);
          }
          if (api && hRenderAt && typeof api[hRenderAt] === 'function') {
            api[hRenderAt](tVal);
          }
          // Ensure view stays in requested ps.view after renderAt if renderAt changed it
          if (api && hSetView && typeof api[hSetView] === 'function' && api.getView?.() !== v) {
            api[hSetView](v, true);
          }
        },
        {
          gName: globalName,
          hSetView: cfg.hooks?.setView || 'setView',
          hRenderAt: cfg.hooks?.renderAt || 'renderAt',
          v: ps.view,
          tVal: toTimeVal(ps.t),
          sec: ps.t,
        }
      );
      const psMask = await getMaskAndCropRects(page, cfg, cropSelectors);
      selectorRectsByShot[ps.id] = psMask.selectorRects;

      const psPath = path.join(shotsDir, `${ps.id}.png`);
      await page.screenshot({ path: psPath, fullPage: false });
      shotPaths[ps.id] = psPath;
    }

    // 4. Static `audit()` output + console errors -> `audit.json`
    const rawAudit = await page.evaluate(
      ({ gName, hAudit }) => {
        const api = window[gName];
        if (api && hAudit && typeof api[hAudit] === 'function') {
          return api[hAudit]();
        }
        return {};
      },
      { gName: globalName, hAudit: cfg.hooks?.audit || 'audit' }
    );

    // 5. Determinism check: re-render t=1.5s after a wall-clock pause and compare on masked canvas (§1.3 & §1.9)
    await page.evaluate(
      ({ gName, hRenderAt, tVal }) => {
        if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(1.5);
        window[gName]?.[hRenderAt]?.(tVal);
      },
      { gName: globalName, hRenderAt: cfg.hooks?.renderAt || 'renderAt', tVal: toTimeVal(1.5) }
    );
    const detPathA = path.join(outDir, 'det-check-a.png');
    await page.screenshot({ path: detPathA, clip: canvasClip });
    await sleep(60);
    await page.evaluate(
      ({ gName, hRenderAt, tVal }) => {
        if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(1.5);
        window[gName]?.[hRenderAt]?.(tVal);
      },
      { gName: globalName, hRenderAt: cfg.hooks?.renderAt || 'renderAt', tVal: toTimeVal(1.5) }
    );
    const detPathB = path.join(outDir, 'det-check-b.png');
    await page.screenshot({ path: detPathB, clip: canvasClip });
    const detComparison = await compareFramesMasked(detPathA, detPathB, null, 8);
    fs.rmSync(detPathA, { force: true });
    fs.rmSync(detPathB, { force: true });

    await page.close();

    // 6. Gameplay capture for every script and view (§1.6)
    const gameplayResults = {};
    if (!options.skipGameplay) {
      for (const script of cfg.gameplay?.scripts || []) {
        const viewsToRun = script.perView
          ? cfg.gameplay?.views || cfg.views || ['2d', '3d']
          : [script.startView || '2d'];
        gameplayResults[script.id] = {};
        for (const v of viewsToRun) {
          const res = await captureGameplayScriptOnPage(context, cfg, script, v, outDir, {
            url: server.url,
            perturbation: options.perturbation,
          });
          gameplayResults[script.id][v] = res;
        }
      }
    }

    const fullAudit = {
      ...rawAudit,
      consoleErrors,
      webglWarningsCount: (rawAudit.webglWarnings || 0) + webglWarnings.length,
      deterministic: detComparison.match,
      determinismDiffFraction: detComparison.diffFraction,
      glRenderer: glInfo.renderer,
      selectorRectsByShot,
    };

    const auditPath = path.join(outDir, 'audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(fullAudit, null, 2), 'utf8');

    const captureManifest = {
      outDir,
      shotPaths,
      flightWebmPath: flightStitch.ok ? flightWebmPath : null,
      motionSegmentClips,
      timeline: {
        fps,
        segments,
        framePaths: timelineFramePaths,
        blankFrames: timelineDiff.blankFrames,
        frameDiffSpikes: timelineDiff.spikes,
      },
      gameplay: gameplayResults,
      audit: fullAudit,
    };

    fs.writeFileSync(
      path.join(outDir, 'capture-manifest.json'),
      JSON.stringify(captureManifest, null, 2),
      'utf8'
    );

    return captureManifest;
  } finally {
    await browser.close();
    if (!options.server) {
      await server.stop();
    }
  }
}

/**
 * Cheap single-image capture path (`captureShot(workDir, shotId | {t} | {script, view, t})`) (§1.10).
 * Page shots and gameplay frames come back full-page, exactly as the judges see them.
 */
export async function captureShot(workDir, target, options = {}) {
  const cfg = options.config || loadLoopConfig(workDir);
  const outDir = options.outDir || path.join(workDir, 'runs', 'preview');
  fs.mkdirSync(outDir, { recursive: true });

  const server = options.server || (await startDevServer(workDir, cfg, options));
  const { browser, context } = await launchHardwareBrowser(cfg, options);

  try {
    const { page } = await prepareFreshPage(context, cfg, { url: server.url });
    const globalName = cfg.hooks?.global || '__game';
    const timeUnit = cfg.hooks?.timeUnit || 's';
    const toTimeVal = (sec) => (timeUnit === 'ms' ? sec * 1000 : sec);

    if (cfg.fixture && cfg.hooks?.loadFixture) {
      await page.evaluate(
        ({ gName, fn, fix }) => {
          window[gName]?.[fn]?.(fix);
        },
        { gName: globalName, fn: cfg.hooks.loadFixture, fix: cfg.fixture }
      );
    }

    const maskInfo = await getMaskAndCropRects(page, cfg);
    const canvasClip = maskInfo.canvasRect;

    // Normalize target
    const norm =
      typeof target === 'string'
        ? { shotId: target }
        : typeof target === 'number'
          ? { t: target }
          : target || {};

    if (norm.script) {
      const script = (cfg.gameplay?.scripts || []).find((s) => s.id === norm.script);
      if (!script) {
        throw new Error(`Unknown gameplay script '${norm.script}' in captureShot`);
      }
      const view = norm.view || script.startView || '2d';
      const targetT = Number(norm.t ?? script.duration);
      const fps = cfg.gameplay?.fps || 12;

      await page.evaluate(
        ({ gName, hSetView, hPlayAt, v }) => {
          if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(0);
          window[gName]?.[hSetView]?.(v, true);
          window[gName]?.[hPlayAt]?.(0);
        },
        {
          gName: globalName,
          hSetView: cfg.hooks?.setView || 'setView',
          hPlayAt: cfg.hooks?.playAt || 'playAt',
          v: view,
        }
      );

      const sortedSteps = [...(script.steps || [])].sort((a, b) => a.at - b.at);
      const applied = new Set();
      const maxFrame = Math.round(targetT * fps);

      for (let f = 0; f <= maxFrame; f++) {
        const curT = Number((f / fps).toFixed(4));
        for (let sIdx = 0; sIdx < sortedSteps.length; sIdx++) {
          if (applied.has(sIdx)) continue;
          const st = sortedSteps[sIdx];
          if (curT + 1e-6 >= st.at) {
            applied.add(sIdx);
            if (st.call) {
              const fnName = cfg.hooks?.[st.call] || st.call;
              await page.evaluate(
                async ({ gName, fn, args }) => {
                  await window[gName]?.[fn]?.(...(args || []));
                },
                { gName: globalName, fn: fnName, args: st.args || [] }
              );
            } else if (st.click) {
              await page.locator(st.click).click({ timeout: 2000 });
            }
          }
        }
        await page.evaluate(
          ({ gName, hPlayAt, tVal, sec }) => {
            if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
            window[gName]?.[hPlayAt]?.(tVal);
          },
          {
            gName: globalName,
            hPlayAt: cfg.hooks?.playAt || 'playAt',
            tVal: toTimeVal(curT),
            sec: curT,
          }
        );
      }

      const outPath = path.join(outDir, `preview-${norm.script}-${view}-${targetT}.png`);
      // Gameplay frames come back full-page (§1.10)
      await page.screenshot({ path: outPath, fullPage: false });
      await page.close();
      return { path: outPath, fullPage: true, kind: 'gameplay' };
    }

    if (typeof norm.t === 'number' && !norm.shotId) {
      await page.evaluate(
        ({ gName, hRenderAt, tVal, sec }) => {
          if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
          window[gName]?.[hRenderAt]?.(tVal);
        },
        {
          gName: globalName,
          hRenderAt: cfg.hooks?.renderAt || 'renderAt',
          tVal: toTimeVal(norm.t),
          sec: norm.t,
        }
      );
      const outPath = path.join(outDir, `preview-t-${norm.t}.png`);
      await page.screenshot({ path: outPath, clip: canvasClip });
      await page.close();
      return { path: outPath, fullPage: false, kind: 'timeline' };
    }

    const shotId = norm.shotId || 'terrace-overview';
    const pageShot = (cfg.pageShots || []).find((ps) => ps.id === shotId);

    if (pageShot) {
      await page.evaluate(
        ({ gName, hSetView, hRenderAt, v, tVal, sec }) => {
          if (window.__setVirtualTimeSeconds) window.__setVirtualTimeSeconds(sec);
          window[gName]?.[hSetView]?.(v, true);
          window[gName]?.[hRenderAt]?.(tVal);
          if (window[gName]?.getView?.() !== v) {
            window[gName]?.[hSetView]?.(v, true);
          }
        },
        {
          gName: globalName,
          hSetView: cfg.hooks?.setView || 'setView',
          hRenderAt: cfg.hooks?.renderAt || 'renderAt',
          v: pageShot.view,
          tVal: toTimeVal(pageShot.t),
          sec: pageShot.t,
        }
      );
      const outPath = path.join(outDir, `preview-${shotId}.png`);
      // Page shots come back full-page (§1.10)
      await page.screenshot({ path: outPath, fullPage: false });
      await page.close();
      return { path: outPath, fullPage: true, kind: 'pageShot' };
    }

    if (shotId === 'tileSheet' && cfg.hooks?.tileSheet) {
      const dataUrl = await page.evaluate(
        ({ gName, fn }) => {
          const c = window[gName]?.[fn]?.();
          return c?.toDataURL?.('image/png') || null;
        },
        { gName: globalName, fn: cfg.hooks.tileSheet }
      );
      const outPath = path.join(outDir, 'preview-tileSheet.png');
      if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
        fs.writeFileSync(outPath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
      } else {
        await page.screenshot({ path: outPath, clip: canvasClip });
      }
      await page.close();
      return { path: outPath, fullPage: false, kind: 'tileSheet' };
    }

    await page.evaluate(
      ({ gName, hCaptureShot, sId }) => {
        window[gName]?.[hCaptureShot]?.(sId);
      },
      {
        gName: globalName,
        hCaptureShot: cfg.hooks?.captureShot || 'captureShot',
        sId: shotId,
      }
    );
    const outPath = path.join(outDir, `preview-${shotId}.png`);
    await page.screenshot({ path: outPath, clip: canvasClip });
    await page.close();
    return { path: outPath, fullPage: false, kind: 'shot' };
  } finally {
    await browser.close();
    if (!options.server) {
      await server.stop();
    }
  }
}
