import { brightBasemap } from './basemap';
import { example, expect, test } from './harness';

// MapLibre example "Display a popup on click": symbols with HTML `description` popups; the
// features have NO ids, and no distinguishing property other than `description` (theatre and
// music icons repeat 2x/3x). `icon-image: '{icon}'` uses the legacy `{token}` interpolation, and
// two icon names ('art-gallery', 'rocket') are not in the basemap's default POI set.
const routes = brightBasemap([-77.04, 38.907], { icons: ['art-gallery', 'rocket'] });

test.describe('wild: display-a-popup-on-click', () => {
  test('all 9 places are on the map, addressable by their (unique) description', async ({ wild }) => {
    const map = await wild.open(example('display-a-popup-on-click'), { routes });
    await expect(map.features({ layer: 'places' })).toHaveFeatureCount(9);
    await expect(map).toHaveFeature({ layer: 'places', where: { description: /Muhsinah/ } });
    const f = await map.feature({ layer: 'places', where: { description: /Ballston Arts/ } }).info();
    expect(f.id).toBeUndefined(); // no feature ids at all in this example's source data
    expect(f.properties.icon).toBe('art-gallery');
  });

  test('clicking a symbol opens a popup with its HTML description, anchored on it', async ({ wild }) => {
    const map = await wild.open(example('display-a-popup-on-click'), { routes });
    const rocket = { layer: 'places', where: { description: /Capital Pride Parade/ } };
    await map.feature(rocket).click();
    await expect(map).toHavePopup({ feature: rocket, text: 'Capital Pride Parade' });
    await expect(await map.popup()).toContainText('Free.');
    // the description is HTML, not escaped text: the link inside actually rendered as a link
    await expect((await map.popup()).locator('a', { hasText: 'Capital Pride Parade' })).toHaveAttribute('href', 'https://www.capitalpride.org/parade');
  });

  test('the cursor turns into a pointer over a symbol, and back when it leaves', async ({ wild, page }) => {
    const map = await wild.open(example('display-a-popup-on-click'), { routes });
    await map.feature({ layer: 'places', where: { description: /Muhsinah/ } }).hover();
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'pointer');
    await map.hoverAt({ lng: -77.09, lat: 38.99 }); // empty water/park area, off every place
    await expect(page.locator('canvas.maplibregl-canvas')).not.toHaveCSS('cursor', 'pointer');
  });

  test('one of two identically-tagged "theatre" symbols is clicked at a time, and it is the right one', async ({ wild }) => {
    const map = await wild.open(example('display-a-popup-on-click'), { routes });
    // Both theatre-icon places have the same icon and no id — but each has its OWN description, so
    // `where` on the description (not the icon) still singles one out reliably.
    const madMen = { layer: 'places', where: { description: /Mad Men Season Five/ } };
    await map.feature(madMen).click();
    await expect(map).toHavePopup({ feature: madMen, text: 'Mad Men Season Five Finale Watch Party' });
    const mountPleasant = { layer: 'places', where: { description: /Make it Mount Pleasant/ } };
    await map.feature(mountPleasant).click();
    await expect(map).toHavePopup({ feature: mountPleasant, text: 'Make it Mount Pleasant' });
  });

  test(
    'two places sharing every queried property are two features (was one: fixed in the library)',
    async ({ wild }) => {
      // FIXED IN THE LIBRARY: this test was written as `test.fixme` — id-less features with identical
      // properties used to collapse into ONE. The engine now splits same-key, id-less pieces by whether they touch on screen.
      const map = await wild.open(example('display-a-popup-on-click'), { routes });
      await expect(map.features({ layer: 'places', where: { icon: 'theatre' } })).toHaveFeatureCount(2);
    },
  );

  test('snapshot under a tight budget: the basemap gives up its rows first, the app layer keeps its own', async ({ wild }) => {
    // Was a known library bug, exposed when the synthetic basemap became production-dense: see
    // "snapshot budget" in dense-basemap.spec.ts.
    const map = await wild.open(example('display-a-popup-on-click'), { routes });
    const snap = await map.snapshot({ maxChars: 3900 });
    expect(snap.length).toBeLessThanOrEqual(3900);
    // all nine places still have a row each (a clickable pixel + their properties) …
    expect(snap).toContain('[places] 9 symbol entities');
    expect(snap.match(/^  - Point @\(\d+,\d+\).* description=/gm)?.length).toBe(9);
    // … while the basemap's busiest layer (hundreds of street blocks, on a tiled source with 8+ layers) has given up most
    // or all of its rows (at most 7 listed). Originally it was the other way round: top-down order spent the budget on
    // the basemap first.
    const [, total, unlisted] = /\[highway-minor\] (\d+) line entities[\s\S]*?… (\d+) more not listed/.exec(snap)?.map(Number) ?? [];
    expect(total - unlisted).toBeLessThanOrEqual(7);
  });
});
