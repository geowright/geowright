import type { Page } from '@playwright/test';

/** Where the wild apps on the synthetic basemap look (11.15, 12, 14, 15.5) and around: the zooms the two basemaps are compared at. */
export const DENSITY_ZOOMS = [11, 12, 13, 14, 15, 16];

/**
 * How dense is a basemap's LABELLING, measured the same way for the synthetic basemap and the opt-in real one: at each
 * zoom the camera jumps to `center` (pitch 0, bearing 0), the map settles, and MapLibre's own `queryRenderedFeatures`
 * lists what the basemap's symbol layers actually placed (a collided label is not rendered, so it is not counted).
 *
 * Counted in a fixed WINDOW centred in the viewport (default 880×720 px, the whole height of the 1280×720 test
 * viewport): the real-basemap cache is 2×2 tiles around its centre at zoom 11–14, and that window is what those tiles
 * cover at every one of those zooms — so both basemaps are measured over the same area, all of it drawn.
 */
export interface LabelDensity {
  zoom: number;
  /** Rendered basemap symbols (distinct features) in the window. */
  symbols: number;
  /** The same, split by symbol layer. */
  byLayer: Record<string, number>;
}

export async function measureLabelDensity(page: Page, o: { center: [number, number]; zooms: number[]; source?: string; window?: [number, number]; mapId?: string }): Promise<LabelDensity[]> {
  return page.evaluate(async ({ center, zooms, source, win, mapId }) => {
    const m = (window as any).__geowright_maps[mapId];
    const ids: string[] = m.getStyle().layers.filter((l: any) => l.type === 'symbol' && l.source === source).map((l: any) => l.id);
    const out: { zoom: number; symbols: number; byLayer: Record<string, number> }[] = [];
    for (const zoom of zooms) {
      const settled = new Promise((r) => m.once('idle', r));
      m.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      await settled;
      const c = m.getCanvas();
      const [w, h] = [c.clientWidth, c.clientHeight];
      const box = [[Math.max(0, (w - win[0]) / 2), Math.max(0, (h - win[1]) / 2)], [Math.min(w, (w + win[0]) / 2), Math.min(h, (h + win[1]) / 2)]];
      const seen = new Set<string>();
      const byLayer: Record<string, number> = {};
      for (const f of m.queryRenderedFeatures(box, { layers: ids })) {
        const key = `${f.layer.id}#${f.id ?? JSON.stringify(f.properties)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        byLayer[f.layer.id] = (byLayer[f.layer.id] ?? 0) + 1;
      }
      out.push({ zoom, symbols: seen.size, byLayer });
    }
    return out;
  }, { center: o.center, zooms: o.zooms, source: o.source ?? 'openmaptiles', win: o.window ?? [880, 720], mapId: o.mapId ?? 'main' });
}

/** One line per zoom, for the report: `z14: 212 symbols (poi_r1 40, housenumber 60, …)`. */
export const formatDensity = (label: string, d: LabelDensity[]) =>
  d.map((r) => `${label} z${r.zoom}: ${r.symbols} symbols (${Object.entries(r.byLayer).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')})`).join('\n');
