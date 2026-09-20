import { test, expect } from '@playwright/test';
import { Engine } from '../../src/inpage/engine';
import type { CanvasAdapter, RenderedFeature, Pt, Visibility } from '../../src/inpage/types';

/**
 * Engine.find() against a FAKE adapter (no DOM, no MapLibre). Covers the grouping/matching logic
 * that snapshot/entities/actionPoint/armClick build on; those still need a real DOM and stay with
 * the e2e suite.
 */

type World = { lng: number; lat: number };

const RECT = { left: 10, top: 20 };

function makeAdapter(features: RenderedFeature[]): CanvasAdapter<World> {
  return {
    kind: 'fake',
    surface: () => ({ clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => RECT }) as any,
    getViewState: () => ({}),
    project: (world) => ({ x: world.lng, y: world.lat }),
    unproject: (pt: Pt) => ({ lng: pt.x, lat: pt.y }),
    worldFromCoord: (coord) => ({ lng: coord[0], lat: coord[1] }),
    queryFeatures: (q) => features.filter((f) => !q.layers || q.layers.includes(f.layer)),
    listLayers: () => [],
    isMoving: () => false,
    waitForIdle: async () => true,
    visibility: (f): Visibility => (f.properties.status === 'archived' ? { visible: false, reason: 'archived' } : { visible: true }),
  };
}

function point(layer: string, id: string | number, properties: Record<string, unknown>, coord: number[]): RenderedFeature {
  return { layer, id, properties, geometry: { type: 'Point', coordinates: coord } };
}

test.describe('Engine.find with a fake adapter', () => {
  test('the same feature returned as several pieces is ONE result', () => {
    const pieceA = point('parcels', 1, { type: 'a' }, [1, 1]);
    const pieceB = point('parcels', 1, { type: 'a' }, [2, 2]); // same layer/id/properties, different geometry
    const engine = new Engine(makeAdapter([pieceA, pieceB]));
    const found = engine.find({ layer: 'parcels', where: { type: 'a' } });
    expect(found).toHaveLength(1);
  });

  test('two features with the same coerced id but different properties are TWO results', () => {
    const a = point('parcels', 1, { type: 'a' }, [1, 1]);
    const b = point('parcels', 1, { type: 'b' }, [2, 2]);
    const engine = new Engine(makeAdapter([a, b]));
    const found = engine.find({ layer: 'parcels', id: 1 });
    expect(found).toHaveLength(2);
  });

  test('where filters on properties', () => {
    const a = point('parcels', 1, { type: 'a' }, [1, 1]);
    const b = point('parcels', 2, { type: 'b' }, [2, 2]);
    const engine = new Engine(makeAdapter([a, b]));
    expect(engine.find({ layer: 'parcels', where: { type: 'a' } })).toHaveLength(1);
    expect(engine.find({ layer: 'parcels', where: { type: { in: ['a', 'b'] } } })).toHaveLength(2);
    expect(engine.find({ layer: 'parcels', where: { type: 'z' } })).toHaveLength(0);
  });

  test('id compares string vs number via String()', () => {
    const strId = point('mixed', '7', {}, [1, 1]);
    const engine = new Engine(makeAdapter([strId]));
    expect(engine.find({ layer: 'mixed', id: 7 })).toHaveLength(1); // number query, string feature id
    expect(engine.find({ layer: 'mixed', id: '7' })).toHaveLength(1);
    expect(engine.find({ layer: 'mixed', id: 8 })).toHaveLength(0);
  });

  test('layer array filters across multiple layers', () => {
    const parcelA = point('parcels', 1, { type: 'a' }, [1, 1]);
    const parcelB = point('parcels', 2, { type: 'b' }, [2, 2]);
    const road = point('roads', 3, { name: 'Main St' }, [3, 3]);
    const sensor = point('sensors', 4, {}, [4, 4]);
    const engine = new Engine(makeAdapter([parcelA, parcelB, road, sensor]));
    const found = engine.find({ layer: ['parcels', 'roads'] });
    expect(found).toHaveLength(3);
    expect(found.some((f) => f.layer === 'sensors')).toBe(false);
  });

  test('visible by default; false = only invisible; \'any\' = rendered, seen or not', () => {
    const archived = point('sensors', 100, { status: 'archived' }, [1, 1]);
    const active = point('sensors', 101, { status: 'active' }, [2, 2]);
    const engine = new Engine(makeAdapter([archived, active]));
    expect(engine.find({ layer: 'sensors', visible: true })).toHaveLength(1);
    expect(engine.find({ layer: 'sensors', visible: true })[0].id).toBe(101);
    expect(engine.find({ layer: 'sensors', visible: false })).toHaveLength(1);
    expect(engine.find({ layer: 'sensors', visible: false })[0].id).toBe(100);
    expect(engine.find({ layer: 'sensors' })).toHaveLength(1); // default: what a user can see
    expect(engine.find({ layer: 'sensors', visible: 'any' })).toHaveLength(2); // MapLibre's "rendered"
  });

  test("summary's client = pixel + the surface rect's left/top", () => {
    const f = point('sensors', 101, { status: 'active' }, [50, 50]);
    const engine = new Engine(makeAdapter([f]));
    const [summary] = engine.find({ layer: 'sensors', id: 101 });
    expect(summary.pixel).toEqual({ x: 50, y: 50 });
    expect(summary.client).toEqual({ x: RECT.left + 50, y: RECT.top + 50 });
  });
});

