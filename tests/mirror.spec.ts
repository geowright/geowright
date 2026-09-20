import { test, expect } from './fixtures';

/**
 * Accessibility mirror (agent mode, opt-in): map features become real, invisible buttons inside
 * MapLibre's canvas container. Ordinary Playwright locators — and therefore Playwright MCP's
 * ordinary snapshot + click — work on map features, with real input and no custom tooling.
 */
test.describe('accessibility mirror', () => {
  test.beforeEach(async ({ map }) => {
    await map._call('mirror');
  });

  test('plain getByRole locators see and click map features', async ({ page }) => {
    const group = page.getByRole('group', { name: /^Map main - 41 features in view/ });
    await expect(group).toBeVisible();
    await expect(group.getByRole('button')).toHaveCount(41);

    await page.getByRole('button', { name: /Gas leak/ }).click(); // a REAL click; bubbles to the map
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');

    await page.getByRole('button', { name: /owner=Talbrook Logistics/ }).click(); // concave parcel
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '105');
  });

  test('aria snapshot contains the map', async ({ page }) => {
    await expect(page.locator('[data-mapwright-mirror="main"]')).toMatchAriaSnapshot(`
      - group /Map main - 41 features in view, center 34\\.7800,32\\.0800 zoom 12\\.0/:
        - button /alerts 1 \\(Point\\) id=1, name=Gas leak, severity=high/
    `);
  });

  test('follows the map: nodes keep identity across re-renders, new features appear, positions move', async ({ map, page }) => {
    const gas = page.getByRole('button', { name: /Gas leak/ });
    const handle = await gas.elementHandle();
    const before = (await gas.boundingBox())!;

    await page.getByTestId('alert-name').fill('Mirror me');
    await page.getByTestId('alert-lng').fill('34.83');
    await page.getByTestId('alert-lat').fill('32.05');
    await page.getByTestId('alert-submit').click();
    await expect(page.getByRole('button', { name: /Mirror me/ })).toBeVisible();

    await map.dragAt({ lng: 34.83, lat: 32.12 }, { lng: 34.8, lat: 32.1 }); // pan with real input
    await map.waitForIdle();
    await expect.poll(async () => (await gas.boundingBox())!.x).not.toBe(before.x);
    expect(await gas.evaluate((el, h) => el === h, handle)).toBe(true); // same DOM node => agent refs stay valid
    await gas.click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
  });
});
