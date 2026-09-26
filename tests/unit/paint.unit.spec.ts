import { test, expect } from '@playwright/test';
import { describeLayerHidden, describeStyleCauses, nameColour, tally } from '../../src/inpage/engine';
import { explainLayerHidden, explainPaint, filterAdmits, inQuad, mercator, paintColour, pixelOccluders, paintVisibility, unparseableProperties, unparseableReasons, zoomUncertainProperties } from '../../src/inpage/maplibre-paint';
import type { RenderedFeature } from '../../src/inpage/types';

/** Just enough of maplibregl.Map for the paint evaluator: one layer, its paint/layout, a zoom. */
function fakeMap(
  type: string,
  paint: Record<string, unknown>,
  layout: Record<string, unknown> = {},
  opts: { zoom?: number; minzoom?: number; maxzoom?: number; globalState?: Record<string, unknown>; tileSize?: number; pitch?: number; images?: Record<string, { sdf: boolean }> } = {},
) {
  return {
    getLayer: (id: string) => (id === 'l' ? { id, type, source: 's', minzoom: opts.minzoom, maxzoom: opts.maxzoom } : undefined),
    getSource: (id: string) => (id === 's' ? { type: 'geojson', tileSize: opts.tileSize ?? 512 } : undefined),
    getZoom: () => opts.zoom ?? 10,
    getPitch: () => opts.pitch ?? 0,
    hasImage: (name: string) => !!opts.images?.[name],
    getImage: (name: string) => opts.images?.[name],
    getGlobalState: () => opts.globalState ?? {},
    getPaintProperty: (_id: string, name: string) => paint[name],
    getLayoutProperty: (_id: string, name: string) => layout[name],
  } as any;
}
const feature = (properties: Record<string, unknown>, state?: Record<string, unknown>): RenderedFeature => ({ layer: 'l', properties, state, geometry: { type: 'Point', coordinates: [0, 0] } });

test.describe('paintColour', () => {
  test('evaluates a data-driven colour for one feature', () => {
    const map = fakeMap('circle', { 'circle-color': ['match', ['get', 'status'], 'fault', '#c62828', '#1565c0'] });
    expect(paintColour(map, feature({ status: 'fault' }))).toEqual({ property: 'circle-color', colour: '#c62828', dataDriven: true });
    expect(paintColour(map, feature({ status: 'ok' }))?.colour).toBe('#1565c0');
  });

  test('a constant colour is not data-driven; semi-transparent colours are un-premultiplied', () => {
    expect(paintColour(fakeMap('fill', { 'fill-color': 'rgba(255, 0, 0, 0.5)' }), feature({}))).toEqual({ property: 'fill-color', colour: '#ff0000', dataDriven: false });
  });

  test('feature-state drives colour too; the default colour applies when nothing is set', () => {
    const map = fakeMap('line', { 'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#00ff00', '#0000ff'] });
    expect(paintColour(map, feature({}, { hover: true }))?.colour).toBe('#00ff00');
    expect(paintColour(fakeMap('circle', {}), feature({}))?.colour).toBe('#000000');
  });

  test('no colour for layer types without one, or a fully transparent colour', () => {
    expect(paintColour(fakeMap('heatmap', {}), feature({}))).toBeUndefined();
    expect(paintColour(fakeMap('circle', { 'circle-color': 'rgba(0,0,0,0)' }), feature({}))).toBeUndefined();
  });
});

test.describe('unsupported expressions (evaluator older than the app\'s MapLibre)', () => {
  test('answer VISIBLE, never a false "invisible" — and say so once', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['frobnicate-from-the-future', 1] });
    expect(paintVisibility(map, feature({}))).toEqual({ visible: true });
    paintVisibility(map, feature({ other: 1 }));
    expect(unparseableProperties(map).filter((p) => p === 'l: circle-opacity')).toHaveLength(1);
  });
});

