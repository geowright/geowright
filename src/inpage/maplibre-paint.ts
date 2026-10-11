import {
  Color,
  createVisibilityExpression,
  expression as styleExpression,
  featureFilter,
  function as styleFunction,
  latest,
  normalizePropertyExpression,
  type StyleExpression,
  type StylePropertyExpression,
} from '@maplibre/maplibre-gl-style-spec';
import type { Map as MlMap } from 'maplibre-gl';
import type { RenderedFeature, Visibility } from './types';
import type { StyleBranch, StyleCause } from './types-internal';

/**
 * "Rendered is not visible": queryRenderedFeatures returns features whose paint makes them
 * invisible (opacity 0, alpha-0 colour, zero radius/width, text-opacity 0 — all verified by spike; and
 * MapLibre 6's whole-layer fill-layer-opacity / line-layer-opacity 0, read from its renderer).
 * This evaluates the layer's paint properties FOR ONE FEATURE (data-driven expressions, zoom,
 * feature-state) through public API: map.getPaintProperty / getLayoutProperty give the style
 * values, and the expression evaluator is MapLibre's own, from the separately published
 * @maplibre/maplibre-gl-style-spec (bundled into the injected script; the app ships nothing).
 *
 * It answers "does the style paint anything for this feature" and says WHY not. It does not know
 * about pixels: a fully transparent icon image, a colour equal to the background, or an opaque
 * feature on top are out of its reach (the pixel probe and the occlusion check cover those).
 * Anything it cannot evaluate (newer expression than the bundled evaluator, unknown layer type)
 * counts as visible — never a false "invisible".
 */
const spec = latest as unknown as Record<string, Record<string, any>>;

/**
 * Compiled expressions and filters, by their style JSON. Bounded: an app that keeps changing a paint property (a
 * highlight driven by a changing literal, an animation) would otherwise add an entry per value, forever.
 */
const CACHE_MAX = 500;
function cached<V>(cache: Map<string, V>, key: string, make: () => V): V {
  if (cache.has(key)) {
    const v = cache.get(key)!;
    cache.delete(key); // most recently used last: the oldest is dropped first
    cache.set(key, v);
    return v;
  }
  const v = make();
  cache.set(key, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return v;
}
const parsed = new Map<string, StylePropertyExpression | null>();
const UNPARSEABLE = Symbol('unparseable') as unknown as StylePropertyExpression;

const GEOM_TYPE: Record<string, 1 | 2 | 3> = { Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3 };

/**
 * The projection the map renders with, and whether it is a GLOBE. `getProjection().type` is a name ('mercator',
 * 'globe', 'vertical-perspective') or, since MapLibre 5, an EXPRESSION of zoom (the style-spec's own example goes from
 * 'vertical-perspective' to 'mercator'); MapLibre renders every one but 'mercator' with its globe transform
 * (createProjectionFromName), so all of them get the globe treatment. `name` is always a string: an expression is
 * named by what it evaluates to at the current zoom.
 */
export function projectionOf(map: MlMap): { name: string; globe: boolean } {
  let type: unknown;
  try {
    type = (map.getProjection?.() as { type?: unknown } | undefined)?.type;
  } catch {
    type = undefined; // (a map whose style is not loaded yet)
  }
  if (type === undefined || type === null) return { name: 'mercator', globe: false };
  if (!Array.isArray(type)) return { name: String(type), globe: type !== 'mercator' };
  let now = 'unknown';
  try {
    const v = normalizePropertyExpression(type as any, 'projection', spec.projection.type).evaluate({ zoom: map.getZoom() } as any, undefined as any);
    now = v && typeof v === 'object' && 'from' in (v as any) ? `${(v as any).from}→${(v as any).to} ${Math.round((v as any).transition * 100)}%` : String(v);
  } catch {
    /* an expression the bundled evaluator cannot parse: said as such */
  }
  return { name: `expression (at this zoom: ${now})`, globe: true };
}

/**
 * The tile zoom MapLibre draws a source's features at, and whether it VARIES across the view. MapLibre evaluates
 * zoom-and-data ("composite") paint per tile, at the tile's zoom z and z+1, and blends by the camera zoom
 * (CompositeExpressionBinder). z = floor(zoom + log2(512 / tileSize)) (coveringZoomLevel; GeoJSON / vector sources
 * reparse overscaled tiles, so it is not capped by the source's maxzoom). Since MapLibre 5 different tiles of one view
 * can have different zooms: with terrain, at high pitch (the threshold depends on the field of view and roll), and on
 * a globe past tile zoom 4 (covering_tiles.ts). Older versions never vary; answering "varies" there only makes a
 * verdict less confident, never wrong.
 */
function tileZoom(map: MlMap, source: string | undefined): { z: number; varies: boolean } {
  let tileSize = 512;
  try {
    const ts = source ? (map.getSource?.(source) as { tileSize?: unknown } | undefined)?.tileSize : undefined;
    if (typeof ts === 'number' && ts > 0) tileSize = ts;
  } catch {
    /* removed source */
  }
  const z = Math.max(0, Math.floor(map.getZoom() + Math.log2(512 / tileSize)));
  let varies = false;
  try {
    if (map.getTerrain?.()) varies = true;
    else if (projectionOf(map).globe && z > 4) varies = true;
    else {
      const pitch = map.getPitch?.() ?? 0;
      const fov = (map as any).getVerticalFieldOfView?.() ?? 36.87;
      const roll = (((map as any).getRoll?.() ?? 0) * Math.PI) / 180;
      const canvas = map.getCanvas?.();
      const w = canvas?.clientWidth || 1, h = canvas?.clientHeight || 1;
      const zfov = (fov * (Math.abs(Math.cos(roll)) * h + Math.abs(Math.sin(roll)) * w)) / h;
      varies = pitch > Math.min(60, Math.max(0, 78.5 - zfov / 2));
    }
  } catch {
    varies = true; // cannot tell: not confident
  }
  return { z, varies };
}

/** `within` / `distance` anywhere in a style value: they need the feature's tile geometry, which the evaluator does not have. */
function needsGeometry(v: unknown): 'within' | 'distance' | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v[0] === 'within' || v[0] === 'distance') return v[0];
  for (const x of v) {
    const r = needsGeometry(x);
    if (r) return r;
  }
  return undefined;
}

