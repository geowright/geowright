import { test, expect } from '@playwright/test';
import { allowForThrottle } from '../slow-machine';

// GEOWRIGHT_CPU_THROTTLE is read when the helper runs: each case sets it for the call and puts it back.
function throttled(rate: string | undefined, fn: () => void): void {
  const was = process.env.GEOWRIGHT_CPU_THROTTLE;
  const set = (v: string | undefined) => (v === undefined ? delete process.env.GEOWRIGHT_CPU_THROTTLE : (process.env.GEOWRIGHT_CPU_THROTTLE = v));
  set(rate);
  try {
    fn();
  } finally {
    set(was);
  }
}

test.describe('allowForThrottle: room in the test timeout for the waits the throttle scaled', () => {
  test('at 4x the test timeout grows by what the throttle added to the budgets it waits out, and by nothing more', () => {
    test.setTimeout(30_000);
    throttled('4', () => allowForThrottle(4 * 8000)); // four FAIL_FAST_MS at 4x: 32 s, of which 8 s is the normal run's
    expect(test.info().timeout).toBe(30_000 + 24_000);
  });

  test('a normal run: the test timeout stays what it was', () => {
    test.setTimeout(30_000);
    throttled(undefined, () => allowForThrottle(8000));
    throttled('1', () => allowForThrottle(8000));
    expect(test.info().timeout).toBe(30_000);
  });

  test('no timeout (debugging) stays no timeout', () => {
    test.setTimeout(0);
    throttled('4', () => allowForThrottle(8000));
    expect(test.info().timeout).toBe(0);
  });
});
