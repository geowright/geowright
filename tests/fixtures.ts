import { test as base } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { mapwright, type MapHandle } from '../src/playwright';

export { expect } from '../src/playwright';

/** Deterministic fixture tile: 256x256 PNG, flat colour with a 1px grid edge. No tile server. */
function makeTilePng(): Buffer {
  const size = 256;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const edge = x === 0 || y === 0;
      const o = row + 1 + x * 3;
      raw[o] = edge ? 200 : 236;
      raw[o + 1] = edge ? 208 : 240;
      raw[o + 2] = edge ? 214 : 243;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const TILE = makeTilePng();

export const test = base.extend<{ map: MapHandle }>({
  map: async ({ page, baseURL }, use) => {
    // Determinism guard: nothing may leave the machine. Any non-local request fails the test.
    const external: string[] = [];
    await page.route(/^https?:\/\//, (route) => {
      const url = route.request().url();
      if (url.startsWith(baseURL!)) return route.fallback();
      external.push(url);
      return route.abort();
    });
    await page.route('**/tiles/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
    await page.goto('/');
    const map = mapwright(page);
    await map.waitForIdle();
    await use(map);
    if (external.length) throw new Error(`external network requests are not allowed in tests:\n${external.join('\n')}`);
  },
});
