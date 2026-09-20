// Playwright MCP --init-page hook: serve basemap tiles locally so the agent's browser needs no
// tile server (same idea as page.route in the tests).
import { makeTilePng } from '../tests/tile-png.ts';

const TILE = makeTilePng();
export default async ({ page }: { page: import('@playwright/test').Page }) => {
  await page.route('**/tiles/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
};
