import type { Page } from '@playwright/test';

/**
 * GEOWRIGHT_CPU_THROTTLE=N makes every page's JavaScript run N times slower (Chrome DevTools' CPU throttling): a slow
 * machine on demand, to MEASURE what the library does there without loading the real machine (this one is shared).
 * It slows the page's main thread, not the GPU process — software GL frames stay as fast as the machine makes them.
 * Unset (every normal run): nothing happens.
 */
export async function throttleFromEnv(page: Page): Promise<void> {
  const rate = Number(process.env.GEOWRIGHT_CPU_THROTTLE || 0);
  if (!(rate > 1)) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}
