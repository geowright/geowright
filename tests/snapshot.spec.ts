import { test, expect } from './fixtures';

test.describe('map snapshot (agent layer)', () => {
  test('prints view, layers, entities with clickable client pixels, and what is off-screen', async ({ map, page }) => {
    const snap = await map.snapshot();
    console.log('\n' + snap + '\n');
    expect(snap).toContain('view: center 34.78,32.08 zoom 12');
    expect(snap).toMatch(/\[alerts\] 3 circle entities \(also drawn by: alerts-labels\)/);
    expect(snap).toMatch(/#1 Point @\(\d+,\d+\) id=1 name="Gas leak" severity="high"/);
    expect(snap).toContain('[source alerts] 1 feature(s) OUTSIDE the viewport (pan to see them): #4 to the east at 35.2,32.08');
    expect(snap).toMatch(/\[source stations\] \d+ feature\(s\) are inside the view but not drawn individually/);
    expect(snap).toMatch(/\[parcels\] 6 fill entities \(also drawn by: parcels-outline\)/);
    expect(snap).toMatch(/visible but empty in this view: .*td-polygon/);
    expect(snap).toContain('[source stations] 28 feature(s) are inside the view but not drawn individually');
    expect(snap).not.toContain('[alerts-labels]'); // labels are folded into their entity

    // the pixel in the snapshot is directly clickable with plain page.mouse — what an agent would do
    const [, x, y] = snap.match(/#1 Point @\((\d+),(\d+)\)/)!;
    await page.mouse.click(+x, +y);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
  });

  test('is bounded: per-layer cap with a summary of the remainder', async ({ map }) => {
    const snap = await map.snapshot({ perLayer: 2 });
    expect(snap).toMatch(/\[parcels\] 6 fill entities/);
    expect(snap).toMatch(/… 4 more not listed \(nearest to the view centre are listed\)\. Summary — .*zoning: /);
    expect(snap.split('\n').length).toBeLessThan(50);
  });
});
