import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Create a hover effect": feature-state driven fill-opacity (0.5 -> 1 on hover).
const routes: Routes = [
  ...DEMOTILES,
  ['https://maplibre.org/maplibre-gl-js/docs/assets/us_states.geojson', 'us_states.geojson'],
];

test.describe('wild: create-a-hover-effect', () => {
  test('the states are on the map, addressable by name', async ({ wild }) => {
    const map = await wild.open(example('create-a-hover-effect'), { routes });
    await expect(map).toHaveFeature({ layer: 'state-fills', where: { STATE_NAME: 'Texas' } });
  });

  test('hovering a state sets its hover feature-state; moving on clears it', async ({ wild }) => {
    const map = await wild.open(example('create-a-hover-effect'), { routes });
    const texas = map.feature({ layer: 'state-fills', where: { STATE_NAME: 'Texas' } });
    await texas.hover();
    await expect.poll(async () => (await texas.info()).state).toEqual({ hover: true });
    expect(await map.snapshot({ filter: { layer: 'state-fills', where: { STATE_NAME: 'Texas' } } })).toContain('state={"hover":true}');
    await map.feature({ layer: 'state-fills', where: { STATE_NAME: 'Kansas' } }).hover();
    await expect.poll(async () => (await texas.info()).state).toEqual({ hover: false });
  });

  test('the basemap underneath is the real demotiles style: countries are there too, and do not get in the way', async ({ wild }) => {
    const map = await wild.open(example('create-a-hover-effect'), { routes });
    await expect(map).toHaveFeature({ layer: 'countries-fill', where: { NAME: 'Mexico' } });
    // Mexico is basemap and not covered by any state: hoverable, and the app's hover state stays empty.
    await map.feature({ layer: 'countries-fill', where: { NAME: 'Mexico' } }).hover();
    expect((await map.feature({ layer: 'state-fills', where: { STATE_NAME: 'Texas' } }).info()).state).toBeUndefined();
    // The USA polygon is almost entirely under the app's state-fills: to a user, and to geowright, it is covered.
    // (Pixel-exact truth: a sliver of northern Alaska is not, where the two coastlines disagree. Found after 15,000
    // hit tests before the search was bounded — see the design notes.)
    await expect(map.feature({ layer: 'countries-fill', where: { NAME: 'United States of America' } }).hover({ timeout: 3000 })).rejects.toThrow(/candidate points are all covered by another feature; topmost is state-(fills|borders)/);
  });
});
