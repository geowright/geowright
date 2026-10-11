import { test, expect } from '@playwright/test';
import {
  testWhere,
  explode,
  pointCandidates,
  lineCandidates,
  polygonCandidates,
  inPolygon,
  distToRing,
  sequenceDistance,
  histogram,
  fmtProps,
  compass,
  describe as describeFeature,
  wholePixels,
  verdictKey,
} from '../../src/inpage/engine';
import { buttonLabel } from '../../src/inpage/mirror';
import type { Geometry, PixelPoint } from '../../src/inpage/types';

/**
 * Pure-function unit tests for src/inpage/engine.ts. No DOM, no browser: these run in plain Node
 * under the Playwright test runner. `snapshot`/`entities`/`actionPoint`/`armClick` need a real DOM
 * (document.elementsFromPoint, window events) and stay covered by the e2e suite only.
 */

test.describe('testWhere', () => {
  test('plain equality, including null/undefined', () => {
    expect(testWhere('a', 'a')).toBe(true);
    expect(testWhere('a', 'b')).toBe(false);
    expect(testWhere(undefined, null)).toBe(true); // both coerce to null
    expect(testWhere(null, null)).toBe(true);
    expect(testWhere(undefined, 'a')).toBe(false);
    expect(testWhere(0, 0)).toBe(true);
    expect(testWhere(false, false)).toBe(true);
  });

  test('eq / ne', () => {
    expect(testWhere('a', { eq: 'a' })).toBe(true);
    expect(testWhere('a', { eq: 'b' })).toBe(false);
    expect(testWhere(undefined, { eq: null })).toBe(true);
    expect(testWhere('a', { ne: 'b' })).toBe(true);
    expect(testWhere('a', { ne: 'a' })).toBe(false);
  });

  test('gt / gte / lt / lte', () => {
    expect(testWhere(5, { gt: 4 })).toBe(true);
    expect(testWhere(5, { gt: 5 })).toBe(false);
    expect(testWhere(5, { gte: 5 })).toBe(true);
    expect(testWhere(5, { lt: 6 })).toBe(true);
    expect(testWhere(5, { lt: 5 })).toBe(false);
    expect(testWhere(5, { lte: 5 })).toBe(true);
  });

  test('numeric operators on non-numbers are false', () => {
    expect(testWhere('5', { gt: 4 })).toBe(false);
    expect(testWhere(null, { gt: 4 })).toBe(false);
    expect(testWhere(undefined, { lte: 100 })).toBe(false);
    expect(testWhere(true, { gte: 0 })).toBe(false);
  });

  test('in', () => {
    expect(testWhere('b', { in: ['a', 'b', 'c'] })).toBe(true);
    expect(testWhere('z', { in: ['a', 'b', 'c'] })).toBe(false);
    expect(testWhere(undefined, { in: [null, 'a'] })).toBe(true);
  });

  test('matches, with and without flags', () => {
    expect(testWhere('Hello', { matches: '^hello$', flags: 'i' })).toBe(true);
    expect(testWhere('Hello', { matches: '^hello$' })).toBe(false);
    expect(testWhere(42, { matches: '^4' })).toBe(true); // tested against String(actual)
    expect(testWhere(undefined, { matches: '.*' })).toBe(false); // must be present
  });

  test('exists true/false', () => {
    expect(testWhere('x', { exists: true })).toBe(true);
    expect(testWhere(undefined, { exists: true })).toBe(false);
    expect(testWhere(null, { exists: false })).toBe(true);
    expect(testWhere(0, { exists: true })).toBe(true); // 0 is present, not nullish
  });

  test('combined operators are ANDed', () => {
    expect(testWhere(5, { gte: 1, lte: 10 })).toBe(true);
    expect(testWhere(5, { gte: 1, lte: 4 })).toBe(false);
    expect(testWhere('active', { exists: true, ne: 'archived' })).toBe(true);
    expect(testWhere('archived', { exists: true, ne: 'archived' })).toBe(false);
  });

  test('a value that is neither a scalar nor an operator object is an error, not "matches everything"', () => {
    // meant as "in", as a nested match, as a misspelt operator: each used to match EVERY feature
    expect(() => testWhere('park', ['park', 'garden'])).toThrow('unknown where operator: an array (to match one of several values use { in: ["park", "garden"] })');
    expect(() => testWhere('park', { equals: 'park' })).toThrow(/unknown where operator "equals"; valid: eq, ne, gt, gte, lt, lte, in, matches, flags, exists/);
    expect(() => testWhere({ city: 'X' }, { city: 'X' })).toThrow(/unknown where operator "city"/);
    expect(() => testWhere(5, { gte: 1, below: 4 })).toThrow(/unknown where operator "below"/);
    expect(() => testWhere(undefined, ['a'])).toThrow(/unknown where operator/); // thrown whatever the feature holds
    // an operator object with no operator in it would match everything
    expect(() => testWhere('park', {})).toThrow(/where operator object has no operator/);
    expect(() => testWhere('park', { flags: 'i' })).toThrow(/where operator object has no operator/);
  });

  test('an operator given a value of the wrong kind is an error, not a substring match or "matches nothing"', () => {
    // `in` on a string did a substring match ('park'.includes('a')); a non-boolean `exists` and a non-number bound
    // matched nothing, so a negative assertion passed; `undefined` (it survives Playwright's serialisation) matched nothing
    expect(() => testWhere('a', { in: 'park' })).toThrow('where operator "in" takes an array of values, got "park"');
    expect(() => testWhere('x', { exists: 'yes' })).toThrow('where operator "exists" takes true or false, got "yes"');
    for (const op of ['gt', 'gte', 'lt', 'lte']) expect(() => testWhere(5, { [op]: '4' })).toThrow(`where operator "${op}" takes a number, got "4"`);
    expect(() => testWhere(5, { gt: NaN })).toThrow('where operator "gt" takes a number, got NaN');
    expect(() => testWhere('x', undefined)).toThrow('a where value is undefined');
    expect(() => testWhere('x', { eq: undefined })).toThrow('where operator "eq" is undefined');
    expect(() => testWhere('x', { matches: 5 })).toThrow('where operator "matches" takes a RegExp source string, got 5');
  });
});

