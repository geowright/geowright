import { cartoBasemap } from './basemap';
import { expect, test, type Routes } from './harness';

// visgl/react-map-gl example "geojson": a choropleth of US states. The app fetches the data itself, computes a
// `percentile` per state for the chosen year and hands a NEW GeoJSON object to <Source data=...> on every
// slider change (=> setData). Generated source id, no feature ids, colour by an interpolated expression.
const routes: Routes = [
  ...cartoBasemap('positron', [-100, 40]),
  ['https://raw.githubusercontent.com/uber/react-map-gl/master/examples/.data/us-income.geojson', 'react-map-gl/us-income.geojson'],
];
const APP = '/apps/react-map-gl/geojson/';

test.describe('wild: react-map-gl / geojson', () => {
  test('the choropleth appears once the app has fetched its data (app-level async, no map signal)', async ({ wild }) => {
    const map = await wild.open(APP, { routes });
    await expect(map).toHaveFeature({ layer: 'data', where: { name: 'Maine' } });
    const maine = await map.feature({ layer: 'data', where: { name: 'Maine' } }).info();
    expect(maine.properties.value).toBe(51419); // 2015, from the fixture
  });

  test('moving the year slider re-computes every state', async ({ wild, page }) => {
    const map = await wild.open(APP, { routes });
    await expect(map).toHaveFeature({ layer: 'data', where: { name: 'Maine', value: 51419 } });
    await page.locator('input[type=range]').fill('1995');
    await expect(map).toHaveFeature({ layer: 'data', where: { name: 'Maine', value: 31189 } });
    await expect(map).not.toHaveFeature({ layer: 'data', where: { value: 51419 } });
    await expect(page.locator('.control-panel b')).toHaveText('1995');
  });

  test('hovering a state shows the tooltip with that state\'s numbers', async ({ wild, page }) => {
    const map = await wild.open(APP, { routes });
    await map.feature({ layer: 'data', where: { name: 'Texas' } }).hover();
    const tip = page.locator('.tooltip');
    await expect(tip).toContainText('State: Texas');
    const texas = await map.feature({ layer: 'data', where: { name: 'Texas' } }).info();
    await expect(tip).toContainText(`Median Household Income: ${texas.properties.value}`);
  });

  test('the snapshot tells the colour story: richer states are drawn differently from poorer ones', async ({ wild }) => {
    const map = await wild.open(APP, { routes });
    await expect(map).toHaveFeature({ layer: 'data', where: { name: 'Maine' } });
    const snap = await map.snapshot({ layers: ['data'], perLayer: 60, maxProps: 2, maxChars: 20000 });
    expect(snap).toContain('fill-color is data-driven');
    const colourOf = (state: string) => new RegExp(`drawn (\\w[\\w ]*)\\((#[0-9a-f]{6})\\)[^\\n]* name="${state}"`).exec(snap)?.[2];
    expect(colourOf('Maryland')).toBeTruthy();
    expect(colourOf('Maryland')).not.toBe(colourOf('Mississippi')); // top vs bottom of the income table
  });
});
