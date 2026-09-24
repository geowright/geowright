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
  /** Library-side per-feature state that styling may depend on (MapLibre feature-state). */
  state?: Record<string, unknown>;
}

/** Does the style paint anything for a feature? `reason` says why not (e.g. "circle-opacity evaluates to 0"). */
export interface Visibility {
  visible: boolean;
  reason?: string;
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
  /** True while the view is moving (a camera animation or a user gesture in progress). Cheap, synchronous. */
  isMoving(): boolean;
  /** Resolves true once fully settled, false on timeout. Must not hang if already idle. */
  waitForIdle(timeoutMs: number): Promise<boolean>;
  /**
   * Optional: after a waitForIdle() that timed out — WHY, as far as the library can tell. The case that matters:
   * a surface that repaints continuously on purpose (an animation) will never be idle, and waiting for it is a
   * mistake in the test, not slowness in the app.
   */
  idleDiagnosis?(): string | undefined;
  /** Optional: call `cb` whenever the rendered content may have changed and has settled. Returns unsubscribe. */
  subscribe?(cb: () => void): () => void;
  /**
   * Optional: "rendered is not visible". Libraries return features from their hit test that the
   * style makes invisible (opacity 0, transparent colour, zero size). Must never report a false
   * "invisible": when in doubt, visible.
   */
  visibility?(f: RenderedFeature): Visibility;
  /**
   * Optional: the colour the style paints this feature with ("#rrggbb"), and whether it depends on the
   * feature (data-driven) or is one constant for the layer. Lets the text snapshot answer "the red ones".
   */
  colour?(f: RenderedFeature): { property: string; colour: string; dataDriven: boolean } | undefined;
  /**
   * Optional: how many pixels UP the screen the top of this feature is drawn from where its geometry
   * projects to at `at` — 3D extrusions seen with a pitched camera. What a user sees and clicks is the
   * roof and the walls, not the footprint on the ground (which may even be outside the viewport while
   * the building towers into it). An estimate is enough: candidates are verified by the hit test.
   */
  lift?(f: RenderedFeature, at: Pt): number;
  /** Optional, with `lift`: the same for the BOTTOM of the drawn volume, when it does not start on the ground. */
  liftBase?(f: RenderedFeature, at: Pt): number;
  /**
   * Optional: if the surface repeats its content horizontally (a zoomed-out web-mercator map shows the
   * world several times), the period in pixels. The same feature drawn in two copies is ONE feature.
   */
  wrapPx?(): number | undefined;
  /**
   * Optional: a library-specific reason why a feature that EXISTS in the data is not drawn
   * (MapLibre: "its icon image X is not in the style" — otherwise indistinguishable from a label collision).
   */
  whyNotRendered?(f: RenderedFeature): string | undefined;
  /**
   * Optional: things the adapter could NOT work out and silently answered safely for (e.g. a style
   * expression newer than the bundled evaluator -> "visible"). Printed once in diagnostics/snapshot.
   */
  caveats?(): string[];
  /**
   * Optional pixel probe: how much do the surface's pixels around `at` change when `layer` is not
   * drawn? 0 = the layer contributes nothing there. Ground truth, but slow and it re-renders.
   * May be async: a library that cannot render synchronously has to wait for real frames.
   */
  pixelContribution?(layer: string, at: Pt, radiusPx?: number): number | undefined | Promise<number | undefined>;
  /**
   * Optional: DOM things the library positions over the surface (MapLibre: Marker, Popup). They are
   * ordinary elements — tests act on them with ordinary locators — but WHERE they sit is map state.
   */
  overlays?(): Overlay[];
  /**
   * Optional: false when `world` has a pixel but is NOT what is drawn there — the far side of a
   * globe, beyond the horizon, behind the camera. Acting on that pixel would hit something else.
   */
  isOnSurface?(world: W): boolean;
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
  /**
   * For apps whose layer ids are GENERATED (svelte-maplibre-gl: `svmlgl-layer-0`, a global counter that
   * shifts when a layer is added): address layers by what they are instead — their type
   * ('circle', 'fill', 'symbol', …) and/or their source id. Combined with `layer` they narrow it.
   */
  layerType?: string | string[];
  source?: string | string[];
  id?: string | number;
  where?: Record<string, WhereValue | WhereOp>;
  /** Only features rendered under this world location (hit test). Disambiguates e.g. vertex handles. */
  at?: LngLat;
  /**
   * Default (undefined / true): only features a user can SEE — the style actually paints them
   * (opacity > 0, non-transparent colour, non-zero size). MapLibre's own notion of "rendered" also
   * includes opacity-0 features; ask for that with 'any'. false: only the invisible ones.
   */
  visible?: boolean | 'any';
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
  /** False when the style paints nothing for this feature ("rendered" but a user cannot see it). */
  visible: boolean;
  invisibleBecause?: string;
  /** The library's per-feature state, when it has any (MapLibre feature-state: `{ hover: true }`). Apps drive highlight styling with it. */
  state?: Record<string, unknown>;
}