/** Caveats are about ONE map as it is now: not another map's, not a style the app has since changed. */
test.describe('caveats belong to one map, and to its current style and view', () => {
  test("another map's unsupported expression is not listed for this one", () => {
    const a = fakeMap('circle', { 'circle-opacity': ['frobnicate-from-the-future', 2] });
    const b = fakeMap('circle', { 'circle-opacity': 1 });
    paintVisibility(a, feature({}));
    paintVisibility(b, feature({}));
    expect(unparseableProperties(a)).toContain('l: circle-opacity');
    expect(unparseableProperties(b)).toEqual([]);
  });

  test('a caveat goes when the style property that caused it is changed, or its layer is removed', () => {
    const paint: Record<string, unknown> = { 'circle-opacity': ['frobnicate-from-the-future', 3] };
    const map = fakeMap('circle', paint);
    paintVisibility(map, feature({}));
    expect(unparseableProperties(map)).toEqual(['l: circle-opacity']);
    paint['circle-opacity'] = 0.5; // the app set a plain value
    expect(unparseableProperties(map)).toEqual([]);
    paint['circle-opacity'] = ['frobnicate-from-the-future', 3];
    paintVisibility(map, feature({}));
    expect(unparseableProperties(map)).toEqual(['l: circle-opacity']);
    map.getLayer = () => undefined; // the app removed the layer
    expect(unparseableProperties(map)).toEqual([]);
  });

  test('"uncertain" goes when tile zooms no longer vary across the view', () => {
    const opts = { zoom: 11.7, pitch: 75 };
    const map = fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] }, {}, opts);
    paintVisibility(map, feature({ o: 1 }));
    expect(zoomUncertainProperties(map)).toEqual(['l: circle-opacity']);
    expect(zoomUncertainProperties(fakeMap('circle', {}, {}, opts))).toEqual([]); // another map
    opts.pitch = 0; // the camera levelled out
    expect(zoomUncertainProperties(map)).toEqual([]);
  });
});

