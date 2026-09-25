import { test, expect, guardNetwork, pageGuards } from './fixtures';

/**
 * No network in tests (decision 0021): a request off the machine fails the test and names the URL. The guard is in the
 * `page` fixture, so a spec that never asks for `map` (dense, draw2, moving, two-maps, timeouts…) has it too.
 */
test.describe('network guard', () => {
  test('a spec that uses only `page` fails when the page fetches anything off the machine', async ({ page }) => {
    await page.goto('/dense.html');
    expect(await page.evaluate(() => fetch('https://example.invalid/x').then(() => 'answered', () => 'failed'))).toBe('failed');
    // The fixture's own guard recorded it, and its check() (run by the fixture after the body) fails with this message.
    const guard = pageGuards.get(page);
    expect(guard, 'the `page` fixture guards the page').toBeDefined();
    expect(() => guard!.check()).toThrow('external network requests are not allowed in tests:\nhttps://example.invalid/x');
    guard!.external.length = 0; // asserted above: not a failure of this test
  });

  test('a WebSocket to anywhere but the preview origin is blocked and named', async ({ page, baseURL }) => {
    await page.goto('/dense.html');
    const guard = await guardNetwork(page, baseURL!); // a second guard, as below: it sees the socket first
    // No traffic leaves the machine even without the guard: the discard port of 127.0.0.1, where nothing listens.
    const outcome = await page.evaluate(
      () =>
        new Promise<string>((r) => {
          const ws = new WebSocket('ws://127.0.0.1:9/x');
          ws.onclose = (e) => r(`closed ${e.code}`);
        }),
    );
    expect(outcome, 'the page opened a socket and saw it close').toMatch(/^closed \d+$/);
    expect(guard.external).toEqual(['ws://127.0.0.1:9/x']);
    expect(() => guard.check()).toThrow('external network requests are not allowed in tests:\nws://127.0.0.1:9/x');
    guard.external.length = 0; // asserted above; nothing reached the fixture's guard
  });

  test('service workers are blocked, so no request can bypass the guard through one', async ({ page }) => {
    // Playwright's routes never see a request a service worker answers; playwright.config.ts sets serviceWorkers: 'block'.
    // Any script of the preview server will do: with serviceWorkers: 'allow', registering this one succeeds (checked).
    await page.goto('/dense.html');
    const registrations = await page.evaluate(async () => {
      await navigator.serviceWorker.register('/maplibre/maplibre-gl-worker.mjs', { type: 'module' }); // 'block': a no-op
      return (await navigator.serviceWorker.getRegistrations()).length;
    });
    expect(registrations, 'service workers registered').toBe(0);
  });

  test('the guard names every URL it aborted, lets the preview server through, and matches its origin exactly', async ({ page, baseURL }) => {
    await page.goto('/dense.html');
    // A second guard, registered last, runs first: it sees (and aborts) the requests; the fixture's own stays clean.
    const guard = await guardNetwork(page, baseURL!);
    const lookAlike = `${baseURL}0/x`; // http://localhost:46730 is not http://localhost:4673
    const outcomes = await page.evaluate(
      (urls) => Promise.all(urls.map((u) => fetch(u).then((r) => r.status, () => 'failed'))),
      ['https://example.invalid/x', lookAlike, '/dense.html'],
    );
    expect(outcomes).toEqual(['failed', 'failed', 200]);
    expect(guard.external).toEqual(['https://example.invalid/x', lookAlike]);
    expect(() => guard.check()).toThrow(`external network requests are not allowed in tests:\nhttps://example.invalid/x\n${lookAlike}`);
    guard.external.length = 0; // asserted above; nothing reached the fixture's guard
  });
});
