import { test, expect, guardNetwork } from './fixtures';

/**
 * No network in tests (decision 0009): a request off the machine fails the test and names the URL. The guard is in the
 * `page` fixture, so a spec that never asks for `map` (dense, draw2, moving, two-maps, timeouts…) has it too.
 */
test.describe('network guard', () => {
  test('a spec that uses only `page` fails when the page fetches anything off the machine', async ({ page }) => {
    // The failure comes from the fixture, after the body: "external network requests are not allowed in tests:
    // https://example.invalid/x". Without the guard in `page`, this test passes — and test.fail() reports that.
    test.fail();
    await page.goto('/dense.html');
    expect(await page.evaluate(() => fetch('https://example.invalid/x').then(() => 'answered', () => 'failed'))).toBe('failed');
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
