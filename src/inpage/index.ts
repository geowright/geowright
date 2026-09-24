import { Engine, clientFrame, toClient, toSurface, topElementAt, type ArmedCheck } from './engine';
import { MapLibreAdapter } from './maplibre-adapter';
import { startMirror } from './mirror';
import type { CanvasAdapter, ClickVerdict, FeatureSummary } from './types';

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

/**
 * Armed click-time / hover-time checks, by token. Module-level, NOT per Engine: an app that re-creates its map (a click
 * handler that re-mounts the map component, a route change) gets a new Engine on the next call, and a check kept by the
 * old one used to be unreachable — the click read as "never reached the page" and was sent again, while the old
 * listeners stayed on the window.
 */
const armed = new Map<string, ArmedCheck>();
function arm(check: ArmedCheck): string {
  const token = Math.random().toString(36).slice(2);
  armed.set(token, check);
  return token;
}

const api = {
  waitForIdle: (mapId: string, timeoutMs: number) => engine(mapId).adapter.waitForIdle(timeoutMs),
  idleDiagnosis: (mapId: string) => engine(mapId).adapter.idleDiagnosis?.(),
  find: async (mapId: string, q: any) => (await engine(mapId).learnIdentity(q), engine(mapId).find(q)),
  /**
   * For the retrying matchers: `find`, plus whether the query names a layer the style does not have. A feature query on
   * a missing layer answers "nothing" — a typo (`alert` for `alerts`) would make every negative assertion pass.
   */
  findChecked: async (mapId: string, q: any): Promise<{ found: FeatureSummary[]; missingLayer?: string }> => {
    const e = engine(mapId);
    await e.learnIdentity(q);
    const found = e.find(q);
    const named: string[] = q.layer === undefined ? [] : Array.isArray(q.layer) ? q.layer : [q.layer];
    if (!named.length) return { found };
    const ids = e.adapter.listLayers().map((l) => l.id);
    const missing = named.filter((id) => !ids.includes(id));
    if (!missing.length) return { found };
    const list = ids.length > 40 ? `${ids.slice(0, 40).join(', ')}, … (${ids.length - 40} more)` : ids.join(', ') || '(none: is the style loaded?)';
    return { found, missingLayer: `${missing.length > 1 ? 'layers' : 'layer'} ${missing.map((id) => `"${id}"`).join(', ')} ${missing.length > 1 ? 'do' : 'does'} not exist. Layers: ${list}` };
  },
  /**
   * A bounded wait for idle that says whether a verdict may be taken now: `idle`, or `never` — the map was diagnosed as
   * one that never becomes idle (an animated source, a source re-set in a loop, continuous repainting), where waiting
   * longer cannot help. Anything else (loading, a moving camera, a slow page) is not settled.
   */
  settle: async (mapId: string, timeoutMs: number): Promise<{ idle: boolean; never: boolean; why?: string }> => {
    const a = engine(mapId).adapter;
    if (await a.waitForIdle(timeoutMs)) return { idle: true, never: false };
    return { idle: false, never: a.neverIdle?.() ?? false, why: a.idleDiagnosis?.() };
  },
  actionPoint: async (mapId: string, q: any, opts: any) => (await engine(mapId).learnIdentity(q), engine(mapId).actionPoint(q, opts)),
  debugMarks: (mapId: string, q: any, opts: any) => engine(mapId).debugMarks(q, opts),
  overlaysAt: (mapId: string, kind: any, o: any) => engine(mapId).overlaysAt(kind, o),
  /**
   * map.marker() / map.popup(): match AND pin in one call, so the pinned element is the one that matched (in
   * two round trips an overlay inserted in between re-pointed a document index). With exactly one match its element is
   * kept in `window.__geowright_pins` under a token, for the Playwright side's pin selector engine. `docIndex`: its
   * position among the document's matches, for the order-bound fallback (-1 inside a shadow root).
   */
  pinOverlay: (mapId: string, kind: any, o: any) => {
    const e = engine(mapId);
    const list = e.overlaysAt(kind, o);
    if (list.length !== 1) return { list };
    const el = e.adapter.overlayElement?.(list[0]);
    if (!el) return { list };
    const w = window as any;
    const pins: Map<string, Element> = (w.__geowright_pins ??= new Map());
    const token = `${pins.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    pins.set(token, el);
    return { list, token, docIndex: [...document.querySelectorAll(list[0].selector)].indexOf(el) };
  },
  geometry: async (mapId: string, q: any) => (await engine(mapId).learnIdentity(q), engine(mapId).geometry(q)),
  compareGeometry: async (mapId: string, q: any, expected: any, tolerancePx: number) => (await engine(mapId).learnIdentity(q), engine(mapId).compareGeometry(q, expected, tolerancePx)),
  pixelProbe: async (mapId: string, q: any, opts?: any) => (await engine(mapId).learnIdentity(q), engine(mapId).pixelProbe(q, opts)),
  /**
   * Pixel-only layers (raster, image, canvas, video, heatmap, hillshade): how much do the pixels at a location change when
   * the layer is not drawn? `ok: false` = no verdict could be reached (the matchers: inconclusive); a hidden layer
   * is a verdict — 0.
   */
  layerPixels: async (mapId: string, layer: string, world: any, radiusPx = 24, budgetMs = 2000) => {
    const a = engine(mapId).adapter;
    const info = a.listLayers().find((l) => l.id === layer);
    if (!info) return { ok: false as const, message: `layer "${layer}" does not exist. Layers: ${a.listLayers().map((l) => l.id).join(', ')}` };
    const el = a.surface();
    if (el.isConnected === false || el.clientWidth < 1 || el.clientHeight < 1) return { ok: false as const, message: el.isConnected === false ? 'map canvas is detached from the document; the map was removed or its container was detached' : `map canvas is ${el.clientWidth}x${el.clientHeight}` };
    const p = a.project(world);
    if (p.x < 0 || p.y < 0 || p.x > el.clientWidth || p.y > el.clientHeight) return { ok: false as const, message: 'that location is outside the viewport' };
    // Its pixel shows something else — the near side of a globe, the ridge in front of it: no verdict about it.
    if (a.isOnSurface?.(world) === false) return { ok: false as const, message: 'that location is not on the visible map surface (the far side of the globe, or hidden behind terrain or beyond the horizon)' };
    if (!info.visible) return { ok: true as const, diff: 0, surface: p, hidden: true };
    // an AREA: imagery is often transparent at any one pixel
    const r = a.probePixels ? await a.probePixels(layer, p, radiusPx, budgetMs) : { diff: await a.pixelContribution?.(layer, p, radiusPx) };
    if ('diff' in r && r.diff !== undefined) return { ok: true as const, diff: r.diff, surface: p };
    const why = 'inconclusive' in r ? r.inconclusive : 'unavailable' in r ? r.unavailable : 'no WebGL context to read from, or no frame was rendered — a hidden tab?';
    return { ok: false as const, message: `this map could not be probed: ${why}` };
  },
  armClick: (mapId: string, q: any, opts: any) => arm(engine(mapId).armClick(q, opts)),
  armHover: (mapId: string, q: any, opts: any) => arm(engine(mapId).armHover(q, opts)),
  /**
   * Removes the check's listeners and returns what it saw — whichever Engine armed it (the map may have been re-created
   * since: the click this check let through can be what re-created it). `null`: no such check in this page. The page was
   * replaced (a navigation), so the input left and was delivered; the caller must not send it again.
   */
  disarmClick: (_mapId: string, token: string): ClickVerdict | null => {
    const a = armed.get(token);
    if (!a) return null;
    armed.delete(token);
    a.dispose();
    return a.verdict;
  },
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
    const inside = p.x >= 0 && p.y >= 0 && p.x <= el.clientWidth && p.y <= el.clientHeight;
    const client = toClient(clientFrame(el), p); // a CSS-scaled map is not just offset
    const top = inside ? topElementAt(client.x, client.y) : null;
    const hidden = inside && a.isOnSurface ? !a.isOnSurface(world) : false;
    return { client, surface: p, inside, hidden, covered: inside && top !== el, moving: a.isMoving() };
  },
  worldAt: (mapId: string, client: { x: number; y: number }) => {
    const a = engine(mapId).adapter;
    return a.unproject(toSurface(clientFrame(a.surface()), client));
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