test.describe('why invisible: property, value, expression branch, zoom', () => {
  const why = (map: any, f: RenderedFeature) => describeStyleCauses(explainPaint(map, f));

  test('nothing to explain for a visible feature', () => {
    expect(explainPaint(fakeMap('fill', { 'fill-opacity': 0.5 }), feature({}))).toEqual([]);
  });

  test('match: the label that matched, or the fallback, with the input value', () => {
    const map = fakeMap('fill', { 'fill-opacity': ['match', ['get', 'kind'], ['forest', 'wood'], 1, 'lake', 0, 0] }, {}, { zoom: 11.2 });
    expect(why(map, feature({ kind: 'park' }))).toBe('at zoom 11.2: fill-opacity is 0 because the match on ["get","kind"] took its fallback for kind="park"');
    expect(why(map, feature({ kind: 'lake' }))).toBe('at zoom 11.2: fill-opacity is 0 because the match on ["get","kind"] matched kind="lake"');
    expect(explainPaint(map, feature({ kind: 'lake' }))[0]).toMatchObject({ layer: 'l', group: 'paint', property: 'fill-opacity', value: 0, zoom: 11.2, origin: 'expression', branches: [{ op: 'match', input: ['get', 'kind'], inputValue: 'lake', taken: 'label', at: 'lake' }] });
  });

  test('case: the first true condition, or the fallback; feature-state is evaluated too', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['case', ['==', ['get', 'status'], 'archived'], 0, ['boolean', ['feature-state', 'muted'], false], 0, 1], 'circle-stroke-width': 0 });
    expect(why(map, feature({ status: 'archived' }))).toBe(
      'at zoom 10: circle-opacity is 0 because the case took its branch 1 (the first true condition: ["==",["get","status"],"archived"]); and circle-stroke-width is 0 (a constant in the style)',
    );
    expect(why(map, feature({ status: 'ok' }, { muted: true }))).toContain('the case took its branch 2 (the first true condition: ["boolean",["feature-state","muted"],false])');
    const fallback = fakeMap('line', { 'line-width': ['case', ['has', 'lanes'], 3, 0] });
    expect(why(fallback, feature({}))).toBe('at zoom 10: line-width is 0 because the case took its fallback (no condition was true)');
  });

  test('step on zoom: the stop used, or the base output below the first stop', () => {
    expect(why(fakeMap('fill', { 'fill-opacity': ['step', ['zoom'], 1, 12, 0] }, {}, { zoom: 12.5 }), feature({}))).toBe(
      'at zoom 12.5: fill-opacity is 0 because the step on zoom used the stop at 12 (zoom 12.5)',
    );
    expect(why(fakeMap('fill', { 'fill-opacity': ['step', ['zoom'], 0, 13, 1] }, {}, { zoom: 11.2 }), feature({}))).toBe(
      'at zoom 11.2: fill-opacity is 0 because the step on zoom used its base output (zoom 11.2 is below its first stop, 13)',
    );
  });

  test('interpolate on zoom: clamped to a stop, or between two stops', () => {
    const map = (zoom: number) => fakeMap('circle', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 0, 14, 8] }, {}, { zoom });
    expect(why(map(9), feature({}))).toContain('circle-radius is 0 because the interpolate on zoom used its stop at 10 (zoom 9;');
    // a transparent colour interpolated between two transparent stops: both stops named, no single branch
    const between = fakeMap('fill', { 'fill-color': ['interpolate', ['linear'], ['zoom'], 10, 'rgba(0,0,0,0)', 14, 'rgba(255,0,0,0)'] }, {}, { zoom: 12 });
    expect(why(between, feature({}))).toMatch(/fill-color is "rgba\(\d+,0,0,0\)" because the interpolate on zoom interpolated between its stops at 10 and 14 \(zoom 12\)/);
  });

  test('nested: a step on zoom whose chosen output is a match', () => {
    // (zoom may only be the input of a TOP-LEVEL step / interpolate: a match around it is not a valid style)
    const map = fakeMap('fill', { 'fill-opacity': ['step', ['zoom'], ['match', ['get', 'kind'], 'park', 0, 1], 14, 1] }, {}, { zoom: 12 });
    expect(why(map, feature({ kind: 'park' }))).toBe(
      'at zoom 12: fill-opacity is 0 because the step on zoom used its base output (zoom 12 is below its first stop, 14), then the match on ["get","kind"] matched kind="park"',
    );
  });

  test('coalesce, legacy functions, defaults — and property + value only when no branch can be traced', () => {
    expect(why(fakeMap('fill', { 'fill-opacity': ['coalesce', ['get', 'opacity'], ['get', 'fallbackOpacity'], 1] }), feature({ fallbackOpacity: 0 }))).toContain(
      'fill-opacity is 0 because the coalesce used its argument 2 (the ones before it were null)',
    );
    expect(why(fakeMap('fill', { 'fill-opacity': { stops: [[12, 0], [14, 1]] } }, {}, { zoom: 11 }), feature({}))).toContain(
      'fill-opacity is 0 because its legacy function, read as an expression: the interpolate on zoom used its stop at 12',
    );
    expect(why(fakeMap('fill', { 'fill-opacity': ['*', ['get', 'o'], 0] }), feature({ o: 1 }))).toBe(
      'at zoom 10: fill-opacity is 0 (an expression; which of its branches produced this cannot be traced)',
    );
    expect(why(fakeMap('fill', { 'fill-opacity': ['let', 'o', 0, ['var', 'o']] }), feature({}))).toContain('cannot be traced');
    // circle-stroke-width is not set: the default (0) is part of why a circle is invisible
    expect(why(fakeMap('circle', { 'circle-radius': 0 }), feature({}))).toBe(
      'at zoom 10: circle-radius is 0 (a constant in the style); and circle-stroke-width is 0 (not set in the style: the default)',
    );
  });

  test('symbols: text and icon causes', () => {
    expect(why(fakeMap('symbol', { 'text-opacity': ['step', ['zoom'], 0, 14, 1] }, { 'text-field': 'x' }), feature({}))).toBe(
      'at zoom 10: text-opacity is 0 because the step on zoom used its base output (zoom 10 is below its first stop, 14); and icon-image is null (not set in the style: the default)',
    );
  });

  test('fill-layer-opacity / line-layer-opacity 0 (MapLibre 6) hides the whole layer, outline included', () => {
    // MapLibre 6 draw_fill / draw_line return early on a layer opacity of 0, before fill-color, the outline or a pattern.
    const fill = fakeMap('fill', { 'fill-layer-opacity': 0, 'fill-color': '#f00', 'fill-outline-color': '#000' });
    expect(paintVisibility(fill, feature({}))).toEqual({ visible: false, reason: 'fill-layer-opacity evaluates to 0' });
    expect(why(fill, feature({}))).toBe('at zoom 10: fill-layer-opacity is 0 (a constant in the style)');
    expect(paintVisibility(fakeMap('fill', { 'fill-layer-opacity': 0, 'fill-pattern': 'dots' }), feature({})).visible).toBe(false);
    const line = fakeMap('line', { 'line-layer-opacity': ['step', ['zoom'], 1, 9, 0], 'line-width': 3 });
    expect(paintVisibility(line, feature({}))).toEqual({ visible: false, reason: 'line-layer-opacity evaluates to 0' });
    expect(why(line, feature({}))).toBe('at zoom 10: line-layer-opacity is 0 because the step on zoom used the stop at 9 (zoom 10)');
    // partial layer opacity still draws; unset (older MapLibre, or not used) reads the default 1
    expect(paintVisibility(fakeMap('fill', { 'fill-layer-opacity': 0.3 }), feature({})).visible).toBe(true);
    expect(paintVisibility(fakeMap('line', { 'line-layer-opacity': 0.3 }), feature({})).visible).toBe(true);
    expect(paintVisibility(fakeMap('line', {}), feature({})).visible).toBe(true);
    // MapLibre 2–5 / Mapbox GL 1 do not know these properties: getPaintProperty THROWS. Not a reason, not an error.
    const older = (type: string, paint: Record<string, unknown>) => {
      const m = fakeMap(type, paint);
      const get = m.getPaintProperty;
      m.getPaintProperty = (id: string, name: string) => {
        if (name.endsWith('-layer-opacity')) throw new TypeError("Cannot read properties of undefined (reading 'value')");
        return get(id, name);
      };
      return m;
    };
    expect(paintVisibility(older('fill', {}), feature({}))).toEqual({ visible: true });
    expect(paintVisibility(older('line', {}), feature({}))).toEqual({ visible: true });
    expect(paintVisibility(older('fill', { 'fill-opacity': 0 }), feature({}))).toEqual({ visible: false, reason: 'fill-opacity evaluates to 0' });
  });

  test('match compares types as MapLibre does: the string "1" is not the label 1', () => {
    const map = fakeMap('fill', { 'fill-opacity': ['match', ['get', 'n'], 1, 1, 0] });
    expect(paintVisibility(map, feature({ n: '1' })).visible).toBe(false);
    expect(why(map, feature({ n: '1' }))).toBe('at zoom 10: fill-opacity is 0 because the match on ["get","n"] took its fallback for n="1"');
  });

  test('a layer outside its zoom range, or with visibility "none" (constant or a global-state expression)', () => {
    expect(explainLayerHidden(fakeMap('fill', {}, {}, { zoom: 12, minzoom: 13 }), 'l').map(describeLayerHidden)).toEqual(['layer "l" is not drawn at zoom 12: its minzoom is 13 (drawn from zoom 13)']);
    expect(explainLayerHidden(fakeMap('fill', {}, {}, { zoom: 12, maxzoom: 12 }), 'l').map(describeLayerHidden)).toEqual(['layer "l" is not drawn at zoom 12: its maxzoom is 12 (drawn below zoom 12 only)']);
    expect(explainLayerHidden(fakeMap('fill', {}, {}, { zoom: 12, minzoom: 10, maxzoom: 14 }), 'l')).toEqual([]);
    expect(explainLayerHidden(fakeMap('fill', {}, { visibility: 'none' }), 'l').map(describeLayerHidden)).toEqual(['layer "l" is not drawn at zoom 10: layout property visibility is "none" (a constant in the style)']);
    const expr = (show: boolean) => fakeMap('fill', {}, { visibility: ['case', ['global-state', 'showParks'], 'visible', 'none'] }, { globalState: { showParks: show } });
    expect(explainLayerHidden(expr(false), 'l').map(describeLayerHidden)).toEqual(['layer "l" is not drawn at zoom 10: layout property visibility is "none" because the case took its fallback (no condition was true)']);
    expect(explainLayerHidden(expr(true), 'l')).toEqual([]);
  });
});

