import type { Page } from '@playwright/test';

/**
 * GEOWRIGHT_CPU_THROTTLE=N makes every page's JavaScript run N times slower (Chrome DevTools' CPU throttling): a slow
 * machine on demand, to MEASURE what the library does there without loading the real machine (this one is shared).
 * It slows the page's main thread, not the GPU process — software GL frames stay as fast as the machine makes them.
 * Unset (every normal run): nothing happens.
 */
export async function throttleFromEnv(page: Page): Promise<void> {
  const rate = cpuSlowdown();
  if (rate === 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/** How many times slower the page's JavaScript runs in this run: 1 unless GEOWRIGHT_CPU_THROTTLE is above 1. A spec that
 * bounds how long in-page work may take scales the bound by it, so the measurement run does not fail on its own slowness. */
export function cpuSlowdown(): number {
  const rate = Number(process.env.GEOWRIGHT_CPU_THROTTLE || 0);
  return rate > 1 ? rate : 1;
}

/**
 * The timeout for an action a spec EXPECTS to fail, when it asserts WHY it failed. An action's timeout is wall-clock:
 * if the page cannot answer the first round trip in time, the action honestly reports "the page did not answer" and
 * never reaches the reason the spec asserts. Sub-second budgets did exactly that in a 20x run (5 workers, load ~27:
 * a globe page answered a first clientPoint in more than 800 ms). Two seconds leaves over 2x that; slower still under
 * GEOWRIGHT_CPU_THROTTLE.
 */
export const FAIL_FAST_MS = 2000 * cpuSlowdown();

/**
 * The same, for an action that probes a pixel-only layer above its target (decision 0022): its look renders four times per
 * probe, up to three probes per aim, and must still be answered in time. Measured (tests/action-probe-measure.spec.ts, one
 * worker, this shared Mac at load ~18): an opaque veil's refused look took 419 ms median, 631 ms at most; at 4x CPU
 * throttling 558 / 879 ms (the renders are the GPU process's: the throttle barely moves them, load does). A CI run at
 * load 37–75 went past FAIL_FAST_MS. Twice it leaves about six times the largest look measured.
 */
export const PROBE_FAIL_FAST_MS = 2 * FAIL_FAST_MS;