/** The keys an expression tests with `['has', key]` (a literal key, no object argument); per expression object, once. */
const hasKeysOf = new WeakMap<object, string[]>();
function hasKeys(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  let keys = hasKeysOf.get(v);
  if (!keys) {
    const out = new Set<string>();
    const walk = (x: unknown) => {
      if (!Array.isArray(x)) return;
      if (x[0] === 'has' && x.length === 2 && typeof x[1] === 'string') out.add(x[1]);
      x.forEach(walk);
    };
    walk(v);
    hasKeysOf.set(v, (keys = [...out]));
  }
  return keys;
}

/** A value between two tile zooms, blended as the renderer's shader does (colours are premultiplied, blended per channel). */
function blend(lo: any, hi: any, t: number): any {
  if (t <= 0) return lo;
  if (t >= 1) return hi;
  if (typeof lo === 'number' && typeof hi === 'number') return lo + (hi - lo) * t;
  if (lo instanceof Color && hi instanceof Color) return new Color(lo.r + (hi.r - lo.r) * t, lo.g + (hi.g - lo.g) * t, lo.b + (hi.b - lo.b) * t, lo.a + (hi.a - lo.a) * t);
  return undefined; // not interpolable: unknown
}

/** Evaluates this layer's paint/layout properties FOR ONE FEATURE. Shared by visibility and appearance. */
function evaluatorFor(map: MlMap, f: RenderedFeature) {
  const layer = map.getLayer(f.layer)!;
  const type = layer.type;
  const zoom = map.getZoom();
  const globals = { zoom };
  const feature = { type: GEOM_TYPE[f.geometry.type] ?? 1, id: f.id, properties: f.properties };
  let globalState: Record<string, unknown> = {};
  try {
    globalState = map.getGlobalState?.() ?? {};
  } catch {
    /* older MapLibre: no global state */
  }
  let tiles: { z: number; varies: boolean } | undefined;

  const expression = (group: 'paint' | 'layout', name: string): StylePropertyExpression | null | undefined => {
    const propSpec = spec[`${group}_${type}`]?.[name];
    if (!propSpec) return undefined;
    let raw: unknown;
    try {
      raw = group === 'paint' ? map.getPaintProperty(f.layer, name as any) : map.getLayoutProperty(f.layer, name as any);
    } catch {
      // A property the bundled spec knows but the app's library does not (fill-layer-opacity before MapLibre 6):
      // MapLibre 2–5 and Mapbox GL 1 THROW on the read (verified by the compat matrix). That library cannot draw
      // by it, so it has no say: not evaluable -> never a reason for "invisible".
      return undefined;
    }
    const input = raw === undefined || raw === null ? propSpec.default : raw;
    if (input === undefined) return null; // no value and no default, e.g. text-field, *-pattern
    const key = `${type}|${name}|${JSON.stringify(input)}|${JSON.stringify(globalState)}`;
    const expr = cached(parsed, key, () => {
      try {
        // An operator the bundled evaluator has never heard of does NOT throw: the array is taken for a
        // literal value (verified). An array with a string head, on a property that is not array-typed,
        // that is not a known expression, is an expression from the future.
        const fromTheFuture = Array.isArray(input) && typeof input[0] === 'string' && propSpec.type !== 'array' && !styleExpression.isExpression(input);
        return fromTheFuture || needsGeometry(input) ? UNPARSEABLE : normalizePropertyExpression(input, name, propSpec as any, globalState);
      } catch {
        return UNPARSEABLE;
      }
    });
    if (expr === UNPARSEABLE) {
      // `within` / `distance` evaluate to false / NaN without the tile geometry — a wrong answer, not an unknown one.
      caveatsOf(map).unparseable.set(`${f.layer}: ${name}`, { why: needsGeometry(input) ?? 'newer', layer: f.layer, group, name, input: JSON.stringify(raw) });
      return undefined;
    }
    return expr;
  };

  const state = (f.state ?? {}) as any;
  /** A zoom-and-data paint value as the renderer draws it from tiles of zoom z (see tileZoom). */
  const composite = (expr: StylePropertyExpression, z: number): any => {
    const lo = expr.evaluate({ zoom: z } as any, feature as any, state);
    const hi = expr.evaluate({ zoom: z + 1 } as any, feature as any, state);
    const t = Math.min(1, Math.max(0, (expr as { interpolationFactor?: (i: number, a: number, b: number) => number }).interpolationFactor?.(zoom, z, z + 1) ?? 0));
    return blend(lo, hi, t);
  };
  const isComposite = (group: 'paint' | 'layout', expr: StylePropertyExpression) => group === 'paint' && (expr as { kind?: string }).kind === 'composite';

  /** Evaluated value; undefined = could not evaluate (unknown property, unsupported expression), null = not set. */
  const value = (group: 'paint' | 'layout', name: string): any => {
    const expr = expression(group, name);
    if (!expr) return expr;
    try {
      if (isComposite(group, expr)) return composite(expr, (tiles ??= tileZoom(map, layer.source)).z);
      return expr.evaluate(globals as any, feature as any, state);
    } catch {
      return undefined;
    }
  };
  /**
   * Where tile zooms vary across the view, the values a zoom-and-data paint property can have in OTHER tiles of it
   * (every tile zoom up to a few past the centre's). Empty when the value is the same everywhere.
   */
  const elsewhere = (group: 'paint' | 'layout', name: string): any[] => {
    const expr = expression(group, name);
    if (!expr || !isComposite(group, expr)) return [];
    const t = (tiles ??= tileZoom(map, layer.source));
    if (!t.varies) return [];
    const out: any[] = [];
    for (let z = 0; z <= Math.min(24, t.z + 4); z++) {
      try {
        out.push(composite(expr, z));
      } catch {
        out.push(undefined);
      }
    }
    return out;
  };
  /** For a zoom-and-data paint property: the tile zoom its value was evaluated at (and the next one, blended). */
  const tileZoomOf = (group: 'paint' | 'layout', name: string): number | undefined => {
    const expr = expression(group, name);
    return expr && isComposite(group, expr) ? (tiles ??= tileZoom(map, layer.source)).z : undefined;
  };
  /**
   * A GeoJSON feature's null-valued property: MapLibre draws from the worker's feature, which keeps it, while the hit test
   * decodes the tile, which drops it. So for a paint value that tests `['has', key]` on a key the rendered feature lacks,
   * the value the RENDERER used may be this one, with those keys present and null. Undefined when that cannot differ
   * (another source type, no such key), or it cannot be evaluated.
   */
  const withNulls = (group: 'paint' | 'layout', name: string): { value: any } | undefined => {
    let source: { type?: string } | undefined;
    try {
      source = layer.source ? (map.getSource(layer.source) as { type?: string } | undefined) : undefined;
    } catch {
      return undefined;
    }
    if (source?.type !== 'geojson') return undefined;
    let raw: unknown;
    // (the raw value first: most paint values test no `has`, and then nothing else is needed)
    try {
      raw = group === 'paint' ? map.getPaintProperty(f.layer, name as any) : map.getLayoutProperty(f.layer, name as any);
    } catch {
      return undefined;
    }
    const missing = hasKeys(raw).filter((k) => !(k in (f.properties ?? {})));
    const expr = missing.length ? expression(group, name) : undefined;
    if (!expr) return undefined;
    const alt = { ...feature, properties: { ...f.properties, ...Object.fromEntries(missing.map((k) => [k, null])) } };
    try {
      return { value: expr.evaluate((isComposite(group, expr) ? { zoom: (tiles ??= tileZoom(map, layer.source)).z } : globals) as any, alt as any, state) };
    } catch {
      return undefined;
    }
  };
  return { type, value, elsewhere, expression, tileZoomOf, withNulls, globalState, feature };
}

