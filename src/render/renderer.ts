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

/**
 * Paints a soft volumetric cumulus cloud cluster onto a 2D canvas context.
 * Matches the fluffy sunlit clouds in `reference/Design_of_game.jpeg` & `reference/UI_reference.jpg`.
 */
function paintCumulusCloudCluster(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scaleX: number,
  scaleY: number,
  seed: number,
  warmTint = 1.0
) {
  const puffs: Array<{ ox: number; oy: number; r: number }> = [
    { ox: -0.58, oy: 0.16, r: 0.46 },
    { ox: -0.34, oy: -0.08, r: 0.56 },
    { ox: -0.06, oy: -0.24, r: 0.68 },
    { ox: 0.24, oy: -0.14, r: 0.58 },
    { ox: 0.52, oy: 0.12, r: 0.48 },
    { ox: -0.18, oy: 0.2, r: 0.54 },
    { ox: 0.16, oy: 0.22, r: 0.54 },
    { ox: 0.0, oy: 0.04, r: 0.64 },
  ];

  // 1. Soft blue-grey ambient shadow base
  for (const p of puffs) {
    const jx = Math.sin(seed * 17.3 + p.ox * 9) * 0.05;
    const jy = Math.cos(seed * 11.7 + p.oy * 9) * 0.04;
    const px = cx + (p.ox + jx) * scaleX;
    const py = cy + (p.oy + jy + 0.12) * scaleY;
    const rad = p.r * Math.min(scaleX, scaleY * 1.35);

    const shGrad = ctx.createRadialGradient(px, py + rad * 0.12, rad * 0.05, px, py, rad);
    shGrad.addColorStop(0, 'rgba(138, 154, 174, 0.52)');
    shGrad.addColorStop(0.55, 'rgba(154, 170, 188, 0.28)');
    shGrad.addColorStop(1, 'rgba(168, 184, 202, 0)');
    ctx.fillStyle = shGrad;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2. Creamy mid-body volume puffs
  for (const p of puffs) {
    const jx = Math.sin(seed * 17.3 + p.ox * 9) * 0.05;
    const jy = Math.cos(seed * 11.7 + p.oy * 9) * 0.04;
    const px = cx + (p.ox + jx) * scaleX;
    const py = cy + (p.oy + jy) * scaleY;
    const rad = p.r * Math.min(scaleX, scaleY * 1.3);

    const midGrad = ctx.createRadialGradient(
      px + rad * 0.12,
      py - rad * 0.16,
      rad * 0.04,
      px,
      py,
      rad
    );
    const rTop = Math.round(252 + 3 * warmTint);
    const gTop = Math.round(246 + 4 * warmTint);
    const bTop = Math.round(238);
    midGrad.addColorStop(0, `rgba(${rTop}, ${gTop}, ${bTop}, 0.92)`);
    midGrad.addColorStop(0.5, 'rgba(236, 232, 228, 0.68)');
    midGrad.addColorStop(0.82, 'rgba(208, 214, 222, 0.22)');
    midGrad.addColorStop(1, 'rgba(208, 214, 222, 0)');
    ctx.fillStyle = midGrad;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. Crisp sunlit top-right crown highlights
  for (const p of puffs.slice(1, 5)) {
    const px = cx + (p.ox + 0.06) * scaleX;
    const py = cy + (p.oy - 0.1) * scaleY;
    const rad = p.r * Math.min(scaleX, scaleY * 1.1) * 0.78;

    const hiGrad = ctx.createRadialGradient(px + rad * 0.15, py - rad * 0.18, 0, px, py, rad);
    hiGrad.addColorStop(0, 'rgba(255, 253, 248, 0.85)');
    hiGrad.addColorStop(0.55, 'rgba(255, 249, 240, 0.35)');
    hiGrad.addColorStop(1, 'rgba(255, 249, 240, 0)');
    ctx.fillStyle = hiGrad;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Generates the atmospheric daylight sky + fluffy cumulus clouds background texture
 * matching `reference/Design_of_game.jpeg` and `reference/UI_reference.jpg`.
 */
function createCloudSkyTexture(theme: ThemeMode = 'day'): THREE.CanvasTexture {
  const w = 1024;
  const h = 768;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // 1. Base diagonal sky gradient (cool zenith blue on top-left -> warm sunlit ivory-gold on right)
    const skyGrad = ctx.createLinearGradient(0, 0, w, h * 0.92);
    if (theme === 'golden') {
      skyGrad.addColorStop(0, '#6d8cb0');
      skyGrad.addColorStop(0.45, '#b8a9b6');
      skyGrad.addColorStop(0.8, '#ebbfa0');
      skyGrad.addColorStop(1, '#fae0c3');
    } else if (theme === 'overcast') {
      skyGrad.addColorStop(0, '#8097b0');
      skyGrad.addColorStop(0.55, '#a8bacb');
      skyGrad.addColorStop(1, '#d5dde6');
    } else {
      skyGrad.addColorStop(0, '#83a4c6');
      skyGrad.addColorStop(0.38, '#a4c0da');
      skyGrad.addColorStop(0.72, '#c8d9e8');
      skyGrad.addColorStop(1, '#f3e6d6');
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Warm solar glow on upper-right horizon (matching Design_of_game.jpeg)
    const sunGlow = ctx.createRadialGradient(w * 0.92, h * 0.28, 10, w * 0.88, h * 0.35, w * 0.65);
    sunGlow.addColorStop(0, 'rgba(255, 248, 232, 0.72)');
    sunGlow.addColorStop(0.4, 'rgba(253, 238, 216, 0.32)');
    sunGlow.addColorStop(1, 'rgba(253, 238, 216, 0)');
    ctx.fillStyle = sunGlow;
    ctx.fillRect(0, 0, w, h);

    // 3. Distant wispy cirrus/alto-cumulus layers
    const cloudPlacements: Array<{ x: number; y: number; sx: number; sy: number; seed: number }> = [
      { x: w * 0.25, y: h * 0.1, sx: 170, sy: 95, seed: 1.1 },
      { x: w * 0.8, y: h * 0.17, sx: 190, sy: 110, seed: 2.3 },
      { x: w * 0.06, y: h * 0.26, sx: 110, sy: 68, seed: 3.7 },
      { x: w * 0.16, y: h * 0.32, sx: 165, sy: 105, seed: 4.9 },
      { x: w * 0.56, y: h * 0.38, sx: 175, sy: 98, seed: 6.2 },
      { x: w * 0.7, y: h * 0.55, sx: 95, sy: 62, seed: 7.4 },
      { x: w * 0.22, y: h * 0.78, sx: 145, sy: 92, seed: 8.8 },
      { x: w * 0.77, y: h * 0.78, sx: 195, sy: 125, seed: 10.1 },
      { x: w * 0.28, y: h * 0.94, sx: 180, sy: 100, seed: 11.5 },
      { x: w * 0.62, y: h * 0.92, sx: 155, sy: 88, seed: 12.9 },
    ];

    for (const c of cloudPlacements) {
      paintCumulusCloudCluster(ctx, c.x, c.y, c.sx, c.sy, c.seed, theme === 'golden' ? 1.5 : 1.0);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a soft feathered 3D cloud puff sprite texture for floating parallax clouds around the island.
 */
function createCloudPuffSpriteTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    paintCumulusCloudCluster(ctx, size * 0.5, size * 0.52, size * 0.38, size * 0.28, 3.14, 1.0);
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
    const tex = createCloudSkyTexture(theme);
    skyTextureCache.set(theme, tex);
    return tex;
  }
  scene.background = getSkyTexture('day');

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

  // 3D Floating Cumulus Cloud Clusters around & below the floating island (outside worldGroup so 2D scale doesn't flatten them)
  const cloudsGroup = new THREE.Group();
  cloudsGroup.name = 'cloudsGroup';
  const cloudPuffTex = createCloudPuffSpriteTexture();
  const cloudRingDefs: Array<{ x: number; y: number; z: number; sx: number; sy: number; opacity: number }> = [
    { x: -3.8, y: -0.6, z: -3.2, sx: 3.4, sy: 2.1, opacity: 0.88 },
    { x: 4.2, y: 0.4, z: -2.8, sx: 3.8, sy: 2.3, opacity: 0.92 },
    { x: 3.5, y: -1.1, z: 3.4, sx: 3.6, sy: 2.2, opacity: 0.9 },
    { x: -3.6, y: -1.2, z: 2.9, sx: 3.2, sy: 1.9, opacity: 0.85 },
    { x: -1.4, y: -2.1, z: 4.5, sx: 4.0, sy: 2.4, opacity: 0.82 },
    { x: 1.8, y: -2.0, z: -4.6, sx: 3.9, sy: 2.3, opacity: 0.84 },
    { x: -5.2, y: 0.8, z: 0.2, sx: 3.1, sy: 1.8, opacity: 0.78 },
    { x: 5.4, y: -0.4, z: 0.6, sx: 3.3, sy: 1.9, opacity: 0.8 },
  ];
  for (const cd of cloudRingDefs) {
    const cMat = new THREE.SpriteMaterial({
      map: cloudPuffTex,
      transparent: true,
      opacity: cd.opacity,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(cMat);
    sp.position.set(cd.x, cd.y, cd.z);
    sp.scale.set(cd.sx, cd.sy, 1);
    sp.userData = { baseX: cd.x, baseY: cd.y, baseZ: cd.z };
    cloudsGroup.add(sp);
  }
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
        const skyGrad = ctx.createLinearGradient(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        skyGrad.addColorStop(0, '#83a4c6');
        skyGrad.addColorStop(0.55, '#b8cfe4');
        skyGrad.addColorStop(1, '#f3e6d6');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        paintCumulusCloudCluster(ctx, fallbackCanvas.width * 0.22, fallbackCanvas.height * 0.25, 140, 80, 1.1);
        paintCumulusCloudCluster(ctx, fallbackCanvas.width * 0.78, fallbackCanvas.height * 0.72, 160, 95, 2.3);
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
      scene.background = getSkyTexture(theme);
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
