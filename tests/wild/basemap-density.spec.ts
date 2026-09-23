import { brightBasemap, brightStyle, syntheticCity } from './basemap';
import { DENSITY_ZOOMS, formatDensity, measureLabelDensity } from './density';
import { example, expect, test } from './harness';

/**
 * Is the synthetic basemap as label-dense as a real one? Rendered basemap symbols in the same 880×720 window at the zooms
 * the wild apps look at, compared with the REAL OpenFreeMap "bright" style measured the same way (real-basemap.spec.ts,
 * opt-in, on the cache from scripts/fetch-real-basemap.sh — the numbers below; counts only, no data).
 * The sparse synthetic city this replaced had 5, 5, 6, 10, 33 and 25.
 */
const REAL_BRIGHT_NYC: Record<number, number> = { 11: 59, 12: 26, 13: 35, 14: 78, 15: 239, 16: 130 };
const NYC: [number, number] = [-74.0066, 40.7135];

test.describe('wild: synthetic basemap label density', () => {
  test('rendered labels per viewport are comparable to the real style at every zoom the wild apps use', async ({ wild, page }) => {
    await wild.open(example('display-buildings-in-3d'), { routes: brightBasemap(NYC) });
    const d = await measureLabelDensity(page, { center: NYC, zooms: DENSITY_ZOOMS });
    console.log(formatDensity('SYNTHETIC', d));
    for (const r of d) {
      // "comparable": within 0.6x–2x of the real style, zoom by zoom (placement is deterministic: same fonts, same window)
      expect.soft(r.symbols, `z${r.zoom}`).toBeGreaterThanOrEqual(Math.round(0.6 * REAL_BRIGHT_NYC[r.zoom]));
      expect.soft(r.symbols, `z${r.zoom}`).toBeLessThanOrEqual(2 * REAL_BRIGHT_NYC[r.zoom]);
    }
    const at = (z: number, re: RegExp) => Object.entries(d.find((r) => r.zoom === z)!.byLayer).filter(([id]) => re.test(id)).reduce((n, [, v]) => n + v, 0);
    // and it is the right KIND of density: place names and road shields at low zoom, POI icons + names and one-way arrows up close
    expect(at(11, /^label_/)).toBeGreaterThanOrEqual(20);
    expect(at(11, /^highway-shield$/)).toBeGreaterThanOrEqual(10);
    expect(at(11, /^waterway-name$|^water_name/)).toBeGreaterThanOrEqual(1);
    expect(at(14, /^highway-name-/)).toBeGreaterThanOrEqual(20);
    expect(at(15, /^poi_/)).toBeGreaterThanOrEqual(50);
    expect(at(15, /^road_oneway/)).toBeGreaterThanOrEqual(5);
  });

  test('the generated basemap is deterministic: the same data and style every run', () => {
    expect(JSON.stringify(syntheticCity(NYC, true))).toBe(JSON.stringify(syntheticCity(NYC, true)));
    expect(JSON.stringify(brightStyle(true))).toBe(JSON.stringify(brightStyle(true)));
    const a = brightBasemap(NYC), b = brightBasemap(NYC);
    expect(JSON.stringify(a.filter(([, f]) => typeof f !== 'function'))).toBe(JSON.stringify(b.filter(([, f]) => typeof f !== 'function')));
  });
});