/**
 * What the evaluator could not answer with confidence, per map (the caveats of one map are not another's), recorded as
 * verdicts are made and listed as long as they are still true of that map (see the two functions below).
 *  - `unparseable`: properties the bundled evaluator cannot answer for: an expression it could not parse (the app runs
 *    a newer MapLibre than the style-spec we ship: 'newer'), or one that uses `within` / `distance`, which need the
 *    feature's tile geometry. For those the visibility answer degrades to "visible" — safe, but weaker, and it must not
 *    be silent: diagnostics print this list once.
 *  - `zoomUncertain`: zoom-and-data paint properties whose verdict was UNCERTAIN because tile zooms vary across the view
 *    (pitch, terrain, globe): hidden at one tile zoom, drawn at another. Treated as visible, and said once.
 *  - `nullUncertain`: properties that test `['has', key]` on a GeoJSON feature whose rendered copy lacks the key: the
 *    renderer keeps a null-valued property, the hit test drops it, so it cannot be told which the renderer saw. Treated
 *    as visible, and said once.
 */
type Unparseable = { why: 'newer' | 'within' | 'distance'; layer: string; group: 'paint' | 'layout'; name: string; input: string };
const caveats = new WeakMap<object, { unparseable: Map<string, Unparseable>; zoomUncertain: Map<string, string>; nullUncertain: Map<string, string> }>();
const caveatsOf = (map: MlMap) => {
  let c = caveats.get(map);
  if (!c) caveats.set(map, (c = { unparseable: new Map(), zoomUncertain: new Map(), nullUncertain: new Map() }));
  return c;
};

/** Properties of this map (layer still there) whose verdict was uncertain because of `['has', key]` on GeoJSON nulls. */
export function nullUncertainProperties(map: MlMap): string[] {
  const list = caveatsOf(map).nullUncertain;
  for (const [k, layer] of list) if (!map.getLayer(layer)) list.delete(k);
  return [...list.keys()];
}

/** Unparseable properties of this map whose layer still has the value that could not be parsed. */
export function unparseableReasons(map: MlMap): [property: string, why: 'newer' | 'within' | 'distance'][] {
  const list = caveatsOf(map).unparseable;
  for (const [k, u] of list) {
    let now: unknown;
    try {
      now = map.getLayer(u.layer) ? (u.group === 'paint' ? map.getPaintProperty(u.layer, u.name as any) : map.getLayoutProperty(u.layer, u.name as any)) : NaN;
    } catch {
      now = NaN; // cannot be read (any more)
    }
    if (JSON.stringify(now) !== u.input) list.delete(k);
  }
  return [...list].map(([k, u]) => [k, u.why]);
}
export const unparseableProperties = (map: MlMap): string[] => unparseableReasons(map).map(([p]) => p);

/** Uncertain properties of this map whose layer is still there, in a view whose tile zooms still vary. */
export function zoomUncertainProperties(map: MlMap): string[] {
  const list = caveatsOf(map).zoomUncertain;
  for (const [k, layer] of list) {
    const l = map.getLayer(layer);
    if (!l || !tileZoom(map, l.source).varies) list.delete(k);
  }
  return [...list.keys()];
}

/** A style property a verdict rests on. */
type Prop = { group: 'paint' | 'layout'; name: string };

/**
 * The verdict, and the style properties behind it. Every hiding reason is a short string (the wording of
 * `reason`); `props` maps each one to the properties it was read from, so that an explanation traces exactly the
 * properties the verdict used — never a second, possibly different, opinion.
 */
