import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';

/**
 * Deterministic dense fixture: ~5,000 point assets and ~1,000 lots with heavy overlap.
 * Everything is invented and generated from a fixed seed (mulberry32), so every run and every
 * machine sees the same map. Look-alikes are deliberate: few distinct kinds/owners, many features.
 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AssetProps {
  id: number;
  kind: 'hydrant' | 'valve' | 'meter' | 'pump';
  status: 'ok' | 'warn' | 'fault';
  zone: string;
  serial: string;
  pressure: number;
}

export interface LotProps {
  id: number;
  owner: string;
  use: 'housing' | 'retail' | 'depot' | 'vacant';
  floors: number;
}

const KINDS: AssetProps['kind'][] = ['hydrant', 'valve', 'meter', 'pump'];
const OWNERS = ['Marrow & Finch', 'Oskar Velde', 'Tindall Cooperative', 'Brannock Holdings', 'Ilse Quarry Trust', 'Pellam Yard Ltd', 'Sable Row Estates', 'Wren Hollow Partners'];
const USES: LotProps['use'][] = ['housing', 'retail', 'depot', 'vacant'];

export const DENSE_CENTER: [number, number] = [34.78, 32.08];
const SPAN_LNG = 0.3; // the default viewport shows roughly 0.19 x 0.105 of this
const SPAN_LAT = 0.2;

export function denseAssets(count = 5000): FeatureCollection<Point, AssetProps> {
  const rnd = mulberry32(20260920);
  // 12 hot spots hold 70% of the assets (heavy overlap); the rest are spread uniformly.
  const hot = Array.from({ length: 12 }, () => [DENSE_CENTER[0] + (rnd() - 0.5) * SPAN_LNG * 0.8, DENSE_CENTER[1] + (rnd() - 0.5) * SPAN_LAT * 0.8]);
  const features: Feature<Point, AssetProps>[] = [];
  for (let i = 0; i < count; i++) {
    let lng: number, lat: number;
    if (rnd() < 0.7) {
      const h = hot[Math.floor(rnd() * hot.length)];
      const r = Math.pow(rnd(), 2) * 0.012;
      const a = rnd() * Math.PI * 2;
      lng = h[0] + Math.cos(a) * r;
      lat = h[1] + Math.sin(a) * r * 0.85;
    } else {
      lng = DENSE_CENTER[0] + (rnd() - 0.5) * SPAN_LNG;
      lat = DENSE_CENTER[1] + (rnd() - 0.5) * SPAN_LAT;
    }
    const id = 10000 + i;
    const s = rnd();
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [+lng.toFixed(6), +lat.toFixed(6)] },
      properties: {
        id,
        kind: KINDS[Math.floor(rnd() * KINDS.length)],
        status: s < 0.9 ? 'ok' : s < 0.98 ? 'warn' : 'fault',
        zone: 'Z' + String(1 + Math.floor(rnd() * 20)).padStart(2, '0'),
        serial: 'SN-' + String(Math.floor(rnd() * 90000) + 10000),
        pressure: Math.round(rnd() * 900) / 10,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function denseLots(count = 1000): FeatureCollection<Polygon, LotProps> {
  const rnd = mulberry32(777);
  const features: Feature<Polygon, LotProps>[] = [];
  for (let i = 0; i < count; i++) {
    const cx = DENSE_CENTER[0] + (rnd() - 0.5) * SPAN_LNG;
    const cy = DENSE_CENTER[1] + (rnd() - 0.5) * SPAN_LAT;
    const w = 0.002 + rnd() * 0.008;
    const h = 0.002 + rnd() * 0.006;
    const id = 50000 + i;
    // An L-shape every 5th lot (concave: centroid can be outside), plain rectangles otherwise.
    const ring =
      i % 5 === 0
        ? [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy - h / 3], [cx - w / 3, cy - h / 3], [cx - w / 3, cy + h], [cx - w, cy + h], [cx - w, cy - h]]
        : [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Polygon', coordinates: [ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])] },
      properties: { id, owner: OWNERS[Math.floor(rnd() * OWNERS.length)], use: USES[Math.floor(rnd() * USES.length)], floors: 1 + Math.floor(rnd() * 12) },
    });
  }
  return { type: 'FeatureCollection', features };
}
