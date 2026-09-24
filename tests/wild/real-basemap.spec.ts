import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Route } from '@playwright/test';
import { DENSITY_ZOOMS, formatDensity, measureLabelDensity } from './density';
import { example, expect, test, type Routes } from './harness';

/**
 * OPT-IN: the same questions as dense-basemap.spec.ts, asked of a REAL basemap — OpenFreeMap "bright", 119 layers,
 * real OpenStreetMap label density — from a cache OUTSIDE the repository (the data is ODbL: never committed, never
 * in CI; the network is still never touched by a test — a tile that is not in the cache is an empty tile).
 *
 *   bash scripts/fetch-real-basemap.sh      # once: ~40 requests, ~9 MB into ~/.cache/geowright/openfreemap
 *   GEOWRIGHT_REAL_BASEMAP=1 npx playwright test tests/wild/real-basemap.spec.ts
 */
const DIR = process.env.GEOWRIGHT_REAL_BASEMAP_DIR ?? join(homedir(), '.cache/geowright/openfreemap');
const enabled = !!process.env.GEOWRIGHT_REAL_BASEMAP;
const cached = existsSync(join(DIR, 'style.json'));

const CORS = { 'access-control-allow-origin': '*' };
const file = (rel: string, contentType: string) => async (route: Route) => {
  const body = await readFile(join(DIR, rel)).catch(() => null);
  return body ? route.fulfill({ status: 200, headers: CORS, contentType, body }) : route.fulfill({ status: 204, headers: CORS, body: '' });
};

function realRoutes(): Routes {
  const meta = JSON.parse(readFileSync(join(DIR, 'meta.json'), 'utf8')) as { tileTemplate: string };
  const prefix = meta.tileTemplate.split('{z}')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ['https://tiles.openfreemap.org/styles/bright', file('style.json', 'application/json')],
    ['https://tiles.openfreemap.org/planet', file('planet.json', 'application/json')],
    [new RegExp(`^${prefix}\\d+/\\d+/\\d+\\.pbf`), (route) => file(`tiles/${new URL(route.request().url()).pathname.split('/').slice(-3).join('/')}`, 'application/x-protobuf')(route)],
    [/^https:\/\/tiles\.openfreemap\.org\/sprites\/.*@2x\.json/, file('sprite@2x.json', 'application/json')],
    [/^https:\/\/tiles\.openfreemap\.org\/sprites\/.*@2x\.png/, file('sprite@2x.png', 'image/png')],
    [/^https:\/\/tiles\.openfreemap\.org\/sprites\/.*\.json/, file('sprite.json', 'application/json')],
    [/^https:\/\/tiles\.openfreemap\.org\/sprites\/.*\.png/, file('sprite.png', 'image/png')],
    [/^https:\/\/tiles\.openfreemap\.org\/fonts\//, (route) => {
      const [font, range] = decodeURIComponent(new URL(route.request().url()).pathname).split('/').slice(-2);
      return file(`fonts/${font.split(',')[0]}/${range}`, 'application/x-protobuf')(route);
    }],
    [/^https:\/\/tiles\.openfreemap\.org\/natural_earth\//, (route) => route.fulfill({ status: 204, headers: CORS, body: '' })],
  ];
}

test.describe('wild: REAL basemap (opt-in, cached outside the repo)', () => {
  test.skip(!enabled, 'set GEOWRIGHT_REAL_BASEMAP=1 (after scripts/fetch-real-basemap.sh)');
  test.skip(enabled && !cached, `no cache in ${DIR}: run scripts/fetch-real-basemap.sh first`);
  test.slow();

  test('the real style: 100+ layers, dozens of label layers, real label density', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes: realRoutes(), options: { timeout: 30_000 } });
    const layers = await map.layers();
    expect(layers.length).toBeGreaterThanOrEqual(100);
    const labels = await map.features({ layerType: 'symbol' }).count();
    console.log(`REAL BASEMAP: ${layers.length} layers, ${layers.filter((l) => l.type === 'symbol').length} symbol layers, ${labels} labels in view, ${await map.features({ layer: '3d-buildings' }).count()} buildings`);
    expect(labels).toBeGreaterThan(20);
  });

  test('label density per zoom, measured exactly as basemap-density.spec.ts measures the synthetic one (printed)', async ({ wild, page }) => {
    await wild.open(example('display-buildings-in-3d'), { routes: realRoutes(), options: { timeout: 30_000 } });
    const d = await measureLabelDensity(page, { center: [-74.0066, 40.7135], zooms: DENSITY_ZOOMS });
    console.log(formatDensity('REAL BASEMAP', d));
    expect(d.every((r) => r.symbols > 0)).toBe(true);
  });

  test('real buildings under real labels: every click lands on the asked building, or is refused with the reason', async ({ wild, page }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes: realRoutes(), options: { timeout: 30_000 } });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.on('click', (e: any) => ((window as any).__top = m.queryRenderedFeatures(e.point).map((f: any) => `${f.layer.id}#${f.id}`)[0]));
    });
    const buildings = (await map.features({ layer: '3d-buildings' }).all()).filter((b) => b.id !== undefined).slice(0, 25);
    const tally: Record<string, number> = {};
    for (const b of buildings) {
      const r = await map._call<{ ok: boolean; why?: string; reason?: string; message?: string }>('actionPoint', { layer: '3d-buildings', id: b.id }, {});
      const under = r.ok ? /under another feature \(([\w-]+?)(#|\))/.exec(r.why ?? '')?.[1] : undefined;
      const key = r.ok ? (under ? `ok, after skipping pixels under "${under}"` : 'ok, first candidate') : `${r.reason}`;
      tally[key] = (tally[key] ?? 0) + 1;
      if (!r.ok) {
        expect(`${r.reason}: ${r.message}`).toMatch(/^(occluded|offscreen|ambiguous): /); // never an unexplained 'not-found'
        continue;
      }
      await map.feature({ layer: '3d-buildings', id: b.id }).click();
      expect(await page.evaluate(() => (window as any).__top)).toBe(`3d-buildings#${b.id}`);
    }
    console.log('REAL BASEMAP tally', JSON.stringify(tally));
  });

  test('snapshot on the real 119-layer style stays inside its budget and keeps the app layer rows', async ({ wild }) => {
    const map = await wild.open(example('display-buildings-in-3d'), { routes: realRoutes(), options: { timeout: 30_000 } });
    const snap = await map.snapshot();
    expect(snap.length).toBeLessThanOrEqual(8000);
    expect(snap).toMatch(/\[3d-buildings\] \d+ fill-extrusion entities/);
    // … and its ROWS (0 of 1,025 were listed while every basemap layer kept its section)
    expect(snap.match(/^  (#\S+|-) (Multi)?Polygon @\(\d+,\d+\).* render_height=/gm)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(snap).not.toContain('cut to fit');
  });
});