function evaluateVisibility(map: MlMap, f: RenderedFeature): { visibility: Visibility; parts: string[]; props: Map<string, Prop[]>; ev?: ReturnType<typeof evaluatorFor> } {
  const props = new Map<string, Prop[]>();
  if (!map.getLayer(f.layer)) return { visibility: { visible: true }, parts: [], props };
  const ev = evaluatorFor(map, f);
  const { type, value } = ev;

  /**
   * A hiding reason only if it hides in EVERY tile of the view (zoom-and-data paint where tile zooms vary), and whether or
   * not the feature has the null-valued properties the hit test drops (`['has', key]` on GeoJSON, see withNulls).
   */
  const everywhere = (group: 'paint' | 'layout', name: string, hides: (v: any) => boolean): boolean => {
    if (!ev.elsewhere(group, name).every(hides)) {
      caveatsOf(map).zoomUncertain.set(`${f.layer}: ${name}`, f.layer);
      return false;
    }
    const alt = ev.withNulls(group, name);
    if (alt && !hides(alt.value)) {
      caveatsOf(map).nullUncertain.set(`${f.layer}: ${name}`, f.layer);
      return false;
    }
    return true;
  };
  const isZero = (v: any) => typeof v === 'number' && v <= 0;
  const isClear = (v: any) => !!v && typeof v === 'object' && typeof v.a === 'number' && v.a <= 0;
  /** Drawn by this verdict, but hidden if the feature has the null-valued properties the hit test drops: said, not decided. */
  const doubt = (group: 'paint' | 'layout', name: string, hides: (v: any) => boolean) => {
    const alt = ev.withNulls(group, name);
    if (alt && hides(alt.value)) caveatsOf(map).nullUncertain.set(`${f.layer}: ${name}`, f.layer);
  };
  const zero = (group: 'paint' | 'layout', name: string): string | undefined => {
    const v = value(group, name);
    if (!isZero(v)) return void doubt(group, name, isZero);
    const r = everywhere(group, name, isZero) ? `${name} evaluates to ${v}` : undefined;
    if (r) props.set(r, [{ group, name }]);
    return r;
  };
  const transparent = (name: string): string | undefined => {
    const v = value('paint', name);
    if (!isClear(v)) return void doubt('paint', name, isClear);
    const r = everywhere('paint', name, isClear) ? `${name} is fully transparent` : undefined;
    if (r) props.set(r, [{ group: 'paint', name }]);
    return r;
  };
  /** A reason worded apart from the property it was read from ("no stroke" <- circle-stroke-width). */
  const alias = (reason: string, from: (string | undefined)[], extra: Prop[] = []): string => {
    props.set(reason, [...from.flatMap((r) => (r ? props.get(r) ?? [] : [])), ...extra]);
    return reason;
  };
  const isSet = (group: 'paint' | 'layout', name: string): boolean => {
    const v = value(group, name);
    if (v === undefined) return true; // unknown: assume it paints
    if (v === null) return false;
    return typeof v.isEmpty === 'function' ? !v.isEmpty() : String(v?.name ?? v) !== '';
  };
  const first = (...reasons: (string | undefined)[]) => reasons.find((r) => r !== undefined);
  let parts: string[] = [];
  const verdict = (...partsInvisible: (string | undefined)[]): Visibility => {
    if (!partsInvisible.every((r) => r !== undefined)) return { visible: true };
    parts = partsInvisible as string[];
    return { visible: false, reason: parts.join(' and ') };
  };

  const decide = (): Visibility => {
    switch (type) {
      case 'circle': {
        const stroke = zero('paint', 'circle-stroke-width');
        return verdict(
          first(zero('paint', 'circle-opacity'), zero('paint', 'circle-radius'), transparent('circle-color')),
          first(stroke && alias('no stroke', [stroke]), zero('paint', 'circle-stroke-opacity'), transparent('circle-stroke-color')),
        );
      }
      case 'fill': {
        // fill-layer-opacity (MapLibre 6; older versions do not have it, see expression()): at 0 nothing of the layer
        // is drawn, outline and pattern included.
        const opacity = first(zero('paint', 'fill-layer-opacity'), zero('paint', 'fill-opacity'));
        if (opacity) return verdict(opacity);
        if (isSet('paint', 'fill-pattern')) return { visible: true };
        // The outline is drawn only with fill-antialias (draw_fill.ts): without it there is no outline to see.
        if (value('paint', 'fill-antialias') === false) return verdict(transparent('fill-color'), alias('no outline (fill-antialias is false)', [], [{ group: 'paint', name: 'fill-antialias' }]));
        const outlineSet = map.getPaintProperty(f.layer, 'fill-outline-color') != null;
        // "no separate outline colour" is context, not a cause of its own: the outline is drawn in fill-color.
        return verdict(transparent('fill-color'), outlineSet ? transparent('fill-outline-color') : alias('no separate outline colour', []));
      }
      case 'line': {
        const painted = isSet('paint', 'line-pattern') || isSet('paint', 'line-gradient');
        return verdict(first(zero('paint', 'line-layer-opacity'), zero('paint', 'line-opacity'), zero('paint', 'line-width'), painted ? undefined : transparent('line-color')));
      }
      case 'fill-extrusion':
        return verdict(first(zero('paint', 'fill-extrusion-opacity'), isSet('paint', 'fill-extrusion-pattern') ? undefined : transparent('fill-extrusion-color')));
      case 'symbol': {
        let text: string;
        if (isSet('layout', 'text-field')) {
          const colour = transparent('text-color');
          const halo = colour && (zero('paint', 'text-halo-width') || transparent('text-halo-color'));
          text = first(zero('paint', 'text-opacity'), zero('layout', 'text-size'), halo ? alias('text-color and halo are fully transparent', [colour, halo]) : undefined)!;
        } else text = alias('no text', [], [{ group: 'layout', name: 'text-field' }]);
        // An SDF icon is a shape drawn IN icon-color (plus its halo); an ordinary image ignores icon-color.
        const sdfClear = (): string | undefined => {
          if (!sdfIcon(map, value('layout', 'icon-image'))) return undefined;
          const colour = transparent('icon-color');
          const halo = colour && (zero('paint', 'icon-halo-width') || transparent('icon-halo-color'));
          return halo ? alias('icon-color and halo are fully transparent (an SDF icon)', [colour, halo]) : undefined;
        };
        const icon = isSet('layout', 'icon-image') ? first(zero('paint', 'icon-opacity'), zero('layout', 'icon-size'), sdfClear()) : alias('no icon', [], [{ group: 'layout', name: 'icon-image' }]);
        return verdict(text, icon);
      }
      default:
        return { visible: true };
    }
  };
  const visibility = decide();
  return { visibility, parts, props, ev };
}

export function paintVisibility(map: MlMap, f: RenderedFeature): Visibility {
  return evaluateVisibility(map, f).visibility;
}

/**
 * For failure messages: the style properties behind an "invisible" verdict of paintVisibility(), each with its
 * evaluated value and the expression branch that produced it. Empty when the feature is visible. Only called when
 * something has already failed: it compiles a few sub-expressions, which the verdict itself never needs.
 */
export function explainPaint(map: MlMap, f: RenderedFeature): StyleCause[] {
  const { visibility, parts, props, ev } = evaluateVisibility(map, f);
  if (visibility.visible || !ev) return [];
  const seen = new Set<string>();
  const out: StyleCause[] = [];
  for (const part of parts) {
    for (const p of props.get(part) ?? []) {
      if (seen.has(`${p.group}|${p.name}`)) continue;
      seen.add(`${p.group}|${p.name}`);
      out.push(explainValue(map, f, ev, p.group, p.name));
    }
  }
  return out;
}