test.describe('id-less features with identical properties (found on MapLibre\'s symbol examples)', () => {
  const idless = (layer: string, properties: Record<string, unknown>, geometry: RenderedFeature['geometry']): RenderedFeature => ({ layer, properties, geometry });
  const square = (x: number, y: number, w: number): RenderedFeature['geometry'] => ({ type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]] });

  test('three look-alike points are THREE features (they were one)', () => {
    const pois = [[100, 100], [300, 120], [500, 400]].map((c) => idless('poi-music', { icon: 'music' }, { type: 'Point', coordinates: c }));
    const engine = new Engine(makeAdapter(pois));
    expect(engine.find({ layer: 'poi-music' })).toHaveLength(3);
    expect(engine.find({ layer: 'poi-music', where: { icon: 'music' } }).map((f) => f.pixel)).toEqual([{ x: 100, y: 100 }, { x: 300, y: 120 }, { x: 500, y: 400 }]);
  });

  test('the same point returned twice (two tiles\' buffers) is still ONE', () => {
    const p = () => idless('poi', {}, { type: 'Point', coordinates: [256, 300] });
    expect(new Engine(makeAdapter([p(), p()])).find({ layer: 'poi' })).toHaveLength(1);
  });

  test('tile pieces of ONE polygon touch, so they stay one; a look-alike elsewhere is another', () => {
    const left = idless('lots', { use: 'vacant' }, square(100, 100, 56)); // clipped at a tile border x=156 (+ buffer)
    const right = idless('lots', { use: 'vacant' }, square(150, 100, 60));
    const elsewhere = idless('lots', { use: 'vacant' }, square(400, 300, 50));
    expect(new Engine(makeAdapter([left, right, elsewhere])).find({ layer: 'lots' })).toHaveLength(2);
  });

  test('features WITH an id are grouped by it alone, however far apart their pieces are (world copies, multi-part shapes)', () => {
    const a = point('islands', 7, { name: 'x' }, [50, 50]);
    const b = point('islands', 7, { name: 'x' }, [700, 500]);
    expect(new Engine(makeAdapter([a, b])).find({ layer: 'islands' })).toHaveLength(1);
  });
});

test('an id-less feature drawn in two WORLD COPIES is one feature (the adapter reports the repeat period)', () => {
  const copy = (x: number): RenderedFeature => ({ layer: 'quakes', properties: { mag: 5 }, geometry: { type: 'Point', coordinates: [x, 300] } });
  const adapter = { ...makeAdapter([copy(100), copy(612), copy(1124)]), wrapPx: () => 512 };
  expect(new Engine(adapter).find({ layer: 'quakes' })).toHaveLength(1);
  expect(new Engine(makeAdapter([copy(100), copy(612)])).find({ layer: 'quakes' })).toHaveLength(2); // no period known: two things
});
