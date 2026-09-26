/**
 * Adapter-seam additions that are INTERNAL until 1.0: the engine and the MapLibre adapter use them,
 * but they are not public API. They live in this file, not in `types.ts`, because `types.ts` is compiled into the
 * published typings (tsconfig.build.json) and this file is not: nothing under `src/playwright` and nothing in
 * `types.ts` may import it (tests/unit/published-types.unit.spec.ts checks that).
 */
import type { CanvasAdapter, Overlay, PixelPoint, RenderedFeature } from './types';

/**
 * One step of how a style expression arrived at its value: which branch it took. Plain, JSON-safe data — the
 * engine words it ("the match on ["get","kind"] took its fallback for kind="park").
 */
export interface StyleBranch {
  /** The operator: 'match' | 'case' | 'step' | 'interpolate' | 'interpolate-hcl' | 'interpolate-lab' | 'coalesce'. */
  op: string;
  /** What the branch was chosen on, as style JSON (match, step, interpolate): `["get","kind"]`, `["zoom"]`. */
  input?: unknown;
  /** What `input` evaluated to, for this feature at this zoom. */
  inputValue?: unknown;
  /**
   * - 'label': match — the label `at` equals the input
   * - 'fallback': match / case — no label matched / no condition was true; the last argument was used
   * - 'condition': case — condition number `at` (1-based; its style JSON in `condition`) was the first true one
   * - 'base': step — the input is below the first stop (`at`); the output before the stops was used
   * - 'stop': step — the output of stop `at`; interpolate — the input is at stop `at`, or clamped to it (below the
   *   first stop, above the last)
   * - 'between': interpolate — interpolated between the stops `at[0]` and `at[1]` (no single branch)
   * - 'argument': coalesce — argument number `at` (1-based) was the first that was not null
   */
  taken: 'label' | 'fallback' | 'condition' | 'base' | 'stop' | 'between' | 'argument';
  at?: unknown;
  condition?: unknown;
}

/**
 * A style property that hides something, for failure messages: its value, the zoom it was evaluated at, and the
 * expression branches that produced it. Plain, JSON-safe data.
 */
export interface StyleCause {
  layer: string;
  /** A paint or layout property of the layer, or 'layer' for the layer's own minzoom / maxzoom. */
  group: 'paint' | 'layout' | 'layer';
  property: string;
  /** The evaluated value (colours as "rgba(…)"). */
  value: unknown;
  /** The camera zoom it was evaluated at. */
  zoom: number;
  /**
   * For a zoom-and-data paint property: the tile zoom the renderer evaluates it at (with the next one, blended by the
   * camera zoom). Its value and `branches` are from there, not from `zoom`.
   */
  tileZoom?: number;
  /**
   * 'default': not set in the style, the spec's default applies · 'constant': a plain value in the style ·
   * 'expression' · 'function': a legacy `{ stops }` function (traced as the expression the style-spec converts it to).
   */
  origin: 'default' | 'constant' | 'expression' | 'function';
  /** For an expression: the branches that produced the value, outermost first. Empty when none can be traced. */
  branches: StyleBranch[];
}

/**
 * What a pixel probe found: how much the pixels changed without the layer (`diff`, 0 = it contributes nothing there),
 * or why there is no verdict YET (`inconclusive`: the pixels changed by themselves between two reads, no frame came
 * within the time budget — ask again later), or why there never will be one here (`unavailable`: no WebGL context,
 * no such layer).
 */
export type ProbeResult = { diff: number; /** the probe made the layer's source reload: see `settleAfterProbe` */ reloads?: true } | { inconclusive: string } | { unavailable: string };

/**
 * A layer the hit test cannot see (raster, image, heatmap, …) that is drawn above a target and may draw at a pixel.
 * `stamp`: opaque; it changes when what the layer draws there may have changed (new data in its source, a new opacity).
 */
export interface PixelOccluder {
  layer: string;
  type: string;
  stamp: string;
}

/**
 * A rendered feature with what only some renderers can say. `sourceLayer`: the layer of a vector-tile source it came
 * from — feature ids are unique within one source-layer only, so it is part of a feature's identity.
 */
