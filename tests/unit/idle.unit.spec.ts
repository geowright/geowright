import { test, expect } from '@playwright/test';
import { DEAD_WORKER_AFTER_MS, deadWorkerDiagnosis, type PendingSource } from '../../src/inpage/maplibre-adapter';

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
