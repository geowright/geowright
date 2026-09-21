import { test as base, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeTilePng } from '../tile-png';
import { throttleFromEnv } from '../slow-machine';
import { geowright, type GeowrightOptions, type MapHandle } from '../../src/playwright';

export { expect } from '../../src/playwright';

/**
 * Harness for the "wild apps" suite: apps we did NOT write (wild/), served untouched by
 * wild/serve.mjs. The only thing a test controls is the NETWORK: everything the app fetches from
 * outside is fulfilled from fixtures in this repo, and anything not covered aborts and FAILS the
 * test, listing the URLs — which is also how you find out what a newly vendored app needs.
 */
// Same arithmetic as playwright.config.ts (not imported: a config module should not be evaluated twice).
const WILD_PORT = Number(process.env.GEOWRIGHT_WILD_PORT ?? Number(process.env.GEOWRIGHT_PORT ?? 4173) + 1);
export const WILD_ORIGIN = `http://localhost:${WILD_PORT}`;
const FIXTURES = fileURLToPath(new URL('../../wild/fixtures/', import.meta.url));
const GLYPHS = fileURLToPath(new URL('../../demo/public/glyphs/Noto Sans Regular/0-255.pbf', import.meta.url));
const TILE = makeTilePng();

const TYPES: Record<string, string> = {
  json: 'application/json', geojson: 'application/json', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
  pbf: 'application/x-protobuf', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif',
};

/** What to answer for a URL: a file under wild/fixtures (or an absolute path), a JSON value, or a route handler. */
export type Fulfil = string | { json: unknown } | { body: Buffer | string; contentType: string } | ((route: Route) => unknown);
export type Routes = [url: string | RegExp, fulfil: Fulfil][];

export interface Wild {
  /**
   * Open a wild app. `routes` are tried in order; CORS is opened on every fulfilled response because
   * the apps fetch cross-origin (and MapLibre loads images with crossOrigin="anonymous").
   */
  open(path: string, o?: { routes?: Routes; mapId?: string; options?: GeowrightOptions; waitForIdle?: boolean }): Promise<MapHandle>;
  /** External URLs the app asked for that no route answered (they were aborted). */
  readonly unrouted: string[];
  readonly page: Page;
  /** Tolerate (still abort) requests matching these: for things an app fetches that the test does not need. */
  allowAbort(...patterns: RegExp[]): void;
}

const CORS = { 'access-control-allow-origin': '*' };

async function fulfil(route: Route, f: Fulfil): Promise<unknown> {
  if (typeof f === 'function') return f(route);
  if (typeof f === 'string') {
    const file = f.startsWith('/') ? f : FIXTURES + f;
    return route.fulfill({ status: 200, headers: CORS, contentType: TYPES[file.split('.').pop()!] ?? 'application/octet-stream', body: await readFile(file) });
  }
  if ('json' in f) return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(f.json) });
  return route.fulfill({ status: 200, headers: CORS, contentType: f.contentType, body: f.body });
}

/** Any glyph request, whatever the font stack: Noto Sans Regular 0-255 (OFL); other ranges are empty. */
export const glyphs = (pattern: string | RegExp): Routes[number] => [
  pattern,
  async (route) => {
    const latin = /\/0-255\.pbf/.test(route.request().url());
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-protobuf', body: latin ? await readFile(GLYPHS) : Buffer.alloc(0) });
  },
];

/** Any raster tile: the repo's generated grey PNG. */
export const rasterTiles = (pattern: string | RegExp): Routes[number] => [pattern, { body: TILE, contentType: 'image/png' }];

export const test = base.extend<{ wild: Wild }>({
  page: async ({ page }, use) => {
    await throttleFromEnv(page); // opt-in slow machine (tests/slow-machine.ts); nothing when unset
    await use(page);
  },
  wild: async ({ page }, use) => {
    const unrouted: string[] = [];
    const tolerated: RegExp[] = [];
    await page.route(/^https?:\/\//, (route) => {
      const url = route.request().url();
      if (url.startsWith(WILD_ORIGIN)) return route.fallback();
      if (!tolerated.some((t) => t.test(url))) unrouted.push(url);
      return route.abort();
    });
    const wild: Wild = {
      unrouted,
      page,
      allowAbort: (...patterns) => void tolerated.push(...patterns),
      async open(path, o = {}) {
        // Registered after the guard, so these win (Playwright runs the most recent route first);
        // reversed so that the FIRST entry of `routes` has the highest priority.
        for (const [url, f] of [...(o.routes ?? [])].reverse()) await page.route(url, (route) => fulfil(route, f));
        await page.goto(WILD_ORIGIN + path);
        const map = geowright(page, { mapId: o.mapId, ...o.options });
        if (o.waitForIdle !== false) await map.waitForIdle();
        return map;
      },
    };
    await use(wild);
    if (unrouted.length) throw new Error(`the app made external requests that no fixture answered (aborted):\n${[...new Set(unrouted)].join('\n')}`);
  },
});

/**
 * MapLibre's demo basemap (demotiles.maplibre.org), which most of their examples use — RECORDED, not
 * synthetic: BSD-3-Clause style + tiles built from Natural Earth (public domain); see
 * wild/fixtures/demotiles/. Only zoom 0–3 is committed (1.6 MB instead of 5 MB), so the TileJSON is
 * served with `maxzoom: 3` and MapLibre overzooms beyond that — the one liberty taken with it.
 */
export const DEMOTILES: Routes = [
  ['https://demotiles.maplibre.org/style.json', 'demotiles/style.json'],
  [
    'https://demotiles.maplibre.org/tiles/tiles.json',
    async (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ ...JSON.parse(await readFile(FIXTURES + 'demotiles/tiles/tiles.json', 'utf8')), maxzoom: 3 }) }),
  ],
  [
    /^https:\/\/demotiles\.maplibre\.org\/tiles\/\d+\/\d+\/\d+\.pbf/,
    async (route) => {
      const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.pbf/.exec(route.request().url())!;
      const body = await readFile(`${FIXTURES}demotiles/tiles/${z}/${x}/${y}.pbf`).catch(() => Buffer.alloc(0)); // no file = empty ocean tile
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-protobuf', body });
    },
  ],
  glyphs(/^https:\/\/demotiles\.maplibre\.org\/font\//),
];

/** Shorthand used by most specs. */
export const example = (name: string) => `/test/examples/${name}.html`;

export type { Page };
