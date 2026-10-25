// STUB — owned by Pranav. Flat coloured slabs so the app boots and the UI can
// develop against something; replaced by the real diorama renderer.
import * as THREE from 'three';
import { segmentAt } from '../contracts/renderer';
import type { ClockMode, FrameManifest, Renderer, View } from '../contracts/renderer';
import { DIR_OFFSETS, LEVEL_HEIGHT, TILE_SIZE, rotatedSides, toWorld } from '../contracts/tiles';
import type { GameState, Side } from '../contracts/types';

// Shared across all tiles, so sync() allocates no GPU resources.
const BASE_GEOMETRY = new THREE.BoxGeometry(TILE_SIZE * 0.96, LEVEL_HEIGHT, TILE_SIZE * 0.96);
const BASE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xe8dcc4 });
const STRIP_GEOMETRY = new THREE.BoxGeometry(TILE_SIZE * 0.3, 0.02, TILE_SIZE * 0.3);
const SIDE_MATERIALS: Record<Side, THREE.Material> = {
  GRASS: new THREE.MeshStandardMaterial({ color: 0x5f9e6e }),
  CITY: new THREE.MeshStandardMaterial({ color: 0x6b7f99 }),
  ROAD: new THREE.MeshStandardMaterial({ color: 0xc9b48a }),
  WATER: new THREE.MeshStandardMaterial({ color: 0x2f7fb8 }),
};

export class StubRenderer implements Renderer {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private board = new THREE.Group();
  private view: View = '2d';
  private clock: ClockMode = 'realtime';
  private lastT = 0;
  private raf = 0;
  private onResize = () => {};

  mount(canvas: HTMLCanvasElement): void {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0xf6f1e7);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x88aacc, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(5, 10, 3);
    this.scene.add(sun, this.board);
    this.applyView();
    this.onResize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.setClockMode('realtime');
  }

  sync(state: GameState): void {
    this.board.clear();
    const off = TILE_SIZE * 0.3;
    for (const p of state.placements) {
      const tile = new THREE.Group();
      const w = toWorld(p.x, p.y, p.level);
      tile.position.set(w.x, w.y, w.z);
      const base = new THREE.Mesh(BASE_GEOMETRY, BASE_MATERIAL);
      base.position.y = -LEVEL_HEIGHT / 2;
      tile.add(base);
      rotatedSides(p.tileId, p.rotation).forEach((side, d) => {
        const strip = new THREE.Mesh(STRIP_GEOMETRY, SIDE_MATERIALS[side]);
        const { dx, dy } = DIR_OFFSETS[d as 0 | 1 | 2 | 3];
        strip.position.set(dx * off, 0.01, dy * off);
        tile.add(strip);
      });
      tile.userData = { tileId: p.tileId };
      this.board.add(tile);
    }
  }

  setGhosts(): void {}

  async setView(view: View): Promise<void> {
    this.view = view;
    this.applyView();
  }

  setTheme(): void {}
  setQuality(): void {}

  setClockMode(mode: ClockMode): void {
    this.clock = mode;
    cancelAnimationFrame(this.raf);
    if (mode === 'realtime') {
      const loop = (t: number) => {
        this.renderFrame(t);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  renderFrame(tMs: number): void {
    this.lastT = tMs;
    this.renderer.render(this.scene, this.camera);
  }

  getManifest(): FrameManifest {
    return {
      tMs: this.lastT,
      view: this.view,
      segment: this.clock === 'manual' ? segmentAt(this.lastT) : null,
      camera: {
        position: this.camera.position.toArray() as [number, number, number],
        target: [0, 0, 0],
        fov: this.camera.fov,
      },
      objects: this.board.children.map((c, i) => ({
        kind: 'tile',
        id: `tile-${i}`,
        tileId: c.userData.tileId,
        sourceFile: 'src/render/stub-renderer.ts',
        screenRect: null,
      })),
      checks: [],
    };
  }

  async startInspectionFlight(): Promise<void> {
    throw new Error('startInspectionFlight: not implemented'); // TODO(render/inspector)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }

  private applyView(): void {
    if (this.view === '2d') {
      this.camera.fov = 8;
      this.camera.position.set(0, 60, 0.001);
    } else {
      this.camera.fov = 45;
      this.camera.position.set(6, 6, 8);
    }
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }
}