test.describe('nameColour / tally', () => {
  test('everyday words for typical map colours', () => {
    const name = (hex: string) => nameColour(hex).replace(/\(.*/, '');
    expect(name('#d32f2f')).toBe('red');
    expect(name('#1565c0')).toBe('blue');
    expect(name('#f9a825')).toBe('orange');
    expect(name('#9ccc65')).toBe('green');
    expect(name('#6d4c41')).toBe('brown');
    expect(name('#000000')).toBe('black');
    expect(name('#ffffff')).toBe('white');
    expect(name('#6d6d6d')).toBe('grey');
    expect(name('#ffeb3b')).toBe('yellow');
    expect(name('#8e24aa')).toBe('purple');
    expect(nameColour('#d32f2f')).toBe('red(#d32f2f)');
  });

  test('tally counts, most frequent first', () => {
    expect(tally(['a', 'b', 'a', 'a', 'b', 'c'])).toBe('a×3, b×2, c×1');
  });
});

/**
 * what MapLibre DRAWS. A zoom-and-data paint expression is evaluated per tile at the tile zoom z and z+1 and
 * blended by the camera zoom (CompositeExpressionBinder); z = floor(zoom + log2(512 / tileSize)).
 */
test.describe('zoom-and-data paint is judged as the renderer draws it', () => {
  test('a step is read at the tile zoom: at camera zoom 11.7 a stop at 11.5 is not reached yet', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] }, {}, { zoom: 11.7 });
    expect(paintVisibility(map, feature({ o: 1 })).visible).toBe(false);
    expect(paintVisibility(fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] }, {}, { zoom: 12.1 }), feature({ o: 1 })).visible).toBe(true);
  });

  test('an interpolate is blended between the tile zoom and the next one: never a false "invisible"', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 11.6, ['get', 'o']] }, {}, { zoom: 11.2 });
    expect(paintVisibility(map, feature({ o: 1 }))).toEqual({ visible: true });
    const colour = fakeMap('fill', { 'fill-color': ['interpolate', ['linear'], ['zoom'], 11.5, 'rgba(0,0,0,0)', 11.6, ['get', 'c']] }, {}, { zoom: 11.2 });
    expect(paintVisibility(colour, feature({ c: '#ff0000' })).visible).toBe(true);
    expect(paintColour(colour, feature({ c: '#ff0000' }))?.colour).toBe('#ff0000');
  });

  test('why invisible traces a zoom-and-data expression at the tile zoom it is drawn from, not the camera zoom', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] }, {}, { zoom: 11.7 });
    expect(describeStyleCauses(explainPaint(map, feature({ o: 1 })))).toBe(
      'at zoom 11.7: circle-opacity is 0, drawn from tiles of zoom 11, because the step on zoom used its base output (zoom 11 is below its first stop, 11.5); and circle-stroke-width is 0 (not set in the style: the default)',
    );
    // blended strictly between two tile zooms: no single branch — property and value only, never a wrong branch
    const blended = fakeMap('circle', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['*', ['get', 'r'], 0], 12, ['*', ['get', 'r'], -1]] }, {}, { zoom: 11.5 });
    expect(explainPaint(blended, feature({ r: 1 }))[0]).toMatchObject({ property: 'circle-radius', tileZoom: 11, branches: [] });
    expect(describeStyleCauses(explainPaint(blended, feature({ r: 1 })))).toContain('circle-radius is -0.5, drawn from tiles of zoom 11 (an expression; which of its branches produced this cannot be traced)');
  });

  test('a 256-pixel tile source is one tile zoom deeper', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] }, {}, { zoom: 11.2, tileSize: 256 });
    expect(paintVisibility(map, feature({ o: 1 })).visible).toBe(true); // tile zoom 12
  });

  test('where tile zooms vary across the view (high pitch) it is uncertain: visible, and said once', () => {
    const map = fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 11.5, ['get', 'o']] }, {}, { zoom: 11.7, pitch: 75 });
    expect(paintVisibility(map, feature({ o: 1 }))).toEqual({ visible: true });
    expect(zoomUncertainProperties(map)).toContain('l: circle-opacity');
    // hidden at EVERY tile zoom: still a confident "invisible"
    expect(paintVisibility(fakeMap('circle', { 'circle-opacity': ['step', ['zoom'], 0, 30, ['get', 'o']] }, {}, { zoom: 11.7, pitch: 75 }), feature({ o: 1 })).visible).toBe(false);
  });

  test('`within` and `distance` need the tile geometry: not evaluable, so visible — and said once', () => {
    const area = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    const within = fakeMap('circle', { 'circle-opacity': ['case', ['within', area], 1, 0] });
    const distance = fakeMap('line', { 'line-opacity': ['case', ['<', ['distance', { type: 'Point', coordinates: [0, 0] }], 100], 1, 0] });
    expect(paintVisibility(within, feature({}))).toEqual({ visible: true });
    expect(paintVisibility(distance, feature({}))).toEqual({ visible: true });
    expect(paintVisibility(fakeMap('circle', { 'circle-opacity': ['case', ['within', area], 0, 1] }), feature({}))).toEqual({ visible: true });
    expect(unparseableProperties(within).filter((p) => p === 'l: circle-opacity')).toHaveLength(1);
    expect(unparseableReasons(distance)).toContainEqual(['l: line-opacity', 'distance']);
  });
});

