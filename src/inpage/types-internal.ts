/**
 * Adapter-seam additions that are INTERNAL until 1.0 (decision on an earlier issue): the engine and the MapLibre adapter use them,
 * but they are not public API. They live in this file, not in `types.ts`, because `types.ts` is compiled into the
 * published typings (tsconfig.build.json) and this file is not: nothing under `src/playwright` and nothing in
 * `types.ts` may import it (tests/unit/published-types.unit.spec.ts checks that).
 */
import type { CanvasAdapter, RenderedFeature } from './types';

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
   * 'default': not set in the style, the spec's default applies · 'constant': a plain value in the style ·
   * 'expression' · 'function': a legacy `{ stops }` function (traced as the expression the style-spec converts it to).
   */
  origin: 'default' | 'constant' | 'expression' | 'function';
  /** For an expression: the branches that produced the value, outermost first. Empty when none can be traced. */
  branches: StyleBranch[];
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
}