test.describe('explode', () => {
  test('all six geometry types', () => {
    const point: Geometry = { type: 'Point', coordinates: [1, 2] };
    expect(explode(point)).toEqual([{ kind: 'point', coord: [1, 2] }]);

    const multiPoint: Geometry = { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] };
    expect(explode(multiPoint)).toEqual([{ kind: 'point', coord: [1, 2] }, { kind: 'point', coord: [3, 4] }]);

    const line: Geometry = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
    expect(explode(line)).toEqual([{ kind: 'line', coords: [[0, 0], [1, 1]] }]);

    const multiLine: Geometry = { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] };
    expect(explode(multiLine)).toEqual([{ kind: 'line', coords: [[0, 0], [1, 1]] }, { kind: 'line', coords: [[2, 2], [3, 3]] }]);

    const polygon: Geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    expect(explode(polygon)).toEqual([{ kind: 'polygon', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }]);

    const multiPolygon: Geometry = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] };
    expect(explode(multiPolygon)).toEqual([
      { kind: 'polygon', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      { kind: 'polygon', rings: [[[5, 5], [6, 5], [6, 6], [5, 5]]] },
    ]);
  });
});

test.describe('pointCandidates', () => {
  test('first candidate is the point itself; 25 candidates total; ring radii 3/6/10', () => {
    const c = { x: 100, y: 100 };
    const out = pointCandidates(c);
    expect(out).toHaveLength(25);
    expect(out[0]).toEqual(c);
    const dist = (p: PixelPoint) => Math.hypot(p.x - c.x, p.y - c.y);
    const ring1 = out.slice(1, 9).map(dist);
    const ring2 = out.slice(9, 17).map(dist);
    const ring3 = out.slice(17, 25).map(dist);
    for (const d of ring1) expect(d).toBeCloseTo(3);
    for (const d of ring2) expect(d).toBeCloseTo(6);
    for (const d of ring3) expect(d).toBeCloseTo(10);
  });
});