test.describe('outline and SDF icons', () => {
  test('B12: fill-antialias false draws no outline — a transparent fill with an opaque outline is then invisible', () => {
    const base = { 'fill-color': 'rgba(0,0,0,0)', 'fill-outline-color': '#000' };
    expect(paintVisibility(fakeMap('fill', base), feature({})).visible).toBe(true);
    expect(paintVisibility(fakeMap('fill', { ...base, 'fill-antialias': false }), feature({}))).toEqual({ visible: false, reason: 'fill-color is fully transparent and no outline (fill-antialias is false)' });
  });

  test('B13: an SDF icon is drawn in icon-color: alpha 0 and no halo is invisible; a plain image ignores icon-color', () => {
    const images = { pin: { sdf: true }, photo: { sdf: false } };
    const sdf = fakeMap('symbol', { 'icon-color': 'rgba(0,0,0,0)' }, { 'icon-image': 'pin' }, { images });
    expect(paintVisibility(sdf, feature({})).visible).toBe(false);
    expect(paintVisibility(sdf, feature({})).reason).toContain('icon-color and halo are fully transparent (an SDF icon)');
    expect(paintVisibility(fakeMap('symbol', { 'icon-color': 'rgba(0,0,0,0)', 'icon-halo-width': 2, 'icon-halo-color': '#fff' }, { 'icon-image': 'pin' }, { images }), feature({})).visible).toBe(true);
    expect(paintVisibility(fakeMap('symbol', { 'icon-color': 'rgba(0,0,0,0)' }, { 'icon-image': 'photo' }, { images }), feature({})).visible).toBe(true);
  });
});

