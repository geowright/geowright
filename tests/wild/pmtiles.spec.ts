import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Routes } from './harness';

// Protomaps' MapLibre PMTiles example is unchanged apart from map registration.
// The app's ODbL Firenze URL receives a tiny first-party synthetic PMTiles v3 archive.
const local = (name: string) => fileURLToPath(new URL(`../../wild/apps/pmtiles/dist/vendor/${name}`, import.meta.url));
const archivePath = fileURLToPath(new URL('../../wild/fixtures/pmtiles/synthetic-firenze.pmtiles', import.meta.url));
const archiveURL = 'https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles';

test('wild: PMTiles protocol serves a synthetic archive through byte-range reads and a building is clickable', async ({ wild }) => {
  const archive = await readFile(archivePath);
  let rangeReads = 0;
  const routes: Routes = [
    ['https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.css', local('maplibre-gl.css')],
    ['https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.js', local('maplibre-gl.js')],
    ['https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js', local('pmtiles.js')],
    [archiveURL, (route) => {
      const wanted = route.request().headers()['range'];
      if (!wanted) return route.fulfill({ status: 200, contentType: 'application/vnd.pmtiles', headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' }, body: archive });
      const m = /^bytes=(\d+)-(\d*)$/.exec(wanted);
      if (!m) return route.fulfill({ status: 400, body: `unsupported range ${wanted}` });
      const start = Number(m[1]);
      const end = Math.min(m[2] ? Number(m[2]) : archive.length - 1, archive.length - 1);
      if (start >= archive.length) return route.fulfill({ status: 416, headers: { 'content-range': `bytes */${archive.length}`, 'access-control-allow-origin': '*' } });
      rangeReads++;
      return route.fulfill({ status: 206, contentType: 'application/vnd.pmtiles', headers: {
        'access-control-allow-origin': '*', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${archive.length}`,
      }, body: archive.subarray(start, end + 1) });
    }],
  ];

  const map = await wild.open('/apps/pmtiles/', { routes });
  expect(rangeReads).toBeGreaterThan(0);
  await expect(map).toHaveFeature({ layer: 'buildings', where: { name: 'Mercato Hall' } });
  await map.feature({ layer: 'buildings', where: { name: 'Mercato Hall' } }).click();
  expect(await map.snapshot()).toContain('Mercato Hall');
});
