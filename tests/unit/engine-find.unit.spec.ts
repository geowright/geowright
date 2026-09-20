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

  test('visible: true/false filters via the fake visibility()', () => {
    const archived = point('sensors', 100, { status: 'archived' }, [1, 1]);
    const active = point('sensors', 101, { status: 'active' }, [2, 2]);
    const engine = new Engine(makeAdapter([archived, active]));
    expect(engine.find({ layer: 'sensors', visible: true })).toHaveLength(1);
    expect(engine.find({ layer: 'sensors', visible: true })[0].id).toBe(101);
    expect(engine.find({ layer: 'sensors', visible: false })).toHaveLength(1);
    expect(engine.find({ layer: 'sensors', visible: false })[0].id).toBe(100);
    expect(engine.find({ layer: 'sensors' })).toHaveLength(2); // no visible filter: both "rendered"
  });

  test("summary's client = pixel + the surface rect's left/top", () => {
    const f = point('sensors', 101, { status: 'active' }, [50, 50]);
    const engine = new Engine(makeAdapter([f]));
    const [summary] = engine.find({ layer: 'sensors', id: 101 });
    expect(summary.pixel).toEqual({ x: 50, y: 50 });
    expect(summary.client).toEqual({ x: RECT.left + 50, y: RECT.top + 50 });
  });
});
