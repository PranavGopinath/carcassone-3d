// STUB — owned by Pranav. Flat coloured slabs so the app boots and the UI can
// develop against something; replaced by the real diorama renderer.
import * as THREE from 'three';
import { INSPECTION_SEGMENTS } from '../contracts/renderer';
import type { ClockMode, FrameManifest, Renderer, View } from '../contracts/renderer';
import { LEVEL_HEIGHT, TILE_SIZE, rotatedHeights, rotatedSides, toWorld } from '../contracts/tiles';
import type { GameState, Side } from '../contracts/types';

const EDGE_COLORS: Record<Side, number> = {
  GRASS: 0x5f9e6e,
  CITY: 0x6b7f99,
  ROAD: 0xc9b48a,
  WATER: 0x2f7fb8,
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

  mount(canvas: HTMLCanvasElement): void {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0xf6f1e7);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x88aacc, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(5, 10, 3);
    this.scene.add(sun, this.board);
    this.applyView();
    const onResize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);
    onResize();
    this.setClockMode('realtime');
  }

  sync(state: GameState): void {
    this.board.clear();
    const s = TILE_SIZE;
    for (const p of state.placements) {
      const tile = new THREE.Group();
      const w = toWorld(p.x, p.y, p.level);
      tile.position.set(w.x, w.y, w.z);
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(s * 0.96, LEVEL_HEIGHT, s * 0.96),
        new THREE.MeshStandardMaterial({ color: 0xe8dcc4 }),
      );
      base.position.y = -LEVEL_HEIGHT / 2;
      tile.add(base);
      const heights = rotatedHeights(p.tileId, p.rotation);
      rotatedSides(p.tileId, p.rotation).forEach((side, d) => {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(s * 0.3, 0.02 + Math.max(0, heights[d]) * LEVEL_HEIGHT * 0.2, s * 0.3),
          new THREE.MeshStandardMaterial({ color: EDGE_COLORS[side] }),
        );
        const off = s * 0.3;
        strip.position.set([0, off, 0, -off][d], 0.01, [-off, 0, off, 0][d]);
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
    const seg = this.clock === 'manual'
      ? INSPECTION_SEGMENTS.find((s) => this.lastT >= s.startMs && this.lastT < s.endMs)?.id ?? null
      : null;
    return {
      tMs: this.lastT,
      view: this.view,
      segment: seg,
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

  dispose(): void {
    cancelAnimationFrame(this.raf);
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