export type ActionPointFailure =
  | 'not-found'
  | 'ambiguous'
  | 'offscreen'
  | 'occluded'
  | 'invisible'
  | 'dom-covered'
  | 'moving'
  | 'unstable';

export type ActionPointResult =
  /** `why`: which candidate pixel was chosen and what was skipped before it — for traces. */
  | { ok: true; client: Pt; surface: Pt; feature: FeatureSummary; why: string; /** with `moving`: px per ms, measured over two frames */ velocity?: Pt }
  | { ok: false; reason: ActionPointFailure; message: string };

export interface ClickVerdict {
  /** A pointer event actually reached the page while armed. */
  fired: boolean;
  /** The target was still the topmost hit at the exact moment and pixel of the real event. */
  ok: boolean;
  reason?: string;
  /** On a miss, when the target could be located at that instant: where it was, relative to the pointer (px). */
  offset?: Pt;
}

export interface ActionPointOptions {
  /** Skip the topmost-hit check (still requires the point to be on the feature). */
  force?: boolean;
  /** Layers that are allowed to be on top of the target (e.g. labels, highlight overlays). */
  ignoreLayers?: string[];
  /**
   * 'allow': act on a target that never stops moving (an animated feature, a camera that keeps panning).
   * For `click`, `rightClick`, `dblclick`, `tap` and `hover` only. The "map is not moving" and "same pixel two
   * frames in a row" checks are skipped; the pixel is taken from the freshest rendered frame, and the ONLY guard
   * is the verification at the instant the real event arrives: if the target is no longer under the pointer by
   * then, a click or tap is swallowed before the app sees it, and a hover — which cannot be taken back — is
   * detected as a miss; either way the action tries again. It can take several attempts; a click or tap never
   * lands on the wrong thing. `dragTo`, `dragBy` and `lngLat` have no such check and refuse the option.
   */
  moving?: 'allow';
  /** @internal with `moving`: aim this many ms ahead along the target's measured velocity (learnt from misses). */
  leadMs?: number;
}

export interface SnapshotOptions {
  /** Max features listed per layer before summarising the rest. Default 15. */
  perLayer?: number;
  /** Max property keys shown per feature. Default 6. */
  maxProps?: number;
  /** Only these layers. Default: every layer that has rendered features, minus `skipLayers`. */
  layers?: string[];
  skipLayers?: string[];
  /** List only entities matching this query — how to find one feature among thousands of look-alikes. */
  filter?: FeatureQuery;
  /** Character budget for the whole snapshot (≈ 4 chars per token). The per-layer cap shrinks to fit. Default 8000. */
  maxChars?: number;
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
  /** False when the entity was counted but not hit-tested (over `max`). */
  located?: boolean;
  /** Set when no layer paints anything for this entity (opacity 0 etc.): rendered, not visible. */
  invisible?: string;
}

/** What `toHaveGeometry` compares against. Vertex order/start/winding of polygon rings do not matter. */
export type GeometryExpectation =
  | Geometry
  /** Every vertex lies on the circle through `edge` around `center` (how draw tools build circles). */
  | { circle: { center: LngLat; edge: LngLat } };

export interface GeometryVerdict {
  ok: boolean;
  /** Why not, in pixels and vertex indices. */
  reason?: string;
  actual?: Geometry;
  /** 'data': the full shape from the source. 'rendered': merged render pieces — may be tile-clipped. */
  from?: 'data' | 'rendered';
}

/** A DOM overlay positioned by the library (marker, popup). */
export interface Overlay {
  kind: 'marker' | 'popup';
  /** CSS selector for this kind, and the element's index among its matches inside the map's container. */
  selector: string;
  index: number;
  /** Bounding box, surface-relative CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  /** The pixel the overlay points at (popup tip; marker anchor if it can be known), surface-relative. */
  anchor?: Pt;
  text: string;
}

/** Something to draw on a failure screenshot, in CLIENT pixels. */
export interface DebugMark {
  x: number;
  y: number;
  /** ok: clean clickable pixel · miss: not on the feature · occluded / dom: on it but covered · target: an asked-for location */
  kind: 'ok' | 'miss' | 'occluded' | 'dom' | 'target';
  label?: string;
}
