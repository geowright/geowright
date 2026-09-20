import { test, expect } from '@playwright/test';
import { nameColour, tally } from '../../src/inpage/engine';
import { paintColour, paintVisibility, unparseableProperties } from '../../src/inpage/maplibre-paint';
import type { RenderedFeature } from '../../src/inpage/types';

/** Just enough of maplibregl.Map for the paint evaluator: one layer, its paint/layout, a zoom. */
function fakeMap(type: string, paint: Record<string, unknown>, layout: Record<string, unknown> = {}) {
  return {
    getLayer: (id: string) => (id === 'l' ? { id, type } : undefined),
    getZoom: () => 10,
    getGlobalState: () => ({}),
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
