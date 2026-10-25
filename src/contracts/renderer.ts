// Boundary between the game (logic + UI) and the 3D renderer, and between the
// renderer and the audit loop. The loop only ever sees the app through these types.
import type { GameState, LegalPlacement } from './types';

export type View = '2d' | '3d';
export type Quality = 'high' | 'medium' | 'low';
export type Theme = 'day' | 'golden' | 'overcast';

/**
 * 'realtime' uses requestAnimationFrame. 'manual' stops the RAF loop and only
 * advances when renderFrame(t) is called, so recordings are frame-exact.
 */
export type ClockMode = 'realtime' | 'manual';

export interface Renderer {
  mount(canvas: HTMLCanvasElement): void;
  /** Idempotent: render exactly what the state describes. */
  sync(state: GameState): void;
  setGhosts(spots: LegalPlacement[]): void;
  /** Resolves when the 1.4 s morph finishes (immediately if `instant`). */
  setView(view: View, opts?: { instant?: boolean }): Promise<void>;
  setTheme(theme: Theme): void;
  setQuality(quality: Quality): void;
  setClockMode(mode: ClockMode): void;
  /** Render the scene at absolute time tMs (manual clock). */
  renderFrame(tMs: number): void;
  getManifest(): FrameManifest;
  /** Realtime 12 s camera flight through INSPECTION_SEGMENTS; resolves when finished. */
  startInspectionFlight(): Promise<void>;
  dispose(): void;
}

/** Something on screen, tagged with the source file the loop should patch if it looks wrong. */
export interface ManifestObject {
  kind: 'tile' | 'meeple' | 'ghost' | 'prop' | 'sky' | 'slab';
  id: string;
  tileId?: string;
  sourceFile: string;
  /** Normalised [0..1] screen bbox, or null when off-screen. */
  screenRect: { x: number; y: number; w: number; h: number } | null;
}

/** Deterministic measurements the loop passes to Gemini as facts. */
export interface HardCheck {
  id: string;
  pass: boolean;
  value: number;
  detail: string;
}

export interface FrameManifest {
  tMs: number;
  view: View;
  segment: InspectionSegmentId | null;
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  objects: ManifestObject[];
  checks: HardCheck[];
}

export type InspectionSegmentId = 'flat' | 'rise' | 'orbit' | 'macro';

export interface InspectionSegment {
  id: InspectionSegmentId;
  startMs: number;
  endMs: number;
  focus: string;
}

export const INSPECTION_SEGMENTS: InspectionSegment[] = [
  { id: 'flat', startMs: 0, endMs: 3000, focus: 'Top-down 2D card: grid alignment, UI overlap' },
  { id: 'rise', startMs: 3000, endMs: 5000, focus: '2D to 3D morph: flicker, pop-in, gaps' },
  { id: 'orbit', startMs: 5000, endMs: 9000, focus: '360 orbit: strata edges, texture stretch, floating props' },
  { id: 'macro', startMs: 9000, endMs: 12000, focus: 'Waterfall foam/spray, bridge, meeple contact' },
];

export const INSPECTION_DURATION_MS = INSPECTION_SEGMENTS[INSPECTION_SEGMENTS.length - 1].endMs;

/** Segment containing tMs. The final frame (tMs === duration) belongs to the last segment. */
export function segmentAt(tMs: number): InspectionSegmentId | null {
  const seg = INSPECTION_SEGMENTS.find((s) => tMs >= s.startMs && tMs < s.endMs);
  if (seg) return seg.id;
  return tMs === INSPECTION_DURATION_MS ? INSPECTION_SEGMENTS[INSPECTION_SEGMENTS.length - 1].id : null;
}