test.describe('lineCandidates', () => {
  test('contains vertices and segment midpoints', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const out = lineCandidates(pts);
    expect(out).toContainEqual({ x: 0, y: 0 });
    expect(out).toContainEqual({ x: 10, y: 0 });
    expect(out).toContainEqual({ x: 20, y: 0 });
    expect(out).toContainEqual({ x: 5, y: 0 }); // midpoint of segment 0-1
    expect(out).toContainEqual({ x: 15, y: 0 }); // midpoint of segment 1-2
    expect(out).toHaveLength(5); // 3 vertices + 2 midpoints
  });

  // Regression: originally the candidates were ranked by index in [midpoints..., vertices...],
  // whose middle index is always the FIRST vertex — lines were clicked at their start, not their
  // middle. These unit tests found it.
  test('first candidate is the middle of the line, ends come last', () => {
    const pts3 = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    expect(lineCandidates(pts3)[0]).toEqual({ x: 10, y: 0 });

    const pts2 = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(lineCandidates(pts2)[0]).toEqual({ x: 5, y: 0 }); // a single segment: its midpoint

    const pts5 = [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: 0 }));
    const out = lineCandidates(pts5);
    expect(out[0]).toEqual({ x: 20, y: 0 });
    expect(out.slice(-2)).toEqual(expect.arrayContaining([pts5[0], pts5[4]]));
  });
});

test.describe('polygonCandidates / inPolygon / distToRing', () => {
  // A U-shape (two prongs joined by a bottom bar) opening at y=0: its bbox centre (50,50) falls in
  // the notch between the prongs, OUTSIDE the shape — the case the centroid-based approach would fail.
  const uShape: PixelPoint[] = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 80 }, { x: 70, y: 80 },
    { x: 70, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 },
  ];
  const size = { w: 200, h: 200 };

  test('bbox centre is outside this concave shape (sanity check on the fixture)', () => {
    expect(inPolygon({ x: 50, y: 50 }, [uShape])).toBe(false);
  });

  test('every candidate is inside the polygon', () => {
    const cands = polygonCandidates([uShape], size);
    expect(cands.length).toBeGreaterThan(0);
    for (const p of cands) expect(inPolygon(p, [uShape])).toBe(true);
  });

  test('the first candidate is the one farthest from the edge', () => {
    const cands = polygonCandidates([uShape], size);
    const dists = cands.map((p) => distToRing(p, uShape));
    for (let i = 1; i < dists.length; i++) expect(dists[0]).toBeGreaterThanOrEqual(dists[i]);
  });

  test('candidates are clipped to the surface size', () => {
    const big: PixelPoint[] = [{ x: -50, y: -50 }, { x: 250, y: -50 }, { x: 250, y: 250 }, { x: -50, y: 250 }, { x: -50, y: -50 }];
    const cands = polygonCandidates([big], size);
    expect(cands.length).toBeGreaterThan(0);
    for (const p of cands) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(size.w);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(size.h);
    }
  });

  test('a polygon fully outside the size yields []', () => {
    const far: PixelPoint[] = [{ x: 300, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 400 }, { x: 300, y: 400 }, { x: 300, y: 300 }];
    expect(polygonCandidates([far], size)).toEqual([]);
  });

  test('holes are respected: no candidate falls inside the hole', () => {
    const outer: PixelPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }];
    const hole: PixelPoint[] = [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 40 }];
    const cands = polygonCandidates([outer, hole], { w: 100, h: 100 });
    expect(cands.length).toBeGreaterThan(0);
    for (const p of cands) expect(p.x > 40 && p.x < 60 && p.y > 40 && p.y < 60).toBe(false);
  });

  test('inPolygon / distToRing direct cases', () => {
    const square: PixelPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
    expect(inPolygon({ x: 5, y: 5 }, [square])).toBe(true);
    expect(inPolygon({ x: 15, y: 5 }, [square])).toBe(false);
    expect(distToRing({ x: 5, y: 0 }, square)).toBe(0); // on the top edge
    expect(distToRing({ x: 5, y: 5 }, square)).toBe(5); // centre, 5px from each edge
  });
});