/* ---------------- which expression branch produced a value ----------------
 *
 * Attribution walks the style JSON of the property (what map.getPaintProperty returns) and asks MapLibre's own
 * evaluator for every value it needs: the INPUT of a match / step / interpolate, each CONDITION of a case, each
 * argument of a coalesce. Choosing the branch from those values is the one documented rule of each operator (the
 * first label equal to the input, else the fallback; the last stop <= the input; …) — and it is CHECKED: MapLibre
 * also evaluates the chosen branch's output, which must equal the value of the whole property. If it does not (a
 * semantic this code does not know), attribution stops there and only property + value are reported. So it never
 * names a branch the evaluator did not take. (Writing our own expression evaluator is "Not planned": ROADMAP.md.)
 *
 * Traced: match, case, step, interpolate / interpolate-hcl / interpolate-lab, coalesce, nested in one another, and
 * legacy `{ stops }` functions (turned into expressions by the style-spec's own convertFunction). NOT traced —
 * property + value only: let / var, arithmetic and every other operator, and an interpolation strictly BETWEEN two
 * stops (both stops are named; no single branch produced the value).
 */

const compiled = new Map<string, StyleExpression | null>();

/** A PART of a style expression, evaluated by MapLibre's evaluator. `ok: false` when it cannot stand alone (a `var`) or throws. */
function evalPart(json: unknown, propSpec: any, c: Ctx): { ok: true; value: any } | { ok: false } {
  const key = `${JSON.stringify(propSpec ?? null)}|${JSON.stringify(json)}|${JSON.stringify(c.globalState)}`;
  const e = cached(compiled, key, () => {
    try {
      const r = styleExpression.createExpression(json, 'geowright', propSpec ?? null, c.globalState);
      return r.result === 'success' ? r.value : null;
    } catch {
      return null;
    }
  });
  if (!e) return { ok: false };
  try {
    return { ok: true, value: e.evaluateWithoutErrorHandling(c.globals as any, c.feature, c.state) };
  } catch {
    return { ok: false };
  }
}

/** A style value as plain, JSON-safe data: colours as "rgba(…)", images by name. */
function plain(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v.name === 'string' && 'available' in v) return v.name; // ResolvedImage
  return typeof v.toString === 'function' && v.toString !== Object.prototype.toString ? String(v) : JSON.stringify(v);
}
const same = (a: any, b: any): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : JSON.stringify(plain(a)) === JSON.stringify(plain(b));

type Ctx = { propSpec: any; globalState: Record<string, unknown>; globals: { zoom: number }; feature: any; state: any };

/** The branches that produced `value` from `json`, outermost first. Stops (keeping what it has) at anything it cannot verify. */
function attribute(json: unknown, value: any, c: Ctx, depth = 0): StyleBranch[] {
  if (!Array.isArray(json) || depth > 10) return [];
  const sub = (j: unknown, spec: any = null) => evalPart(j, spec, c);
  /** A branch counts only if MapLibre's value for its output IS the value of the whole; then look inside it. */
  const via = (branch: StyleBranch, output: unknown): StyleBranch[] => {
    const out = sub(output, c.propSpec);
    return out.ok && same(out.value, value) ? [branch, ...attribute(output, value, c, depth + 1)] : [];
  };
  const op = json[0];
  switch (op) {
    case 'match': {
      if (json.length < 5) return [];
      const input = sub(json[1]);
      if (!input.ok) return [];
      const base = { op, input: json[1], inputValue: plain(input.value) };
      for (let i = 2; i < json.length - 1; i += 2) {
        const labels = Array.isArray(json[i]) ? (json[i] as unknown[]) : [json[i]];
        if (labels.some((l) => l === input.value)) return via({ ...base, taken: 'label', at: input.value }, json[i + 1]);
      }
      return via({ ...base, taken: 'fallback' }, json[json.length - 1]);
    }
    case 'case': {
      for (let i = 1; i < json.length - 1; i += 2) {
        const test = sub(json[i], { type: 'boolean' });
        if (!test.ok) return [];
        if (test.value === true) return via({ op, taken: 'condition', at: (i + 1) / 2, condition: json[i] }, json[i + 1]);
      }
      return via({ op, taken: 'fallback' }, json[json.length - 1]);
    }
    case 'step': {
      const input = sub(json[1]);
      if (!input.ok || typeof input.value !== 'number') return [];
      const base = { op, input: json[1], inputValue: input.value };
      let chosen = 2; // the base output, for an input below the first stop
      for (let i = 3; i < json.length - 1; i += 2) if ((json[i] as number) <= input.value) chosen = i + 1;
      return chosen === 2 ? via({ ...base, taken: 'base', at: json[3] }, json[2]) : via({ ...base, taken: 'stop', at: json[chosen - 1] }, json[chosen]);
    }
    case 'interpolate':
    case 'interpolate-hcl':
    case 'interpolate-lab': {
      const input = sub(json[2]);
      if (!input.ok || typeof input.value !== 'number') return [];
      const x = input.value;
      const base = { op, input: json[2], inputValue: x };
      const stops: number[] = [];
      for (let i = 3; i < json.length - 1; i += 2) stops.push(json[i] as number);
      if (!stops.length) return [];
      const output = (k: number) => json[4 + 2 * k];
      if (x <= stops[0]) return via({ ...base, taken: 'stop', at: stops[0] }, output(0));
      const last = stops.length - 1;
      if (x >= stops[last]) return via({ ...base, taken: 'stop', at: stops[last] }, output(last));
      const exact = stops.indexOf(x);
      if (exact >= 0) return via({ ...base, taken: 'stop', at: x }, output(exact));
      const k = stops.findIndex((s, i) => s <= x && x < stops[i + 1]);
      return k >= 0 ? [{ ...base, taken: 'between', at: [stops[k], stops[k + 1]] }] : [];
    }
    case 'coalesce': {
      for (let i = 1; i < json.length; i++) {
        const arg = sub(json[i]);
        if (!arg.ok) return [];
        if (arg.value !== null) return via({ op, taken: 'argument', at: i }, json[i]);
      }
      return [];
    }
    default:
      return [];
  }
}

