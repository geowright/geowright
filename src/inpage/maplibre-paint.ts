import { expression as styleExpression, latest, normalizePropertyExpression, type StylePropertyExpression } from '@maplibre/maplibre-gl-style-spec';
import type { Map as MlMap } from 'maplibre-gl';
import type { RenderedFeature, Visibility } from './types';

/**
 * "Rendered is not visible": queryRenderedFeatures returns features whose paint makes them
 * invisible (opacity 0, alpha-0 colour, zero radius/width, text-opacity 0 — all verified by spike).
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
    const raw = group === 'paint' ? map.getPaintProperty(f.layer, name as any) : map.getLayoutProperty(f.layer, name as any);
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
  return { type, value, expression };
}

/**
 * Properties whose expression the BUNDLED evaluator could not parse (the app runs a newer MapLibre
 * than the style-spec we ship). For those the visibility answer degrades to "visible" — safe, but
 * weaker, and it must not be silent: diagnostics print this list once.
 */
const unparseable = new Set<string>();
export const unparseableProperties = (): string[] => [...unparseable];

export function paintVisibility(map: MlMap, f: RenderedFeature): Visibility {
  if (!map.getLayer(f.layer)) return { visible: true };
  const { type, value } = evaluatorFor(map, f);

  const zero = (group: 'paint' | 'layout', name: string): string | undefined => {
    const v = value(group, name);
    return typeof v === 'number' && v <= 0 ? `${name} evaluates to ${v}` : undefined;
  };
  const transparent = (name: string): string | undefined => {
    const v = value('paint', name);
    return v && typeof v === 'object' && typeof v.a === 'number' && v.a <= 0 ? `${name} is fully transparent` : undefined;
  };
  const isSet = (group: 'paint' | 'layout', name: string): boolean => {
    const v = value(group, name);
    if (v === undefined) return true; // unknown: assume it paints
    if (v === null) return false;
    return typeof v.isEmpty === 'function' ? !v.isEmpty() : String(v?.name ?? v) !== '';
  };
  const first = (...reasons: (string | undefined)[]) => reasons.find((r) => r !== undefined);
  const verdict = (...partsInvisible: (string | undefined)[]): Visibility =>
    partsInvisible.every((r) => r !== undefined) ? { visible: false, reason: partsInvisible.join(' and ') } : { visible: true };

  switch (type) {
    case 'circle':
      return verdict(
        first(zero('paint', 'circle-opacity'), zero('paint', 'circle-radius'), transparent('circle-color')),
        first(zero('paint', 'circle-stroke-width') && 'no stroke', zero('paint', 'circle-stroke-opacity'), transparent('circle-stroke-color')),
      );
    case 'fill': {
      const opacity = zero('paint', 'fill-opacity');
      if (opacity) return { visible: false, reason: opacity };
      if (isSet('paint', 'fill-pattern')) return { visible: true };
      const outlineSet = map.getPaintProperty(f.layer, 'fill-outline-color') != null;
      return verdict(transparent('fill-color'), outlineSet ? transparent('fill-outline-color') : 'no separate outline colour');
    }
    case 'line': {
      const painted = isSet('paint', 'line-pattern') || isSet('paint', 'line-gradient');
      return verdict(first(zero('paint', 'line-opacity'), zero('paint', 'line-width'), painted ? undefined : transparent('line-color')));
    }
    case 'fill-extrusion':
      return verdict(first(zero('paint', 'fill-extrusion-opacity'), isSet('paint', 'fill-extrusion-pattern') ? undefined : transparent('fill-extrusion-color')));
    case 'symbol': {
      const text = isSet('layout', 'text-field')
        ? first(zero('paint', 'text-opacity'), zero('layout', 'text-size'), transparent('text-color') && (zero('paint', 'text-halo-width') || transparent('text-halo-color')) && 'text-color and halo are fully transparent')
        : 'no text';
      const icon = isSet('layout', 'icon-image') ? first(zero('paint', 'icon-opacity'), zero('layout', 'icon-size')) : 'no icon';
      return verdict(text, icon);
    }
    default:
      return { visible: true };
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