test.describe('sequenceDistance', () => {
  const square: PixelPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  test('identical sequences are 0, cyclic or not', () => {
    expect(sequenceDistance(square, square, true)).toBe(0);
    expect(sequenceDistance(square, square, false)).toBe(0);
  });

  test('cyclic matches a rotated start vertex', () => {
    const rotated: PixelPoint[] = [{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(sequenceDistance(square, rotated, true)).toBe(0);
  });

  test('cyclic matches reversed winding', () => {
    const reversed: PixelPoint[] = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
    expect(sequenceDistance(square, reversed, true)).toBe(0);
  });

  test('non-cyclic does NOT forgive reversed winding', () => {
    const reversed: PixelPoint[] = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
    const worst = sequenceDistance(square, reversed, false);
    expect(worst).toBeCloseTo(Math.hypot(10, 10)); // vertices 1 and 3 are swapped diagonally
  });

  test('returns the worst (max) vertex distance, not an average', () => {
    const a: PixelPoint[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    const b: PixelPoint[] = [{ x: 3, y: 4 }, { x: 0, y: 0 }];
    expect(sequenceDistance(a, b, false)).toBe(5);
  });
});

test.describe('histogram', () => {
  test('low-cardinality props listed as value×count, sorted by count desc', () => {
    const props = [{ zoning: 'residential' }, { zoning: 'residential' }, { zoning: 'commercial' }];
    expect(histogram(props, 3)).toBe('Summary of all 3 — zoning: residential×2, commercial×1');
  });

  test('numeric high-cardinality props shown as min..max', () => {
    const props = [1, 2, 3, 4, 5, 6].map((v) => ({ height: v }));
    expect(histogram(props, 6)).toBe('Summary of all 6 — height: 1..6');
  });

  test("starts with 'Summary of all <total> — '", () => {
    expect(histogram([{ a: 'x' }], 1)).toMatch(/^Summary of all 1 — /);
  });

  test("returns '' when nothing qualifies", () => {
    // 6 distinct non-numeric strings: too many distinct values to list, not numeric to range.
    const props = ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => ({ name: v }));
    expect(histogram(props, 6)).toBe('');
    expect(histogram([], 0)).toBe('');
  });
});

test.describe('fmtProps', () => {
  test('caps the number of keys and says (+N props)', () => {
    const props = { a: 1, b: 2, c: 3, d: 4 };
    expect(fmtProps(props, 2)).toBe('a=1 b=2 (+2 props)');
    expect(fmtProps(props, 4)).toBe('a=1 b=2 c=3 d=4');
  });

  test('long strings are truncated', () => {
    const long = 'x'.repeat(50);
    const out = fmtProps({ a: long }, 1);
    expect(out).toContain('…"');
    expect(out).toBe(`a="${'x'.repeat(39)}…"`);
  });
});

test.describe('compass', () => {
  test('the four cardinals', () => {
    expect(compass(1, 0, 0)).toBe('east');
    expect(compass(0, 1, 0)).toBe('north');
    expect(compass(-1, 0, 0)).toBe('west');
    expect(compass(0, -1, 0)).toBe('south');
  });

  test('the four diagonals', () => {
    expect(compass(1, 1, 0)).toBe('north-east');
    expect(compass(-1, 1, 0)).toBe('north-west');
    expect(compass(-1, -1, 0)).toBe('south-west');
    expect(compass(1, -1, 0)).toBe('south-east');
  });

  test('wraps across the antimeridian: dLng=359 behaves like dLng=-1 (1° west)', () => {
    // ((359 % 360 + 540) % 360) - 180 === -1, so this IS handled correctly: 359° east is folded
    // back to the equivalent short way round (1° west), not read as "almost all the way east".
    expect(compass(359, 0, 0)).toBe('west');
    expect(compass(359, 0, 0)).toBe(compass(-1, 0, 0));
  });
});

test.describe('describe', () => {
  test('includes layer#id', () => {
    const s = describeFeature({ layer: 'parcels', id: 42, properties: {} });
    expect(s).toContain('parcels#42');
  });

  test('truncates long props', () => {
    const bigProps = { blob: 'y'.repeat(200) };
    const s = describeFeature({ layer: 'l', id: 1, properties: bigProps });
    const propsPart = JSON.stringify(bigProps);
    expect(propsPart.length).toBeGreaterThan(120);
    expect(s).toContain('…');
    expect(s.length).toBeLessThan(propsPart.length + 20);
  });

  test('appends [NOT VISIBLE: reason] when visible === false', () => {
    const s = describeFeature({ layer: 'l', id: 1, properties: {}, visible: false, invisibleBecause: 'opacity 0' });
    expect(s).toContain('[NOT VISIBLE: opacity 0]');
    const visibleS = describeFeature({ layer: 'l', id: 1, properties: {}, visible: true });
    expect(visibleS).not.toContain('NOT VISIBLE');
  });
});

test.describe('nested property values (found on a react-map-gl app: counties with a `flows` object)', () => {
  test('fmtProps prints them as truncated JSON, not "[object Object]"', () => {
    expect(fmtProps({ name: 'Seward, KS', flows: { '18': -36, '26': -6, '35': -1, '46': 16, '69': 1 }, centroid: [-100.85, 37.19, 0] }, 6)).toBe(
      'name="Seward, KS" flows={"18":-36,"26":-6,"35":-1,"46":16,"69":1} centroid=[-100.85,37.19,0]',
    );
    expect(fmtProps({ flows: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i), i])) }, 6)).toMatch(/^flows=\{"0":0,.{20,40}…$/);
  });

  test('the accessibility mirror labels them as JSON, not "[object Object]"', () => {
    const label = buttonLabel({ layer: 'counties', id: 7, geometryType: 'Polygon', properties: { name: 'Seward', flows: { '18': -36 }, centroid: [-100.85, 37.19] } });
    expect(label).toBe('counties 7 (Polygon) name=Seward, flows={"18":-36}, centroid=[-100.85,37.19]');
  });

  test('histogram ignores them', () => {
    expect(histogram([{ a: { x: 1 }, kind: 'k' }, { a: { x: 2 }, kind: 'k' }], 2)).toBe('Summary of all 2 — kind: k×2');
  });
});

