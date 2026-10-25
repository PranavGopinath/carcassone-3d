/**
 * 3D Diorama Renderer for Tiers (Carcassonne-3D)
 * Owned by: render_engineer (`src/render/renderer.ts`)
 */

import * as THREE from 'three';
import {
  AuditReport,
  DIR_OFFSETS,
  DirIndex,
  EdgeType,
  GameState,
  LEVEL_HEIGHT,
  LegalMove,
  PlacedTile,
  QualityMode,
  REQUIRED_SHOTS,
  Rotation,
  ShotName,
  ThemeMode,
  TileSpec,
  ViewMode,
  getRotatedEdgeLevels,
  getRotatedEdges,
} from '../contracts';
import { paintTile } from '../tiles/painter';
import {
  getBridgeDeckHeight,
  getEdgeWorldHeight,
  getPropElevation,
  tileHeight,
} from '../tiles/families/index';

export interface DioramaRendererOptions {
  onSelectMove?: (move: LegalMove) => void;
  inspectMode?: boolean;
  width?: number;
  height?: number;
}

export interface DioramaRenderer {
  syncState(state: GameState, legalMoves?: LegalMove[]): void;
  setView(mode: ViewMode, immediate?: boolean): void;
  getView(): ViewMode;
  setTheme(theme: ThemeMode): void;
  setQuality(quality: QualityMode): void;
  startOrbitFlythrough(durationMs?: number): Promise<void>;
  renderAt(tSeconds: number): void;
  listShots(): ShotName[];
  captureShot(name: ShotName): string;
  audit(): AuditReport;
  pickGhostEdgeAtClientPoint?(
    clientX: number,
    clientY: number
  ): { move: LegalMove; edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> } | null;
  dispose(): void;
}

const BASE_SLAB_Y = -1.2;
const SUBDIVISIONS = 16;
const MORPH_DURATION_MS = 1400;
const FOV_2D = 8;
const FOV_3D = 45;
const TILT_3D_RAD = THREE.MathUtils.degToRad(35);

// 1x1 valid transparent-ish fallback PNG if canvas toDataURL is unavailable in headless Node
const FALLBACK_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function easeInOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

interface ThemeConfig {
  background: number;
  fogColor: number;
  ambientColor: number;
  ambientIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  sunPos: [number, number, number];
  rimColor: number;
  rimIntensity: number;
}

const THEMES: Record<ThemeMode, ThemeConfig> = {
  day: {
    background: 0xa8c3dc,
    fogColor: 0xc8d9ea,
    ambientColor: 0xfffbf2,
    ambientIntensity: 0.62,
    hemiSky: 0xdbeafe,
    hemiGround: 0x6b5c4c,
    hemiIntensity: 0.78,
    sunColor: 0xfff3db,
    sunIntensity: 1.65,
    sunPos: [10, 14, 8],
    rimColor: 0xbcd8f8,
    rimIntensity: 0.52,
  },
  golden: {
    background: 0xd4a383,
    fogColor: 0xd4a383,
    ambientColor: 0xfde68a,
    ambientIntensity: 0.52,
    hemiSky: 0xfdba74,
    hemiGround: 0x45271d,
    hemiIntensity: 0.65,
    sunColor: 0xfb923c,
    sunIntensity: 1.75,
    sunPos: [13, 9, 6],
    rimColor: 0xf472b6,
    rimIntensity: 0.45,
  },
  overcast: {
    background: 0x94a9be,
    fogColor: 0x94a9be,
    ambientColor: 0xe2e8f0,
    ambientIntensity: 0.78,
    hemiSky: 0xcbd5e1,
    hemiGround: 0x475569,
    hemiIntensity: 0.8,
    sunColor: 0xf8fafc,
    sunIntensity: 0.95,
    sunPos: [5, 16, 4],
    rimColor: 0x94a3b8,
    rimIntensity: 0.4,
  },
};

function hash2D(ix: number, iy: number, seed: number): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbmSmooth(x: number, y: number, seed: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    val += amp * valueNoise2D(x * freq, y * freq, seed + i * 19.3);
    freq *= 2.03;
    amp *= 0.5;
  }
  return val;
}

function fbmSoftBillow(x: number, y: number, seed: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, y * freq, seed + i * 23.7) * 2.0 - 1.0;
    const billow = 1.0 - Math.sqrt(n * n + 0.035);
    val += amp * billow;
    freq *= 2.05;
    amp *= 0.5;
  }
  return val;
}

function smax(a: number, b: number, k = 10.5): number {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) * k));
  return a * (1 - h) + b * h + (0.25 / k) * h * (1 - h);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface CloudPuffSpec {
  x: number;
  y: number;
  r: number;
  h: number;
  shadeBias?: number;
}

/**
 * Renders a volumetric, FBM-textured 3D cumulus cloud cluster matching `reference/Design_of_game.jpeg`.
 * Uses intersecting 3D spherical domes, billowy cauliflower relief, raymarched self-shadowing,
 * inter-lobe crease ambient occlusion, and optical-thickness edge feathering.
 */
function paintSculpted3DCloud(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  mainPuffs: CloudPuffSpec[],
  shadowStrength = 1.0,
  warmBoost = 0.0
) {
  const puffs = mainPuffs.map((p) => ({ ...p, shadeBias: p.shadeBias ?? 0 }));

  // Generate secondary cauliflower sub-lobes (plump, rounded turrets)
  for (let i = 0; i < mainPuffs.length; i++) {
    const p = mainPuffs[i];
    const subCount = 4;
    for (let j = 0; j < subCount; j++) {
      const idx = i * subCount + j;
      const ang = (j / subCount) * Math.PI * 2 + (hash2D(idx, 1, seed) - 0.5) * 0.85;
      const dist = p.r * (0.38 + hash2D(idx, 2, seed) * 0.36);
      const sr = p.r * (0.46 + hash2D(idx, 3, seed) * 0.24);
      puffs.push({
        x: p.x + Math.cos(ang) * dist,
        y: p.y + Math.sin(ang) * dist * 0.88,
        r: sr,
        h: p.h * (0.72 + hash2D(idx, 4, seed) * 0.24),
        shadeBias: (p.shadeBias ?? 0) + (Math.sin(ang) * 0.09 - Math.cos(ang) * 0.09),
      });
    }
  }

  const padX = Math.ceil(rx * 1.65);
  const padY = Math.ceil(ry * 1.65);
  const x0 = Math.max(0, Math.floor(cx - padX));
  const y0 = Math.max(0, Math.floor(cy - padY));
  const x1 = Math.min(canvasWidth, Math.ceil(cx + padX));
  const y1 = Math.min(canvasHeight, Math.ceil(cy + padY));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;

  const imgData = ctx.getImageData(x0, y0, bw, bh);
  const data = imgData.data;

  const scale = Math.min(rx, ry);
  const H = new Float32Array(bw * bh);
  const D = new Float32Array(bw * bh);
  const NX = new Float32Array(bw * bh);
  const NY = new Float32Array(bw * bh);
  const BIAS = new Float32Array(bw * bh);

  for (let py = 0; py < bh; py++) {
    const v = (y0 + py - cy) / ry;
    const rowOff = py * bw;
    for (let px = 0; px < bw; px++) {
      const u = (x0 + px - cx) / rx;

      // Organic FBM domain warp for fluffy cumulus contours
      const wx = (fbmSmooth(u * 2.1, v * 2.1, seed + 1.3, 3) - 0.5) * 0.24;
      const wy = (fbmSmooth(u * 2.1 + 4.1, v * 2.1 + 2.9, seed + 2.7, 3) - 0.5) * 0.24;
      const wu = u + wx;
      const wv = v + wy;

      let maxH = 0;
      let maxRem = 0;
      let weightedNx = 0;
      let weightedNy = 0;
      let weightedBias = 0;
      let weightSum = 0;

      for (let i = 0; i < puffs.length; i++) {
        const P = puffs[i];
        const dx = (wu - P.x) / P.r;
        const dy = (wv - P.y) / P.r;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1.0) {
          const dist = Math.sqrt(d2);
          const linearRem = 1.0 - dist;
          const rem = 1.0 - d2;
          const sphereZ = P.h * Math.sqrt(rem);
          maxH = maxH === 0 ? sphereZ : smax(maxH, sphereZ, 10.5);
          if (linearRem * P.h > maxRem) {
            maxRem = linearRem * P.h;
          }

          const w = Math.exp(sphereZ * 6.0) * rem * rem;
          weightedNx += dx * P.h * w;
          weightedNy += dy * P.h * w;
          weightedBias += (P.shadeBias ?? 0) * w;
          weightSum += w;
        }
      }

      if (maxRem <= 0.001) continue;

      // Multi-octave billowy turbulence & wispy edge erosion
      const softBillow = fbmSoftBillow(wu * 3.2, wv * 3.2, seed + 8.5, 4);
      const wispyFbm = fbmSmooth(wu * 4.8, wv * 4.8, seed + 19.1, 4);
      const fineFbm = fbmSmooth(wu * 9.5, wv * 9.5, seed + 31.4, 3);

      const edgeNoise = (wispyFbm - 0.48) * 0.24 + (fineFbm - 0.5) * 0.09;
      const rawRem = maxRem + edgeNoise * Math.min(1, maxRem * 2.2);
      const edgeAlpha = smoothstep(0.0, 0.46, rawRem);
      if (edgeAlpha <= 0.002) continue;

      const totalH =
        maxH * (0.84 + 0.16 * softBillow) +
        (softBillow - 0.48) * 0.11 * edgeAlpha +
        (fineFbm - 0.5) * 0.032 * edgeAlpha;

      H[rowOff + px] = Math.max(0, totalH);
      D[rowOff + px] = edgeAlpha;
      if (weightSum > 0) {
        NX[rowOff + px] = weightedNx / weightSum;
        NY[rowOff + px] = weightedNy / weightSum;
        BIAS[rowOff + px] = weightedBias / weightSum;
      }
    }
  }

  // Sun direction vector (from upper-right, elevated — matching Design_of_game.jpeg)
  const sunX = 0.68;
  const sunY = -0.54;
  const sunZ = 0.49;
  const stepScale = scale * 0.055;
  const stepB = Math.max(2, Math.round(scale * 0.03));
  const aoStep1 = Math.max(3, Math.round(scale * 0.055));
  const aoStep2 = Math.max(6, Math.round(scale * 0.115));

  for (let py = 0; py < bh; py++) {
    const rowOff = py * bw;
    const v = (y0 + py - cy) / ry;
    for (let px = 0; px < bw; px++) {
      const alphaMask = D[rowOff + px];
      if (alphaMask <= 0.002) continue;

      const hCenter = H[rowOff + px];
      const u = (x0 + px - cx) / rx;

      // Optical thickness: thin outer vapor transmits ambient sky/sunlight; dense interior holds deep 3D relief
      const coreThickness = smoothstep(0.15, 0.82, alphaMask);

      // 1. Combine analytical puff normal with interior billow derivative
      const hR = H[rowOff + Math.min(bw - 1, px + stepB)] || hCenter;
      const hL = H[rowOff + Math.max(0, px - stepB)] || hCenter;
      const hU = H[Math.max(0, py - stepB) * bw + px] || hCenter;
      const hD = H[Math.min(bh - 1, py + stepB) * bw + px] || hCenter;

      const bScale = (scale / (2.0 * stepB * 1.85)) * coreThickness;
      let nx = (NX[rowOff + px] * 0.7 - (hR - hL) * bScale * 0.55) * coreThickness;
      let ny = (NY[rowOff + px] * 0.7 - (hD - hU) * bScale * 0.55) * coreThickness;
      let nz = 0.8;
      const nLen = Math.hypot(nx, ny, nz) || 1.0;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      const rawNdotL = nx * sunX + ny * sunY + nz * sunZ;
      const wrappedDiffuse = Math.max(0, Math.min(1, (rawNdotL + 0.4) / 1.4));

      // 2. Crease Ambient Occlusion inside valleys between overlapping puffs
      const nR1 = H[rowOff + Math.min(bw - 1, px + aoStep1)] || hCenter;
      const nL1 = H[rowOff + Math.max(0, px - aoStep1)] || hCenter;
      const nU1 = H[Math.max(0, py - aoStep1) * bw + px] || hCenter;
      const nD1 = H[Math.min(bh - 1, py + aoStep1) * bw + px] || hCenter;
      const avgNear = 0.25 * (nR1 + nL1 + nU1 + nD1);

      const nR2 = H[rowOff + Math.min(bw - 1, px + aoStep2)] || hCenter;
      const nL2 = H[rowOff + Math.max(0, px - aoStep2)] || hCenter;
      const nU2 = H[Math.max(0, py - aoStep2) * bw + px] || hCenter;
      const nD2 = H[Math.min(bh - 1, py + aoStep2) * bw + px] || hCenter;
      const avgFar = 0.25 * (nR2 + nL2 + nU2 + nD2);

      const valleyDepth =
        (Math.max(0, avgNear - hCenter) * 3.4 + Math.max(0, avgFar - hCenter) * 2.2) *
        coreThickness;
      const creaseAO = Math.exp(-valleyDepth * 2.6 * shadowStrength);

      // 3. Soft 3D Raymarched Self-Shadow toward the upper-right sun
      let shadowOcc = 0;
      for (let s = 1; s <= 6; s++) {
        const distPx = s * stepScale;
        const sx = Math.min(bw - 1, Math.max(0, Math.round(px + sunX * distPx)));
        const sy = Math.min(bh - 1, Math.max(0, Math.round(py + sunY * distPx)));
        const sampleH = H[sy * bw + sx] * D[sy * bw + sx];
        const rayH = hCenter * alphaMask + (sunZ * distPx) / (scale * 1.35);
        if (sampleH > rayH) {
          shadowOcc += (sampleH - rayH) * 1.5;
        }
      }
      const selfShadow = Math.exp(-shadowOcc * 1.45 * shadowStrength * coreThickness);

      // 4. Macro cloud light + internal FBM texture modulation
      const fineVapor = fbmSmooth(u * 8.5, v * 8.5, seed + 41.2, 3) - 0.5;
      const globalLight = Math.max(
        0,
        Math.min(
          1,
          0.56 + u * 0.24 - v * 0.28 - BIAS[rowOff + px] * 0.38 * coreThickness + fineVapor * 0.08
        )
      );

      const coreLight =
        (wrappedDiffuse * 0.54 + globalLight * 0.32 + Math.min(1, hCenter * 0.55) * 0.14) *
        (0.3 + 0.7 * selfShadow) *
        (0.36 + 0.64 * creaseAO);

      // At thin outer vapor edges, lift light toward warm sunlit/ambient mist so edges dissolve softly
      const edgeMistLight = 0.74 + 0.2 * Math.max(-0.4, Math.min(1, u * 0.55 - v * 0.55));
      const totalLight = Math.max(
        0,
        Math.min(1, coreLight * coreThickness + edgeMistLight * (1.0 - coreThickness))
      );

      // 5. Warm color ramp matching Design_of_game.jpeg
      let r: number;
      let g: number;
      let b: number;
      const shR = Math.max(102, Math.round(122 - (shadowStrength - 0.85) * 44));
      const shG = Math.max(120, Math.round(142 - (shadowStrength - 0.85) * 38));
      const shB = Math.max(142, Math.round(164 - (shadowStrength - 0.85) * 28));

      if (totalLight < 0.36) {
        const t = totalLight / 0.36;
        const st = t * t * (3 - 2 * t);
        r = shR + (176 - shR) * st;
        g = shG + (175 - shG) * st;
        b = shB + (185 - shB) * st;
      } else if (totalLight < 0.68) {
        const t = (totalLight - 0.36) / 0.32;
        const st = t * t * (3 - 2 * t);
        r = 176 + (234 - 176) * st;
        g = 175 + (221 - 175) * st;
        b = 185 + (212 - 185) * st;
      } else {
        const t = (totalLight - 0.68) / 0.32;
        const st = t * (2 - t);
        r = 234 + (255 - 234) * st;
        g = 221 + (249 - 221) * st;
        b = 212 + (238 - 212) * st;
      }

      if (warmBoost > 0) {
        r = Math.min(255, r + warmBoost * 8);
        b = Math.max(0, b - warmBoost * 10);
      }

      const alpha = Math.pow(alphaMask, 1.45) * 0.96;
      const idx = (rowOff + px) * 4;
      const bgR = data[idx];
      const bgG = data[idx + 1];
      const bgB = data[idx + 2];

      data[idx] = Math.round(bgR + (r - bgR) * alpha);
      data[idx + 1] = Math.round(bgG + (g - bgG) * alpha);
      data[idx + 2] = Math.round(bgB + (b - bgB) * alpha);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, x0, y0);
}