/** One property of one feature's layer: its value, and how the style arrived at it. */
function explainValue(map: MlMap, f: RenderedFeature, ev: ReturnType<typeof evaluatorFor>, group: 'paint' | 'layout', name: string): StyleCause {
  const zoom = map.getZoom();
  const value = ev.value(group, name);
  const raw: unknown = group === 'paint' ? map.getPaintProperty(f.layer, name as any) : map.getLayoutProperty(f.layer, name as any);
  const cause: StyleCause = { layer: f.layer, group, property: name, value: plain(value), zoom, origin: 'default', branches: [] };
  if (raw === undefined || raw === null) return cause;
  const isFn = !Array.isArray(raw) && typeof raw === 'object' && styleFunction.isFunction(raw);
  if (!isFn && !(Array.isArray(raw) && styleExpression.isExpression(raw))) return { ...cause, origin: 'constant' };
  const propSpec = spec[`${group}_${ev.type}`]?.[name];
  let json = raw;
  if (isFn) {
    try {
      json = styleFunction.convertFunction(raw, propSpec);
    } catch {
      return { ...cause, origin: 'function' };
    }
  }
  // A zoom-and-data value is drawn from tiles of zoom z (see tileZoom): traced there, not at the camera zoom, where its
  // branches would not produce it (attribute() checks every branch against the value, so it would name none). Said in
  // the message only where it differs from the camera zoom.
  const tileZ = ev.tileZoomOf(group, name);
  const ctx: Ctx = { propSpec, globalState: ev.globalState, globals: { zoom: tileZ ?? zoom }, feature: ev.feature, state: f.state ?? {} };
  return { ...cause, origin: isFn ? 'function' : 'expression', ...(tileZ === undefined || tileZ === zoom ? {} : { tileZoom: tileZ }), branches: value === undefined ? [] : attribute(json, value, ctx) };
}

/**
 * A layer's layout `visibility` as the style evaluates it NOW: a constant, or (MapLibre >= 5.16) an expression on
 * global state, evaluated by the style-spec's own visibility evaluator. `value` is undefined when the expression
 * cannot be evaluated (newer than the bundled evaluator): unknown, which every caller treats as visible.
 */
function layoutVisibility(map: MlMap, layerId: string): { raw: unknown; value: unknown; globalState: Record<string, unknown> } {
  const raw = map.getLayoutProperty(layerId, 'visibility') as unknown;
  let globalState: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return { raw, value: raw, globalState };
  try {
    globalState = map.getGlobalState?.() ?? {};
  } catch {
    /* older MapLibre: no global state */
  }
  let value: unknown;
  try {
    value = createVisibilityExpression(raw as any, `layers[${layerId}].layout.visibility`, globalState).evaluate();
  } catch {
    value = undefined; // an expression the bundled evaluator cannot parse: unknown, so not hidden
  }
  return { raw, value, globalState };
}

/** False when layout `visibility` hides the layer: "none" as a constant, or what its expression evaluates to now. */
export function layoutVisible(map: MlMap, layerId: string): boolean {
  return layoutVisibility(map, layerId).value !== 'none';
}

/** The paint properties that, all at 0, make a layer of that type draw nothing. */
const OPACITY_PROPERTIES: Record<string, string[]> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  symbol: ['icon-opacity', 'text-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
};

/**
 * The opacity properties the pixel probe can set to 0 to hide this layer WITHOUT MapLibre reloading its source. A paint
 * change reloads the source only when the old or the new value is data-driven (feature properties or feature-state) or
 * cross-faded — StyleLayer.setPaintProperty, the same in MapLibre 2–6 and Mapbox GL 1 — while `visibility: none` always
 * does, and the tiles that come back from that reload lack the layer. Undefined when the type has no such
 * properties, or one of them is data-driven or cannot be read: then only `visibility` can hide the layer.
 */
export function reloadFreeOpacity(map: MlMap, layerId: string): string[] | undefined {
  const type = map.getLayer(layerId)?.type;
  const names = type ? OPACITY_PROPERTIES[type] : undefined;
  if (!names) return undefined;
  for (const name of names) {
    let raw: unknown;
    try {
      raw = map.getPaintProperty(layerId, name as any);
    } catch {
      return undefined;
    }
    if (raw === undefined || raw === null || typeof raw === 'number') continue;
    // an operator the bundled evaluator does not know would be read as a literal (see evaluatorFor): unknown, not constant
    if (Array.isArray(raw) && typeof raw[0] === 'string' && !styleExpression.isExpression(raw)) return undefined;
    try {
      const kind = (normalizePropertyExpression(raw as any, name, spec[`paint_${type}`][name]) as { kind?: string }).kind;
      if (kind !== 'constant' && kind !== 'camera') return undefined;
    } catch {
      return undefined;
    }
  }
  return names;
}

/**
 * The layer types the hit test never returns (they draw pixels, not features), with the paint property that, at 0, makes
 * each draw nothing (null: none). A heatmap is hit-testable over its radius on MapLibre >= 5 but not before: it is here
 * on every version, and its hit is never taken as an occluder (the adapter's `pixelOnly`), so the gate and the probe
 * decide on every version.
 */
const PIXEL_ONLY_OPACITY: Record<string, string | null> = {
  raster: 'raster-opacity',
  hillshade: 'hillshade-exaggeration',
  'color-relief': 'color-relief-opacity',
  background: 'background-opacity',
  heatmap: 'heatmap-opacity',
  custom: null,
};

/** Does a layer of this type draw pixels rather than features (the gate's types)? */
export const isPixelOnlyType = (type: string | undefined): boolean => type !== undefined && type in PIXEL_ONLY_OPACITY;

/** Web Mercator, as MapLibre places an image / video / canvas source: x and y in [0, 1] over the world. */
export function mercator([lng, lat]: number[]): [number, number] {
  const y = Math.log(Math.tan(Math.PI / 4 + (Math.max(-89.9999, Math.min(89.9999, lat)) * Math.PI) / 360));
  return [(lng + 180) / 360, 0.5 - y / (2 * Math.PI)];
}

