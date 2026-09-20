import { brightBasemap } from './basemap';
import { example, expect, test } from './harness';

// MapLibre example "Display buildings in 3D": a fill-extrusion layer over the basemap's `building`
// source-layer, inserted beneath the first label layer; pitched 45°, rotated -17.6°.
const routes = brightBasemap([-74.0066, 40.7135]);

test.describe('wild: display-buildings-in-3d', () => {
  test('the extrusion layer sits beneath the labels and shows buildings with heights', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes });
    const order = (await map.layers()).map((l) => l.id);
    const firstLabel = (await map.layers()).find((l) => l.type === 'symbol' && l.id !== 'road_oneway')!.id;
    expect(order.indexOf('3d-buildings')).toBe(order.indexOf(firstLabel) - 1);
    await expect(map).toHaveFeature({ layer: '3d-buildings', where: { render_height: { gte: 80 } } });
  });

  test('a click on an extruded building lands on THAT building (pitched camera, neighbours in front)', async ({ wild, page }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes });
    // the example has no click handler of its own: record what MapLibre says was clicked
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.on('click', (e: any) => ((window as any).__clicked = m.queryRenderedFeatures(e.point, { layers: ['3d-buildings'] })[0]?.id));
    });
    const tall = (await map.features({ layer: '3d-buildings', where: { render_height: { gte: 60 } } }).all()).slice(0, 5);
    expect(tall.length).toBe(5);
    for (const b of tall) {
      await map.feature({ layer: '3d-buildings', id: b.id }).click();
      expect(await page.evaluate(() => (window as any).__clicked)).toBe(b.id);
    }
  });

  test('zooming out past the layer minzoom removes the extrusions', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes });
    await expect(map).toHaveFeature({ layer: '3d-buildings' });
    await map.keyboard.press('-');
    await expect(map).toHaveView({ zoom: 14.5 });
    await expect(map).not.toHaveFeature({ layer: '3d-buildings' });
    await expect(map).toHaveFeature({ layer: 'building' }); // the flat footprints remain
  });

  test('the text snapshot stays readable on a 20-layer basemap', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes });
    const snap = await map.snapshot({ layers: ['3d-buildings', 'poi_r1'], perLayer: 3 });
    expect(snap).toMatch(/\[3d-buildings\] \d+ fill-extrusion entities/);
    expect(snap).toContain('fill-extrusion-color is data-driven');
    expect(snap).toMatch(/note: tiled source\(s\) openmaptiles \(\d+ layers\), openfreemap \(1 layer\)/);
  });
});
