import { latest, normalizePropertyExpression, type StylePropertyExpression } from '@maplibre/maplibre-gl-style-spec';
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

const GEOM_TYPE: Record<string, 1 | 2 | 3> = { Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3 };

export function paintVisibility(map: MlMap, f: RenderedFeature): Visibility {
  const layer = map.getLayer(f.layer);
  if (!layer) return { visible: true };
  const type = layer.type;
  const globals = { zoom: map.getZoom() };
  const feature = { type: GEOM_TYPE[f.geometry.type] ?? 1, id: f.id, properties: f.properties };
  let globalState: Record<string, unknown> = {};
  try {
    globalState = map.getGlobalState?.() ?? {};
  } catch {
    /* older MapLibre: no global state */
  }

  /** Evaluated value of a paint/layout property for this feature; undefined = could not evaluate. */
  const value = (group: 'paint' | 'layout', name: string): any => {
    const propSpec = spec[`${group}_${type}`]?.[name];
    if (!propSpec) return undefined;
    const raw = group === 'paint' ? map.getPaintProperty(f.layer, name as any) : map.getLayoutProperty(f.layer, name as any);
    const input = raw === undefined || raw === null ? propSpec.default : raw;
    if (input === undefined) return null; // no value and no default, e.g. text-field, *-pattern
    const key = `${type}|${name}|${JSON.stringify(input)}|${JSON.stringify(globalState)}`;
    let expr = parsed.get(key);
    if (expr === undefined) {
      try {
        expr = normalizePropertyExpression(input, name, propSpec as any, globalState);
      } catch {
        expr = null;
      }
      parsed.set(key, expr);
    }
    if (!expr) return undefined;
    try {
      return expr.evaluate(globals as any, feature as any, (f.state ?? {}) as any);
    } catch {
      return undefined;
    }
  };

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