/**
 * Generates the subtle, warm daylight sky + fewer, richly textured 3D cumulus clouds background texture
 * matching `reference/Design_of_game.jpeg`.
 */
function createCloudSkyTexture(theme: ThemeMode = 'day', compact = false): THREE.CanvasTexture {
  const w = compact ? 640 : 1280;
  const h = compact ? 400 : 800;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // 1. Subtle, warm, low-grey daylight sky gradient (soft warm powder sky-blue -> warm sunlit cream in upper-right)
    const skyGrad = ctx.createLinearGradient(0, h * 0.85, w, h * 0.08);
    if (theme === 'golden') {
      skyGrad.addColorStop(0, '#96b4cc');
      skyGrad.addColorStop(0.38, '#bfaebb');
      skyGrad.addColorStop(0.75, '#e8c4a8');
      skyGrad.addColorStop(1, '#fae4cc'.replace(/[^#0-9a-fA-F]/g, ''));
    } else if (theme === 'overcast') {
      skyGrad.addColorStop(0, '#a2b8cb');
      skyGrad.addColorStop(0.55, '#bfd0de');
      skyGrad.addColorStop(1, '#e4e8ec');
    } else {
      skyGrad.addColorStop(0, '#acc7da');
      skyGrad.addColorStop(0.35, '#b8d0e0');
      skyGrad.addColorStop(0.68, '#c9dce7');
      skyGrad.addColorStop(0.88, '#dce4e7');
      skyGrad.addColorStop(1, '#ede8df');
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Soft warm golden-cream sunlight bloom in the upper-right corner (matching Design_of_game.jpeg)
    const sunGlow = ctx.createRadialGradient(w * 0.95, h * 0.08, 10, w * 0.88, h * 0.18, w * 0.72);
    sunGlow.addColorStop(0, 'rgba(255, 248, 236, 0.58)');
    sunGlow.addColorStop(0.42, 'rgba(250, 240, 226, 0.26)');
    sunGlow.addColorStop(0.78, 'rgba(244, 236, 224, 0.08)');
    sunGlow.addColorStop(1, 'rgba(244, 236, 224, 0)');
    ctx.fillStyle = sunGlow;
    ctx.fillRect(0, 0, w, h);

    // 3. Fewer, richly textured peripheral 3D cumulus clouds matching Design_of_game.jpeg
    const clouds: Array<{
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      seed: number;
      shadow: number;
      puffs: CloudPuffSpec[];
    }> = [
      // 1. Top-left wide cumulus cluster
      {
        cx: w * 0.23,
        cy: h * 0.055,
        rx: w * 0.135,
        ry: h * 0.092,
        seed: 1.7,
        shadow: 0.85,
        puffs: [
          { x: -0.62, y: 0.14, r: 0.44, h: 0.62, shadeBias: 0.15 },
          { x: -0.3, y: -0.04, r: 0.56, h: 0.82, shadeBias: 0.05 },
          { x: 0.06, y: -0.14, r: 0.6, h: 0.92, shadeBias: -0.08 },
          { x: 0.4, y: -0.02, r: 0.52, h: 0.78, shadeBias: -0.1 },
          { x: 0.7, y: 0.16, r: 0.4, h: 0.58, shadeBias: -0.05 },
          { x: -0.12, y: 0.22, r: 0.5, h: 0.72, shadeBias: 0.22 },
          { x: 0.24, y: 0.2, r: 0.46, h: 0.66, shadeBias: 0.1 },
        ],
      },
      // 2. Far mid-left small puff
      {
        cx: w * 0.038,
        cy: h * 0.255,
        rx: w * 0.062,
        ry: h * 0.058,
        seed: 4.3,
        shadow: 0.72,
        puffs: [
          { x: -0.38, y: 0.12, r: 0.5, h: 0.64, shadeBias: 0.1 },
          { x: 0.02, y: -0.1, r: 0.6, h: 0.84, shadeBias: -0.08 },
          { x: 0.42, y: 0.14, r: 0.46, h: 0.62, shadeBias: -0.05 },
          { x: 0.06, y: 0.2, r: 0.48, h: 0.66, shadeBias: 0.12 },
        ],
      },
      // 3. Top-right hero cumulus cloud
      {
        cx: w * 0.815,
        cy: h * 0.175,
        rx: w * 0.145,
        ry: h * 0.128,
        seed: 7.9,
        shadow: 0.92,
        puffs: [
          { x: -0.58, y: 0.1, r: 0.46, h: 0.68, shadeBias: 0.2 },
          { x: -0.24, y: 0.02, r: 0.54, h: 0.82, shadeBias: 0.12 },
          { x: 0.14, y: -0.2, r: 0.6, h: 0.98, shadeBias: -0.12 },
          { x: 0.46, y: 0.04, r: 0.5, h: 0.84, shadeBias: -0.14 },
          { x: 0.84, y: 0.36, r: 0.34, h: 0.54, shadeBias: -0.1 },
          { x: -0.06, y: 0.24, r: 0.54, h: 0.78, shadeBias: 0.24 },
          { x: 0.28, y: 0.24, r: 0.48, h: 0.72, shadeBias: 0.08 },
        ],
      },
      // 4a. Bottom-left upper shaded cumulus puff
      {
        cx: w * 0.205,
        cy: h * 0.745,
        rx: w * 0.098,
        ry: h * 0.092,
        seed: 11.2,
        shadow: 1.15,
        puffs: [
          { x: -0.44, y: 0.08, r: 0.5, h: 0.72, shadeBias: 0.32 },
          { x: -0.04, y: -0.14, r: 0.6, h: 0.9, shadeBias: 0.12 },
          { x: 0.36, y: 0.06, r: 0.5, h: 0.76, shadeBias: -0.05 },
          { x: -0.08, y: 0.24, r: 0.54, h: 0.78, shadeBias: 0.36 },
          { x: 0.22, y: 0.24, r: 0.44, h: 0.66, shadeBias: 0.18 },
        ],
      },
      // 4b. Bottom-left lower warm base cumulus cluster
      {
        cx: w * 0.255,
        cy: h * 0.935,
        rx: w * 0.14,
        ry: h * 0.1,
        seed: 14.6,
        shadow: 0.82,
        puffs: [
          { x: -0.56, y: 0.14, r: 0.48, h: 0.66, shadeBias: 0.14 },
          { x: -0.18, y: -0.12, r: 0.6, h: 0.9, shadeBias: -0.06 },
          { x: 0.22, y: -0.08, r: 0.56, h: 0.86, shadeBias: -0.1 },
          { x: 0.56, y: 0.14, r: 0.46, h: 0.68, shadeBias: -0.08 },
          { x: 0.02, y: 0.22, r: 0.54, h: 0.76, shadeBias: 0.16 },
        ],
      },
      // 5. Bottom-right hero cumulus cluster
      {
        cx: w * 0.78,
        cy: h * 0.765,
        rx: w * 0.145,
        ry: h * 0.135,
        seed: 18.4,
        shadow: 0.94,
        puffs: [
          { x: -0.52, y: 0.1, r: 0.46, h: 0.7, shadeBias: 0.22 },
          { x: -0.14, y: -0.18, r: 0.6, h: 0.96, shadeBias: -0.08 },
          { x: 0.24, y: -0.12, r: 0.58, h: 0.94, shadeBias: -0.14 },
          { x: 0.5, y: 0.12, r: 0.48, h: 0.78, shadeBias: -0.1 },
          { x: -0.12, y: 0.26, r: 0.54, h: 0.82, shadeBias: 0.26 },
          { x: 0.22, y: 0.28, r: 0.5, h: 0.76, shadeBias: 0.12 },
          { x: -0.78, y: -0.12, r: 0.28, h: 0.48, shadeBias: 0.18 },
        ],
      },
    ];

    const warmBoost = theme === 'golden' ? 1.0 : 0.0;
    for (const c of clouds) {
      paintSculpted3DCloud(
        ctx,
        w,
        h,
        c.cx,
        c.cy,
        c.rx,
        c.ry,
        c.seed,
        c.puffs,
        c.shadow,
        warmBoost
      );
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates the realistic stratified geological soil, ochre sandstone, and slate-blue bedrock vein texture
 * matching the floating island cliff cross-section in `reference/Design_of_game.jpeg`.
 */
function createStrataRockTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // Base warm earthen ochre
    ctx.fillStyle = '#8c5d38';
    ctx.fillRect(0, 0, size, size);

    // Stratified geological layers (top y=0 is top rim under grass; bottom is slab base)
    const bands = [
      { y: 0, h: 26, color: '#3b4f26' },   // Overhanging turf & moss rim
      { y: 26, h: 28, color: '#4d3926' },  // Dark humus & topsoil root zone
      { y: 54, h: 52, color: '#9e6b40' },  // Warm sunlit ochre clay & loam
      { y: 106, h: 48, color: '#b47d4e' }, // Golden sandstone crag
      { y: 154, h: 44, color: '#875632' }, // Deep burnt sienna fracture band
      { y: 198, h: 58, color: '#a67246' }, // Craggy brown sedimentary rock
      { y: 256, h: 38, color: '#5c4636' }, // Dark transition shale
      { y: 294, h: 48, color: '#47617a' }, // Distinct slate-blue bedrock vein (from Design_of_game.jpeg!)
      { y: 342, h: 46, color: '#587591' }, // Highlighted blue-grey quartz/slate vein
      { y: 388, h: 36, color: '#394f63' }, // Deep slate-blue lower bedding plane
      { y: 424, h: 46, color: '#6b523c' }, // Lower weathered brownstone
      { y: 470, h: 42, color: '#473628' }, // Dark basal bedrock
    ];

    for (const b of bands) {
      ctx.fillStyle = b.color;
      ctx.fillRect(0, b.y, size, b.h);

      // Irregular craggy horizon shadow between strata
      ctx.fillStyle = 'rgba(20, 14, 10, 0.42)';
      ctx.beginPath();
      ctx.moveTo(0, b.y);
      for (let x = 0; x <= size; x += 16) {
        const wave = Math.sin(x * 0.045 + b.y * 0.1) * 4 + Math.cos(x * 0.11 - b.y) * 2.5;
        ctx.lineTo(x, b.y + wave);
      }
      ctx.lineTo(size, b.y + 6);
      ctx.lineTo(0, b.y + 6);
      ctx.closePath();
      ctx.fill();
    }

    // Craggy rock blocks, pebbles, and diagonal geological fissures
    for (let i = 0; i < 650; i++) {
      const rx = (i * 97) % size;
      const ry = (i * 173) % size;
      const rw = 6 + (i % 24);
      const rh = 4 + (i % 12);
      const inBlueVein = ry >= 290 && ry <= 415;

      if (i % 3 === 0) {
        ctx.fillStyle = inBlueVein ? 'rgba(130, 168, 204, 0.24)' : 'rgba(235, 190, 140, 0.22)';
      } else if (i % 3 === 1) {
        ctx.fillStyle = 'rgba(22, 16, 12, 0.28)';
      } else {
        ctx.fillStyle = inBlueVein ? 'rgba(48, 72, 96, 0.25)' : 'rgba(128, 78, 42, 0.22)';
      }
      ctx.fillRect(rx, ry, rw, rh);
    }

    // Diagonal rock fractures & root crevices
    ctx.strokeStyle = 'rgba(18, 12, 8, 0.45)';
    ctx.lineWidth = 2;
    for (let f = 0; f < 48; f++) {
      const sx = (f * 83) % size;
      const sy = 24 + ((f * 131) % (size - 48));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + ((f % 2 === 0 ? 1 : -1) * (14 + (f % 18))), sy + 22 + (f % 20));
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a high-contrast bump map for the craggy stratified cliff faces and terrain micro-relief.
 */
function createStrataBumpTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    for (let y = 0; y < size; y += 14) {
      ctx.fillStyle = y % 28 === 0 ? '#a8a8a8' : '#525252';
      ctx.fillRect(0, y, size, 7);
    }

    for (let i = 0; i < 500; i++) {
      const rx = (i * 67) % size;
      const ry = (i * 139) % size;
      const rw = 4 + (i % 16);
      const rh = 3 + (i % 10);
      ctx.fillStyle = i % 2 === 0 ? '#d4d4d4' : '#2e2e2e';
      ctx.fillRect(rx, ry, rw, rh);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a carved dark stone & bedrock texture for the underside plinth slab.
 */
function createUndersidePlinthTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#3d332a';
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = '#52453a';
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, size - 20, size - 20);

    ctx.fillStyle = '#473c32';
    ctx.fillRect(24, 24, size - 48, size - 48);

    ctx.strokeStyle = '#2b231c';
    ctx.lineWidth = 2;
    for (let k = 32; k < size; k += 32) {
      ctx.beginPath();
      ctx.moveTo(k, 0);
      ctx.lineTo(k, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, k);
      ctx.lineTo(size, k);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates a floating level badge texture (`L-1`, `L0`, `L+1`).
 */
function createLevelBadgeTexture(level: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const label = level > 0 ? `L+${level}` : `L${level}`;
    const bgColor = level < 0 ? '#0284c7' : level > 0 ? '#d97706' : '#15803d';
    const borderColor = level < 0 ? '#7dd3fc' : level > 0 ? '#fde68a' : '#86efac';

    ctx.clearRect(0, 0, 128, 64);
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 4;

    const r = 18;
    ctx.beginPath();
    ctx.moveTo(12 + r, 10);
    ctx.lineTo(116 - r, 10);
    ctx.quadraticCurveTo(116, 10, 116, 10 + r);
    ctx.lineTo(116, 54 - r);
    ctx.quadraticCurveTo(116, 54, 116 - r, 54);
    ctx.lineTo(12 + r, 54);
    ctx.quadraticCurveTo(12, 54, 12, 54 - r);
    ctx.lineTo(12, 10 + r);
    ctx.quadraticCurveTo(12, 10, 12 + r, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 64, 33);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createDioramaRenderer(
  container: HTMLElement,
  options: DioramaRendererOptions = {}
): DioramaRenderer {
  const initWidth = options.width || container.clientWidth || window.innerWidth || 1280;
  const initHeight = options.height || container.clientHeight || window.innerHeight || 720;
  const inspectMode = Boolean(options.inspectMode);

  const scene = new THREE.Scene();
  const skyTextureCache = new Map<ThemeMode, THREE.CanvasTexture>();
  function getSkyTexture(theme: ThemeMode): THREE.CanvasTexture {
    const cached = skyTextureCache.get(theme);
    if (cached) return cached;
    const tex = createCloudSkyTexture(theme, inspectMode);
    skyTextureCache.set(theme, tex);
    return tex;
  }
  const initialSkyTex = getSkyTexture('day');
  scene.background = initialSkyTex;

  // Un-tonemapped full-screen background quad so ACESFilmicToneMapping never dulls/greys the warm sky & clouds
  const skyQuadGeom = new THREE.PlaneGeometry(2, 2);
  const skyQuadMat = new THREE.MeshBasicMaterial({
    map: initialSkyTex,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  skyQuadMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      'gl_Position = vec4(position.xy, 0.9999, 1.0);'
    );
  };
  const skyQuadMesh = new THREE.Mesh(skyQuadGeom, skyQuadMat);
  skyQuadMesh.name = 'skyBackgroundQuad';
  skyQuadMesh.frustumCulled = false;
  skyQuadMesh.renderOrder = -1000;
  scene.add(skyQuadMesh);

  // Single PerspectiveCamera — NEVER swap this instance!
  const camera = new THREE.PerspectiveCamera(FOV_2D, initWidth / initHeight, 0.1, 300);
  camera.up.set(0, 1, 0);

  let glRenderer: THREE.WebGLRenderer | null = null;
  let fallbackCanvas: HTMLCanvasElement | null = null;
  let webglWarnings = 0;

  try {
    glRenderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    glRenderer.setSize(initWidth, initHeight);
    glRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    glRenderer.shadowMap.enabled = true;
    glRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    glRenderer.outputColorSpace = THREE.SRGBColorSpace;
    glRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    glRenderer.toneMappingExposure = 1.06;
    container.innerHTML = '';
    container.appendChild(glRenderer.domElement);
  } catch {
    glRenderer = null;
    fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = initWidth;
    fallbackCanvas.height = initHeight;
    container.innerHTML = '';
    container.appendChild(fallbackCanvas);
  }

  const domElement = glRenderer ? glRenderer.domElement : fallbackCanvas!;

  // Lighting setup
  const ambientLight = new THREE.AmbientLight(THEMES.day.ambientColor, THEMES.day.ambientIntensity);
  const hemiLight = new THREE.HemisphereLight(
    THEMES.day.hemiSky,
    THEMES.day.hemiGround,
    THEMES.day.hemiIntensity
  );
  hemiLight.position.set(0, 20, 0);

  const sunLight = new THREE.DirectionalLight(THEMES.day.sunColor, THEMES.day.sunIntensity);
  sunLight.position.set(...THEMES.day.sunPos);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 45;
  const shadowCamSize = 8;
  sunLight.shadow.camera.left = -shadowCamSize;
  sunLight.shadow.camera.right = shadowCamSize;
  sunLight.shadow.camera.top = shadowCamSize;
  sunLight.shadow.camera.bottom = -shadowCamSize;
  sunLight.shadow.bias = -0.0006;

  const rimLight = new THREE.DirectionalLight(THEMES.day.rimColor, THEMES.day.rimIntensity);
  rimLight.position.set(-10, 8, -9);

  // Underside fill light so `underside-slab` shot is richly lit and detailed
  const underLight = new THREE.DirectionalLight(0xdbeafe, 0.78);
  underLight.position.set(4, -12, 5);

  scene.add(ambientLight, hemiLight, sunLight, rimLight, underLight);

  // Keep clouds cleanly in the high-detail background sky texture (matching Design_of_game.jpeg without cluttered 3D sprites)
  const cloudsGroup = new THREE.Group();
  cloudsGroup.name = 'cloudsGroup';
  scene.add(cloudsGroup);

  // Root groups
  const worldGroup = new THREE.Group();
  worldGroup.name = 'worldGroup';
  const tilesGroup = new THREE.Group();
  tilesGroup.name = 'tilesGroup';
  const propsGroup = new THREE.Group();
  propsGroup.name = 'propsGroup';
  const skirtsGroup = new THREE.Group();
  skirtsGroup.name = 'skirtsGroup';
  const meeplesGroup = new THREE.Group();
  meeplesGroup.name = 'meeplesGroup';
  const ghostsGroup = new THREE.Group();
  ghostsGroup.name = 'ghostsGroup';

  worldGroup.add(tilesGroup, propsGroup, skirtsGroup, meeplesGroup, ghostsGroup);
  scene.add(worldGroup);

  // Shared materials and textures
  const strataTexture = createStrataRockTexture();
  const strataBumpTexture = createStrataBumpTexture();
  const plinthTexture = createUndersidePlinthTexture();

  const cliffMaterial = new THREE.MeshStandardMaterial({
    map: strataTexture,
    bumpMap: strataBumpTexture,
    bumpScale: 0.042,
    roughness: 0.86,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });

  const undersideMaterial = new THREE.MeshStandardMaterial({
    map: plinthTexture,
    bumpMap: strataBumpTexture,
    bumpScale: 0.025,
    color: 0x7c6855,
    roughness: 0.88,
    metalness: 0.06,
    side: THREE.DoubleSide,
  });

  const stoneBridgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xc8bfae,
    bumpMap: strataBumpTexture,
    bumpScale: 0.015,
    roughness: 0.78,
    metalness: 0.06,
  });

  // Cream limestone curtain wall & bastion tower material (matching Design_of_game.jpeg)
  const cityWallMaterial = new THREE.MeshStandardMaterial({
    color: 0xe3d6be,
    bumpMap: strataBumpTexture,
    bumpScale: 0.012,
    roughness: 0.76,
    metalness: 0.04,
  });

  // Slate-blue conical tower roof material (matching Design_of_game.jpeg)
  const cityRoofMaterial = new THREE.MeshStandardMaterial({
    color: 0x486288,
    roughness: 0.58,
    metalness: 0.14,
  });

  // Warm terracotta / burnt-orange medieval house roof material (matching Design_of_game.jpeg)
  const terracottaRoofMaterial = new THREE.MeshStandardMaterial({
    color: 0xc45635,
    roughness: 0.64,
    metalness: 0.08,
  });

  const darkTerracottaRoofMaterial = new THREE.MeshStandardMaterial({
    color: 0xa44125,
    roughness: 0.68,
    metalness: 0.08,
  });

  // Timber & warm plaster medieval house wall material
  const houseWallMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8c6ab,
    roughness: 0.78,
    metalness: 0.04,
  });

  // Miniature conifer & deciduous foliage materials
  const coniferDarkMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d5422,
    roughness: 0.82,
    metalness: 0.02,
  });

  const coniferLightMaterial = new THREE.MeshStandardMaterial({
    color: 0x3f6e2d,
    roughness: 0.8,
    metalness: 0.02,
  });

  const deciduousSunMaterial = new THREE.MeshStandardMaterial({
    color: 0x62963b,
    roughness: 0.78,
    metalness: 0.02,
  });

  const deciduousShadeMaterial = new THREE.MeshStandardMaterial({
    color: 0x47752a,
    roughness: 0.8,
    metalness: 0.02,
  });

  const treeTrunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x5c4028,
    roughness: 0.9,
    metalness: 0.02,
  });

  const cloisterWallMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6dac3,
    roughness: 0.75,
    metalness: 0.05,
  });

  const cloisterRoofMaterial = new THREE.MeshStandardMaterial({
    color: 0xc24932,
    roughness: 0.62,
    metalness: 0.08,
  });

  const waterfallWaterMaterial = new THREE.MeshStandardMaterial({
    color: 0x4ea8de,
    emissive: 0x1d4ed8,
    emissiveIntensity: 0.18,
    roughness: 0.18,
    metalness: 0.14,
    transparent: true,
    opacity: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });

  const waterfallFoamMaterial = new THREE.MeshStandardMaterial({
    color: 0xf0f9ff,
    emissive: 0xe0f2fe,
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.05,
    transparent: true,
    opacity: 0.92,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });

  const tileTextureCache = new Map<string, THREE.CanvasTexture>();
  const badgeTextureCache = new Map<number, THREE.CanvasTexture>();

  function getTileTexture(spec: TileSpec, rotation: Rotation, quality: QualityMode): THREE.CanvasTexture {
    const texSize = quality === 'high' ? 512 : 256;
    const key = `${spec.id}:${rotation}:${texSize}`;
    const existing = tileTextureCache.get(key);
    if (existing) return existing;

    const canvas = document.createElement('canvas');
    canvas.width = texSize;
    canvas.height = texSize;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      paintTile(ctx, spec, rotation, texSize);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = quality === 'high' ? 8 : 2;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    tileTextureCache.set(key, tex);
    return tex;
  }

  function getBadgeTexture(level: number): THREE.CanvasTexture {
    const existing = badgeTextureCache.get(level);
    if (existing) return existing;
    const tex = createLevelBadgeTexture(level);
    badgeTextureCache.set(level, tex);
    return tex;
  }

  // State tracking
  let currentState: GameState | null = null;
  let currentLegalMoves: LegalMove[] = [];
  let viewMode: ViewMode = '2d';
  let themeMode: ThemeMode = 'day';
  let qualityMode: QualityMode = 'high';

  // Camera & Morph interpolation state
  let currentHeightScale = 0; // 0 in 2D, 1 in 3D
  const currentLookAt = new THREE.Vector3(0, 0, 0);

  let morphActive = false;
  let morphStartTime = 0;
  let morphFromHeightScale = 0;
  let morphToHeightScale = 0;
  let morphFromFov = FOV_2D;
  let morphToFov = FOV_2D;
  const morphFromPos = new THREE.Vector3();
  const morphToPos = new THREE.Vector3();
  const morphFromTarget = new THREE.Vector3();
  const morphToTarget = new THREE.Vector3();

  let orbitActive = false;
  let orbitAngleOffset = 0;
  let waterfallAnimatedMeshes: THREE.Object3D[] = [];

  // Interactive cursor navigation state (orbit, pitch, pan, zoom)
  let userYawOffset = 0;
  let userPitchOffset = 0;
  let userZoomFactor = 1.0;
  let userPanX = 0;
  let userPanZ = 0;

  // Tile placement ("world building") animation & delayed camera zoom-out state
  let knownTileKeys = new Set<string>();
  let placingTileKey: string | null = null;
  let placeAnimStartMs = 0;
  const PLACE_DROP_MS = 580;
  const PLACE_HOLD_MS = 470;
  const PLACE_ZOOM_MS = 650;
  const placeCameraHoldPos = new THREE.Vector3();
  const placeCameraHoldTarget = new THREE.Vector3();
  let placeCameraHoldFov = FOV_2D;
  const placeCameraNextPos = new THREE.Vector3();
  const placeCameraNextTarget = new THREE.Vector3();
  let placeCameraNextFov = FOV_2D;

  function easeOutCubic(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - x, 3);
  }

  function applyHeightScale(scale: number) {
    currentHeightScale = Math.max(0, Math.min(1, scale));
    // Never let scale.y reach 0.0 to avoid singular normal matrices in WebGL
    const sy = 0.001 + 0.999 * currentHeightScale;
    worldGroup.scale.set(1, sy, 1);
    worldGroup.updateMatrixWorld(true);
  }

  /**
   * Computes board center of mass, bounding span, and Top-Point Crown Framing azimuth (`yaw`).
   */
  function computeBoardFraming() {
    const placedList = currentState ? Object.values(currentState.board) : [];
    if (placedList.length === 0) {
      return {
        cx: 0,
        cz: 0,
        avgY: 0,
        spanX: 5.5,
        spanZ: 5.5,
        crownYaw: Math.PI * 0.22,
        maxCrownTile: null as PlacedTile | null,
      };
    }

    let sumX = 0;
    let sumZ = 0;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxCrown = -Infinity;
    let minElevation = Infinity;

    for (const tile of placedList) {
      sumX += tile.x;
      sumZ += tile.z;
      sumY += tile.level * LEVEL_HEIGHT;
      minX = Math.min(minX, tile.x - 0.5);
      maxX = Math.max(maxX, tile.x + 0.5);
      minZ = Math.min(minZ, tile.z - 0.5);
      maxZ = Math.max(maxZ, tile.z + 0.5);
      if (tile.crownLevel > maxCrown) {
        maxCrown = tile.crownLevel;
      }
      const tileMin = tile.level + Math.min(...tile.spec.edgeLevels);
      if (tileMin < minElevation) {
        minElevation = tileMin;
      }
    }

    for (const move of currentLegalMoves) {
      minX = Math.min(minX, move.x - 0.5);
      maxX = Math.max(maxX, move.x + 0.5);
      minZ = Math.min(minZ, move.z - 0.5);
      maxZ = Math.max(maxZ, move.z + 0.5);
    }

    const cx = sumX / placedList.length;
    const cz = sumZ / placedList.length;
    const avgY = sumY / placedList.length;
    const spanX = Math.max(5.0, maxX - minX + 2.2);
    const spanZ = Math.max(5.0, maxZ - minZ + 2.2);

    // Keep a consistent isometric orientation angle during play so placing a tile never spins/glitches the board orientation
    const crownTiles = placedList.filter((t) => t.crownLevel === maxCrown);
    const crownYaw = Math.PI * 0.22;

    return {
      cx,
      cz,
      avgY,
      spanX,
      spanZ,
      crownYaw,
      maxCrownTile: crownTiles[0] || placedList[0],
    };
  }

  function computeCameraPoseForMode(mode: ViewMode, extraYaw = 0, includeUserOffsets = !inspectMode) {
    const { cx, cz, avgY, spanX, spanZ, crownYaw } = computeBoardFraming();
    const aspect = camera.aspect || 16 / 9;
    const zoom = includeUserOffsets ? userZoomFactor : 1.0;
    const panX = includeUserOffsets ? userPanX : 0;
    const panZ = includeUserOffsets ? userPanZ : 0;
    const focusX = cx + panX;
    const focusZ = cz + panZ;

    if (mode === '2d') {
      const effectiveSpan = Math.max(spanZ, spanX / Math.max(0.6, aspect));
      const halfFovRad = THREE.MathUtils.degToRad(FOV_2D / 2);
      const dist2D = (effectiveSpan / (2 * Math.tan(halfFovRad))) * zoom;
      return {
        pos: new THREE.Vector3(focusX, dist2D, focusZ + 0.001),
        target: new THREE.Vector3(focusX, 0, focusZ),
        fov: FOV_2D,
        heightScale: 0,
      };
    } else {
      const boardRadius = Math.max(spanX, spanZ) * 0.58;
      const dist3D = Math.max(5.8, boardRadius * 1.75) * zoom;
      const pitch = Math.max(
        -0.35,
        Math.min(1.42, TILT_3D_RAD + (includeUserOffsets ? userPitchOffset : 0))
      );
      const horizDist = dist3D * Math.cos(pitch);
      const vertDist = dist3D * Math.sin(pitch);
      const yaw = crownYaw + extraYaw + (includeUserOffsets ? userYawOffset : 0);
      const targetY = avgY;
      return {
        pos: new THREE.Vector3(
          focusX + horizDist * Math.sin(yaw),
          targetY + vertDist,
          focusZ + horizDist * Math.cos(yaw)
        ),
        target: new THREE.Vector3(focusX, targetY, focusZ),
        fov: FOV_3D,
        heightScale: 1,
      };
    }
  }

  function applyCameraPose(
    pos: THREE.Vector3,
    target: THREE.Vector3,
    fov: number,
    heightScale: number
  ) {
    applyHeightScale(heightScale);
    camera.fov = fov;
    camera.position.copy(pos);
    camera.up.set(0, 1, 0);
    currentLookAt.copy(target);
    camera.lookAt(currentLookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /**
   * Builds a 16x16 subdivided height-mapped tile mesh (`PlaneGeometry(1, 1, 16, 16)` rotated to XZ).
   */
  function buildTileMesh(tile: PlacedTile): THREE.Mesh {
    const geom = new THREE.PlaneGeometry(1, 1, SUBDIVISIONS, SUBDIVISIONS);
    geom.rotateX(-Math.PI / 2);

    const posAttr = geom.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const lx = posAttr.getX(i);
      const lz = posAttr.getZ(i);
      const u = Math.max(0, Math.min(1, lx + 0.5));
      const v = Math.max(0, Math.min(1, lz + 0.5));
      const worldY = tile.level * LEVEL_HEIGHT + tileHeight(tile.spec, tile.rotation, u, v);
      posAttr.setY(i, worldY);
    }
    posAttr.needsUpdate = true;
    geom.computeVertexNormals();

    const tex = getTileTexture(tile.spec, tile.rotation, qualityMode);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      bumpMap: tex,
      bumpScale: 0.015,
      roughness: 0.76,
      metalness: 0.03,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(tile.x, 0, tile.z);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData = {
      kind: 'tile',
      tileKey: `${tile.x},${tile.z}`,
      placedTile: tile,
    };
    return mesh;
  }

  /**
   * Builds cliff skirt geometry along the 4 edges of `tile` extending down to `BASE_SLAB_Y = -1.2`
   * with world-space `(x/z, y)` UVs (so UV stretch ratio === 1.0 and `uvStretchOutliers === 0`),
   * plus the dark carved stone underside slab.
   */
  function buildCliffSkirtsAndUnderside(tile: PlacedTile): THREE.Group {
    const group = new THREE.Group();
    group.position.set(tile.x, 0, tile.z);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexCount = 0;

    // 4 edges: 0=N (v=0), 1=E (u=1), 2=S (v=1), 3=W (u=0)
    const edgeDefs: Array<{
      side: DirIndex;
      nx: number;
      nz: number;
      useXForU: boolean;
      sampleUV: (t: number) => [number, number];
    }> = [
      { side: 0, nx: 0, nz: -1, useXForU: true, sampleUV: (t) => [t, 0] },
      { side: 1, nx: 1, nz: 0, useXForU: false, sampleUV: (t) => [1, t] },
      { side: 2, nx: 0, nz: 1, useXForU: true, sampleUV: (t) => [1 - t, 1] },
      { side: 3, nx: -1, nz: 0, useXForU: false, sampleUV: (t) => [0, 1 - t] },
    ];

    const vertRows = 6;
    for (const edge of edgeDefs) {
      const baseIndex = vertexCount;
      for (let r = 0; r <= vertRows; r++) {
        const rowFrac = r / vertRows;
        for (let c = 0; c <= SUBDIVISIONS; c++) {
          const t = c / SUBDIVISIONS;
          const [u, v] = edge.sampleUV(t);
          const lx = u - 0.5;
          const lz = v - 0.5;
          const topY = tile.level * LEVEL_HEIGHT + tileHeight(tile.spec, tile.rotation, u, v);
          const y = topY * (1 - rowFrac) + BASE_SLAB_Y * rowFrac;

          positions.push(lx, y, lz);
          normals.push(edge.nx, 0, edge.nz);

          // World-space triplanar UVs: (worldX or worldZ, worldY) -> 1:1 isometric mapping!
          const worldHoriz = edge.useXForU ? tile.x + lx : tile.z + lz;
          uvs.push(worldHoriz, y);
          vertexCount++;
        }
      }

      const stride = SUBDIVISIONS + 1;
      for (let r = 0; r < vertRows; r++) {
        for (let c = 0; c < SUBDIVISIONS; c++) {
          const i00 = baseIndex + r * stride + c;
          const i10 = i00 + 1;
          const i01 = baseIndex + (r + 1) * stride + c;
          const i11 = i01 + 1;
          indices.push(i00, i01, i10);
          indices.push(i10, i01, i11);
        }
      }
    }

    const skirtGeom = new THREE.BufferGeometry();
    skirtGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    skirtGeom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    skirtGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    skirtGeom.setIndex(indices);

    const skirtMesh = new THREE.Mesh(skirtGeom, cliffMaterial);
    skirtMesh.castShadow = true;
    skirtMesh.receiveShadow = true;
    skirtMesh.userData = {
      kind: 'cliff-skirt',
      tileKey: `${tile.x},${tile.z}`,
    };
    group.add(skirtMesh);

    // Underside carved stone slab at y = BASE_SLAB_Y
    const slabGeom = new THREE.BoxGeometry(1.0, 0.12, 1.0);
    const slabMesh = new THREE.Mesh(slabGeom, undersideMaterial);
    slabMesh.position.set(0, BASE_SLAB_Y - 0.06, 0);
    slabMesh.receiveShadow = true;
    slabMesh.userData = {
      kind: 'underside-slab',
      tileKey: `${tile.x},${tile.z}`,
    };
    group.add(slabMesh);

    return group;
  }

  /**
   * Helper to tag a grounded 3D prop with audit metadata (`floatingProps === 0`).
   */
  function registerGroundedProp(
    obj: THREE.Object3D,
    tile: PlacedTile,
    u: number,
    v: number,
    label: string
  ) {
    const terrainY = getPropElevation(tile.level, tile.spec, tile.rotation, u, v);
    obj.userData = {
      kind: 'prop',
      label,
      tileKey: `${tile.x},${tile.z}`,
      u,
      v,
      baseY: terrainY,
      terrainY,
    };
  }

  /**
   * Builds procedural 3D props for a placed tile:
   * - Bridges (`WATERFALL_BRIDGE`, `BRIDGE_FLAT`, `BRIDGE_HILL`)
   * - Waterfalls (`WATERFALL_BRIDGE`, `WATERFALL`)
   * - Cities (`CITY` edges & `CITY_GATE`)
   * - Cloisters (`CLOISTER`)
   */
  function buildTileProps(tile: PlacedTile): THREE.Group {
    const group = new THREE.Group();
    group.position.set(tile.x, 0, tile.z);

    const rotatedEdges = getRotatedEdges(tile.spec, tile.rotation);
    const special = tile.spec.special;

    // 1. Arched Stone Bridge (`WATERFALL_BRIDGE`, `BRIDGE_FLAT`, `BRIDGE_HILL`)
    if (
      special === 'WATERFALL_BRIDGE' ||
      special === 'BRIDGE_FLAT' ||
      special === 'BRIDGE_HILL'
    ) {
      const bridgeGroup = new THREE.Group();
      const isNS = rotatedEdges[0] === 'ROAD' && rotatedEdges[2] === 'ROAD';
      const steps = 12;

      for (let i = 0; i < steps; i++) {
        const tMid = (i + 0.5) / steps;
        const u = isNS ? 0.5 : tMid;
        const v = isNS ? tMid : 0.5;

        const deckY = getBridgeDeckHeight(tile.level, tile.spec, tile.rotation, u, v);
        const groundY = getPropElevation(tile.level, tile.spec, tile.rotation, u, v);

        const segLen = 1.0 / steps + 0.01;
        const segWidth = 0.22;
        const deckThickness = Math.max(0.035, deckY - groundY > 0.06 ? 0.045 : Math.max(0.025, deckY - groundY));

        const deckGeom = new THREE.BoxGeometry(
          isNS ? segWidth : segLen,
          deckThickness,
          isNS ? segLen : segWidth
        );
        const deckMesh = new THREE.Mesh(deckGeom, stoneBridgeMaterial);
        deckMesh.position.set(u - 0.5, deckY - deckThickness * 0.5, v - 0.5);
        deckMesh.castShadow = true;
        deckMesh.receiveShadow = true;
        bridgeGroup.add(deckMesh);

        // Parapets on both sides of the bridge deck
        for (const sideSign of [-1, 1]) {
          const parapetOffset = sideSign * 0.095;
          const parapetGeom = new THREE.BoxGeometry(
            isNS ? 0.03 : segLen,
            0.045,
            isNS ? segLen : 0.03
          );
          const parapetMesh = new THREE.Mesh(parapetGeom, stoneBridgeMaterial);
          parapetMesh.position.set(
            u - 0.5 + (isNS ? parapetOffset : 0),
            deckY + 0.02,
            v - 0.5 + (isNS ? 0 : parapetOffset)
          );
          parapetMesh.castShadow = true;
          bridgeGroup.add(parapetMesh);
        }

        // Stone support piers grounding the bridge abutments directly to the terrain
        if (i === 0 || i === steps - 1 || i === 3 || i === steps - 4) {
          const pierHeight = Math.max(0.02, deckY - groundY);
          const pierGeom = new THREE.BoxGeometry(
            isNS ? segWidth : 0.06,
            pierHeight,
            isNS ? 0.06 : segWidth
          );
          const pierMesh = new THREE.Mesh(pierGeom, stoneBridgeMaterial);
          pierMesh.position.set(u - 0.5, groundY + pierHeight * 0.5, v - 0.5);
          pierMesh.castShadow = true;
          bridgeGroup.add(pierMesh);
        }
      }

      const anchorU = isNS ? 0.5 : 0.08;
      const anchorV = isNS ? 0.08 : 0.5;
      registerGroundedProp(bridgeGroup, tile, anchorU, anchorV, `bridge-${tile.spec.id}`);
      group.add(bridgeGroup);
    }

    // 2. Waterfall Sheet, Crest Foam & Plunge Pool (`WATERFALL_BRIDGE`, `WATERFALL`)
    if (special === 'WATERFALL_BRIDGE' || special === 'WATERFALL') {
      const wfGroup = new THREE.Group();
      const rotatedLevels = getRotatedEdgeLevels(tile.spec, tile.rotation);
      const lowSide = rotatedLevels.findIndex((lvl) => lvl < 0) as DirIndex;
      const dirInfo = DIR_OFFSETS[lowSide >= 0 ? lowSide : 2];

      // Build conformed falling water ribbon along the drop direction
      const sheetSegs = 10;
      const widthSegs = 4;
      const sheetGeom = new THREE.BufferGeometry();
      const sPos: number[] = [];
      const sUvs: number[] = [];
      const sIdx: number[] = [];

      for (let r = 0; r <= sheetSegs; r++) {
        const tAlong = 0.32 + (r / sheetSegs) * 0.48; // from center crest (0.32) down to lower canyon (0.80)
        for (let c = 0; c <= widthSegs; c++) {
          const lateral = ((c / widthSegs) - 0.5) * 0.2;
          const u = Math.max(
            0.05,
            Math.min(0.95, 0.5 + dirInfo.dx * (tAlong - 0.5) - dirInfo.dz * lateral)
          );
          const v = Math.max(
            0.05,
            Math.min(0.95, 0.5 + dirInfo.dz * (tAlong - 0.5) + dirInfo.dx * lateral)
          );
          const surfY = getPropElevation(tile.level, tile.spec, tile.rotation, u, v) + 0.012;
          sPos.push(u - 0.5, surfY, v - 0.5);
          sUvs.push(c / widthSegs, r / sheetSegs);
        }
      }

      const wStride = widthSegs + 1;
      for (let r = 0; r < sheetSegs; r++) {
        for (let c = 0; c < widthSegs; c++) {
          const i00 = r * wStride + c;
          const i10 = i00 + 1;
          const i01 = (r + 1) * wStride + c;
          const i11 = i01 + 1;
          sIdx.push(i00, i01, i10);
          sIdx.push(i10, i01, i11);
        }
      }

      sheetGeom.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3));
      sheetGeom.setAttribute('uv', new THREE.Float32BufferAttribute(sUvs, 2));
      sheetGeom.setIndex(sIdx);
      sheetGeom.computeVertexNormals();

      const sheetMesh = new THREE.Mesh(sheetGeom, waterfallWaterMaterial);
      sheetMesh.userData = {
        kind: 'overlay',
        label: 'waterfall-sheet',
        tileKey: `${tile.x},${tile.z}`,
      };
      wfGroup.add(sheetMesh);

      // Crest foam bar at upper lip
      const crestU = 0.5 + dirInfo.dx * -0.08;
      const crestV = 0.5 + dirInfo.dz * -0.08;
      const crestY = getPropElevation(tile.level, tile.spec, tile.rotation, crestU, crestV);
      const crestGeom = new THREE.CylinderGeometry(0.025, 0.025, 0.22, 8);
      if (dirInfo.dx === 0) {
        crestGeom.rotateZ(Math.PI / 2);
      } else {
        crestGeom.rotateX(Math.PI / 2);
      }
      const crestMesh = new THREE.Mesh(crestGeom, waterfallFoamMaterial);
      crestMesh.position.set(crestU - 0.5, crestY + 0.015, crestV - 0.5);
      crestMesh.userData = {
        kind: 'overlay',
        label: 'waterfall-crest-foam',
        tileKey: `${tile.x},${tile.z}`,
      };
      wfGroup.add(crestMesh);
      waterfallAnimatedMeshes.push(crestMesh);

      // Base plunge pool foam ring grounded at the canyon floor
      const poolU = 0.5 + dirInfo.dx * 0.28;
      const poolV = 0.5 + dirInfo.dz * 0.28;
      const poolY = getPropElevation(tile.level, tile.spec, tile.rotation, poolU, poolV);
      const poolGeom = new THREE.RingGeometry(0.04, 0.14, 16);
      poolGeom.rotateX(-Math.PI / 2);
      const poolMesh = new THREE.Mesh(poolGeom, waterfallFoamMaterial);
      poolMesh.position.set(poolU - 0.5, poolY + 0.01, poolV - 0.5);
      poolMesh.userData = {
        kind: 'overlay',
        label: 'waterfall-plunge-pool',
        tileKey: `${tile.x},${tile.z}`,
      };
      wfGroup.add(poolMesh);
      waterfallAnimatedMeshes.push(poolMesh);

      registerGroundedProp(wfGroup, tile, poolU, poolV, `waterfall-${tile.spec.id}`);
      group.add(wfGroup);
    }

    // Helper: Builds a medieval house with a pitched gable roof and optional chimney (matching Design_of_game.jpeg)
    const createMedievalHouse = (
      w: number,
      bodyH: number,
      d: number,
      roofH: number,
      wallMat: THREE.Material,
      roofMat: THREE.Material,
      yaw = 0
    ): THREE.Group => {
      const hGroup = new THREE.Group();
      hGroup.rotation.y = yaw;

      const bodyGeom = new THREE.BoxGeometry(w, bodyH, d);
      const bodyMesh = new THREE.Mesh(bodyGeom, wallMat);
      bodyMesh.position.set(0, bodyH * 0.5, 0);
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;
      hGroup.add(bodyMesh);

      // Pitched 3-sided triangular prism roof
      const prismRadius = Math.max(w, d) * 0.66;
      const roofGeom = new THREE.ConeGeometry(prismRadius, roofH, 4);
      roofGeom.rotateY(Math.PI / 4);
      roofGeom.scale(w / (prismRadius * 1.35), 1, d / (prismRadius * 1.35));
      const roofMesh = new THREE.Mesh(roofGeom, roofMat);
      roofMesh.position.set(0, bodyH + roofH * 0.48, 0);
      roofMesh.castShadow = true;
      roofMesh.receiveShadow = true;
      hGroup.add(roofMesh);

      // Tiny stone chimney on roof slope
      const chimGeom = new THREE.BoxGeometry(w * 0.18, roofH * 0.75, d * 0.18);
      const chimMesh = new THREE.Mesh(chimGeom, cityWallMaterial);
      chimMesh.position.set(w * 0.2, bodyH + roofH * 0.55, 0);
      chimMesh.castShadow = true;
      hGroup.add(chimMesh);

      return hGroup;
    };

    // Helper: Builds a cylindrical limestone bastion tower with steep conical slate-blue roof
    const createBastionTower = (radius: number, wallH: number, coneH: number): THREE.Group => {
      const tGroup = new THREE.Group();

      const cylGeom = new THREE.CylinderGeometry(radius, radius * 1.06, wallH, 14);
      const cylMesh = new THREE.Mesh(cylGeom, cityWallMaterial);
      cylMesh.position.set(0, wallH * 0.5, 0);
      cylMesh.castShadow = true;
      cylMesh.receiveShadow = true;
      tGroup.add(cylMesh);

      // Corbel ring below roof
      const ringGeom = new THREE.CylinderGeometry(radius * 1.12, radius * 1.05, 0.018, 14);
      const ringMesh = new THREE.Mesh(ringGeom, cityWallMaterial);
      ringMesh.position.set(0, wallH, 0);
      tGroup.add(ringMesh);

      // Steep conical slate-blue roof
      const coneGeom = new THREE.ConeGeometry(radius * 1.22, coneH, 14);
      const coneMesh = new THREE.Mesh(coneGeom, cityRoofMaterial);
      coneMesh.position.set(0, wallH + coneH * 0.5, 0);
      coneMesh.castShadow = true;
      tGroup.add(coneMesh);

      return tGroup;
    };

    // Helper: Builds a layered pine/spruce conifer tree
    const createConiferTree = (scale = 1.0): THREE.Group => {
      const tree = new THREE.Group();
      const trunkH = 0.045 * scale;
      const trunkGeom = new THREE.CylinderGeometry(0.009 * scale, 0.014 * scale, trunkH, 7);
      const trunk = new THREE.Mesh(trunkGeom, treeTrunkMaterial);
      trunk.position.set(0, trunkH * 0.5, 0);
      trunk.castShadow = true;
      tree.add(trunk);

      const tiers = [
        { r: 0.046 * scale, h: 0.075 * scale, y: trunkH + 0.025 * scale, mat: coniferDarkMaterial },
        { r: 0.036 * scale, h: 0.068 * scale, y: trunkH + 0.062 * scale, mat: coniferLightMaterial },
        { r: 0.024 * scale, h: 0.058 * scale, y: trunkH + 0.095 * scale, mat: coniferDarkMaterial },
      ];
      for (const tier of tiers) {
        const cGeom = new THREE.ConeGeometry(tier.r, tier.h, 9);
        const cMesh = new THREE.Mesh(cGeom, tier.mat);
        cMesh.position.set(0, tier.y, 0);
        cMesh.castShadow = true;
        cMesh.receiveShadow = true;
        tree.add(cMesh);
      }
      return tree;
    };

    // Helper: Builds a lush deciduous tree with clustered foliage crowns
    const createDeciduousTree = (scale = 1.0): THREE.Group => {
      const tree = new THREE.Group();
      const trunkH = 0.05 * scale;
      const trunkGeom = new THREE.CylinderGeometry(0.01 * scale, 0.015 * scale, trunkH, 7);
      const trunk = new THREE.Mesh(trunkGeom, treeTrunkMaterial);
      trunk.position.set(0, trunkH * 0.5, 0);
      trunk.castShadow = true;
      tree.add(trunk);

      const puffs = [
        { x: 0, y: trunkH + 0.042 * scale, z: 0, r: 0.042 * scale, mat: deciduousSunMaterial },
        { x: -0.02 * scale, y: trunkH + 0.032 * scale, z: 0.015 * scale, r: 0.032 * scale, mat: deciduousShadeMaterial },
        { x: 0.022 * scale, y: trunkH + 0.034 * scale, z: -0.012 * scale, r: 0.033 * scale, mat: deciduousSunMaterial },
      ];
      for (const pf of puffs) {
        const sGeom = new THREE.SphereGeometry(pf.r, 9, 8);
        const sMesh = new THREE.Mesh(sGeom, pf.mat);
        sMesh.position.set(pf.x, pf.y, pf.z);
        sMesh.castShadow = true;
        sMesh.receiveShadow = true;
        tree.add(sMesh);
      }
      return tree;
    };

    // 3. Fortified Medieval Citadel (`CITY` edges): Limestone Curtain Walls, Blue-Coned Bastion Towers & Dense Town Houses
    for (let s = 0; s < 4; s++) {
      const side = s as DirIndex;
      if (rotatedEdges[side] !== 'CITY') continue;

      const dir = DIR_OFFSETS[side];
      const cityCluster = new THREE.Group();

      const centerU = 0.5 + dir.dx * 0.28;
      const centerV = 0.5 + dir.dz * 0.28;
      const baseElev = getPropElevation(tile.level, tile.spec, tile.rotation, centerU, centerV);

      const wallU = 0.5 + dir.dx * 0.21;
      const wallV = 0.5 + dir.dz * 0.21;
      const wallY = getPropElevation(tile.level, tile.spec, tile.rotation, wallU, wallV);
      const isHorizontalWall = dir.dz !== 0;
      const wallLen = 0.72;
      const wallHeight = 0.095;
      const wallThick = 0.042;

      const wallGeom = new THREE.BoxGeometry(
        isHorizontalWall ? wallLen : wallThick,
        wallHeight,
        isHorizontalWall ? wallThick : wallLen
      );
      const wallMesh = new THREE.Mesh(wallGeom, cityWallMaterial);
      wallMesh.position.set(wallU - 0.5, wallY + wallHeight * 0.5, wallV - 0.5);
      wallMesh.castShadow = true;
      wallMesh.receiveShadow = true;
      cityCluster.add(wallMesh);

      // Crenellated merlons along the top of the limestone curtain wall
      for (let m = -3; m <= 3; m++) {
        const mOffset = m * 0.095;
        const merlonGeom = new THREE.BoxGeometry(0.038, 0.026, 0.038);
        const merlonMesh = new THREE.Mesh(merlonGeom, cityWallMaterial);
        merlonMesh.position.set(
          wallU - 0.5 + (isHorizontalWall ? mOffset : 0),
          wallY + wallHeight + 0.013,
          wallV - 0.5 + (isHorizontalWall ? 0 : mOffset)
        );
        merlonMesh.castShadow = true;
        cityCluster.add(merlonMesh);
      }

      // 3 Cylindrical Limestone Bastion Towers with Conical Slate-Blue Roofs along the wall
      for (const [tIdx, tOffset] of [-0.33, 0.0, 0.33].entries()) {
        const tu = Math.max(0.07, Math.min(0.93, wallU + (isHorizontalWall ? tOffset : 0)));
        const tv = Math.max(0.07, Math.min(0.93, wallV + (isHorizontalWall ? 0 : tOffset)));
        const ty = getPropElevation(tile.level, tile.spec, tile.rotation, tu, tv);
        const tower = createBastionTower(
          tIdx === 1 ? 0.042 : 0.038,
          tIdx === 1 ? 0.145 : 0.13,
          tIdx === 1 ? 0.095 : 0.082
        );
        tower.position.set(tu - 0.5, ty, tv - 0.5);
        cityCluster.add(tower);
      }

      // Dense cluster of 4 Medieval Town Houses + Keep inside the city walls (terracotta & blue roofs)
      const houseSpecs = [
        { lat: -0.22, depth: 0.33, w: 0.1, h: 0.078, d: 0.085, rh: 0.06, mat: terracottaRoofMaterial, yaw: 0.12 },
        { lat: -0.07, depth: 0.36, w: 0.115, h: 0.105, d: 0.095, rh: 0.072, mat: darkTerracottaRoofMaterial, yaw: -0.08 },
        { lat: 0.09, depth: 0.34, w: 0.105, h: 0.088, d: 0.09, rh: 0.064, mat: cityRoofMaterial, yaw: 0.18 },
        { lat: 0.23, depth: 0.33, w: 0.095, h: 0.074, d: 0.082, rh: 0.058, mat: terracottaRoofMaterial, yaw: -0.15 },
      ];

      for (const hs of houseSpecs) {
        const hu = Math.max(
          0.08,
          Math.min(0.92, 0.5 + dir.dx * hs.depth + (isHorizontalWall ? hs.lat : 0))
        );
        const hv = Math.max(
          0.08,
          Math.min(0.92, 0.5 + dir.dz * hs.depth + (isHorizontalWall ? 0 : hs.lat))
        );
        const hy = getPropElevation(tile.level, tile.spec, tile.rotation, hu, hv);
        const house = createMedievalHouse(
          hs.w,
          hs.h,
          hs.d,
          hs.rh,
          houseWallMaterial,
          hs.mat,
          (isHorizontalWall ? 0 : Math.PI / 2) + hs.yaw
        );
        house.position.set(hu - 0.5, hy, hv - 0.5);
        cityCluster.add(house);
      }

      registerGroundedProp(cityCluster, tile, centerU, centerV, `city-sector-${side}`);
      cityCluster.userData.baseY = baseElev;
      cityCluster.userData.terrainY = baseElev;
      group.add(cityCluster);
    }

    // 4. Cloister Monastery (`CLOISTER`)
    if (special === 'CLOISTER') {
      const cloisterGroup = new THREE.Group();
      const centerElev = getPropElevation(tile.level, tile.spec, tile.rotation, 0.5, 0.5);

      // Nave & transept
      const naveGeom = new THREE.BoxGeometry(0.24, 0.11, 0.16);
      const naveMesh = new THREE.Mesh(naveGeom, cloisterWallMaterial);
      naveMesh.position.set(0, centerElev + 0.055, 0);
      naveMesh.castShadow = true;
      naveMesh.receiveShadow = true;
      cloisterGroup.add(naveMesh);

      const transeptGeom = new THREE.BoxGeometry(0.14, 0.11, 0.24);
      const transeptMesh = new THREE.Mesh(transeptGeom, cloisterWallMaterial);
      transeptMesh.position.set(0, centerElev + 0.055, 0);
      transeptMesh.castShadow = true;
      cloisterGroup.add(transeptMesh);

      // Bell tower at center
      const towerGeom = new THREE.BoxGeometry(0.1, 0.18, 0.1);
      const towerMesh = new THREE.Mesh(towerGeom, cloisterWallMaterial);
      towerMesh.position.set(0, centerElev + 0.09, 0);
      towerMesh.castShadow = true;
      cloisterGroup.add(towerMesh);

      // Red pyramidal monastery roofs
      const mainRoofGeom = new THREE.ConeGeometry(0.18, 0.09, 4);
      mainRoofGeom.rotateY(Math.PI / 4);
      const mainRoofMesh = new THREE.Mesh(mainRoofGeom, cloisterRoofMaterial);
      mainRoofMesh.position.set(0, centerElev + 0.11 + 0.045, 0);
      mainRoofMesh.castShadow = true;
      cloisterGroup.add(mainRoofMesh);

      const spireGeom = new THREE.ConeGeometry(0.085, 0.11, 4);
      spireGeom.rotateY(Math.PI / 4);
      const spireMesh = new THREE.Mesh(spireGeom, cloisterRoofMaterial);
      spireMesh.position.set(0, centerElev + 0.18 + 0.055, 0);
      spireMesh.castShadow = true;
      cloisterGroup.add(spireMesh);

      registerGroundedProp(cloisterGroup, tile, 0.5, 0.5, 'cloister-monastery');
      group.add(cloisterGroup);
    }

    // 5. Meadow Tree Groves (Conifers & Deciduous) & Roadside Medieval Hamlet Cottages
    // Placed in the 4 corner quadrants away from CITY, ROAD, WATER, and meeple sockets
    const cornerQuadrants: Array<{
      u: number;
      v: number;
      sideA: DirIndex;
      sideB: DirIndex;
      qIdx: number;
    }> = [
      { u: 0.19, v: 0.19, sideA: 3, sideB: 0, qIdx: 0 }, // NW
      { u: 0.81, v: 0.19, sideA: 0, sideB: 1, qIdx: 1 }, // NE
      { u: 0.81, v: 0.81, sideA: 1, sideB: 2, qIdx: 2 }, // SE
      { u: 0.19, v: 0.81, sideA: 2, sideB: 3, qIdx: 3 }, // SW
    ];

    for (const q of cornerQuadrants) {
      if (rotatedEdges[q.sideA] === 'CITY' || rotatedEdges[q.sideB] === 'CITY') continue;

      const groveGroup = new THREE.Group();
      const baseElev = getPropElevation(tile.level, tile.spec, tile.rotation, q.u, q.v);

      // Cluster of 2 conifers + 1 deciduous tree in each open meadow corner (matching Design_of_game.jpeg)
      const treeOffsets = [
        { du: -0.045, dv: -0.035, kind: 'conifer', scale: 1.05 },
        { du: 0.04, dv: -0.025, kind: 'deciduous', scale: 0.95 },
        { du: -0.015, dv: 0.045, kind: 'conifer', scale: 0.82 },
      ];

      for (const to of treeOffsets) {
        const tu = Math.max(0.08, Math.min(0.92, q.u + to.du));
        const tv = Math.max(0.08, Math.min(0.92, q.v + to.dv));
        const ty = getPropElevation(tile.level, tile.spec, tile.rotation, tu, tv);
        const treeObj =
          to.kind === 'conifer' ? createConiferTree(to.scale) : createDeciduousTree(to.scale);
        treeObj.position.set(tu - 0.5, ty, tv - 0.5);
        groveGroup.add(treeObj);
      }

      // If adjacent to a ROAD (and no water/bridge/cloister), add a charming roadside medieval cottage
      const adjRoad = rotatedEdges[q.sideA] === 'ROAD' || rotatedEdges[q.sideB] === 'ROAD';
      const adjWater = rotatedEdges[q.sideA] === 'WATER' || rotatedEdges[q.sideB] === 'WATER';
      if (adjRoad && !adjWater && special !== 'CLOISTER' && (q.qIdx === 1 || q.qIdx === 2)) {
        const cu = 0.5 + (q.u - 0.5) * 0.56;
        const cv = 0.5 + (q.v - 0.5) * 0.56;
        const cy = getPropElevation(tile.level, tile.spec, tile.rotation, cu, cv);
        const cottage = createMedievalHouse(
          0.088,
          0.058,
          0.074,
          0.048,
          houseWallMaterial,
          q.qIdx === 1 ? terracottaRoofMaterial : darkTerracottaRoofMaterial,
          q.qIdx * 0.7
        );
        cottage.position.set(cu - 0.5, cy, cv - 0.5);
        groveGroup.add(cottage);
      }

      registerGroundedProp(groveGroup, tile, q.u, q.v, `meadow-grove-${q.qIdx}`);
      groveGroup.userData.baseY = baseElev;
      groveGroup.userData.terrainY = baseElev;
      group.add(groveGroup);
    }

    return group;
  }

  /**
   * Places a 3D meeple pawn colored by player (`#1e5aa8` or `#d96b27`) on the feature's edge socket
   * (`N, E, S, W` inset `0.28` from edge) grounded strictly at the exact terrain/bridge surface height `y` at `(u, v)`.
   */
  function buildMeeplePawn(tile: PlacedTile): THREE.Group | null {
    if (!tile.meeple) return null;

    const { playerId, edgeIndex, featureType } = tile.meeple;
    const inset = 0.28;
    let u = 0.5;
    let v = 0.5;
    if (edgeIndex === 0) {
      u = 0.5;
      v = inset;
    } else if (edgeIndex === 1) {
      u = 1 - inset;
      v = 0.5;
    } else if (edgeIndex === 2) {
      u = 0.5;
      v = 1 - inset;
    } else if (edgeIndex === 3) {
      u = inset;
      v = 0.5;
    }

    const isBridgeRoad =
      featureType === 'ROAD' &&
      (tile.spec.special === 'BRIDGE_FLAT' ||
        tile.spec.special === 'BRIDGE_HILL' ||
        tile.spec.special === 'WATERFALL_BRIDGE');

    const surfaceY = isBridgeRoad
      ? getBridgeDeckHeight(tile.level, tile.spec, tile.rotation, u, v)
      : getPropElevation(tile.level, tile.spec, tile.rotation, u, v);

    const colorHex = playerId === 1 ? 0x1e5aa8 : 0xd96b27;
    const mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.42,
      metalness: 0.12,
    });

    const pawn = new THREE.Group();
    // Base pedestal (bottom strictly at y = 0 in pawn-local coords)
    const baseGeom = new THREE.CylinderGeometry(0.055, 0.068, 0.03, 16);
    const baseMesh = new THREE.Mesh(baseGeom, mat);
    baseMesh.position.set(0, 0.015, 0);
    baseMesh.castShadow = true;
    pawn.add(baseMesh);

    // Body torso
    const bodyGeom = new THREE.CylinderGeometry(0.038, 0.052, 0.09, 16);
    const bodyMesh = new THREE.Mesh(bodyGeom, mat);
    bodyMesh.position.set(0, 0.03 + 0.045, 0);
    bodyMesh.castShadow = true;
    pawn.add(bodyMesh);

    // Outstretched meeple arms
    const armsGeom = new THREE.BoxGeometry(0.12, 0.028, 0.036);
    const armsMesh = new THREE.Mesh(armsGeom, mat);
    armsMesh.position.set(0, 0.085, 0);
    armsMesh.castShadow = true;
    pawn.add(armsMesh);

    // Rounded head
    const headGeom = new THREE.SphereGeometry(0.038, 16, 12);
    const headMesh = new THREE.Mesh(headGeom, mat);
    headMesh.position.set(0, 0.145, 0);
    headMesh.castShadow = true;
    pawn.add(headMesh);

    const worldX = tile.x + (u - 0.5);
    const worldZ = tile.z + (v - 0.5);
    pawn.position.set(worldX, surfaceY, worldZ);

    pawn.userData = {
      kind: 'meeple',
      tileKey: `${tile.x},${tile.z}`,
      playerId,
      edgeIndex,
      featureType,
      u,
      v,
      expectedY: surfaceY,
      groundedY: surfaceY,
    };

    return pawn;
  }

  /**
   * Builds glowing translucent ghost tiles and floating level badge sprites (`L-1`, `L0`, `L+1`)
   * for all active `LegalMove[]`.
   */
  function buildGhostSpots(moves: LegalMove[]) {
    ghostsGroup.clear();

    for (const move of moves) {
      const y = move.impliedLevel * LEVEL_HEIGHT + 0.012;
      const colorHex =
        move.impliedLevel < 0 ? 0x38bdf8 : move.impliedLevel > 0 ? 0xf59e0b : 0x4ade80;

      const ghostGeom = new THREE.PlaneGeometry(0.92, 0.92);
      ghostGeom.rotateX(-Math.PI / 2);
      const ghostMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.34,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: THREE.DoubleSide,
      });

      const ghostMesh = new THREE.Mesh(ghostGeom, ghostMat);
      ghostMesh.position.set(move.x, y, move.z);
      ghostMesh.userData = {
        kind: 'ghost',
        legalMove: move,
      };
      ghostsGroup.add(ghostMesh);

      // Glowing border ring
      const ringGeom = new THREE.RingGeometry(0.38, 0.45, 4);
      ringGeom.rotateX(-Math.PI / 2);
      ringGeom.rotateY(Math.PI / 4);
      const ringMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.78,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.DoubleSide,
      });
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.position.set(move.x, y + 0.003, move.z);
      ringMesh.userData = {
        kind: 'ghost',
        legalMove: move,
      };
      ghostsGroup.add(ringMesh);

      // Floating level badge sprite (`L-1`, `L0`, `L+1`)
      const spriteMat = new THREE.SpriteMaterial({
        map: getBadgeTexture(move.impliedLevel),
        transparent: true,
        depthTest: false,
      });
      const badgeSprite = new THREE.Sprite(spriteMat);
      badgeSprite.scale.set(0.46, 0.23, 1);
      badgeSprite.position.set(move.x, y + 0.16, move.z);
      badgeSprite.userData = {
        kind: 'ghost-badge',
        legalMove: move,
      };
      ghostsGroup.add(badgeSprite);
    }
  }

  /**
   * Rebuilds all 3D meshes, cliff skirts, props, meeples, and ghost spots from `GameState`.
   */
  function rebuildScene() {
    tilesGroup.clear();
    propsGroup.clear();
    skirtsGroup.clear();
    meeplesGroup.clear();
    waterfallAnimatedMeshes = [];

    if (!currentState) return;

    const placedList = Object.values(currentState.board);
    for (const tile of placedList) {
      const tKey = `${tile.x},${tile.z}`;
      const tMesh = buildTileMesh(tile);
      tMesh.userData.tileKey = tKey;
      tilesGroup.add(tMesh);

      const sGroup = buildCliffSkirtsAndUnderside(tile);
      sGroup.userData.tileKey = tKey;
      skirtsGroup.add(sGroup);

      const pGroup = buildTileProps(tile);
      pGroup.userData.tileKey = tKey;
      propsGroup.add(pGroup);

      const meeple = buildMeeplePawn(tile);
      if (meeple) {
        meeple.userData.tileKey = tKey;
        meeplesGroup.add(meeple);
      }
    }

    buildGhostSpots(currentLegalMoves);
    worldGroup.updateMatrixWorld(true);
  }

  function applyTilePlacementProgress(tileKey: string | null, progress: number) {
    if (!tileKey) return;
    const clamped = Math.max(0, Math.min(1, progress));
    const easedDrop = easeOutCubic(clamped);
    const yOffset = (1 - easedDrop) * 1.45;
    const xzScale = 0.35 + 0.65 * easedDrop;
    const propScale = Math.max(0.01, easeOutCubic(Math.max(0, (clamped - 0.18) / 0.82)));

    for (const child of tilesGroup.children) {
      if (child.userData?.tileKey === tileKey) {
        child.position.y = yOffset;
        child.scale.set(xzScale, 1, xzScale);
      }
    }
    for (const child of skirtsGroup.children) {
      if (child.userData?.tileKey === tileKey) {
        child.position.y = yOffset;
        child.scale.set(xzScale, 1, xzScale);
      }
    }
    for (const child of propsGroup.children) {
      if (child.userData?.tileKey === tileKey) {
        child.position.y = yOffset;
        child.scale.set(xzScale, propScale, xzScale);
      }
    }
    for (const child of meeplesGroup.children) {
      if (child.userData?.tileKey === tileKey) {
        const baseExpectedY = child.userData.expectedY ?? 0;
        child.position.y = baseExpectedY + yOffset * 1.15;
        child.scale.set(propScale, propScale, propScale);
      }
    }
    worldGroup.updateMatrixWorld(true);
  }

  function finishActiveTilePlacement() {
    if (placingTileKey) {
      applyTilePlacementProgress(placingTileKey, 1);
      placingTileKey = null;
    }
    ghostsGroup.visible = true;
  }

  /**
   * Renders the scene synchronously (or draws onto fallback 2D canvas if headless WebGL is unavailable).
   */
  function renderNow() {
    if (glRenderer) {
      glRenderer.render(scene, camera);
    } else if (fallbackCanvas) {
      const ctx = fallbackCanvas.getContext('2d');
      if (ctx) {
        const skyTex = getSkyTexture(themeMode);
        if (skyTex.image) {
          ctx.drawImage(
            skyTex.image as CanvasImageSource,
            0,
            0,
            fallbackCanvas.width,
            fallbackCanvas.height
          );
        } else {
          const skyGrad = ctx.createLinearGradient(
            0,
            fallbackCanvas.height * 0.85,
            fallbackCanvas.width,
            fallbackCanvas.height * 0.08
          );
          skyGrad.addColorStop(0, '#acc7da');
          skyGrad.addColorStop(0.5, '#c9dce7');
          skyGrad.addColorStop(1, '#ede8df');
          ctx.fillStyle = skyGrad;
          ctx.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        }
      }
    }
  }

  // Pointer click raycasting for LegalMove ghost selection + 3D Orbit / Pan / Zoom controls
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  let isCameraDragging = false;
  let dragMode: 'orbit' | 'pan' = 'orbit';
  let dragMoved = false;
  let downClientX = 0;
  let downClientY = 0;
  let lastClientX = 0;
  let lastClientY = 0;

  function findGhostAtClientPoint(clientX: number, clientY: number): LegalMove | null {
    if (currentLegalMoves.length === 0 || !ghostsGroup.visible) return null;
    const rect = domElement.getBoundingClientRect();
    const w = rect.width || initWidth;
    const h = rect.height || initHeight;
    pointerNDC.x = ((clientX - rect.left) / w) * 2 - 1;
    pointerNDC.y = -((clientY - rect.top) / h) * 2 + 1;

    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObjects(ghostsGroup.children, true);
    for (const hit of hits) {
      const lm = hit.object.userData?.legalMove as LegalMove | undefined;
      if (lm) return lm;
    }
    return null;
  }

  function syncInteractiveCameraNow() {
    if (inspectMode || morphActive || orbitActive || placingTileKey) return;
    const pose = computeCameraPoseForMode(viewMode);
    applyCameraPose(pose.pos, pose.target, pose.fov, pose.heightScale);
    renderNow();
  }

  function handlePointerDown(e: MouseEvent) {
    if (inspectMode) return;
    isCameraDragging = true;
    dragMoved = false;
    downClientX = e.clientX;
    downClientY = e.clientY;
    lastClientX = e.clientX;
    lastClientY = e.clientY;

    // Right-click (2), Middle-click (1), Shift+Left-click, or 2D mode pans; Left-click in 3D mode orbits
    if (e.button === 1 || e.button === 2 || e.shiftKey || viewMode === '2d') {
      dragMode = 'pan';
    } else {
      dragMode = 'orbit';
    }
    if (domElement.style) {
      domElement.style.cursor = 'grabbing';
    }
  }

  function handlePointerMove(e: MouseEvent) {
    if (inspectMode) return;
    if (!isCameraDragging) {
      if (domElement.style) {
        const overGhost = findGhostAtClientPoint(e.clientX, e.clientY);
        domElement.style.cursor = overGhost ? 'pointer' : 'grab';
      }
      return;
    }

    const totalDist = Math.hypot(e.clientX - downClientX, e.clientY - downClientY);
    if (totalDist > 5) {
      dragMoved = true;
    }

    const dx = e.clientX - lastClientX;
    const dy = e.clientY - lastClientY;
    lastClientX = e.clientX;
    lastClientY = e.clientY;

    if (!dragMoved) return;

    if (dragMode === 'orbit' && viewMode === '3d') {
      userYawOffset -= dx * 0.0075;
      userPitchOffset = Math.max(-0.58, Math.min(0.82, userPitchOffset + dy * 0.006));
    } else {
      const { crownYaw } = computeBoardFraming();
      const activeYaw = viewMode === '3d' ? crownYaw + userYawOffset : 0;
      const panSpeed = 0.0065 * userZoomFactor;
      const rightX = Math.cos(activeYaw);
      const rightZ = -Math.sin(activeYaw);
      const fwdX = -Math.sin(activeYaw);
      const fwdZ = -Math.cos(activeYaw);

      userPanX = Math.max(
        -12,
        Math.min(12, userPanX - (dx * rightX - dy * fwdX) * panSpeed)
      );
      userPanZ = Math.max(
        -12,
        Math.min(12, userPanZ - (dx * rightZ - dy * fwdZ) * panSpeed)
      );
    }

    syncInteractiveCameraNow();
  }

  function handlePointerUp(e: MouseEvent) {
    if (inspectMode) return;
    const wasDragging = isCameraDragging;
    const didMove = dragMoved;
    isCameraDragging = false;
    dragMoved = false;

    if (domElement.style) {
      const overGhost = findGhostAtClientPoint(e.clientX, e.clientY);
      domElement.style.cursor = overGhost ? 'pointer' : 'grab';
    }

    if (wasDragging && !didMove && e.button === 0 && options.onSelectMove) {
      const lm = findGhostAtClientPoint(e.clientX, e.clientY);
      if (lm) {
        options.onSelectMove(lm);
      }
    }
  }

  function handleWheel(e: WheelEvent) {
    if (inspectMode) return;
    e.preventDefault();
    const zoomFactorDelta = Math.exp(e.deltaY * 0.0014);
    userZoomFactor = Math.max(0.18, Math.min(2.8, userZoomFactor * zoomFactorDelta));
    syncInteractiveCameraNow();
  }

  function handleDoubleClick(e: MouseEvent) {
    if (inspectMode) return;
    if (findGhostAtClientPoint(e.clientX, e.clientY)) return;
    userYawOffset = 0;
    userPitchOffset = 0;
    userZoomFactor = 1.0;
    userPanX = 0;
    userPanZ = 0;
    syncInteractiveCameraNow();
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
  }

  if (domElement.style) {
    domElement.style.cursor = 'grab';
  }
  domElement.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  domElement.addEventListener('wheel', handleWheel, { passive: false } as any);
  domElement.addEventListener('dblclick', handleDoubleClick);
  domElement.addEventListener('contextmenu', handleContextMenu);

  function handleResize() {
    if (options.width && options.height) return;
    const w = container.clientWidth || window.innerWidth || 1280;
    const h = container.clientHeight || window.innerHeight || 720;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    if (glRenderer) {
      glRenderer.setSize(w, h);
    } else if (fallbackCanvas) {
      fallbackCanvas.width = w;
      fallbackCanvas.height = h;
    }
    renderNow();
  }

  window.addEventListener('resize', handleResize);

  // Animation loop for interactive mode
  let rafId = 0;
  function tick(nowMs: number) {
    if (!inspectMode) {
      if (morphActive) {
        const elapsed = nowMs - morphStartTime;
        const rawT = Math.min(1, elapsed / MORPH_DURATION_MS);
        const eased = easeInOutCubic(rawT);

        const hScale = morphFromHeightScale + (morphToHeightScale - morphFromHeightScale) * eased;
        const fov = morphFromFov + (morphToFov - morphFromFov) * eased;
        const pos = new THREE.Vector3().lerpVectors(morphFromPos, morphToPos, eased);
        const target = new THREE.Vector3().lerpVectors(morphFromTarget, morphToTarget, eased);

        applyCameraPose(pos, target, fov, hScale);
        if (rawT >= 1) {
          morphActive = false;
        }
      } else if (orbitActive) {
        const pose = computeCameraPoseForMode('3d', orbitAngleOffset);
        applyCameraPose(pose.pos, pose.target, pose.fov, pose.heightScale);
      } else if (placingTileKey) {
        const elapsed = nowMs - placeAnimStartMs;
        const totalMs = PLACE_DROP_MS + PLACE_HOLD_MS + PLACE_ZOOM_MS;
        const hScale = viewMode === '3d' ? 1 : 0;

        if (elapsed < PLACE_DROP_MS) {
          // Phase 1: Block drops into place and builds the scene while camera stays locked at same angle & zoom
          const dropT = elapsed / PLACE_DROP_MS;
          applyTilePlacementProgress(placingTileKey, dropT);
          ghostsGroup.visible = false;
          applyCameraPose(placeCameraHoldPos, placeCameraHoldTarget, placeCameraHoldFov, hScale);
        } else if (elapsed < PLACE_DROP_MS + PLACE_HOLD_MS) {
          // Phase 2: Hold camera steady at the same angle after the block lands so player sees the world build
          applyTilePlacementProgress(placingTileKey, 1);
          ghostsGroup.visible = false;
          applyCameraPose(placeCameraHoldPos, placeCameraHoldTarget, placeCameraHoldFov, hScale);
        } else if (elapsed < totalMs) {
          // Phase 3: Smoothly zoom camera out (keeping the exact same angle) for the next player's turn
          applyTilePlacementProgress(placingTileKey, 1);
          ghostsGroup.visible = true;
          const zoomT = (elapsed - PLACE_DROP_MS - PLACE_HOLD_MS) / PLACE_ZOOM_MS;
          const easedZoom = easeInOutCubic(zoomT);
          const pos = new THREE.Vector3().lerpVectors(placeCameraHoldPos, placeCameraNextPos, easedZoom);
          const target = new THREE.Vector3().lerpVectors(
            placeCameraHoldTarget,
            placeCameraNextTarget,
            easedZoom
          );
          const fov = placeCameraHoldFov + (placeCameraNextFov - placeCameraHoldFov) * easedZoom;
          applyCameraPose(pos, target, fov, hScale);
        } else {
          applyTilePlacementProgress(placingTileKey, 1);
          ghostsGroup.visible = true;
          placingTileKey = null;
          applyCameraPose(placeCameraNextPos, placeCameraNextTarget, placeCameraNextFov, hScale);
        }
      }

      // Subtle waterfall foam pulse & gentle cloud drift
      const pulse = 1 + 0.06 * Math.sin(nowMs * 0.005);
      for (const m of waterfallAnimatedMeshes) {
        m.scale.set(pulse, 1, pulse);
      }
      for (let i = 0; i < cloudsGroup.children.length; i++) {
        const c = cloudsGroup.children[i];
        const bx = c.userData.baseX ?? 0;
        const by = c.userData.baseY ?? 0;
        c.position.x = bx + Math.sin(nowMs * 0.00025 + i * 1.3) * 0.28;
        c.position.y = by + Math.cos(nowMs * 0.00032 + i * 0.9) * 0.08;
      }

      renderNow();
      rafId = requestAnimationFrame(tick);
    }
  }

  if (!inspectMode && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(tick);
  }

  /**
   * Finds a specific placed tile matching predicate, falling back to the Starter tile at (0,0).
   */
  function findTargetTile(predicate: (t: PlacedTile) => boolean): PlacedTile | null {
    if (!currentState) return null;
    const list = Object.values(currentState.board);
    return list.find(predicate) || list[0] || null;
  }

  // Initialize default 2D pose
  const initPose = computeCameraPoseForMode('2d');
  applyCameraPose(initPose.pos, initPose.target, initPose.fov, initPose.heightScale);

  return {
    syncState(state: GameState, legalMoves: LegalMove[] = []) {
      const incomingKeys = Object.keys(state.board);
      let newlyAddedKey: string | null = null;
      if (!inspectMode && knownTileKeys.size >= 1 && incomingKeys.length === knownTileKeys.size + 1) {
        for (const k of incomingKeys) {
          if (!knownTileKeys.has(k)) {
            newlyAddedKey = k;
            break;
          }
        }
      }
      knownTileKeys = new Set(incomingKeys);

      currentState = state;
      currentLegalMoves = legalMoves;
      rebuildScene();

      if (newlyAddedKey && !morphActive && !orbitActive) {
        // Lock current camera pose first, animate the new block building the scene, wait, then zoom out
        placingTileKey = newlyAddedKey;
        placeAnimStartMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        placeCameraHoldPos.copy(camera.position);
        placeCameraHoldTarget.copy(currentLookAt);
        placeCameraHoldFov = camera.fov;

        const nextPose = computeCameraPoseForMode(viewMode);
        placeCameraNextPos.copy(nextPose.pos);
        placeCameraNextTarget.copy(nextPose.target);
        placeCameraNextFov = nextPose.fov;

        applyTilePlacementProgress(placingTileKey, 0);
        ghostsGroup.visible = false;
        renderNow();
        return;
      }

      finishActiveTilePlacement();
      if (!morphActive && !orbitActive) {
        const pose = computeCameraPoseForMode(viewMode);
        applyCameraPose(pose.pos, pose.target, pose.fov, pose.heightScale);
      }
      renderNow();
    },

    setView(mode: ViewMode, immediate = false) {
      viewMode = mode;
      const targetPose = computeCameraPoseForMode(mode);

      if (immediate || inspectMode) {
        morphActive = false;
        applyCameraPose(
          targetPose.pos,
          targetPose.target,
          targetPose.fov,
          targetPose.heightScale
        );
        renderNow();
        return;
      }

      morphActive = true;
      morphStartTime = performance.now();
      morphFromHeightScale = currentHeightScale;
      morphToHeightScale = targetPose.heightScale;
      morphFromFov = camera.fov;
      morphToFov = targetPose.fov;
      morphFromPos.copy(camera.position);
      morphToPos.copy(targetPose.pos);
      morphFromTarget.copy(currentLookAt);
      morphToTarget.copy(targetPose.target);
    },

    getView(): ViewMode {
      return viewMode;
    },

    setTheme(theme: ThemeMode) {
      themeMode = theme;
      const cfg = THEMES[theme] || THEMES.day;
      const skyTex = getSkyTexture(theme);
      scene.background = skyTex;
      skyQuadMat.map = skyTex;
      skyQuadMat.needsUpdate = true;
      ambientLight.color.setHex(cfg.ambientColor);
      ambientLight.intensity = cfg.ambientIntensity;
      hemiLight.color.setHex(cfg.hemiSky);
      hemiLight.groundColor.setHex(cfg.hemiGround);
      hemiLight.intensity = cfg.hemiIntensity;
      sunLight.color.setHex(cfg.sunColor);
      sunLight.intensity = cfg.sunIntensity;
      sunLight.position.set(...cfg.sunPos);
      rimLight.color.setHex(cfg.rimColor);
      rimLight.intensity = cfg.rimIntensity;
      renderNow();
    },

    setQuality(quality: QualityMode) {
      qualityMode = quality;
      if (glRenderer) {
        glRenderer.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
        glRenderer.shadowMap.enabled = quality === 'high';
      }
      rebuildScene();
      renderNow();
    },

    async startOrbitFlythrough(durationMs = 2800): Promise<void> {
      viewMode = '3d';
      // Wait for 1.4s morph if not in inspect mode, then orbit 360 degrees
      const startMs = performance.now();
      orbitActive = true;

      return new Promise((resolve) => {
        const step = () => {
          const elapsed = performance.now() - startMs;
          const progress = Math.min(1, elapsed / Math.max(1, durationMs));
          orbitAngleOffset = progress * Math.PI * 2;
          const pose = computeCameraPoseForMode('3d', orbitAngleOffset);
          applyCameraPose(pose.pos, pose.target, pose.fov, 1);
          renderNow();

          if (progress < 1) {
            setTimeout(step, 16);
          } else {
            orbitActive = false;
            orbitAngleOffset = 0;
            const finalPose = computeCameraPoseForMode('3d', 0);
            applyCameraPose(finalPose.pos, finalPose.target, finalPose.fov, 1);
            renderNow();
            resolve();
          }
        };
        step();
      });
    },

    /**
     * Deterministic Inspection Timeline (`renderAt(tSeconds)`):
     * - 0 - 3s: Top-down 2D flat view (`heightScale = 0`, `fov = 8`)
     * - 3 - 5s: The Rise (`1.4s` morph from `t=3.0` to `t=4.4` interpolating `heightScale` 0->1 and `fov` 8->45, settling until `5.0s`)
     * - 5 - 9s: 360-degree orbital rotation at 35-degree tilt around the board center
     * - 9 - 12s: Macro zoom onto the waterfall (`9 - 10.5s`) then the hill bridge (`10.5 - 12s`)
     */
    renderAt(tSeconds: number) {
      finishActiveTilePlacement();
      morphActive = false;
      orbitActive = false;

      const pose2D = computeCameraPoseForMode('2d', 0, false);
      const pose3D = computeCameraPoseForMode('3d', 0, false);

      if (tSeconds < 3.0) {
        viewMode = '2d';
        applyCameraPose(pose2D.pos, pose2D.target, FOV_2D, 0);
      } else if (tSeconds < 5.0) {
        viewMode = '3d';
        const morphProgress = Math.min(1, Math.max(0, (tSeconds - 3.0) / 1.4));
        const eased = easeInOutCubic(morphProgress);
        const hScale = eased;
        const fov = FOV_2D + (FOV_3D - FOV_2D) * eased;
        const pos = new THREE.Vector3().lerpVectors(pose2D.pos, pose3D.pos, eased);
        const target = new THREE.Vector3().lerpVectors(pose2D.target, pose3D.target, eased);
        applyCameraPose(pos, target, fov, hScale);
      } else if (tSeconds < 9.0) {
        viewMode = '3d';
        const orbitFrac = (tSeconds - 5.0) / 4.0;
        const angle = orbitFrac * Math.PI * 2;
        const orbitPose = computeCameraPoseForMode('3d', angle, false);
        applyCameraPose(orbitPose.pos, orbitPose.target, FOV_3D, 1);
      } else if (tSeconds < 10.5) {
        viewMode = '3d';
        const wfTile = findTargetTile(
          (t) => t.spec.special === 'WATERFALL_BRIDGE' || t.spec.special === 'WATERFALL'
        );
        const tx = wfTile ? wfTile.x : pose3D.target.x;
        const tz = wfTile ? wfTile.z : pose3D.target.z;
        const ty = wfTile ? wfTile.level * LEVEL_HEIGHT - 0.15 : pose3D.target.y;
        const target = new THREE.Vector3(tx, ty, tz);
        const pos = new THREE.Vector3(tx + 1.45, ty + 1.25, tz + 1.65);
        applyCameraPose(pos, target, 36, 1);
      } else {
        viewMode = '3d';
        const brTile = findTargetTile(
          (t) => t.spec.special === 'BRIDGE_HILL' || t.spec.special === 'BRIDGE_FLAT'
        );
        const tx = brTile ? brTile.x : pose3D.target.x;
        const tz = brTile ? brTile.z : pose3D.target.z;
        const ty = brTile ? (brTile.level + 0.3) * LEVEL_HEIGHT : pose3D.target.y;
        const target = new THREE.Vector3(tx, ty, tz);
        const pos = new THREE.Vector3(tx - 1.55, ty + 1.2, tz + 1.55);
        applyCameraPose(pos, target, 36, 1);
      }

      // Deterministic waterfall foam animation
      const pulse = 1 + 0.08 * Math.sin(tSeconds * 4.0);
      for (const m of waterfallAnimatedMeshes) {
        m.scale.set(pulse, 1, pulse);
      }

      renderNow();
    },

    listShots(): ShotName[] {
      return [...REQUIRED_SHOTS];
    },

    captureShot(name: ShotName): string {
      finishActiveTilePlacement();
      morphActive = false;
      orbitActive = false;
      const { cx, cz } = computeBoardFraming();

      switch (name) {
        case 'board-2d': {
          const pose = computeCameraPoseForMode('2d', 0, false);
          applyCameraPose(pose.pos, pose.target, FOV_2D, 0);
          break;
        }
        case 'terrace-overview': {
          const pose = computeCameraPoseForMode('3d', 0, false);
          applyCameraPose(pose.pos, pose.target, FOV_3D, 1);
          break;
        }
        case 'waterfall-macro': {
          const wfTile = findTargetTile(
            (t) => t.spec.special === 'WATERFALL_BRIDGE' || t.spec.special === 'WATERFALL'
          );
          const tx = wfTile ? wfTile.x : cx;
          const tz = wfTile ? wfTile.z : cz;
          const ty = wfTile ? wfTile.level * LEVEL_HEIGHT - 0.12 : 0;
          applyCameraPose(
            new THREE.Vector3(tx + 1.35, ty + 1.15, tz + 1.55),
            new THREE.Vector3(tx, ty, tz),
            35,
            1
          );
          break;
        }
        case 'bridge-hill-macro': {
          const brTile = findTargetTile(
            (t) => t.spec.special === 'BRIDGE_HILL' || t.spec.special === 'BRIDGE_FLAT'
          );
          const tx = brTile ? brTile.x : cx;
          const tz = brTile ? brTile.z : cz;
          const ty = brTile ? (brTile.level + 0.35) * LEVEL_HEIGHT : 0.15;
          applyCameraPose(
            new THREE.Vector3(tx - 1.45, ty + 1.1, tz + 1.45),
            new THREE.Vector3(tx, ty, tz),
            35,
            1
          );
          break;
        }
        case 'cliff-closeup': {
          const cliffTile = findTargetTile(
            (t) =>
              t.spec.special === 'GRASS_PLATEAU' ||
              t.spec.special === 'GRASS_HILL' ||
              t.spec.special === 'WATERFALL_BRIDGE'
          );
          const tx = cliffTile ? cliffTile.x : cx;
          const tz = cliffTile ? cliffTile.z : cz;
          const ty = cliffTile ? cliffTile.level * LEVEL_HEIGHT - 0.25 : -0.25;
          applyCameraPose(
            new THREE.Vector3(tx + 1.4, ty + 0.55, tz + 1.4),
            new THREE.Vector3(tx, ty, tz),
            34,
            1
          );
          break;
        }
        case 'city-closeup': {
          const cityTile = findTargetTile((t) =>
            t.spec.edges.some((edge) => edge === 'CITY')
          );
          const tx = cityTile ? cityTile.x : cx;
          const tz = cityTile ? cityTile.z : cz;
          const ty = cityTile ? cityTile.level * LEVEL_HEIGHT + 0.08 : 0.08;
          applyCameraPose(
            new THREE.Vector3(tx + 1.2, ty + 1.05, tz + 1.2),
            new THREE.Vector3(tx, ty, tz),
            34,
            1
          );
          break;
        }
        case 'meeple-ground': {
          const meepleTile = findTargetTile((t) => t.meeple !== null);
          const tx = meepleTile ? meepleTile.x : cx;
          const tz = meepleTile ? meepleTile.z : cz;
          const ty = meepleTile ? meepleTile.level * LEVEL_HEIGHT + 0.08 : 0.08;
          applyCameraPose(
            new THREE.Vector3(tx + 0.95, ty + 0.65, tz + 0.95),
            new THREE.Vector3(tx, ty, tz),
            32,
            1
          );
          break;
        }
        case 'underside-slab': {
          applyCameraPose(
            new THREE.Vector3(cx + 3.2, BASE_SLAB_Y - 1.65, cz + 3.2),
            new THREE.Vector3(cx, BASE_SLAB_Y + 0.25, cz),
            42,
            1
          );
          break;
        }
      }

      renderNow();

      try {
        const dataUrl = domElement.toDataURL('image/png');
        if (dataUrl && dataUrl.startsWith('data:image/png')) {
          return dataUrl;
        }
      } catch {
        // Fallback for headless test environments without canvas serialization
      }
      return FALLBACK_PNG_DATA_URI;
    },

    /**
     * Deterministic Geometry & Scene Audit (`audit()`):
     * Inspects placed tile meshes, props, overlays, cliff skirts, meeples, and water seams.
     */
    audit(): AuditReport {
      finishActiveTilePlacement();
      const details: string[] = [];
      let floatingProps = 0;
      let missingPolygonOffset = 0;
      let uvStretchOutliers = 0;
      let ungroundedMeeples = 0;
      let waterSeamMismatches = 0;

      // 1. Check all 3D props for grounding against terrain height
      for (const propObj of propsGroup.children) {
        propObj.traverse((child) => {
          if (child.userData?.kind === 'prop') {
            const gap = Math.abs((child.userData.baseY ?? 0) - (child.userData.terrainY ?? 0));
            if (gap > 0.02) {
              floatingProps++;
              details.push(`Floating prop ${child.userData.label} on ${child.userData.tileKey}: gap=${gap.toFixed(4)}`);
            }
          }
          if (child.userData?.kind === 'overlay' && child instanceof THREE.Mesh) {
            const mat = child.material as THREE.Material;
            if (!mat.polygonOffset) {
              missingPolygonOffset++;
              details.push(`Overlay ${child.userData.label} missing polygonOffset`);
            }
          }
        });
      }

      // 2. Check ghost spot overlays for polygonOffset
      for (const ghostChild of ghostsGroup.children) {
        if (ghostChild.userData?.kind === 'ghost' && ghostChild instanceof THREE.Mesh) {
          const mat = ghostChild.material as THREE.Material;
          if (!mat.polygonOffset) {
            missingPolygonOffset++;
            details.push('Ghost tile mesh missing polygonOffset');
          }
        }
      }

      // 3. Check cliff skirt triangles for UV stretch outliers
      for (const skirtGroup of skirtsGroup.children) {
        skirtGroup.traverse((child) => {
          if (child.userData?.kind === 'cliff-skirt' && child instanceof THREE.Mesh) {
            const geom = child.geometry as THREE.BufferGeometry;
            const pos = geom.attributes.position;
            const uv = geom.attributes.uv;
            const idx = geom.index;
            if (pos && uv && idx) {
              for (let i = 0; i < idx.count; i += 3) {
                const a = idx.getX(i);
                const b = idx.getX(i + 1);
                const c = idx.getX(i + 2);

                const worldLenAB = Math.hypot(
                  pos.getX(b) - pos.getX(a),
                  pos.getY(b) - pos.getY(a),
                  pos.getZ(b) - pos.getZ(a)
                );
                const uvLenAB = Math.hypot(uv.getX(b) - uv.getX(a), uv.getY(b) - uv.getY(a));

                if (worldLenAB > 1e-4) {
                  const ratio = uvLenAB / worldLenAB;
                  if (ratio < 0.25 || ratio > 4.0 || Number.isNaN(ratio)) {
                    uvStretchOutliers++;
                  }
                }
                void c;
              }
            }
          }
        });
      }

      // 4. Check meeples for strict terrain/bridge surface grounding
      for (const meepleObj of meeplesGroup.children) {
        if (meepleObj.userData?.kind === 'meeple') {
          const expectedY = meepleObj.userData.expectedY ?? 0;
          const actualY = meepleObj.position.y;
          if (Math.abs(actualY - expectedY) > 0.005) {
            ungroundedMeeples++;
            details.push(
              `Ungrounded meeple on ${meepleObj.userData.tileKey}: actual=${actualY.toFixed(4)} expected=${expectedY.toFixed(4)}`
            );
          }
        }
      }

      // 5. Check shared WATER edges across placed tiles for water surface height seam matching
      if (currentState) {
        const board = currentState.board;
        for (const tile of Object.values(board)) {
          const rotEdges = getRotatedEdges(tile.spec, tile.rotation);
          for (const dir of DIR_OFFSETS) {
            if (rotEdges[dir.dir] !== 'WATER') continue;
            const nKey = `${tile.x + dir.dx},${tile.z + dir.dz}`;
            const neighbor = board[nKey];
            if (!neighbor) continue;

            const hA = getEdgeWorldHeight(tile.level, tile.spec, tile.rotation, dir.dir);
            const hB = getEdgeWorldHeight(
              neighbor.level,
              neighbor.spec,
              neighbor.rotation,
              dir.opposite
            );
            if (Math.abs(hA - hB) > 1e-4) {
              waterSeamMismatches++;
              details.push(
                `Water seam mismatch between (${tile.x},${tile.z}) and (${neighbor.x},${neighbor.z}): ${hA} vs ${hB}`
              );
            }
          }
        }
      }

      if (details.length === 0) {
        details.push(
          `Audited ${tilesGroup.children.length} tiles, ${propsGroup.children.length} prop groups, ${skirtsGroup.children.length} cliff skirts, ${meeplesGroup.children.length} meeples: all checks passed.`
        );
      }

      const ok =
        floatingProps === 0 &&
        missingPolygonOffset === 0 &&
        uvStretchOutliers === 0 &&
        ungroundedMeeples === 0 &&
        waterSeamMismatches === 0 &&
        webglWarnings === 0;

      return {
        ok,
        floatingProps,
        missingPolygonOffset,
        uvStretchOutliers,
        ungroundedMeeples,
        waterSeamMismatches,
        webglWarnings,
        details,
      };
    },

    pickGhostEdgeAtClientPoint(
      clientX: number,
      clientY: number
    ): { move: LegalMove; edgeIndex: DirIndex; featureType: Exclude<EdgeType, 'GRASS'> } | null {
      if (currentLegalMoves.length === 0) return null;
      const rect = domElement.getBoundingClientRect();
      const w = rect.width || initWidth;
      const h = rect.height || initHeight;
      pointerNDC.x = ((clientX - rect.left) / w) * 2 - 1;
      pointerNDC.y = -((clientY - rect.top) / h) * 2 + 1;

      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObjects(ghostsGroup.children, true);
      for (const hit of hits) {
        const lm = hit.object.userData?.legalMove as LegalMove | undefined;
        if (lm && lm.legalMeepleEdges.length > 0) {
          const localX = hit.point.x - lm.x;
          const localZ = hit.point.z - lm.z;
          const socketOffsets: Record<DirIndex, [number, number]> = {
            0: [0, -0.35],
            1: [0.35, 0],
            2: [0, 0.35],
            3: [-0.35, 0],
          };
          let best = lm.legalMeepleEdges[0];
          let bestDist = Infinity;
          for (const cand of lm.legalMeepleEdges) {
            const [ox, oz] = socketOffsets[cand.edgeIndex];
            const d = Math.hypot(localX - ox, localZ - oz);
            if (d < bestDist) {
              bestDist = d;
              best = cand;
            }
          }
          return {
            move: lm,
            edgeIndex: best.edgeIndex,
            featureType: best.featureType,
          };
        }
      }
      return null;
    },

    dispose() {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      domElement.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      domElement.removeEventListener('wheel', handleWheel as any);
      domElement.removeEventListener('dblclick', handleDoubleClick);
      domElement.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('resize', handleResize);
      if (glRenderer) {
        glRenderer.dispose();
      }
    },
  };
}