test.describe('wholePixels', () => {
  test('snaps each candidate to the whole client pixel nearest to it first, then the four around it; surface-relative', () => {
    const rect = { left: 10.25, top: 20.5, sx: 1, sy: 1 };
    // client (110.65, 70.9): nearest (111, 71), then floor/ceil combinations; given back relative to the surface
    const out = wholePixels([{ x: 100.4, y: 50.4 }], rect);
    expect(out.map((p) => [p.x + rect.left, p.y + rect.top])).toEqual([[111, 71], [110, 70], [111, 70], [110, 71]]);
  });

  test('a candidate already on a whole client pixel gives just that pixel', () => {
    const out = wholePixels([{ x: 5, y: 6 }], { left: 0, top: 0, sx: 1, sy: 1 });
    expect(out).toEqual([{ x: 5, y: 6 }]);
  });

  test('no pixel is tried twice across candidates, and the order of candidates is kept', () => {
    const out = wholePixels([{ x: 10.2, y: 10.2 }, { x: 10.4, y: 10.4 }, { x: 30, y: 30 }], { left: 0, top: 0, sx: 1, sy: 1 });
    const keys = out.map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['10,10', '11,10', '10,11', '11,11', '30,30']);
  });
});

test.describe('verdictKey (a pixel verdict within one action)', () => {
  const view = { center: { lng: 34.78, lat: 32.08 }, zoom: 12, bearing: 0, pitch: 0 };
  const size = { w: 800, h: 600 };
  const over: { layer: string; stamp: string; data?: string }[] = [{ layer: 'veil', stamp: '1|null|0.5', data: '0' }];
  const key = (o: Partial<{ target: string; c: PixelPoint; view: object; size: typeof size; over: typeof over }> = {}) =>
    verdictKey(o.target ?? 'alerts|1|{}', o.c ?? { x: 100.4, y: 200.6 }, o.view ?? view, o.size ?? size, o.over ?? over);

  test('the same target, pixel, camera and overlays: the same key (the retry does not probe again)', () => {
    expect(key()).toBe(key({ c: { x: 100.2, y: 200.9 } }));
  });

  test('any camera change, a resize, another pixel, target, overlay stamp or overlay data: another key', () => {
    const k = key();
    for (const [what, other] of [
      ['zoom', key({ view: { ...view, zoom: 11 } })],
      ['centre', key({ view: { ...view, center: { lng: 34.79, lat: 32.08 } } })],
      ['bearing', key({ view: { ...view, bearing: 10 } })],
      ['pitch', key({ view: { ...view, pitch: 30 } })],
      ['size', key({ size: { w: 800, h: 500 } })],
      ['pixel', key({ c: { x: 102, y: 200 } })],
      ['target', key({ target: 'alerts|2|{}' })],
      ['stamp', key({ over: [{ layer: 'veil', stamp: '1|null|1', data: '0' }] })],
      ['data', key({ over: [{ layer: 'veil', stamp: '1|null|0.5', data: '1' }] })],
      ['overlays', key({ over: [...over, { layer: 'radar', stamp: 'x' }] })],
    ] as const) expect(other, what).not.toBe(k);
  });
});
