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
