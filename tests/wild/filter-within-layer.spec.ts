import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Filter within a Layer": a DOM filter-builder (checkboxes + operator selects +
// number inputs for felt/mag/tsunami) that is supposed to call map.setFilter('earthquakes', [...])
// on 'change'. As vendored (upstream, unmodified apart from the hook line) the whole interactive
// feature is broken: the script is an ES module (`type="module"`, always strict mode) and every
// branch of its 'change' handler assigns to an UNDECLARED variable (`operatorFelt = ...`,
// `operatorMag = ...`, `tsunami = ...`, `mapLibreFilterSpread = ...`) — a ReferenceError in strict
// mode. Every one of the page's controls throws before map.setFilter is ever called. This is a bug
// in the example itself (not in geowright); the tests below document exactly what a QA pass finds.
const routes: Routes = [
  ...DEMOTILES,
  ['https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson', 'earthquakes.geojson'],
];

// The dataset is global (6107 unclustered points, zoom ~0.5): querying the FULL rendered set is
// costly, so only the baseline test does an exact count; the bug tests below prove the map was
// untouched more cheaply, via one representative feature (the largest quake) that would still be
// there unfiltered but would be the first to drop out under almost any real filter.
const biggestQuake = { where: { id: 'us2000ahv0' } }; // mag 8.1

test.describe('wild: filter-within-a-layer', () => {
  test.slow(); // ~6k rendered circle features at a near-global view; queries here are inherently heavier

  test('with no filter applied, every earthquake is on the map', async ({ wild, page }) => {
    const map = await wild.open(example('filter-within-a-layer'), { routes });
    await expect(page.locator('#filter-result')).toHaveText('["all"]');
    await expect(map.features({ layer: 'earthquakes' })).toHaveFeatureCount(6107);
  });

  test('BUG: checking the magnitude filter throws (undeclared `operatorMag`) and never reaches setFilter', async ({ wild, page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const map = await wild.open(example('filter-within-a-layer'), { routes });

    await page.getByLabel('Apply magnitude Filter').check();

    expect(errors).toContain('operatorMag is not defined');
    // the checkbox itself DID toggle (native DOM), but the app's own filter state never changed
    await expect(page.getByLabel('Apply magnitude Filter')).toBeChecked();
    await expect(page.locator('#filter-result')).toHaveText('["all"]');
    await expect(map).toHaveFeature({ layer: 'earthquakes', ...biggestQuake });
  });

  test('BUG: checking the felt filter throws (undeclared `operatorFelt`) the same way', async ({ wild, page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const map = await wild.open(example('filter-within-a-layer'), { routes });

    await page.getByLabel('Apply felt Filter').check();

    expect(errors).toContain('operatorFelt is not defined');
    await expect(page.locator('#filter-result')).toHaveText('["all"]');
    await expect(map).toHaveFeature({ layer: 'earthquakes', ...biggestQuake });
  });

  test('BUG: the tsunami filter throws whether or not 0/1 was picked first (undeclared `tsunami`, then `mapLibreFilterSpread`)', async ({ wild, page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const map = await wild.open(example('filter-within-a-layer'), { routes });

    await page.locator('#tsunami').check(); // no radio chosen yet
    expect(errors).toContain('tsunami is not defined');

    await page.locator('#t1').check(); // picking 0/1 afterwards hits the 'default' branch instead
    expect(errors).toContain('mapLibreFilterSpread is not defined');

    await expect(page.locator('#filter-result')).toHaveText('["all"]');
    await expect(map).toHaveFeature({ layer: 'earthquakes', ...biggestQuake });
  });

  test('BUG: even touching an operator dropdown alone throws (undeclared `mapLibreFilterSpread`) — no control on this page can reach setFilter', async ({ wild, page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const map = await wild.open(example('filter-within-a-layer'), { routes });

    await page.locator('#operator-mag').selectOption('>');

    expect(errors).toContain('mapLibreFilterSpread is not defined');
    await expect(page.locator('#filter-result')).toHaveText('["all"]');
    await expect(map).toHaveFeature({ layer: 'earthquakes', ...biggestQuake });
  });
});
