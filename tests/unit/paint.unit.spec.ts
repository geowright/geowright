import { test, expect } from '@playwright/test';
import { describeLayerHidden, describeStyleCauses, nameColour, tally } from '../../src/inpage/engine';
import { explainLayerHidden, explainPaint, paintColour, paintVisibility, unparseableProperties } from '../../src/inpage/maplibre-paint';
import type { RenderedFeature } from '../../src/inpage/types';

/** Just enough of maplibregl.Map for the paint evaluator: one layer, its paint/layout, a zoom. */
function fakeMap(type: string, paint: Record<string, unknown>, layout: Record<string, unknown> = {}, opts: { zoom?: number; minzoom?: number; maxzoom?: number; globalState?: Record<string, unknown> } = {}) {
  return {
    getLayer: (id: string) => (id === 'l' ? { id, type, minzoom: opts.minzoom, maxzoom: opts.maxzoom } : undefined),
    getZoom: () => opts.zoom ?? 10,
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
    expect(unparseableProperties().filter((p) => p === 'l: circle-opacity')).toHaveLength(1);
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
