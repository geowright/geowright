import { Engine } from './engine';
import { MapLibreAdapter } from './maplibre-adapter';
import type { CanvasAdapter } from './types';

/**
 * In-page entry. Injected by the Playwright side (never shipped in the app bundle).
 *
 * The app's only obligation is one dependency-free line:
 *     (window.__mapwright_maps ??= {}).main = map;
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
  throw new Error('mapwright: registered object is not a recognised map instance');
}

function engine(mapId: string): Engine<any> {
  const reg = (window as any).__mapwright_maps as Registry | undefined;
  const instance = reg?.[mapId];
  if (!instance) {
    const ids = reg ? Object.keys(reg) : [];
    throw new Error(
      `mapwright: no map registered as "${mapId}"` +
        (ids.length ? ` (registered: ${ids.join(', ')})` : '. Add to the app: (window.__mapwright_maps ??= {}).main = map;'),
    );
  }
  const cached = engines.get(mapId);
  if (cached && cached.instance === instance) return cached.engine; // app may recreate the map
  const e = new Engine(adapterFor(instance));
  engines.set(mapId, { instance, engine: e });
  return e;
}

const api = {
  has: (mapId: string) => !!(window as any).__mapwright_maps?.[mapId],
  waitForIdle: (mapId: string, timeoutMs: number) => engine(mapId).adapter.waitForIdle(timeoutMs),
  find: (mapId: string, q: any) => engine(mapId).find(q),
  actionPoint: (mapId: string, q: any, opts: any) => engine(mapId).actionPoint(q, opts),
  armClick: (mapId: string, q: any, opts: any) => engine(mapId).armClick(q, opts),
  disarmClick: (mapId: string, token: string) => engine(mapId).disarmClick(token),
  explain: (mapId: string, q: any) => engine(mapId).explain(q),
  reveal: (mapId: string, q: any) => engine(mapId).reveal(q),
  viewState: (mapId: string) => engine(mapId).adapter.getViewState(),
  layers: (mapId: string) => engine(mapId).adapter.listLayers(),
  isMoving: (mapId: string) => engine(mapId).adapter.isMoving(),
  /** world -> client pixel, plus whether that pixel is inside the surface and not DOM-covered */
  clientPoint: (mapId: string, world: any) => {
    const a = engine(mapId).adapter;
    const p = a.project(world);
    const el = a.surface();
    const r = el.getBoundingClientRect();
    const inside = p.x >= 0 && p.y >= 0 && p.x <= el.clientWidth && p.y <= el.clientHeight;
    const client = { x: r.left + p.x, y: r.top + p.y };
    const top = inside ? document.elementFromPoint(client.x, client.y) : null;
    return { client, surface: p, inside, covered: inside && top !== el, moving: a.isMoving() };
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
(window as any).__mapwright = api;