/** Is `p` inside the quadrilateral `quad` (any four corners in order, convex or not; even-odd rule)? */
export function inQuad(p: [number, number], quad: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const [xi, yi] = quad[i], [xj, yj] = quad[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** A number per source OBJECT: a source removed and added again under the same id is another one. */
const serials = new WeakMap<object, number>();
let lastSerial = 0;
const serial = (o: object) => serials.get(o) ?? (serials.set(o, ++lastSerial), lastSerial);

/** Does this hillshade draw nothing on flat ground (exaggeration 0)? Its method decides; unknown: no. */
function hillshadeFlatIsBlank(map: MlMap, layerId: string): boolean {
  let method: unknown;
  try {
    method = map.getPaintProperty(layerId, 'hillshade-method' as any);
  } catch {
    return false;
  }
  return method === undefined || method === null || method === 'standard' || method === 'combined' || method === 'igor';
}

/** Is the layer's opacity exactly 0 at the camera zoom? Anything the evaluator cannot read: no (it may draw). */
function opacityZero(map: MlMap, layerId: string, type: string): boolean {
  const name = PIXEL_ONLY_OPACITY[type];
  if (!name) return false;
  // At exaggeration 0 the `basic` and `multidirectional` hillshade methods still paint a flat tint (their shaders light a
  // flat surface); `standard` (the default), `combined` and `igor` paint nothing.
  if (type === 'hillshade' && !hillshadeFlatIsBlank(map, layerId)) return false;
  try {
    const raw = map.getPaintProperty(layerId, name as any) as unknown;
    if (raw === undefined || raw === null) return false; // the spec's defaults are all > 0
    if (typeof raw === 'number') return raw === 0;
    if (Array.isArray(raw) && typeof raw[0] === 'string' && !styleExpression.isExpression(raw)) return false;
    const e = normalizePropertyExpression(raw as any, name, spec[`paint_${type}`][name]) as { kind?: string; evaluate: (g: unknown) => unknown };
    return (e.kind === 'constant' || e.kind === 'camera') && e.evaluate({ zoom: map.getZoom() }) === 0;
  } catch {
    return false;
  }
}

/**
 * The pixel-only layers drawn ABOVE `target` that may draw at the surface pixel `at` (bottom to top): visible, inside
 * their zoom range, drawing something (opacity not exactly 0), and — where it can be told — whose source covers `at`: an
 * image / video / canvas source's `coordinates` (a quad in Mercator, as MapLibre warps it). Under terrain there is no
 * area test (a draped raster is not where `unproject` says). It may say too much, which costs a probe; it must never say
 * too little, which is a false pass (decision 0022).
 * `stamp`: changes when what the layer draws may have changed in a way it can see — its source (another object: removed
 * and added again), its `coordinates`, and the layer's opacity; `data`: the source's data events (`dataEvents`; not for
 * the target's own source). They only serve one action's retries (the engine keeps verdicts per action).
 */
export function pixelOccluders(map: MlMap, target: string, at: { x: number; y: number }, ids: string[], dataEvents: (source: string) => number): { layer: string; type: string; stamp: string; data: string }[] {
  const out: { layer: string; type: string; stamp: string; data: string }[] = [];
  const from = ids.indexOf(target);
  if (from < 0) return out;
  const zoom = map.getZoom();
  // The target's own source is left out of `data`: a probe that hides the target by `visibility` reloads it, and a key
  // that changed with that reload would never find the verdict just reached (probe, reload, probe… for ever).
  const targetSource = (map.getLayer(target) as { source?: string } | undefined)?.source;
  let terrain: unknown;
  try {
    terrain = (map as any).getTerrain?.();
  } catch {
    terrain = undefined;
  }
  let where: [number, number][] | undefined; // `at` in Mercator, in this world copy and the ones on either side
  const here = () => {
    if (!where) {
      const ll = map.unproject([at.x, at.y] as any);
      where = [-360, 0, 360].map((d) => mercator([ll.lng + d, ll.lat]));
    }
    return where;
  };
  let style: { sources?: Record<string, { coordinates?: number[][] }> } | undefined;
  const styleSource = (id: string) => (style ??= (map.getStyle() ?? {}) as unknown as typeof style)!.sources?.[id];
  for (let i = from + 1; i < ids.length; i++) {
    const id = ids[i];
    const layer = map.getLayer(id);
    if (!layer || !(layer.type in PIXEL_ONLY_OPACITY)) continue;
    if (!layoutVisible(map, id)) continue;
    if ((layer.minzoom && zoom < layer.minzoom) || (layer.maxzoom && zoom >= layer.maxzoom)) continue;
    if (opacityZero(map, id, layer.type)) continue;
    const sourceId = (layer as { source?: string }).source;
    const src = sourceId ? (map.getSource(sourceId) as { coordinates?: number[][] } | undefined) : undefined;
    const coordinates = src?.coordinates ?? (sourceId ? styleSource(sourceId)?.coordinates : undefined);
    // Only a quad says where a layer draws. A tiled source's `bounds` do not: MapLibre draws every tile that meets them
    // whole, edge tiles past the bounds included, and a parent tile of a lower zoom while one loads.
    if (sourceId && !terrain && Array.isArray(coordinates) && coordinates.length === 4) {
      try {
        const quad = coordinates.map(mercator);
        if (!here().some((p) => inQuad(p, quad))) continue;
      } catch {
        /* cannot tell: it may cover `at` */
      }
    }
    const opacity = PIXEL_ONLY_OPACITY[layer.type];
    let paint: unknown;
    try {
      paint = opacity ? map.getPaintProperty(id, opacity as any) : undefined;
    } catch {
      paint = undefined;
    }
    out.push({ layer: id, type: layer.type, stamp: `${src ? serial(src) : 0}|${JSON.stringify(coordinates ?? null)}|${JSON.stringify(paint ?? null)}`, data: String(sourceId && sourceId !== targetSource ? dataEvents(sourceId) : 0) });
  }
  return out;
}

/**
 * Why the style draws NOTHING of a layer at the current camera: the zoom is outside minzoom–maxzoom (MapLibre hides
 * a layer when zoom < minzoom or zoom >= maxzoom), or layout `visibility` is "none" — a constant, or (MapLibre
 * >= 5.16) an expression on global state, evaluated by the style-spec's own visibility evaluator. Empty: drawn.
 */
export function explainLayerHidden(map: MlMap, layerId: string): StyleCause[] {
  const layer = map.getLayer(layerId);
  if (!layer) return [];
  const zoom = map.getZoom();
  const out: StyleCause[] = [];
  const base = { layer: layerId, zoom, origin: 'constant' as const, branches: [] };
  if (layer.minzoom && zoom < layer.minzoom) out.push({ ...base, group: 'layer', property: 'minzoom', value: layer.minzoom });
  if (layer.maxzoom && zoom >= layer.maxzoom) out.push({ ...base, group: 'layer', property: 'maxzoom', value: layer.maxzoom });
  const { raw, value, globalState } = layoutVisibility(map, layerId);
  if (value !== 'none') return out;
  if (!Array.isArray(raw)) out.push({ ...base, group: 'layout', property: 'visibility', value: 'none' });
  else {
    const ctx: Ctx = { propSpec: spec[`layout_${layer.type}`]?.visibility, globalState, globals: { zoom }, feature: { type: 1, properties: {} }, state: {} };
    out.push({ ...base, group: 'layout', property: 'visibility', value, origin: 'expression', branches: attribute(raw, value, ctx) });
  }
  return out;
}

const filters = new Map<string, ReturnType<typeof featureFilter> | null>();

/**
 * Does the layer's `filter` let this DATA feature (from queryData) through? MapLibre applies it per tile, at the tile's
 * zoom, so that is where it is evaluated here too (see tileZoom); where tile zooms vary across the view, it is "no" only
 * if no tile zoom lets it through. Undefined when it cannot be told: a filter the bundled evaluator cannot compile, or
 * one that needs the tile geometry (`within`, `distance`). Never a false "no".
 */
export function filterAdmits(map: MlMap, f: RenderedFeature): boolean | undefined {
  const layer = map.getLayer(f.layer);
  if (!layer) return undefined;
  let raw: unknown;
  try {
    raw = map.getFilter(f.layer);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === null) return true;
  let globalState: Record<string, unknown> = {};
  try {
    globalState = map.getGlobalState?.() ?? {};
  } catch {
    /* older MapLibre: no global state */
  }
  const key = `${JSON.stringify(raw)}|${JSON.stringify(globalState)}`;
  const compiled = cached(filters, key, () => {
    try {
      return featureFilter(raw as any, `layers.${f.layer}.filter`, globalState);
    } catch {
      return null;
    }
  });
  if (!compiled || compiled.needGeometry) return undefined;
  const feature = { type: GEOM_TYPE[f.geometry.type] ?? 1, id: f.id, properties: f.properties };
  const t = tileZoom(map, layer.source);
  const zooms = t.varies ? Array.from({ length: Math.min(24, t.z + 4) + 1 }, (_, z) => z) : [t.z];
  try {
    return zooms.some((zoom) => compiled!.filter({ zoom } as any, feature as any));
  } catch {
    return undefined;
  }
}

/** Is this evaluated icon-image an SDF image of the style? `map.getImage` is feature-detected (not in Mapbox GL 1). */
function sdfIcon(map: MlMap, image: unknown): boolean {
  const name = image && typeof image === 'object' ? String((image as { name?: unknown }).name ?? '') : typeof image === 'string' ? image : '';
  if (!name || typeof (map as any).getImage !== 'function') return false;
  try {
    return (map as any).getImage(name)?.sdf === true;
  } catch {
    return false;
  }
}

const COLOUR_PROPERTY: Record<string, string> = { circle: 'circle-color', fill: 'fill-color', line: 'line-color', 'fill-extrusion': 'fill-extrusion-color' };

/**
 * The colour the style paints THIS feature with, as #rrggbb — what a user means by "the red ones".
 * `dataDriven`: the colour depends on the feature (properties / feature-state), so it says something
 * about it; a constant layer colour is the same for every row and is reported per layer instead.
 */
export function paintColour(map: MlMap, f: RenderedFeature): { property: string; colour: string; dataDriven: boolean } | undefined {
  if (!map.getLayer(f.layer)) return undefined;
  const { type, value, expression } = evaluatorFor(map, f);
  const property = type === 'symbol' ? (value('layout', 'text-field') ? 'text-color' : 'icon-color') : COLOUR_PROPERTY[type];
  if (!property) return undefined;
  const v = value('paint', property);
  if (!v || typeof v !== 'object' || typeof v.r !== 'number' || !(v.a > 0)) return undefined;
  // style-spec colours are premultiplied by alpha
  const hex = (c: number) => Math.round(Math.min(1, Math.max(0, c / v.a)) * 255).toString(16).padStart(2, '0');
  const kind = (expression('paint', property) as { kind?: string } | null | undefined)?.kind;
  return { property, colour: `#${hex(v.r)}${hex(v.g)}${hex(v.b)}`, dataDriven: kind === 'source' || kind === 'composite' };
}

/** Height in metres a fill-extrusion layer raises THIS feature to, at the current zoom (0 for anything else). */
export function extrusionHeight(map: MlMap, f: RenderedFeature): number {
  if (map.getLayer(f.layer)?.type !== 'fill-extrusion') return 0;
  const h = evaluatorFor(map, f).value('paint', 'fill-extrusion-height');
  return typeof h === 'number' && h > 0 ? h : 0;
}

/** Where the extrusion STARTS (fill-extrusion-base, metres): real building parts float — a roof slab from 120m to 132m. */
export function extrusionBase(map: MlMap, f: RenderedFeature): number {
  if (map.getLayer(f.layer)?.type !== 'fill-extrusion') return 0;
  const b = evaluatorFor(map, f).value('paint', 'fill-extrusion-base');
  return typeof b === 'number' && b > 0 ? b : 0;
}

/** For a symbol layer: the icon this feature asks for, when the style does not have it (a typo, a sprite that failed to load). */
export function missingIcon(map: MlMap, f: RenderedFeature): string | undefined {
  if (map.getLayer(f.layer)?.type !== 'symbol') return undefined;
  const v = evaluatorFor(map, f).value('layout', 'icon-image');
  const name = v && typeof v === 'object' ? String(v.name ?? '') : typeof v === 'string' ? v : '';
  return name && !map.hasImage(name) ? name : undefined;
}
