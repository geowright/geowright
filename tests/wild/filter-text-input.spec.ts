import { brightBasemap } from './basemap';
import { example, expect, test } from './harness';

// MapLibre example "Filter symbols by text input": one symbol layer per icon TYPE (poi-theatre,
// poi-bar, poi-bicycle, poi-music), each with its own text label; a search box's `keyup` sets each
// layer's visibility to `visible` iff its layer id (e.g. "poi-music") CONTAINS the typed text.
const routes = brightBasemap([-77.04, 38.907], { icons: ['theatre_11', 'bar_11', 'bicycle_11', 'music_11'] });

test.describe('wild: filter-symbols-by-text-input', () => {
  test('every icon type is on the map before any input', async ({ wild }) => {
    const map = await wild.open(example('filter-symbols-by-text-input'), { routes });
    for (const icon of ['theatre', 'bar', 'bicycle', 'music']) {
      await expect(map).toHaveFeature({ layer: `poi-${icon}`, where: { icon } });
    }
  });

  test('typing a substring shows only the matching layer(s); clearing brings the rest back', async ({ wild, page }) => {
    const map = await wild.open(example('filter-symbols-by-text-input'), { routes });
    const input = page.getByPlaceholder('Filter by name');
    // The app listens for the DOM 'keyup' event specifically. locator.fill() sets the value and
    // fires 'input'/'change' but NOT keyboard events, so it never triggers this app's filter —
    // pressSequentially() sends real keystrokes (also closer to "only real input").
    await input.pressSequentially('bic');
    await expect(map).toHaveFeature({ layer: 'poi-bicycle' });
    await expect(map).not.toHaveFeature({ layer: 'poi-theatre' });
    await expect(map).not.toHaveFeature({ layer: 'poi-bar' });
    await expect(map).not.toHaveFeature({ layer: 'poi-music' });
    for (let i = 0; i < 'bic'.length; i++) await page.keyboard.press('Backspace'); // real keyup per press, back to ""
    await expect(map).toHaveFeature({ layer: 'poi-theatre' });
    await expect(map).toHaveFeature({ layer: 'poi-bar' });
    await expect(map).toHaveFeature({ layer: 'poi-music' });
  });

  test('the filter matches the LAYER ID ("poi-..."), so "poi" (a prefix of every layer id) matches all, and an unmatched word hides everything', async ({ wild, page }) => {
    const map = await wild.open(example('filter-symbols-by-text-input'), { routes });
    const input = page.getByPlaceholder('Filter by name');
    await input.pressSequentially('zzz');
    await expect(map).not.toHaveFeature({ layer: 'poi-theatre', visible: 'any' });
    await input.clear();
    await input.pressSequentially('poi');
    for (const icon of ['theatre', 'bar', 'bicycle', 'music']) await expect(map).toHaveFeature({ layer: `poi-${icon}` });
  });

  test(
    'the snapshot lists the 3 id-less, property-identical "music" symbols as 3 entities (was 1: fixed in the library)',
    async ({ wild }) => {
      // FIXED IN THE LIBRARY (an earlier phase): this test was written as `test.fixme` — id-less features with identical
      // properties used to collapse into ONE. The engine now splits same-key, id-less pieces by whether they touch on screen.
      const map = await wild.open(example('filter-symbols-by-text-input'), { routes });
      const snap = await map.snapshot({ layers: ['poi-music'] });
      expect(snap).toMatch(/\[poi-music\] 3 symbol entit/);
    },
  );
});
