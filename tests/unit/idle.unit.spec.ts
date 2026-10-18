import { test, expect, type Page } from '@playwright/test';
import { DEAD_WORKER_AFTER_MS, deadWorkerDiagnosis, type PendingSource } from '../../src/inpage/maplibre-adapter';
import { MapHandle } from '../../src/playwright/index';

const inline = (id: string, forMs: number): PendingSource => ({ id, type: 'geojson', inline: true, forMs });

test.describe('waitForIdle diagnosis: a dead web worker', () => {
  test('inline GeoJSON pending for seconds and no worker-backed source loaded: says DEAD WORKER, names the sources', () => {
    const why = deadWorkerDiagnosis([inline('lots', 7200), inline('assets', 7100)], 0);
    expect(why).toContain('source(s) lots, assets hold inline GeoJSON');
    expect(why).toContain('have not loaded for 7s');
    expect(why).toContain('DEAD WORKER');
    expect(why).toContain("optimizeDeps: { exclude: ['maplibre-gl'] }");
  });

  test('one loaded GeoJSON or vector source proves the workers run: no accusation', () => {
    expect(deadWorkerDiagnosis([inline('lots', 60_000)], 1)).toBeUndefined();
  });

  test('not yet: under the threshold a slow parse is still plausible', () => {
    expect(deadWorkerDiagnosis([inline('lots', DEAD_WORKER_AFTER_MS - 1)], 0)).toBeUndefined();
  });

  test('GeoJSON from a URL, and tiled sources, may be waiting for the network: not this diagnosis', () => {
    expect(deadWorkerDiagnosis([{ id: 'places', type: 'geojson', inline: false, forMs: 60_000 }], 0)).toBeUndefined();
    expect(deadWorkerDiagnosis([{ id: 'basemap', type: 'vector', inline: false, forMs: 60_000 }], 0)).toBeUndefined();
  });
});

test.describe('waitForIdle failure: the verdict "never idle" is not replaced by a shorter look that saw less', () => {
  // A scripted page that never becomes idle. Each look's diagnosis is the next in `looks`; the last one repeats.
  const page = (looks: { why?: string; never: boolean }[]) =>
    ({
      evaluate: async (_fn: unknown, [method, , args]: [string, string, unknown[]]) => {
        if (method === 'waitForIdle') {
          await new Promise((r) => setTimeout(r, Math.min(args[0] as number, 300)));
          return { missing: false, value: false };
        }
        return { missing: false, value: looks.length > 1 ? looks.shift() : looks[0] };
      },
    }) as unknown as Page;
  const LOOP = 'the app keeps replacing the data of source(s) point (14 times in 2000ms) — setData in a requestAnimationFrame loop or a timer. Such a map NEVER becomes idle';

  test('the error names the setData loop a longer look saw, not the last short look\'s frame count', async () => {
    const map = new MapHandle(page([{ why: LOOP, never: true }, { why: 'the map rendered 1 frames in 120ms (8.3 per second) with the camera at rest and no source loading', never: false }]));
    await expect(map.waitForIdle({ timeout: 1500 })).rejects.toThrow(`did not become idle (still moving, loading tiles, or repainting) — ${LOOP}`);
  });

  test('without such a verdict the last diagnosis is reported, as before', async () => {
    const map = new MapHandle(page([{ why: 'tiles of source(s) a are still loading', never: false }, { why: 'source(s) b have not finished loading', never: false }]));
    await expect(map.waitForIdle({ timeout: 1500 })).rejects.toThrow('did not become idle (still moving, loading tiles, or repainting) — source(s) b have not finished loading');
  });
});
