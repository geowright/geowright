import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * A map CONTAINER that moves on the page while the camera stands still (a CSS transition, a sliding panel, a collapsing
 * sidebar). The camera is at rest and the feature's pixel on the canvas is the same two frames running, but its position
 * in the PAGE moves, so an action that presses a page pixel computed a moment earlier lands off target. README item 2
 * promises the target pixel is stable: a location action waits until the map holds still on the page, or fails; it never
 * reports success for an input that landed elsewhere (review findings A-14, I-11).
 *
 * The app's own click/mousemove handler records where MapLibre got the input (e.point) and where the asked location IS at
 * that instant (map.project): their distance is the error.
 */

const at = { lng: 34.83, lat: 32.1 }; // right half of the demo map: stays clear of the sidebar while #map slides left

const slide = (page: Page, px: number, ms: number) =>
  page.evaluate(
    ([px, ms]) => {
      const el = document.querySelector('#map') as HTMLElement;
      el.style.transition = `transform ${ms}ms linear`;
      void el.getBoundingClientRect(); // commit the start state
      el.style.transform = `translateX(${px}px)`;
      // return once the slide is under way (two frames into it), as when the test acts right after the app started it
      return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    },
    [px, ms] as const,
  );

const watchClicks = (page: Page) =>
  page.evaluate((at) => {
    const w = window as any;
    const m = w.__geowright_maps.main;
    w.__clicks = [];
    m.on('click', (e: any) => {
      const want = m.project([at.lng, at.lat]);
      w.__clicks.push(Math.round(Math.hypot(e.point.x - want.x, e.point.y - want.y)));
    });
  }, at);

test.describe('a map container that moves on the page', () => {
  test('clickAt waits for the slide to finish and lands on the asked location', async ({ map, page }) => {
    await watchClicks(page);
    await slide(page, -300, 900);
    await map.clickAt(at, { timeout: 8000 });
    const clicks: number[] = await page.evaluate(() => (window as any).__clicks);
    expect(clicks, 'one click, at most 2 px from the asked location').toHaveLength(1);
    expect(clicks[0]).toBeLessThanOrEqual(2);
  });

  test('clickAt fails instead of landing off target when the container never holds still', async ({ map, page }) => {
    await watchClicks(page);
    // a one-way slide that lasts longer than the action's timeout: the container is never still on the page (0.17 px/ms)
    await slide(page, -500, 3000);
    const error = await map.clickAt(at, { timeout: 1500 }).then(() => null, (e: Error) => e.message);
    expect(error, 'clickAt must fail, not click a pixel the map is about to leave').toMatch(/moving on the page/);
    expect(await page.evaluate(() => (window as any).__clicks)).toHaveLength(0);
  });

  test('hoverAt waits for the slide to finish and arrives at the asked location', async ({ map, page }) => {
    await page.evaluate((at) => {
      const w = window as any;
      const m = w.__geowright_maps.main;
      w.__moves = [];
      m.on('mousemove', (e: any) => {
        const want = m.project([at.lng, at.lat]);
        w.__moves.push(Math.round(Math.hypot(e.point.x - want.x, e.point.y - want.y)));
      });
    }, at);
    await slide(page, -300, 900);
    await map.hoverAt(at, { timeout: 8000 });
    const moves: number[] = await page.evaluate(() => (window as any).__moves);
    expect(moves.at(-1)).toBeLessThanOrEqual(2);
  });

  test('clickAt while the sidebar collapses and the map container grows lands on the asked location', async ({ map, page }) => {
    await watchClicks(page);
    await page.evaluate(() => {
      const el = document.getElementById('map')!;
      document.getElementById('sidebar')!.style.display = 'none';
      el.style.transition = 'left 900ms linear';
      void el.getBoundingClientRect();
      el.style.left = '0px';
      return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    });
    await map.clickAt(at, { timeout: 8000 });
    const clicks: number[] = await page.evaluate(() => (window as any).__clicks);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toBeLessThanOrEqual(1);
  });

  test('control: a map that does not move is clicked at once', async ({ map, page }) => {
    await watchClicks(page);
    const started = Date.now();
    await map.clickAt(at);
    expect(Date.now() - started, 'no extra wait on a still map').toBeLessThan(3000);
    expect(await page.evaluate(() => (window as any).__clicks)).toHaveLength(1);
  });
});
