/**
 * Fixture data for the demo's basemap switcher (demo/src/main.ts): the light and dark basemap styles, which a real app
 * loads from a server. Invented. Lives with the tests, not in the app; tests/fixtures.ts answers /basemaps/<name>.json
 * with them, as it answers the tiles.
 */
export function basemapStyle(name: string, origin: string): object | undefined {
  const raster = () => ({ type: 'raster', tiles: [`${origin}/tiles/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 14 });
  if (name === 'light') {
    return {
      version: 8,
      name: 'Light',
      sources: { basemap: raster() },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#e9eef2' } },
        { id: 'basemap', type: 'raster', source: 'basemap' },
      ],
    };
  }
  if (name === 'dark') {
    return {
      version: 8,
      name: 'Dark',
      sources: { 'dark-basemap': raster() },
      layers: [
        { id: 'dark-background', type: 'background', paint: { 'background-color': '#1f2933' } },
        { id: 'dark-basemap', type: 'raster', source: 'dark-basemap', paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.35 } },
      ],
    };
  }
  return undefined;
}
