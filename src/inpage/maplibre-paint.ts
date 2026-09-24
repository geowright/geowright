import {
  createVisibilityExpression,
  expression as styleExpression,
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
const parsed = new Map<string, StylePropertyExpression | null>();
const UNPARSEABLE = Symbol('unparseable') as unknown as StylePropertyExpression;

const GEOM_TYPE: Record<string, 1 | 2 | 3> = { Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3 };

/** Evaluates this layer's paint/layout properties FOR ONE FEATURE. Shared by visibility and appearance. */
function evaluatorFor(map: MlMap, f: RenderedFeature) {
  const type = map.getLayer(f.layer)!.type;
  const globals = { zoom: map.getZoom() };
  const feature = { type: GEOM_TYPE[f.geometry.type] ?? 1, id: f.id, properties: f.properties };
  let globalState: Record<string, unknown> = {};
  try {
    globalState = map.getGlobalState?.() ?? {};
  } catch {
    /* older MapLibre: no global state */
  }

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
    let expr = parsed.get(key);
    if (expr === undefined) {
      try {
        // An operator the bundled evaluator has never heard of does NOT throw: the array is taken for a
        // literal value (verified). An array with a string head, on a property that is not array-typed,
        // that is not a known expression, is an expression from the future.
        const fromTheFuture = Array.isArray(input) && typeof input[0] === 'string' && propSpec.type !== 'array' && !styleExpression.isExpression(input);
        expr = fromTheFuture ? UNPARSEABLE : normalizePropertyExpression(input, name, propSpec as any, globalState);
      } catch {
        expr = UNPARSEABLE;
      }
      if (expr === UNPARSEABLE) unparseable.add(`${f.layer}: ${name}`);
      parsed.set(key, expr);
    }
    return expr === UNPARSEABLE ? undefined : expr;
  };

  /** Evaluated value; undefined = could not evaluate (unknown property, unsupported expression), null = not set. */
  const value = (group: 'paint' | 'layout', name: string): any => {
    const expr = expression(group, name);
    if (!expr) return expr;
    try {
      return expr.evaluate(globals as any, feature as any, (f.state ?? {}) as any);
    } catch {
      return undefined;
    }
  };
  return { type, value, expression, globalState, feature };
}

/**
 * Properties whose expression the BUNDLED evaluator could not parse (the app runs a newer MapLibre
 * than the style-spec we ship). For those the visibility answer degrades to "visible" — safe, but
 * weaker, and it must not be silent: diagnostics print this list once.
 */
const unparseable = new Set<string>();
export const unparseableProperties = (): string[] => [...unparseable];

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

  const zero = (group: 'paint' | 'layout', name: string): string | undefined => {
    const v = value(group, name);
    const r = typeof v === 'number' && v <= 0 ? `${name} evaluates to ${v}` : undefined;
    if (r) props.set(r, [{ group, name }]);
    return r;
  };
  const transparent = (name: string): string | undefined => {
    const v = value('paint', name);
    const r = v && typeof v === 'object' && typeof v.a === 'number' && v.a <= 0 ? `${name} is fully transparent` : undefined;
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
        const icon = isSet('layout', 'icon-image') ? first(zero('paint', 'icon-opacity'), zero('layout', 'icon-size')) : alias('no icon', [], [{ group: 'layout', name: 'icon-image' }]);
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
  let e = compiled.get(key);
  if (e === undefined) {
    try {
      const r = styleExpression.createExpression(json, 'geowright', propSpec ?? null, c.globalState);
      e = r.result === 'success' ? r.value : null;
    } catch {
      e = null;
    }
    compiled.set(key, e);
  }
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
  const ctx: Ctx = { propSpec, globalState: ev.globalState, globals: { zoom }, feature: ev.feature, state: f.state ?? {} };
  return { ...cause, origin: isFn ? 'function' : 'expression', branches: value === undefined ? [] : attribute(json, value, ctx) };
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
