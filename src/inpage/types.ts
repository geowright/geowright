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
  /** e.g. 'geojson' | 'vector' | 'raster'. Tells whether off-screen data can be known (geojson only). */
  sourceType?: string;
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
  /** Optional: call `cb` whenever the rendered content may have changed and has settled. Returns unsubscribe. */
  subscribe?(cb: () => void): () => void;
  /** Optional "scrollIntoView": move the camera so `world` is comfortably inside the viewport. */
  reveal?(world: W): Promise<void>;
}

/* ---------- protocol between the Playwright side and the in-page engine ---------- */

export type WhereValue = string | number | boolean | null;

/** Serializable property predicate. The Playwright side also accepts a RegExp and converts it. */
export interface WhereOp {
  eq?: WhereValue;
  ne?: WhereValue;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: WhereValue[];
  /** RegExp source, tested against String(value). */
  matches?: string;
  flags?: string;
  /** true: property must be present; false: must be absent. */
  exists?: boolean;
}

export interface FeatureQuery {
  layer?: string | string[];
  id?: string | number;
  where?: Record<string, WhereValue | WhereOp>;
  /** Only features rendered under this world location (hit test). Disambiguates e.g. vertex handles. */
  at?: LngLat;
}

export interface FeatureSummary {
  layer: string;
  id?: string | number;
  properties: Record<string, unknown>;
  geometryType: string;
  /** Representative pixel on the feature, relative to the surface (canvas). Undefined if off-screen. */
  pixel?: Pt;
  /** Same pixel in client (viewport) coordinates — what page.mouse wants. */
  client?: Pt;
  /** World coordinate under that pixel (for maps: { lng, lat }). */
  world?: unknown;
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

export interface ClickVerdict {
  /** A pointer event actually reached the page while armed. */
  fired: boolean;
  /** The target was still the topmost hit at the exact moment and pixel of the real event. */
  ok: boolean;
  reason?: string;
}

export interface ActionPointOptions {
  /** Skip the topmost-hit check (still requires the point to be on the feature). */
  force?: boolean;
  /** Layers that are allowed to be on top of the target (e.g. labels, highlight overlays). */
  ignoreLayers?: string[];
}

export interface SnapshotOptions {
  /** Max features listed per layer before summarising the rest. Default 15. */
  perLayer?: number;
  /** Max property keys shown per feature. Default 6. */
  maxProps?: number;
  /** Only these layers. Default: every layer that has rendered features, minus `skipLayers`. */
  layers?: string[];
  skipLayers?: string[];
}

/** One data entity as the snapshot / mirror see it. */
export interface EntityView {
  /** Stable identity (source + id + properties) — lets a mirror reuse DOM nodes across renders. */
  key: string;
  layer: string;
  alsoLayers: string[];
  id?: string | number;
  geometryType: string;
  properties: Record<string, unknown>;
  /** Clickable surface pixel where the entity is the topmost hit and no DOM covers it. */
  pixel?: Pt;
  /** Why there is no clean pixel (covered-by:..., covered-by-dom:..., or out of view). */
  blocked?: string;
}