/** autoPan and full geometry read the SOURCE: a feature the layer's filter leaves out is never drawn by that layer. */
test.describe("filterAdmits: does the layer's filter let a data feature through", () => {
  const withFilter = (filter: unknown, zoom = 10) => ({ ...fakeMap('circle', {}, {}, { zoom }), getFilter: () => filter });
  test('expression and legacy filters; no filter lets everything through', () => {
    expect(filterAdmits(withFilter(['!=', ['get', 'kind'], 'ghost']), feature({ kind: 'ghost' }))).toBe(false);
    expect(filterAdmits(withFilter(['!=', ['get', 'kind'], 'ghost']), feature({ kind: 'probe' }))).toBe(true);
    expect(filterAdmits(withFilter(['==', 'kind', 'ghost']), feature({ kind: 'probe' }))).toBe(false); // legacy syntax
    expect(filterAdmits(withFilter(undefined), feature({}))).toBe(true);
  });

  test('zoom is the tile zoom; what cannot be evaluated is "cannot tell", never "no"', () => {
    expect(filterAdmits(withFilter(['>=', ['zoom'], 10.5], 10.7), feature({}))).toBe(false); // tile zoom 10
    expect(filterAdmits(withFilter(['>=', ['zoom'], 10.5], 11.2), feature({}))).toBe(true);
    const area = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    expect(filterAdmits(withFilter(['within', area]), feature({}))).toBeUndefined();
    expect(filterAdmits(withFilter(['frobnicate-from-the-future', 1]), feature({}))).toBeUndefined();
  });
});

