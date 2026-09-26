import { DEMOTILES, example, expect, test } from './harness';

/**
 * Measurement for the waitForIdle timeout of animate-point.spec — NOT part of the suite: runs only with GEOWRIGHT_MEASURE=1.
 * Five workers on purpose: the suite runs five on this Mac, and several animate-a-point pages animate at once there.
 *   uptime && GEOWRIGHT_MEASURE=1 npx playwright test tests/wild/idle-measure.spec.ts --workers=5 --repeat-each=5
 * waitForIdle() abandons its round trip at the deadline, and the in-page wait takes half the time left (at most 2 s). On a
 * page that replaces its data every frame, the answer comes back LATE: measured here is how late (round trip minus the
 * in-page wait). A timeout T leaves T - min(T/2, 2000) ms for it; if the first answer is later, the spec gets "the page did
 * not answer" instead of the diagnosis it asserts.
 */
const TRIALS = 8;
const WAIT_MS = 1250;

test.describe('measure: how late a never-idle page answers waitForIdle', () => {
  test.skip(!process.env.GEOWRIGHT_MEASURE, 'set GEOWRIGHT_MEASURE=1');
  test.setTimeout(120_000);

  test('animate-a-point', async ({ wild }) => {
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'point' });
    const late: number[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const t0 = Date.now();
      expect(await map._call<boolean>('waitForIdle', WAIT_MS)).toBe(false);
      late.push(Date.now() - t0 - WAIT_MS);
    }
    const line = `late by (ms): ${late.join(' ')}`;
    console.log(`MEASURE ${line}`);
    test.info().annotations.push({ type: 'measure', description: line });
  });
});
