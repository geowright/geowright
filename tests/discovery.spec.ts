import { test, expect } from './fixtures';

/**
 * Design question 1, as an executable claim: in a bundled ESM app (MapLibre 6 is ESM-only) the
 * map instance cannot be auto-discovered from outside. If this test ever FAILS, auto-discovery
 * became possible and the explicit hook could be made optional.
 */
test('auto-discovery finds nothing in a bundled ESM app; the explicit hook does', async ({ page, map }) => {
  void map; // fixture navigates and waits for idle

  const found = await page.evaluate(() => {
    const isMapLike = (v: any) => {
      try {
        return !!v && typeof v === 'object' && typeof v.queryRenderedFeatures === 'function' && typeof v.project === 'function';
      } catch {
        return false;
      }
    };
    const w = window as any;
    // 1. the classic: a library global whose constructor could be patched from addInitScript
    const libraryGlobal = 'maplibregl' in w || 'mapboxgl' in w;
    // 2. any window property holding a map (excluding our hook)
    const globals = Object.getOwnPropertyNames(w).filter((k) => k !== '__geowright_maps' && isMapLike(w[k]));
    // 3. a back-reference from the map's DOM subtree (own props incl. symbols, e.g. framework expandos)
    const container = document.querySelector('.maplibregl-map')!;
    const nodes = [container, ...container.querySelectorAll('*')];
    const domRefs = nodes.filter((n) =>
      [...Object.getOwnPropertyNames(n), ...Object.getOwnPropertySymbols(n)].some((k) => isMapLike((n as any)[k])),
    ).length;
    return { libraryGlobal, globals, domRefs, hook: isMapLike(w.__geowright_maps?.main) };
  });

  expect(found).toEqual({ libraryGlobal: false, globals: [], domRefs: 0, hook: true });
});
