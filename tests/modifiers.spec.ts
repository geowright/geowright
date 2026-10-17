import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ActionOptions.modifiers is documented as "keys held down during the action (real key events)" for click, dblclick,
 * rightClick, tap and hover, and SteadyActionOptions (hoverAt, tapAt, the touch gestures…) carry it too. hover(), tap(),
 * hoverAt(), tapAt() and the CDP touch gestures used to accept the option and drop it: the input went out with no key
 * held (review finding A-2). The page sees a held key as `keydown` and as `shiftKey` on the mouse/touch event.
 */

const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    w.__rec = { keydowns: [] as string[], moveShift: [] as boolean[], touchShift: [] as boolean[], touchKeys: [] as string[] };
    window.addEventListener('keydown', (e) => w.__rec.keydowns.push(e.key), true);
    window.addEventListener('mousemove', (e) => w.__rec.moveShift.push(e.shiftKey), true);
    window.addEventListener('touchstart', (e) => { w.__rec.touchShift.push(e.shiftKey); w.__rec.touchKeys.push(`${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.metaKey ? 'M' : ''}${e.shiftKey ? 'S' : ''}`); }, true);
  });
const recorded = (page: Page) => page.evaluate(() => (window as any).__rec as { keydowns: string[]; moveShift: boolean[]; touchShift: boolean[]; touchKeys: string[] });
const here = { lng: 34.83, lat: 32.04 };

test('hover({ modifiers: [Shift] }) holds Shift as the pointer arrives', async ({ map, page }) => {
  await record(page);
  await map.feature({ layer: 'alerts', id: 1 }).hover({ modifiers: ['Shift'] });
  const r = await recorded(page);
  expect(r.keydowns.length).toBeGreaterThan(0);
    expect(r.keydowns.every((k) => k === 'Shift')).toBe(true);
  expect(r.moveShift.at(-1)).toBe(true);
});

test('hover({ modifiers, moving: "allow" }) holds Shift too', async ({ map, page }) => {
  await record(page);
  await map.feature({ layer: 'alerts', id: 1 }).hover({ modifiers: ['Shift'], moving: 'allow' });
  const r = await recorded(page);
  expect(r.keydowns.length).toBeGreaterThan(0);
    expect(r.keydowns.every((k) => k === 'Shift')).toBe(true);
  expect(r.moveShift.at(-1)).toBe(true);
});

test('hoverAt(at, { modifiers: [Shift] }) holds Shift as the pointer arrives', async ({ map, page }) => {
  await record(page);
  await map.hoverAt(here, { modifiers: ['Shift'] });
  const r = await recorded(page);
  expect(r.keydowns.length).toBeGreaterThan(0);
    expect(r.keydowns.every((k) => k === 'Shift')).toBe(true);
  expect(r.moveShift.at(-1)).toBe(true);
});

test('without modifiers no key is pressed (control)', async ({ map, page }) => {
  await record(page);
  await map.feature({ layer: 'alerts', id: 1 }).hover();
  await map.hoverAt(here);
  const r = await recorded(page);
  expect(r.keydowns).toEqual([]);
  expect(r.moveShift.every((shift) => shift === false)).toBe(true);
});

test('click({ modifiers: [Shift] }) holds Shift (control: it always did)', async ({ map, page }) => {
  await record(page);
  await map.feature({ layer: 'alerts', id: 1 }).click({ modifiers: ['Shift'] });
  expect((await recorded(page)).keydowns.every((k) => k === 'Shift')).toBe(true);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('tap({ modifiers: [Shift] }) holds Shift during the tap', async ({ map, page }) => {
    await record(page);
    await map.feature({ layer: 'alerts', id: 1 }).tap({ modifiers: ['Shift'] });
    const r = await recorded(page);
    expect(r.keydowns.length).toBeGreaterThan(0);
    expect(r.keydowns.every((k) => k === 'Shift')).toBe(true);
    expect(r.touchShift.every(Boolean)).toBe(true);
  });

  test('tapAt(at, { modifiers: [Shift] }) holds Shift during the tap', async ({ map, page }) => {
    await record(page);
    await map.tapAt(here, { modifiers: ['Shift'] });
    const r = await recorded(page);
    expect(r.keydowns.length).toBeGreaterThan(0);
    expect(r.keydowns.every((k) => k === 'Shift')).toBe(true);
    expect(r.touchShift.every(Boolean)).toBe(true);
  });

  test('a CDP touch gesture (touchDragAt) carries the modifier on its touchstart', async ({ map, page }) => {
    await record(page);
    await map.touchDragAt({ lng: 34.8, lat: 32.07 }, { lng: 34.82, lat: 32.07 }, { modifiers: ['Shift'], steps: 4 });
    const r = await recorded(page);
    expect(r.keydowns.length).toBeGreaterThan(0);
    expect(r.keydowns.every((k) => k === 'Shift')).toBe(true);
    expect(r.touchShift[0]).toBe(true);
  });

  test('CDP touch gestures carry every modifier bit: Control + Alt on pinch, Meta on a double tap', async ({ map, page }) => {
    await record(page);
    await map.pinchAt({ lng: 34.81, lat: 32.07 }, { scale: 1.2, steps: 3, modifiers: ['Control', 'Alt'] });
    expect((await recorded(page)).touchKeys[0]).toBe('CA');
    await page.evaluate(() => { (window as any).__rec.touchKeys.length = 0; });
    await map.doubleTapAt({ lng: 34.81, lat: 32.07 }, { modifiers: ['Meta'] });
    const r = await recorded(page);
    expect(r.touchKeys).toEqual(['M', 'M']);
    expect(r.keydowns.filter((k) => k === 'Meta'), 'Meta is held once across both taps').toHaveLength(1);
  });

  test('a CDP touch gesture without modifiers presses nothing (control)', async ({ map, page }) => {
    await record(page);
    await map.touchDragAt({ lng: 34.8, lat: 32.07 }, { lng: 34.82, lat: 32.07 }, { steps: 4 });
    const r = await recorded(page);
    expect(r.keydowns).toEqual([]);
    expect(r.touchShift[0]).toBe(false);
  });
});

test('an invalid key in the list fails the action and leaves no key held down', async ({ map, page }) => {
  await record(page);
  const error = await map.hoverAt(here, { modifiers: ['Shift', 'Ctrl' as any], timeout: 4000 }).then(() => null, (e: Error) => e);
  expect(error, 'an invalid key name is an error, not a silent hover').not.toBeNull();
  await page.evaluate(() => { (window as any).__rec.moveShift.length = 0; });
  await map.hoverAt({ lng: 34.84, lat: 32.05 }); // a later, plain action: Shift must not still be down
  const r = await recorded(page);
  expect(r.moveShift.every((shift) => shift === false), 'Shift was released after the failed action').toBe(true);
});
