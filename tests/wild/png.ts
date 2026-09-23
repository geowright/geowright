import { deflateSync } from 'node:zlib';

/** Minimal RGBA PNG encoder for generated fixtures (sprites, icons, DEM tiles). No dependency, deterministic. */
export function encodePng(width: number, height: number, rgba: (x: number, y: number) => [number, number, number, number]): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(rgba(x, y), y * stride + 1 + x * 4);
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * A sprite sheet of plain discs, one per icon name, each in its own colour — plus, optionally, road SHIELDS: white
 * rounded plates with a dark rim, `shield-1` … `shield-N`, wide enough for a ref of that many characters (a style picks
 * one with `['concat', 'shield-', ['get', 'ref_length']]`). Returns what a style's `sprite` URL serves.
 */
export function makeSprite(names: string[], size = 21, o: { shields?: number } = {}): { json: Record<string, { x: number; y: number; width: number; height: number; pixelRatio: number }>; png: Buffer } {
  const cols = Math.ceil(Math.sqrt(names.length));
  const rows = Math.ceil(names.length / cols);
  const colour = (i: number): [number, number, number] => {
    const h = (i * 47) % 360, f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.5 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  };
  const json: Record<string, { x: number; y: number; width: number; height: number; pixelRatio: number }> = {};
  names.forEach((n, i) => (json[n] = { x: (i % cols) * size, y: Math.floor(i / cols) * size, width: size, height: size, pixelRatio: 1 }));
  // shields: one row each, under the discs; plate width grows 7 px per character
  const SH = 18, shieldW = (n: number) => 10 + 7 * n;
  const shields = Array.from({ length: o.shields ?? 0 }, (_, i) => i + 1);
  shields.forEach((n, i) => (json[`shield-${n}`] = { x: 0, y: rows * size + i * SH, width: shieldW(n), height: SH, pixelRatio: 1 }));
  const width = Math.max(cols * size, ...shields.map(shieldW));
  const png = encodePng(width, rows * size + shields.length * SH, (x, y) => {
    if (y >= rows * size) {
      const n = Math.floor((y - rows * size) / SH) + 1, sy = (y - rows * size) % SH, w = shieldW(n);
      if (x >= w) return [0, 0, 0, 0];
      const corner = Math.hypot(Math.max(0, 3 - x, x - (w - 4)), Math.max(0, 3 - sy, sy - (SH - 4)));
      if (corner > 3) return [0, 0, 0, 0];
      return x < 2 || x >= w - 2 || sy < 2 || sy >= SH - 2 || corner > 1.5 ? [70, 70, 90, 255] : [255, 255, 255, 255];
    }
    if (x >= cols * size) return [0, 0, 0, 0];
    const i = Math.floor(y / size) * cols + Math.floor(x / size);
    if (i >= names.length) return [0, 0, 0, 0];
    const d = Math.hypot((x % size) - (size - 1) / 2, (y % size) - (size - 1) / 2);
    if (d > size / 2 - 1) return [0, 0, 0, 0];
    return d > size / 2 - 3 ? [255, 255, 255, 255] : [...colour(i), 255];
  });
  return { json, png };
}
