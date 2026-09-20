import { Engine, topElementAt } from './engine';
import { MapLibreAdapter } from './maplibre-adapter';
import { startMirror } from './mirror';
import type { CanvasAdapter } from './types';

/**
 * In-page entry. Injected by the Playwright side (never shipped in the app bundle).
 *
 * The app's only obligation is one dependency-free line:
 *     (window.__geowright_maps ??= {}).main = map;
 * We wrap whatever is registered there in an adapter, lazily, on first use — so it does not
 * matter whether the app registers before or after this script is injected.
 */
type Registry = Record<string, unknown>;

const engines = new Map<string, { instance: unknown; engine: Engine<any> }>();

function adapterFor(instance: any): CanvasAdapter<any> {
  // Duck-typed so the app needs no import from us. Other libraries plug in here.
  if (instance && typeof instance.queryRenderedFeatures === 'function' && typeof instance.project === 'function') {
    return new MapLibreAdapter(instance);
  }
  throw new Error('geowright: registered object is not a recognised map instance');
}

function engine(mapId: string): Engine<any> {
  const reg = (window as any).__geowright_maps as Registry | undefined;
  const instance = reg?.[mapId];
  if (!instance) {
    const ids = reg ? Object.keys(reg) : [];
    throw new Error(
      `geowright: no map registered as "${mapId}"` +
        (ids.length ? ` (registered: ${ids.join(', ')})` : '. Add to the app: (window.__geowright_maps ??= {}).main = map;'),
    );
  }
  const cached = engines.get(mapId);
  if (cached && cached.instance === instance) return cached.engine; // app may recreate the map
  const e = new Engine(adapterFor(instance));
  engines.set(mapId, { instance, engine: e });
  return e;
}

const api = {
  waitForIdle: (mapId: string, timeoutMs: number) => engine(mapId).adapter.waitForIdle(timeoutMs),
  find: async (mapId: string, q: any) => (await engine(mapId).learnIdentity(q), engine(mapId).find(q)),
  actionPoint: async (mapId: string, q: any, opts: any) => (await engine(mapId).learnIdentity(q), engine(mapId).actionPoint(q, opts)),
  debugMarks: (mapId: string, q: any, opts: any) => engine(mapId).debugMarks(q, opts),
  overlaysAt: (mapId: string, kind: any, o: any) => engine(mapId).overlaysAt(kind, o),
  geometry: async (mapId: string, q: any) => (await engine(mapId).learnIdentity(q), engine(mapId).geometry(q)),
  compareGeometry: async (mapId: string, q: any, expected: any, tolerancePx: number) => (await engine(mapId).learnIdentity(q), engine(mapId).compareGeometry(q, expected, tolerancePx)),
  pixelProbe: async (mapId: string, q: any) => (await engine(mapId).learnIdentity(q), engine(mapId).pixelProbe(q)),
  /** Pixel-only layers (raster, image, canvas, video, heatmap, hillshade): how much do the pixels at a location change when the layer is not drawn? */
  layerPixels: (mapId: string, layer: string, world: any, radiusPx = 24) => {
    const a = engine(mapId).adapter;
    if (!a.listLayers().some((l) => l.id === layer)) return { ok: false as const, message: `layer "${layer}" does not exist. Layers: ${a.listLayers().map((l) => l.id).join(', ')}` };
    const p = a.project(world);
    const el = a.surface();
    if (p.x < 0 || p.y < 0 || p.x > el.clientWidth || p.y > el.clientHeight) return { ok: false as const, message: 'that location is outside the viewport' };
    const diff = a.pixelContribution?.(layer, p, radiusPx); // an AREA: imagery is often transparent at any one pixel
    return diff === undefined ? { ok: false as const, message: `layer "${layer}" is hidden (visibility: none), or this map cannot be probed` } : { ok: true as const, diff, surface: p };
  },
  armClick: (mapId: string, q: any, opts: any) => engine(mapId).armClick(q, opts),
  disarmClick: (mapId: string, token: string) => engine(mapId).disarmClick(token),
  entities: (mapId: string, opts?: any) => engine(mapId).entities(opts),
  /** Agent sessions only: mirror features into the accessibility tree as real, clickable buttons. */
  hasMirror: (mapId: string) => !!(window as any).__geowright_mirrors?.[mapId],
  mirror: (mapId: string, opts?: any) => {
    const w = window as any;
    (w.__geowright_mirrors ??= {})[mapId]?.();
    w.__geowright_mirrors[mapId] = startMirror(engine(mapId), mapId, opts);
    return true;
  },
  snapshot: async (mapId: string, opts?: any) => (await engine(mapId).learnIdentity({ layer: opts?.layers }), engine(mapId).snapshot(opts)),
  explain: (mapId: string, q: any) => engine(mapId).explain(q),
  reveal: (mapId: string, q: any) => engine(mapId).reveal(q),
  viewState: (mapId: string) => engine(mapId).adapter.getViewState(),
  layers: (mapId: string) => engine(mapId).adapter.listLayers(),
  isMoving: (mapId: string) => engine(mapId).adapter.isMoving(),
  /** world -> client pixel, plus whether that pixel is inside the surface and not DOM-covered */
  clientPoint: (mapId: string, world: any) => {
    engine(mapId).scrollIntoView();
    const a = engine(mapId).adapter;
    const p = a.project(world);
    const el = a.surface();
    const r = el.getBoundingClientRect();
    const inside = p.x >= 0 && p.y >= 0 && p.x <= el.clientWidth && p.y <= el.clientHeight;
    const client = { x: r.left + p.x, y: r.top + p.y };
    const top = inside ? topElementAt(client.x, client.y) : null;
    const hidden = inside && a.isOnSurface ? !a.isOnSurface(world) : false;
    return { client, surface: p, inside, hidden, covered: inside && top !== el, moving: a.isMoving() };
  },
  worldAt: (mapId: string, client: { x: number; y: number }) => {
    const a = engine(mapId).adapter;
    const r = a.surface().getBoundingClientRect();
    return a.unproject({ x: client.x - r.left, y: client.y - r.top });
  },
  revealWorld: async (mapId: string, world: any) => {
    await engine(mapId).adapter.reveal?.(world);
  },
};

export type InPageApi = typeof api;
(window as any).__geowright = api;

/**
 * Agent integration, best effort: if the browser exposes the experimental WebMCP API
 * (navigator.modelContext), register a tool. Playwright MCP collects page-registered tools and
 * offers them to the agent, so the agent DISCOVERS the map capability instead of being told about
 * a magic global. Read-only by nature: page JS cannot produce real input, so acting still goes
 * through the agent's own mouse tool using the pixels in the snapshot.
 */
try {
  const mc = (navigator as any).modelContext;
  if (mc?.registerTool && !(window as any).__geowright_webmcp) {
    (window as any).__geowright_webmcp = true;
    mc.registerTool({
      name: 'map_snapshot',
      description:
        'Text snapshot of the interactive map canvas on this page (invisible to the accessibility snapshot): view state, layers, ' +
        'and every rendered feature with its properties and CLIENT pixel position. Click a feature by clicking its pixel.',
      inputSchema: { type: 'object', properties: { mapId: { type: 'string', description: 'default "main"' } } },
      annotations: { readOnlyHint: true },
      execute: async (args: { mapId?: string }) => ({ content: [{ type: 'text', text: await api.snapshot(args?.mapId ?? 'main') }] }),
    });
  }
} catch {
  /* WebMCP is experimental; absence or API drift must never break the adapter */
}