test.describe('the pixel-only-layer gate (decision 0022)', () => {
  test('point in quad, in Mercator: a rectangle, a trapezoid, a concave quad', () => {
    const rect = [[34, 33], [35, 33], [35, 32], [34, 32]].map(mercator);
    expect(inQuad(mercator([34.5, 32.5]), rect)).toBe(true);
    expect(inQuad(mercator([35.5, 32.5]), rect)).toBe(false);
    expect(inQuad(mercator([34.5, 33.01]), rect)).toBe(false);
    // a trapezoid, wide at the top: a point inside the rectangle of its corners but outside the slanted side
    const trapezoid = [[0, 10], [10, 10], [7, 0], [3, 0]].map(mercator);
    expect(inQuad(mercator([5, 5]), trapezoid)).toBe(true);
    expect(inQuad(mercator([1, 1]), trapezoid)).toBe(false);
    expect(inQuad(mercator([1, 9]), trapezoid)).toBe(true);
    // a concave (dart) quad: the notch is outside
    const dart = [[0, 10], [5, 3], [10, 10], [5, 0]].map(mercator);
    expect(inQuad(mercator([5, 6]), dart)).toBe(false);
    expect(inQuad(mercator([5, 2]), dart)).toBe(true);
    // Mercator, not degrees: the quad's straight edges are straight in Mercator (as MapLibre warps the image)
    expect(mercator([0, 0])).toEqual([0.5, 0.5]);
    expect(mercator([180, 0])[0]).toBe(1);
  });

  /** A style of layers bottom to top, each { type, paint?, layout?, minzoom?, maxzoom?, source? }; sources by id. */
  const styleMap = (layers: Record<string, any>, sources: Record<string, any> = {}, o: { zoom?: number; terrain?: boolean; at?: [number, number] } = {}) => ({
    getLayer: (id: string) => (layers[id] ? { id, ...layers[id] } : undefined),
    getLayoutProperty: (id: string, name: string) => layers[id]?.layout?.[name],
    getPaintProperty: (id: string, name: string) => layers[id]?.paint?.[name],
    getSource: (id: string) => sources[id],
    getStyle: () => ({ sources }),
    getZoom: () => o.zoom ?? 10,
    getGlobalState: () => ({}),
    getTerrain: () => (o.terrain ? { source: 'dem' } : null),
    unproject: () => ({ lng: o.at?.[0] ?? 34.5, lat: o.at?.[1] ?? 32.5 }),
  });
  const gate = (m: ReturnType<typeof styleMap>, layers: string[]) => pixelOccluders(m as any, 'target', { x: 1, y: 1 }, layers, () => 0).map((o) => o.layer);

  test('which layers above the target may cover a pixel', () => {
    const layers: Record<string, any> = {
      under: { type: 'raster', source: 'tiles' },
      target: { type: 'circle', source: 'points' },
      fill: { type: 'fill', source: 'points' },
      radar: { type: 'raster', source: 'tiles', paint: { 'raster-opacity': 0.4 } },
      off: { type: 'raster', source: 'tiles', paint: { 'raster-opacity': 0 } },
      zoomedOff: { type: 'raster', source: 'tiles', paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 8, 1, 9, 0] } },
      hidden: { type: 'raster', source: 'tiles', layout: { visibility: 'none' } },
      outOfRange: { type: 'hillshade', source: 'dem', minzoom: 12 },
      heat: { type: 'heatmap', source: 'points' },
      bg: { type: 'background', paint: { 'background-opacity': 0.2 } },
      custom: { type: 'custom' },
      unknownExpr: { type: 'raster', source: 'tiles', paint: { 'raster-opacity': ['frobnicate-from-the-future', 0] } },
    };
    const m = styleMap(layers, { tiles: { type: 'raster' }, points: { type: 'geojson' }, dem: { type: 'raster-dem' } });
    // below the target, not pixel-only, opacity exactly 0 (a constant, or at this zoom), hidden, outside the zoom range: out.
    // What the evaluator cannot read counts as covering.
    expect(gate(m, Object.keys(layers))).toEqual(['radar', 'heat', 'bg', 'custom', 'unknownExpr']);
    expect(gate(m, ['target', 'fill']), 'nothing pixel-only above').toEqual([]);
  });

  test("an image / video / canvas source covers only its quad; a tiled source everything, whatever its bounds; under terrain, everything", () => {
    const layers = { target: { type: 'fill', source: 'points' }, img: { type: 'raster', source: 'img' }, tiles: { type: 'raster', source: 'tiles' } };
    const sources = {
      points: { type: 'geojson' },
      img: { type: 'image', coordinates: [[34, 33], [35, 33], [35, 32], [34, 32]] },
      tiles: { type: 'raster', bounds: [34, 32, 35, 33] },
    };
    expect(gate(styleMap(layers, sources, { at: [34.5, 32.5] }), Object.keys(layers))).toEqual(['img', 'tiles']);
    // outside the bounds: MapLibre draws every tile that meets them whole (edge tiles reach past them), and a parent
    // tile of a lower zoom while one loads, so the bounds say nothing about a pixel
    expect(gate(styleMap(layers, sources, { at: [36, 32.5] }), Object.keys(layers))).toEqual(['tiles']);
    // another world copy of the same place
    expect(gate(styleMap(layers, sources, { at: [34.5 + 360, 32.5] }), Object.keys(layers))).toEqual(['img', 'tiles']);
    expect(gate(styleMap(layers, sources, { at: [36, 32.5], terrain: true }), Object.keys(layers)), 'terrain: no area test').toEqual(['img', 'tiles']);
  });

  test('a hillshade at exaggeration 0 draws nothing only with a method that paints nothing on flat ground', () => {
    const layers = (method?: string) => ({ target: { type: 'fill', source: 'points' }, shade: { type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0, ...(method && { 'hillshade-method': method }) } } });
    const at = (method?: string) => gate(styleMap(layers(method)), ['target', 'shade']);
    expect(at(), 'standard (the default)').toEqual([]);
    for (const m of ['standard', 'combined', 'igor']) expect(at(m), m).toEqual([]);
    // basic and multidirectional light a flat surface: a tint, opaque at a high illumination altitude
    for (const m of ['basic', 'multidirectional']) expect(at(m), m).toEqual(['shade']);
  });

  test("the stamp changes with an overlay's opacity and its source's data events, but not with the target's own source", () => {
    const layers: Record<string, any> = { target: { type: 'circle', source: 'points' }, radar: { type: 'raster', source: 'tiles', paint: { 'raster-opacity': 0.5 } }, heat: { type: 'heatmap', source: 'points' } };
    const events: Record<string, number> = { tiles: 0, points: 0 };
    const m = styleMap(layers, { tiles: { type: 'raster' }, points: { type: 'geojson' } });
    const stamps = () => Object.fromEntries(pixelOccluders(m as any, 'target', { x: 1, y: 1 }, Object.keys(layers), (s) => events[s]).map((o) => [o.layer, o.stamp]));
    const before = stamps();
    layers.radar.paint['raster-opacity'] = 1;
    const opaque = stamps();
    expect(opaque.radar, 'opacity 0.5 -> 1').not.toBe(before.radar);
    events.tiles++;
    expect(stamps().radar, "a data event of the overlay's source").not.toBe(opaque.radar);
    // a probe that hides the target by visibility reloads ITS source: the heatmap on that source keeps its stamp
    const heat = stamps().heat;
    events.points += 5;
    expect(stamps().heat, "the target's own source").toBe(heat);
  });
});
