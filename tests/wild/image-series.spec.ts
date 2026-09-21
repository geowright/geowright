import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Animate a series of images": an `image` source whose `url` is swapped every
// 200ms (setInterval + updateImage) between radar0..4.gif, forever.
const routes: Routes = [
  ...DEMOTILES,
  ...[0, 1, 2, 3, 4].map((i) => [`https://maplibre.org/maplibre-gl-js/docs/assets/radar${i}.gif`, `radar${i}.gif`] as Routes[number]),
];

test.describe('wild: animate-a-series-of-images', () => {
  test('the radar raster layer is added over the forecast area and visible', async ({ wild }) => {
    const map = await wild.open(example('animate-a-series-of-images'), { routes, waitForIdle: false });
    // no queryable feature on an `image` source: poll layers() for the layer the app adds on 'load'.
    await expect.poll(async () => (await map.layers()).some((l) => l.id === 'radar-layer')).toBe(true);
    const radarLayer = (await map.layers()).find((l) => l.id === 'radar-layer');
    expect(radarLayer).toMatchObject({ type: 'raster', source: 'radar', visible: true });
    await expect(map).toHaveView({ center: { lng: -75.789, lat: 41.874 }, zoom: 5 });
  });

  test('unlike a per-frame animation, the map DOES settle to idle between image swaps', async ({ wild }) => {
    const map = await wild.open(example('animate-a-series-of-images'), { routes, waitForIdle: false });
    await expect.poll(async () => (await map.layers()).some((l) => l.id === 'radar-layer')).toBe(true);
    // updateImage() on a 200ms interval briefly disturbs idle, then the map is genuinely still until
    // the next tick — contrast with animate-a-point / add-a-canvas-source, where it never resolves.
    await map.waitForIdle({ timeout: 3000 });
  });

  test('zoom is clamped to the map\'s configured range (4 .. 5.99)', async ({ wild }) => {
    const map = await wild.open(example('animate-a-series-of-images'), { routes, waitForIdle: false });
    for (let i = 0; i < 5; i++) await map.keyboard.press('-');
    await expect(map).toHaveView({ zoom: 4 });
    await map.waitForIdle();
    for (let i = 0; i < 5; i++) await map.keyboard.press('+');
    await expect.poll(async () => (await map.viewState()).zoom).toBeLessThanOrEqual(5.99);
    await expect.poll(async () => (await map.viewState()).zoom).toBeGreaterThan(5.9);
  });

  test('the radar image keeps cycling through distinct frames, forever (network-level: no query API for image-source content)', async ({ wild, page }) => {
    const seen = new Set<string>();
    page.on('request', (req) => {
      const m = /radar(\d)\.gif/.exec(req.url());
      if (m) seen.add(m[1]);
    });
    await wild.open(example('animate-a-series-of-images'), { routes, waitForIdle: false });
    // 5 frames cycling every 200ms: within a couple of seconds every frame must have been requested at least once.
    await expect.poll(() => seen.size, { timeout: 5000 }).toBe(5);
  });

  // REMOVED after the 20x: `toHaveLayerPixels` on this layer. The example swaps the source image every 200 ms; when
  // the machine cannot deliver and decode an image in 200 ms (5 workers of software GL), the layer paints nothing
  // for seconds — the app's behaviour under starvation, faithfully observed: 7 failures in 160 under contention, 0 in
  // 40 alone. An assertion that depends on the machine being fast is not one for this suite.
});