export interface InternalRenderedFeature extends RenderedFeature {
  sourceLayer?: string;
}

/** `CanvasAdapter` plus the internal optional methods. Every `CanvasAdapter` is one (the additions are optional). */
export interface InternalCanvasAdapter<W = unknown> extends CanvasAdapter<W> {
  /**
   * Optional, for failure messages: the style properties behind a `visibility()` verdict of "invisible", each with
   * its value, zoom and the expression branch that produced it. Called only after something failed. Empty: visible.
   */
  explainInvisible?(f: RenderedFeature): StyleCause[];
  /**
   * Optional, for failure messages: why the style draws nothing of `layer` at the current camera (hidden layer,
   * zoom outside its zoom range). Empty: the style draws it.
   */
  explainLayerHidden?(layer: string): StyleCause[];
  /**
   * Optional, after a `waitForIdle()` that timed out: true when the surface was seen to be one that NEVER becomes idle
   * by design (an animated source, data re-set in a loop, continuous repainting) — as opposed to one still loading or
   * moving. A negative assertion may then take its verdict without idle; otherwise it waits for idle.
   * Must never answer true for a surface that is merely slow.
   */
  neverIdle?(): boolean;
  /**
   * Optional: for a flat map that repeats the world horizontally. Rendered geometry comes back in one canonical copy of
   * the world (lng in [-180, 180]), but what is drawn in view is the copy NEAREST the view: seen from lng 179.5, a point
   * at lng -179.8 is drawn 0.7° east, not 359° west. Returns the world position of a coordinate in the copy nearest
   * the view centre that `anchor` (a coordinate of the same geometry part) is drawn in — or undefined when that is the
   * canonical copy, or the surface does not repeat (a globe, world copies off): then `worldFromCoord` applies.
   */
  nearestCopy?(anchor: number[]): ((coord: number[]) => W) | undefined;
  /**
   * Optional, the pixel probe with its full answer (see `ProbeResult`) and a time budget for renderers that must wait
   * for real frames. When present it is used instead of `pixelContribution`.
   */
  probePixels?(layer: string, at: PixelPoint, radiusPx: number, budgetMs: number): ProbeResult | Promise<ProbeResult>;
  /**
   * Optional, with `probePixels`: the layers the hit test cannot see that are drawn above `layer` and may draw at `at`
   * (the gate before an action's pixel probe, decision 0022). It may list too many (a probe is spent); it must never leave one
   * out (a click through an opaque overlay passes). Cheap: no rendering. Empty: nothing of the kind can cover `at`.
   */
  pixelOccluders?(layer: string, at: PixelPoint): PixelOccluder[];
  /**
   * Optional, after a probe that answered `reloads`: resolves once a frame has been rendered since the probe and the
   * layer's source is loaded again — true then, false when `budgetMs` ran out first.
   */
  settleAfterProbe?(layer: string, budgetMs: number): Promise<boolean>;
  /**
   * Optional, with `queryData`: does the layer's filter let this data feature (`f.layer` is the layer asked) through,
   * at the current camera? A source holds features that some of its layers never draw (a filter per kind, clusters).
   * false only when it certainly does not; undefined when it cannot be told (then: as if it did).
   */
  filterAdmits?(f: RenderedFeature): boolean | undefined;
  /** Optional, with `overlays`: the element an overlay stands for, looked up the way `overlays()` found it. */
  overlayElement?(o: Overlay): Element | undefined;
  /**
   * Optional: does a feature of `layer` whose id in the app's data is `id` come back from `queryFeatures` with that same
   * id? MapLibre coerces a GeoJSON id that is not a non-negative integer ('north-gate' is drawn as 0, -5 as
   * 18446744073709552000), and a vector tile can carry nothing else. false: the rendered id is not the app's — the
   * engine then finds the feature through `queryData` and its properties, and does not trust the rendered id to tell
   * look-alikes apart. undefined: the layer has no features to tell (no such layer, no source).
   */
  idRoundTrips?(layer: string, id: string | number): boolean | undefined;
}
