/**
 * The adapter seam.
 *
 * Everything library-specific lives behind `CanvasAdapter`. The engine (matching, action-point
 * selection, diagnostics) and the Playwright binding only ever talk to this interface.
 *
 * Vocabulary is deliberately not map-specific where it can be avoided:
 *  - "world" coordinates: whatever the library's native coordinate space is (lng/lat for maps,
 *    scene units for a canvas editor, data values for a chart).
 *  - "surface": the DOM element that receives real input and defines the pixel origin.
 *  - "feature": an addressable thing drawn on the surface, grouped into "layers".
 */

/** CSS pixels relative to the surface element's top-left corner. */
export interface Pt {
  x: number;
  y: number;
}

/** MapLibre world coordinate. Other adapters define their own. */
export interface LngLat {
  lng: number;
  lat: number;
}

export type Geometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface RenderedFeature {
  layer: string;
  source?: string;
  id?: string | number;
  properties: Record<string, unknown>;
  /** Geometry in world coordinates. May be a clipped piece of the full feature (tiling). */
  geometry: Geometry;
}

export interface LayerInfo {
  id: string;
  type: string;
  visible: boolean;
  source?: string;
}

export interface CanvasAdapter<W = unknown> {
  readonly kind: string;
  /** Element that receives pointer input; origin of `Pt`. */
  surface(): HTMLElement;
  getViewState(): Record<string, unknown>;
  project(world: W): Pt;
  unproject(pt: Pt): W;
  /** World position of a raw coordinate tuple from a feature geometry. */
  worldFromCoord(coord: number[]): W;
  /**
   * Features currently RENDERED, topmost first. With `at`, only features under that pixel
   * (this is the hit test). Without, everything in the viewport.
   */
  queryFeatures(q: { layers?: string[]; at?: Pt }): RenderedFeature[];
  /**
   * Features known to the library's data model for a layer, rendered or not (off-screen,
   * hidden layer). Used for diagnostics and auto-pan. Optional: not every library can answer.
   */
  queryData?(layer: string): Promise<RenderedFeature[] | null>;
  listLayers(): LayerInfo[];
  /** True when nothing is animating, loading, or pending a repaint. Cheap, synchronous. */
  isMoving(): boolean;
  /** Resolves true once fully settled, false on timeout. Must not hang if already idle. */
  waitForIdle(timeoutMs: number): Promise<boolean>;
  /** Optional "scrollIntoView": move the camera so `world` is comfortably inside the viewport. */
  reveal?(world: W): Promise<void>;
}

/* ---------- protocol between the Playwright side and the in-page engine ---------- */

export type WhereValue = string | number | boolean | null;

export interface FeatureQuery {
  layer?: string | string[];
  id?: string | number;
  where?: Record<string, WhereValue>;
  /** Only features rendered under this world location (hit test). Disambiguates e.g. vertex handles. */
  at?: LngLat;
}

export interface FeatureSummary {
  layer: string;
  id?: string | number;
  properties: Record<string, unknown>;
  geometryType: string;
  /** Representative pixel (surface-relative), if on screen. */
  pixel?: Pt;
}

export type ActionPointFailure =
  | 'not-found'
  | 'ambiguous'
  | 'offscreen'
  | 'occluded'
  | 'dom-covered'
  | 'moving'
  | 'unstable';

export type ActionPointResult =
  | { ok: true; client: Pt; surface: Pt; feature: FeatureSummary }
  | { ok: false; reason: ActionPointFailure; message: string };

export interface ActionPointOptions {
  /** Skip the topmost-hit check (still requires the point to be on the feature). */
  force?: boolean;
  /** Layers that are allowed to be on top of the target (e.g. labels, highlight overlays). */
  ignoreLayers?: string[];
}
