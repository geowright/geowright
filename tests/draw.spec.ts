import { test, expect } from './fixtures';
import type { LngLat } from '../src/playwright';

/** ACT gap, hard mode: drawing and editing geometry with a real draw library (terra-draw). */
const SQUARE: LngLat[] = [
  { lng: 34.825, lat: 32.04 },
  { lng: 34.85, lat: 32.04 },
  { lng: 34.85, lat: 32.055 },
  { lng: 34.825, lat: 32.055 },
];

async function drawnRing(page: import('@playwright/test').Page): Promise<number[][]> {
  const json = JSON.parse(await page.getByTestId('draw-json').innerText());
  return json[0].geometry.coordinates[0];
}

test.describe('drawing', () => {
  test('draw a polygon with real clicks; geometry lands where we asked', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });

    await expect(page.getByTestId('draw-count')).toHaveText('1');
    await expect(map.features({ layer: 'td-polygon' })).toHaveFeatureCount(1);

    const ring = await drawnRing(page);
    expect(ring).toHaveLength(5); // closed ring
    SQUARE.forEach((v, i) => {
      expect(ring[i][0]).toBeCloseTo(v.lng, 3); // 1px at z12 ≈ 0.00017°
      expect(ring[i][1]).toBeCloseTo(v.lat, 3);
    });
  });

  test('select a drawn polygon and drag one vertex', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    await expect(page.getByTestId('draw-count')).toHaveText('1');

    await page.getByTestId('draw-select').click();
    await map.feature({ layer: 'td-polygon' }).click();
    await expect(map.features({ layer: 'td-point', where: { selectionPoint: true } })).toHaveFeatureCount(4);

    const to = { lng: 34.86, lat: 32.065 };
    await map.feature({ layer: 'td-point', where: { selectionPoint: true }, at: SQUARE[2] }).dragTo(to);

    await expect
      .poll(async () => {
        const r = await drawnRing(page);
        return [+r[2][0].toFixed(3), +r[2][1].toFixed(3)];
      })
      .toEqual([34.86, 32.065]);
    const ring = await drawnRing(page);
    expect(ring[0][0]).toBeCloseTo(SQUARE[0].lng, 3); // other vertices untouched
    expect(ring[1][1]).toBeCloseTo(SQUARE[1].lat, 3);
  });

  test('toHaveGeometry reads the MAP (full shape from the source), not the app JSON', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    const drawn = map.feature({ layer: 'td-polygon' });
    await expect(drawn).toHaveGeometry(SQUARE);
    await expect(drawn).toHaveGeometry([SQUARE[2], SQUARE[1], SQUARE[0], SQUARE[3]]); // start vertex and winding are free
    await expect(drawn).not.toHaveGeometry([SQUARE[0], SQUARE[1], SQUARE[2], { lng: 34.83, lat: 32.058 }]);
    const err = await expect(drawn).toHaveGeometry([SQUARE[0], SQUARE[1], SQUARE[2]], { timeout: 500 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('4 vertices, expected 3');
    expect(err?.message).toContain('Geometry on the map (data)');
    // parcel 105 is concave and spans internal tiles: the renderer returns pieces, the source the whole ring
    const parcel = await map.feature({ layer: 'parcels', id: 105 }).geometry();
    expect(parcel.type).toBe('Polygon');
    expect((parcel.coordinates as number[][][])[0].length).toBeGreaterThan(5);
  });

  test('line: click vertices, finish on the last one', async ({ map, page }) => {
    const path: LngLat[] = [{ lng: 34.825, lat: 32.04 }, { lng: 34.84, lat: 32.05 }, { lng: 34.855, lat: 32.042 }];
    await page.getByTestId('draw-line').click();
    await map.draw.line(path, { finish: 'click-last' });
    await expect(map.feature({ layer: 'td-linestring' })).toHaveGeometry(path);
  });

  test('rectangle (click-move-click) and circle (press-drag-release)', async ({ map, page }) => {
    await page.getByTestId('draw-rectangle').click();
    await map.draw.rectangle(SQUARE[0], SQUARE[2]);
    await expect(map.feature({ layer: 'td-polygon', where: { mode: 'rectangle' } })).toHaveGeometry(SQUARE);

    // REAL INPUT FINDING: terra-draw recognises a drag only after the pointer has moved 8px
    // (minPixelDragDistanceDrawing), and centres the circle where the drag was RECOGNISED, not where
    // the button went down. A user gets the same offset; a synthetic dragstart event would not.
    // So: the circle passes exactly through the release point, around a centre a few px from the press.
    const press = { lng: 34.72, lat: 32.1 };
    const release = { lng: 34.73, lat: 32.1 };
    await page.getByTestId('draw-circle').click();
    await map.draw.circle(press, release, { gesture: 'drag', steps: 30 });
    const circle = map.feature({ layer: 'td-polygon', where: { mode: 'circle' } });
    const ring = ((await circle.geometry()).coordinates as number[][][])[0];
    const lngs = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    const center = { lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
    await expect(circle).toHaveGeometry({ circle: { center, edge: release } });
    const px = async (l: LngLat) => (await map._call<{ client: { x: number; y: number } }>('clientPoint', l)).client;
    const [c, p] = [await px(center), await px(press)];
    expect(Math.hypot(c.x - p.x, c.y - p.y)).toBeLessThan(12); // the drag threshold, not an error of ours
    await expect(circle).not.toHaveGeometry({ circle: { center, edge: { lng: 34.74, lat: 32.1 } } });
  });

  test('Escape cancels a shape in progress', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE.slice(0, 3), { finish: 'none' });
    await expect(map).toHaveFeature({ layer: 'td-polygon' }); // the in-progress shape is on the map
    await map.draw.cancel();
    await expect(map).not.toHaveFeature({ layer: 'td-polygon' });
    await expect(page.getByTestId('draw-count')).toHaveText('0');
  });

  test('edit: insert a vertex by dragging a midpoint, delete a vertex, move the whole shape', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    await page.getByTestId('draw-select').click();
    const drawn = map.feature({ layer: 'td-polygon' });
    await drawn.click();

    // midpoint of the bottom edge, dragged south: a fifth vertex appears there
    const mid = { lng: (SQUARE[0].lng + SQUARE[1].lng) / 2, lat: SQUARE[0].lat };
    const pulled = { lng: mid.lng, lat: 32.03 };
    await map.feature({ layer: 'td-point', where: { midPoint: true }, at: mid }).dragTo(pulled);
    await expect(drawn).toHaveGeometry([SQUARE[0], pulled, SQUARE[1], SQUARE[2], SQUARE[3]]);

    // terra-draw deletes a vertex on right-click of its selection point
    await map.feature({ layer: 'td-point', where: { selectionPoint: true }, at: pulled }).rightClick();
    await expect(drawn).toHaveGeometry(SQUARE);

    // move the whole polygon
    const d = { dLng: -0.02, dLat: 0.01 };
    await drawn.dragBy(d);
    // Same real-input finding as the circle: terra-draw starts moving the shape only once the drag is
    // recognised (8px in), so it lands up to ~12px short of the requested offset — as it does for a user.
    await expect(drawn).toHaveGeometry(SQUARE.map((v) => ({ lng: v.lng + d.dLng, lat: v.lat + d.dLat })), { tolerancePx: 14 });
    await expect(drawn).not.toHaveGeometry(SQUARE, { tolerancePx: 14 });
    // ...and it moved rigidly: every vertex by the same offset (to 0.000005°; mercator makes lat offsets differ in the 6th decimal)
    const moved = ((await drawn.geometry()).coordinates as number[][][])[0];
    const dx = moved[0][0] - SQUARE[0].lng;
    const dy = moved[0][1] - SQUARE[0].lat;
    SQUARE.forEach((v, i) => {
      expect(moved[i][0] - v.lng).toBeCloseTo(dx, 5);
      expect(moved[i][1] - v.lat).toBeCloseTo(dy, 5);
    });
  });
});
