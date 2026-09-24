import { expect, test, WILD_ORIGIN } from './harness';

// The wild harness lets only the wild server through: its exact origin, not every URL that starts with it (G7 of an earlier issue).
test('wild harness: a look-alike origin (:41740 for :4174) is aborted and reported, the wild server is not', async ({ wild }) => {
  await wild.page.goto(`${WILD_ORIGIN}/`);
  const lookAlike = `${WILD_ORIGIN}0/x`;
  const outcomes = await wild.page.evaluate((urls) => Promise.all(urls.map((u) => fetch(u).then((r) => r.status, () => 'failed'))), [lookAlike, '/']);
  expect(outcomes).toEqual(['failed', 200]);
  expect(wild.unrouted).toEqual([lookAlike]);
  wild.unrouted.length = 0; // asserted above: not a failure of this test
});
