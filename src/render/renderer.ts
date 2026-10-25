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
    background: 0x162234,
    fogColor: 0x162234,
    ambientColor: 0xffffff,
    ambientIntensity: 0.55,
    hemiSky: 0xdbeafe,
    hemiGround: 0x3f4e38,
    hemiIntensity: 0.65,
    sunColor: 0xfff7ed,
    sunIntensity: 1.35,
    sunPos: [9, 15, 8],
    rimColor: 0x93c5fd,
    rimIntensity: 0.45,
  },
  golden: {
    background: 0x231829,
    fogColor: 0x231829,
    ambientColor: 0xfde68a,
    ambientIntensity: 0.48,
    hemiSky: 0xfdba74,
    hemiGround: 0x45271d,
    hemiIntensity: 0.6,
    sunColor: 0xfb923c,
    sunIntensity: 1.55,
    sunPos: [13, 9, 6],
    rimColor: 0xf472b6,
    rimIntensity: 0.4,
  },
  overcast: {
    background: 0x1e2631,
    fogColor: 0x1e2631,
    ambientColor: 0xe2e8f0,
    ambientIntensity: 0.72,
    hemiSky: 0xcbd5e1,
    hemiGround: 0x334155,
    hemiIntensity: 0.75,
    sunColor: 0xf1f5f9,
    sunIntensity: 0.85,
    sunPos: [5, 16, 4],
    rimColor: 0x94a3b8,
    rimIntensity: 0.35,
  },
};

/**
 * Generates a procedural horizontal sedimentary rock strata texture for triplanar cliff skirts.
 */
function createStrataRockTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#686058';
    ctx.fillRect(0, 0, size, size);

    const bands = [
      { y: 0, h: 28, color: '#746c64' },
      { y: 28, h: 20, color: '#5c544c' },
      { y: 48, h: 36, color: '#6b635b' },
      { y: 84, h: 18, color: '#504942' },
      { y: 102, h: 32, color: '#787066' },
      { y: 134, h: 24, color: '#5a524b' },
      { y: 158, h: 40, color: '#6e665e' },
      { y: 198, h: 22, color: '#4d4640' },
      { y: 220, h: 36, color: '#645c54' },
    ];

    for (const b of bands) {
      ctx.fillStyle = b.color;
      ctx.fillRect(0, b.y, size, b.h);
      ctx.fillStyle = 'rgba(30, 26, 22, 0.35)';
      ctx.fillRect(0, b.y, size, 2);
    }

    // Deterministic mineral grain & vertical crevices
    for (let i = 0; i < 320; i++) {
      const rx = ((i * 73) % size);
      const ry = ((i * 137) % size);
      const rw = 4 + (i % 14);
      const rh = 2 + (i % 4);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,248,240,0.08)' : 'rgba(20,16,12,0.12)';
      ctx.fillRect(rx, ry, rw, rh);
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
 * Generates a carved dark museum stone texture for the underside plinth slab.
 */
function createUndersidePlinthTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#36322e';
    ctx.fillRect(0, 0, size, size);

    // Carved coffered stone grid
    ctx.strokeStyle = '#4a453f';
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, size - 20, size - 20);

    ctx.fillStyle = '#403b36';
    ctx.fillRect(24, 24, size - 48, size - 48);

    ctx.strokeStyle = '#292522';
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
  scene.background = new THREE.Color(THEMES.day.background);

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
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 45;
  const shadowCamSize = 8;
  sunLight.shadow.camera.left = -shadowCamSize;
  sunLight.shadow.camera.right = shadowCamSize;
  sunLight.shadow.camera.top = shadowCamSize;
  sunLight.shadow.camera.bottom = -shadowCamSize;
  sunLight.shadow.bias = -0.0008;

  const rimLight = new THREE.DirectionalLight(THEMES.day.rimColor, THEMES.day.rimIntensity);
  rimLight.position.set(-10, 8, -9);

  // Underside fill light so `underside-slab` shot is richly lit and detailed
  const underLight = new THREE.DirectionalLight(0xcbd5e1, 0.75);
  underLight.position.set(4, -12, 5);

  scene.add(ambientLight, hemiLight, sunLight, rimLight, underLight);

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
  const plinthTexture = createUndersidePlinthTexture();

  const cliffMaterial = new THREE.MeshStandardMaterial({
    map: strataTexture,
    roughness: 0.88,
    metalness: 0.06,
    side: THREE.DoubleSide,
  });

  const undersideMaterial = new THREE.MeshStandardMaterial({
    map: plinthTexture,
    color: 0x78716c,
    roughness: 0.85,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });

  const stoneBridgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8b2a6,
    roughness: 0.8,
    metalness: 0.08,
  });

  const cityWallMaterial = new THREE.MeshStandardMaterial({
    color: 0xc29b78,
    roughness: 0.78,
    metalness: 0.05,
  });

  const cityRoofMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a6280,
    roughness: 0.65,
    metalness: 0.12,
  });

  const cloisterWallMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6dac3,
    roughness: 0.75,
    metalness: 0.05,
  });

  const cloisterRoofMaterial = new THREE.MeshStandardMaterial({
    color: 0xbc4c38,
    roughness: 0.65,
    metalness: 0.1,
  });

  const waterfallWaterMaterial = new THREE.MeshStandardMaterial({
    color: 0x4ea8de,
    emissive: 0x1d4ed8,
    emissiveIntensity: 0.18,
    roughness: 0.25,
    metalness: 0.1,
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
    const texSize = quality === 'high' ? 256 : 128;
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
    tex.anisotropy = quality === 'high' ? 4 : 1;
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

  function computeCameraPoseForMode(mode: ViewMode, extraYaw = 0) {
    const { cx, cz, avgY, spanX, spanZ, crownYaw } = computeBoardFraming();
    const aspect = camera.aspect || 16 / 9;

    if (mode === '2d') {
      const effectiveSpan = Math.max(spanZ, spanX / Math.max(0.6, aspect));
      const halfFovRad = THREE.MathUtils.degToRad(FOV_2D / 2);
      const dist2D = effectiveSpan / (2 * Math.tan(halfFovRad));
      return {
        pos: new THREE.Vector3(cx, dist2D, cz + 0.001),
        target: new THREE.Vector3(cx, 0, cz),
        fov: FOV_2D,
        heightScale: 0,
      };
    } else {
      const boardRadius = Math.max(spanX, spanZ) * 0.58;
      const dist3D = Math.max(5.8, boardRadius * 1.75);
      const horizDist = dist3D * Math.cos(TILT_3D_RAD);
      const vertDist = dist3D * Math.sin(TILT_3D_RAD);
      const yaw = crownYaw + extraYaw;
      const targetY = avgY;
      return {
        pos: new THREE.Vector3(
          cx + horizDist * Math.sin(yaw),
          targetY + vertDist,
          cz + horizDist * Math.cos(yaw)
        ),
        target: new THREE.Vector3(cx, targetY, cz),
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

    const mat = new THREE.MeshStandardMaterial({
      map: getTileTexture(tile.spec, tile.rotation, qualityMode),
      roughness: 0.78,
      metalness: 0.04,
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

    // 3. City Battlement Walls & Blue-Slate Gabled Roofs (`CITY` edges)
    for (let s = 0; s < 4; s++) {
      const side = s as DirIndex;
      if (rotatedEdges[side] !== 'CITY') continue;

      const dir = DIR_OFFSETS[side];
      const cityCluster = new THREE.Group();

      // Anchor point at inset 0.22 along this edge's city sector
      const centerU = 0.5 + dir.dx * 0.28;
      const centerV = 0.5 + dir.dz * 0.28;
      const baseElev = getPropElevation(tile.level, tile.spec, tile.rotation, centerU, centerV);

      // Inner fortified curtain wall with crenellated merlons (inset 0.26 from edge)
      const wallU = 0.5 + dir.dx * 0.22;
      const wallV = 0.5 + dir.dz * 0.22;
      const wallY = getPropElevation(tile.level, tile.spec, tile.rotation, wallU, wallV);
      const isHorizontalWall = dir.dz !== 0;
      const wallLen = 0.68;
      const wallHeight = 0.085;
      const wallThick = 0.045;

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

      // 5 Merlons along the top of the curtain wall
      for (let m = -2; m <= 2; m++) {
        const mOffset = m * 0.13;
        const merlonGeom = new THREE.BoxGeometry(0.05, 0.03, 0.05);
        const merlonMesh = new THREE.Mesh(merlonGeom, cityWallMaterial);
        merlonMesh.position.set(
          wallU - 0.5 + (isHorizontalWall ? mOffset : 0),
          wallY + wallHeight + 0.015,
          wallV - 0.5 + (isHorizontalWall ? 0 : mOffset)
        );
        merlonMesh.castShadow = true;
        cityCluster.add(merlonMesh);
      }

      // 2 Medieval Houses with Blue-Slate Gabled Roofs inside the city segment
      for (const hOffset of [-0.18, 0.18]) {
        const hu = Math.max(0.08, Math.min(0.92, centerU + (isHorizontalWall ? hOffset : 0)));
        const hv = Math.max(0.08, Math.min(0.92, centerV + (isHorizontalWall ? 0 : hOffset)));
        const hy = getPropElevation(tile.level, tile.spec, tile.rotation, hu, hv);

        const bodyH = 0.075;
        const bodyGeom = new THREE.BoxGeometry(0.11, bodyH, 0.11);
        const bodyMesh = new THREE.Mesh(bodyGeom, cityWallMaterial);
        bodyMesh.position.set(hu - 0.5, hy + bodyH * 0.5, hv - 0.5);
        bodyMesh.castShadow = true;
        cityCluster.add(bodyMesh);

        const roofH = 0.065;
        const roofGeom = new THREE.ConeGeometry(0.095, roofH, 4);
        roofGeom.rotateY(Math.PI / 4);
        const roofMesh = new THREE.Mesh(roofGeom, cityRoofMaterial);
        roofMesh.position.set(hu - 0.5, hy + bodyH + roofH * 0.5, hv - 0.5);
        roofMesh.castShadow = true;
        cityCluster.add(roofMesh);
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
        ctx.fillStyle = '#162234';
        ctx.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText(`Tiers (${viewMode.toUpperCase()})`, 24, 36);
      }
    }
  }

  // Pointer click raycasting for LegalMove ghost selection
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  function handlePointerDown(e: MouseEvent) {
    if (!options.onSelectMove || currentLegalMoves.length === 0) return;
    const rect = domElement.getBoundingClientRect();
    const w = rect.width || initWidth;
    const h = rect.height || initHeight;
    pointerNDC.x = ((e.clientX - rect.left) / w) * 2 - 1;
    pointerNDC.y = -((e.clientY - rect.top) / h) * 2 + 1;

    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObjects(ghostsGroup.children, true);
    for (const hit of hits) {
      const lm = hit.object.userData?.legalMove as LegalMove | undefined;
      if (lm) {
        options.onSelectMove(lm);
        return;
      }
    }
  }

  domElement.addEventListener('pointerdown', handlePointerDown);

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

      // Subtle waterfall foam pulse
      const pulse = 1 + 0.06 * Math.sin(nowMs * 0.005);
      for (const m of waterfallAnimatedMeshes) {
        m.scale.set(pulse, 1, pulse);
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
      scene.background = new THREE.Color(cfg.background);
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

      const pose2D = computeCameraPoseForMode('2d');
      const pose3D = computeCameraPoseForMode('3d');

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
        const orbitPose = computeCameraPoseForMode('3d', angle);
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
          const pose = computeCameraPoseForMode('2d');
          applyCameraPose(pose.pos, pose.target, FOV_2D, 0);
          break;
        }
        case 'terrace-overview': {
          const pose = computeCameraPoseForMode('3d');
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
      window.removeEventListener('resize', handleResize);
      if (glRenderer) {
        glRenderer.dispose();
      }
    },
  };
}
