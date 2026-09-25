import { expect, test, WILD_ORIGIN } from './harness';

// The wild harness lets only the wild server through: its exact origin, not every URL that starts with it.
test('wild harness: a look-alike origin (:41740 for :4174) is aborted and reported, the wild server is not', async ({ wild }) => {
  await wild.page.goto(`${WILD_ORIGIN}/`);
  const lookAlike = `${WILD_ORIGIN}0/x`;
  const outcomes = await wild.page.evaluate((urls) => Promise.all(urls.map((u) => fetch(u).then((r) => r.status, () => 'failed'))), [lookAlike, '/']);
  expect(outcomes).toEqual(['failed', 200]);
  expect(wild.unrouted).toEqual([lookAlike]);
  wild.unrouted.length = 0; // asserted above: not a failure of this test
});

// ...and it guards the context, WebSockets included (Playwright's routes do not see them; routeWebSocket does).
test('wild harness: a WebSocket to anywhere but the wild server is closed and reported', async ({ wild }) => {
  await wild.page.goto(`${WILD_ORIGIN}/`);
  // nothing listens on the discard port of 127.0.0.1: no traffic leaves the machine even without the guard
  const outcome = await wild.page.evaluate(() => new Promise<string>((r) => (new WebSocket('ws://127.0.0.1:9/x').onclose = (e) => r(`closed ${e.code}`))));
  expect(outcome, 'the page opened a socket and saw it close').toMatch(/^closed \d+$/);
  expect(wild.unrouted).toEqual(['ws://127.0.0.1:9/x']);
  wild.unrouted.length = 0; // asserted above: not a failure of this test
});
