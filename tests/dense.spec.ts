import { test as base, expect } from './fixtures';
import { geowright, type MapHandle } from '../src/playwright';
import type { EntityView } from '../src/inpage/types';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * Dense map: ~5,000 point assets (70% of them piled into 12 hot spots) and ~1,000 overlapping lots,
 * no clustering. 3,240 assets + 415 lots are in the default view. Deterministic (seeded) fixture.
 */
const test = base.extend<{ dense: MapHandle }>({
  dense: async ({ page }, use) => {
    await page.goto('/dense.html');
    const map = geowright(page);
    await map.waitForIdle();
    await use(map);
  },
});

test.describe('dense map', () => {
  test('assertions and where-queries over thousands of features', async ({ dense }) => {
    await expect(dense.features({ layer: 'assets' })).toHaveFeatureCount(3240);
    await expect(dense.features({ layer: 'lots' })).toHaveFeatureCount(415);
    await expect(dense.features({ layer: 'assets', where: { status: 'fault', kind: 'pump' } })).toHaveFeatureCount(20);
    await expect(dense).toHaveFeature({ layer: 'assets', where: { serial: /^SN-9287/ } });
    await expect(dense).not.toHaveFeature({ layer: 'assets', where: { kind: 'turbine' } });
  });

  test('exact selection among look-alikes: click lands on the asked feature or fails naming the occluder', async ({ dense, page }) => {
    const ents = await dense._call<EntityView[]>('entities', { layers: ['assets'], max: 400 });
    const centre = new Map((await dense.features({ layer: 'assets' }).all()).map((f) => [f.id, f.pixel!]));
    const clean = ents.filter((e) => e.pixel);
    // Rescued by the ring candidates: the centre pixel belongs to a neighbour, a crescent is still clickable.
    const offCentre = clean.filter((e) => Math.hypot(e.pixel!.x - centre.get(e.id)!.x, e.pixel!.y - centre.get(e.id)!.y) > 2);
    expect(offCentre.length).toBeGreaterThan(5);
    for (const e of [...clean.slice(0, 3), ...offCentre.slice(0, 3)]) {
      await dense.feature({ layer: 'assets', id: e.id }).click();
      await expect(page.getByTestId('selected')).toHaveText(`assets:${e.id}`);
    }
    const buried = ents.find((e) => e.located && !e.pixel && e.blocked?.startsWith('covered-by:assets'))!;
    const err = await dense.feature({ layer: 'assets', id: buried.id }).click({ timeout: FAIL_FAST_MS }).then(() => null, (x: Error) => x);
    expect(err?.message).toMatch(/occluded: every candidate point is covered by another feature; topmost is assets#\d+/);
  });

  test('polygons under a pile of points: an interior pixel that is really theirs, or a clear refusal', async ({ dense, page }) => {
    const ents = await dense._call<EntityView[]>('entities', { layers: ['lots'], max: 40 });
    const clean = ents.filter((x) => x.pixel);
    expect(clean.length, 'lots with a clean pixel: without them this test would pass having clicked nothing').toBeGreaterThanOrEqual(4);
    for (const e of clean.slice(0, 4)) {
      await dense.feature({ layer: 'lots', id: e.id }).click();
      await expect(page.getByTestId('selected')).toHaveText(`lots:${e.id}`);
    }
  });

  test('snapshot holds a character budget and can be filtered down to one look-alike', async ({ dense, page }) => {
    const full = await dense.snapshot();
    expect(full.length).toBeLessThanOrEqual(8000);
    expect(full).toMatch(/\[assets\] 3240 circle entities/);
    expect(full).toMatch(/… 3225 more not listed \(nearest to the view centre are listed\)\. Summary of all \d+ — .*kind: hydrant×\d+, .*status: ok×\d+, warn×\d+, fault×75/);
    expect(full).toContain("snapshot('<mapId>', { filter: { layer: 'assets'");

    const tight = await dense.snapshot({ maxChars: 1500 });
    expect(tight.length).toBeLessThanOrEqual(1500);
    expect(tight).toMatch(/\[assets\] 3240 circle entities/); // counts and histograms survive, rows are what shrinks
    expect(tight).toMatch(/Summary of all \d+ — .*kind: /);

    const one = await dense.snapshot({ filter: { layer: 'assets', where: { serial: 'SN-92872' } } });
    expect(one).toMatch(/\[assets\] 1 circle entity/);
    const [, id, x, y] = one.match(/#(\d+) Point @\((\d+),(\d+)\) drawn \w+\(#\w+\) id=/)!;
    await page.mouse.click(+x, +y);
    await expect(page.getByTestId('selected')).toHaveText(`assets:${id}`);
  });

  test('mirror stays bounded: 80 buttons, the rest counted', async ({ page }) => {
    await page.goto('/dense.html');
    const map = geowright(page, { mirror: { max: 80 } });
    await map.waitForIdle();
    const group = page.getByRole('group', { name: /^Map main - 365\d features in view/ });
    await expect(group.getByRole('button')).toHaveCount(80);
    await expect(group.getByRole('note')).toContainText(/357\d more map features are not individually listed/);
  });

  test('measurements (printed, not asserted: wall-clock limits are flakes waiting to happen)', async ({ dense, page }) => {
    // Asserts nothing, so it runs only when asked for, like tests/measure.spec.ts: it cost ~10 s of every suite and 20x.
    test.skip(!process.env.GEOWRIGHT_MEASURE, 'set GEOWRIGHT_MEASURE=1');
    // The UNCAPPED entity list below is the deliberately expensive path: every entity without a clean pixel tries up to
    // 40 of them (1,436 such entities here) — ~10 s on the development Mac, 43 s at a 4x slower CPU
    // (GEOWRIGHT_CPU_THROTTLE=4). What users get is capped (mirror: 80, snapshot: per layer): 0.1–0.5 s even at 4x.
    test.slow();
    await dense.viewState();
    const r = await page.evaluate(async () => {
      const g = (window as any).__geowright;
      const t = async (fn: () => any) => {
        const t0 = performance.now();
        const v = await fn();
        return { ms: Math.round(performance.now() - t0), v };
      };
      const findAssets = await t(() => g.find('main', { layer: 'assets' }).length);
      const findLots = await t(() => g.find('main', { layer: 'lots' }).length);
      const findWhere = await t(() => g.find('main', { layer: 'assets', where: { status: 'fault', kind: 'pump' } }).length);
      const actionPoint = await t(() => g.actionPoint('main', { layer: 'assets', id: 11037 }, {}).then((x: any) => x.ok));
      const snapshot = await t(() => g.snapshot('main', {}).then((s: string) => s.length));
      const entities80 = await t(() => g.entities('main', { max: 80 }).length);
      const entitiesAll = await t(() => g.entities('main', {}).filter((e: any) => !e.pixel).length);
      return { findAssets, findLots, findWhere, actionPoint, snapshot, entities80, entitiesAll_blocked: entitiesAll };
    });
    console.log('DENSE ' + JSON.stringify(r));
  });
});
