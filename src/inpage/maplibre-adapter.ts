import type { Map as MlMap, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import { clientFrame, toSurface } from './engine';
import { explainLayerHidden, explainPaint, extrusionBase, extrusionHeight, filterAdmits, isPixelOnlyType, layoutVisible, missingIcon, nullUncertainProperties, paintColour, paintVisibility, pixelOccluders, projectionOf, reloadFreeOpacity, unparseableReasons, zoomUncertainProperties } from './maplibre-paint';
import type { Geometry, LayerInfo, LngLat, Overlay, PixelPoint, RenderedFeature, Visibility } from './types';
import type { InternalCanvasAdapter, InternalRenderedFeature, PixelOccluder, ProbeResult, StyleCause } from './types-internal';

/** A source that is not loaded right now: its type, whether its GeoJSON is inline (nothing to download), and how long
 *  it has been pending as far as this adapter has seen (the retries of one waitForIdle() share that clock). */
export interface PendingSource {
  id: string;
  type: string;
  inline: boolean;
  forMs: number;
}

export const DEAD_WORKER_AFTER_MS = 5000;

/**
 * settleAfterProbe on a map seen never to go idle (repaint on, an animated source, or so diagnosed by the last
 * waitForIdle), or once the layer's filter, its source's data, the camera or the global state has changed since the
 * probe: how long, in time and in rendered frames, the layer's source must have been loaded again before the wait for
 * its features gives up (they were taken away in a way no check sees, or by that change; after such a change, counted
 * from the first reload after it: the later reloads do not restart it). A symbol is hit-tested again
 * only once placed again, and MapLibre starts a placement no sooner than its fade duration (300 ms by default) after
 * the one before. Measured (MapLibre 6, a map that repaints every frame, 50,000 points in the source, quiet machine, 12
 * probes each): a symbol was back 0 to 227 ms (up to 14 frames) after its source had loaded, a circle in the same
 * frame. Both bounds must pass: placement waits for the clock (that fade duration) and runs in frames, of which a
 * loaded machine renders few. Out of both, the wait ends as it would with the features back: the probe's verdict
 * stands, and the caller's next look sees what is there. On such a map, or after such a change, with a fade duration
 * above about 600 ms, a read right after the matcher may miss a symbol that is not placed again yet. Not otherwise on a
 * map that goes idle: with a fade of 1000 ms a symbol was back about 1000 ms after the probe, and a give-up at 600 ms
 * missed it about every second time; the wait ends at idle there.
 */
const SETTLE_GRACE_MS = 600;
const SETTLE_GRACE_FRAMES = 8;

/** Starts during one settle wait: inline data and the current uninterrupted sequence of overlapping loads. */
interface Starts {
  n: number;
  inline: boolean;
  first: number;
  last: number;
  overlapping: number;
}

/** Whether a source's data is inline GeoJSON (in its serialised style spec): nothing to download, data the app has in hand. */
function inlineGeoJSON(spec: unknown): boolean {
  const s = spec as { type?: string; data?: unknown } | undefined;
  return s?.type === 'geojson' && typeof s.data === 'object' && s.data !== null;
}

/**
 * Inline GeoJSON needs no network: MapLibre parses it in a web worker. When it has not loaded for seconds AND no
 * worker-backed source (GeoJSON, vector) on the map has loaded at all, the worker is almost always dead — its script
 * was not found or could not start (MapLibre 6 under Vite's dev server, a worker URL the page cannot load, a CSP).
 * A loaded GeoJSON / vector source proves the workers run; then it is something else, and this says nothing.
 * Before this, a first-time user with exactly that setup got "source(s) places have not finished loading": true, and useless.
 */
export function deadWorkerDiagnosis(pending: PendingSource[], workerSourcesLoaded: number): string | undefined {
  if (workerSourcesLoaded > 0) return undefined;
  const stuck = pending.filter((p) => p.inline && p.forMs >= DEAD_WORKER_AFTER_MS);
  if (!stuck.length) return undefined;
  const secs = Math.floor(Math.min(...stuck.map((p) => p.forMs)) / 1000);
  return (
    `source(s) ${stuck.map((p) => p.id).join(', ')} hold inline GeoJSON (nothing to download) and have not loaded for ${secs}s, ` +
    `and no GeoJSON or vector source of this map has loaded at all. MapLibre parses GeoJSON in a web worker: this is ` +
    `almost always a DEAD WORKER — its script was not found or could not start. The browser console (and a dev server's ` +
    `log) says which. Common case: MapLibre GL JS 6 under Vite's dev server needs optimizeDeps: { exclude: ['maplibre-gl'] } ` +
    `(docs/RECIPES.md, "The map never becomes idle"). If the machine is merely starved, a longer timeout will show it`
  );
}

/**
 * MapLibre GL JS adapter. PUBLIC API ONLY — no underscore fields. (MapGrab, the archived prior
 * art, relied on _styleDirty/_frameRequest/_placementDirty/...; that is what we are avoiding.)
 *
 * Versions: written against MapLibre GL JS 6, run against 2–6 and Mapbox GL JS 1.13 (the same API
 * family) by tests/compat. Newer public methods are FEATURE-DETECTED, never version-sniffed, and what
 * an old version cannot do is said out loud in caveats() instead of being answered wrongly.
 */
export class MapLibreAdapter implements InternalCanvasAdapter<LngLat> {
  readonly kind = 'maplibre';
  constructor(private readonly map: MlMap) {}

  surface(): HTMLElement {
    return this.map.getCanvas();
  }

  getViewState() {
    const c = this.map.getCenter();
    const b = this.map.getBounds();
    const canvas = this.map.getCanvas();
    return {
      center: { lng: c.lng, lat: c.lat },
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      bounds: { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
      size: { width: canvas.clientWidth, height: canvas.clientHeight },
      // Both change what a pixel means (a globe has a far side, terrain hides what is behind a ridge). Always a string:
      // a projection expression (MapLibre 5+) is named by what it is at this zoom.
      projection: projectionOf(this.map).name,
      terrain: !!this.map.getTerrain?.(),
    };
  }

  project(w: LngLat): PixelPoint {
    const p = this.map.project([w.lng, w.lat]);
    return { x: p.x, y: p.y };
  }

  unproject(pt: PixelPoint): LngLat {
    const ll = this.map.unproject([pt.x, pt.y]);
    return { lng: ll.lng, lat: ll.lat };
  }

  /**
   * project() always answers, even for the far side of the globe (it returns the pixel where the
   * location WOULD be if the earth were transparent). The public way to know: round-trip. The pixel
   * unprojects to what is actually drawn there; if that is not (about) the location we asked for,
   * the location is hidden. Tolerance scales with what one pixel covers at that spot (large near
   * the limb of the globe, tiny on a zoomed-in flat map).
   */
  isOnSurface(w: LngLat): boolean {
    const p = this.map.project([w.lng, w.lat]);
    const back = this.map.unproject(p);
    const next = this.map.unproject([p.x + 1, p.y + 1]);
    const dist = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) => {
      const dLng = ((((a.lng - b.lng) % 360) + 540) % 360) - 180;
      return Math.hypot(dLng * Math.cos((a.lat * Math.PI) / 180), a.lat - b.lat);
    };
    return dist(back, w) <= 3 * dist(back, next) + 1e-9;
  }

  worldFromCoord(coord: number[]): LngLat {
    return { lng: coord[0], lat: coord[1] };
  }

  /** The copy of the world nearest the view centre (the camera's lng may be outside [-180, 180] after panning). */
  nearestCopy(anchor: number[]): ((coord: number[]) => LngLat) | undefined {
    if (projectionOf(this.map).globe || !(this.map.getRenderWorldCopies?.() ?? true)) return undefined;
    const shift = 360 * Math.round((this.map.getCenter().lng - anchor[0]) / 360);
    return shift ? (c) => ({ lng: c[0] + shift, lat: c[1] }) : undefined;
  }

  queryFeatures(q: { layers?: string[]; at?: PixelPoint }): RenderedFeature[] {
    // queryRenderedFeatures throws for layer ids that do not exist; an unknown layer is a
    // legitimate "nothing there (yet)" for a retrying assertion, so filter them out.
    const layers = q.layers?.filter((id) => this.map.getLayer(id));
    if (q.layers && layers!.length === 0) return [];
    const opts = layers ? { layers } : {};
    if (q.at) return this.map.queryRenderedFeatures([q.at.x, q.at.y], opts).map(toRendered);
    // 'globe', 'vertical-perspective' and projection expressions all render through MapLibre's globe transform.
    if (!projectionOf(this.map).globe) return this.map.queryRenderedFeatures(opts).map(toRendered);
    return this.queryGlobe(opts);
  }

  /**
   * On a GLOBE, MapLibre's viewport-wide queryRenderedFeatures is wrong in both directions (verified on
   * 6.10 with its own globe example, zoom 2: the no-geometry query and a full-viewport box both return
   * 24 countries; point queries find 83; smaller boxes return 187 — they include the FAR side).
   * Point queries are right. So: ask in a 4x4 grid of boxes (a superset), drop duplicate pieces, and keep
   * a piece only if some vertex of it is on the near side and inside the viewport — the same public
   * project/unproject round-trip as isOnSurface(). Actions verify by point hit tests anyway.
   */
  private queryGlobe(opts: { layers?: string[] }): RenderedFeature[] {
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight, N = 4;
    const seen = new Set<string>();
    const out: RenderedFeature[] = [];
    const nearSide = (f: RenderedFeature) => {
      const coords: number[][] = [];
      const walk = (c: any): void => (typeof c[0] === 'number' ? void coords.push(c) : c.forEach(walk));
      walk(f.geometry.coordinates);
      const step = Math.max(1, Math.floor(coords.length / 40));
      for (let i = 0; i < coords.length; i += step) {
        const p = this.map.project(coords[i] as [number, number]);
        if (p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h && this.isOnSurface({ lng: coords[i][0], lat: coords[i][1] })) return true;
      }
      return false;
    };
    const take = (raw: MapGeoJSONFeature, check: boolean) => {
      const f = toRendered(raw);
      const first = JSON.stringify(f.geometry.coordinates).slice(0, 80);
      const key = `${f.layer}|${f.id ?? ''}|${JSON.stringify(f.properties)}|${first}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!check || nearSide(f)) out.push(f);
    };
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        for (const raw of this.map.queryRenderedFeatures([[(i * w) / N, (j * h) / N], [((i + 1) * w) / N, ((j + 1) * h) / N]], opts)) take(raw, true);
      }
    }
    // fill-extrusion on a globe: BOX queries return nothing at all for it (verified: MapLibre's own globe +
    // fill-extrusion example, 3 extrusions plainly drawn, box query 0, point query hits). Only point queries
    // see them, so sweep a grid of points over those layers. A point hit IS the near side: no check needed.
    const extrusions = (opts.layers ?? this.layerIds()).filter((id) => this.map.getLayer(id)?.type === 'fill-extrusion' && layoutVisible(this.map, id));
    if (extrusions.length) {
      const probe = (x: number, y: number) => {
        if (x < 0 || y < 0 || x > w || y > h) return;
        for (const raw of this.map.queryRenderedFeatures([x, y], { layers: extrusions })) take(raw, false);
      };
      for (let x = 8; x < w; x += 16) for (let y = 8; y < h; y += 16) probe(x, y);
      // Small ones slip through a 16px grid: also ask exactly where the source says their footprints are.
      for (const id of extrusions) {
        const layer = this.map.getLayer(id)!;
        for (const sf of this.map.querySourceFeatures(layer.source, { sourceLayer: layer.sourceLayer })) {
          const g = sf.geometry;
          const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((poly) => poly[0]) : [];
          for (const ring of rings) {
            const c = ring.reduce((a, v) => [a[0] + v[0] / ring.length, a[1] + v[1] / ring.length], [0, 0]);
            if (!this.isOnSurface({ lng: c[0], lat: c[1] })) continue;
            const p = this.map.project(c as [number, number]);
            probe(p.x, p.y);
          }
        }
      }
    }
    return out;
  }

  async queryData(layerId: string): Promise<RenderedFeature[] | null> {
    const layer = this.map.getLayer(layerId);
    if (!layer) return null;
    const source = this.map.getSource(layer.source) as GeoJSONSource | undefined;
    if (!source || source.type !== 'geojson') return null;
    // GeoJSONSource.getData() is MapLibre >= 4. Before that the public way back to the data is serialize(),
    // which echoes what the app passed in — the object itself, or only its URL (then: unknowable, like tiles).
    let data: GeoJSON.GeoJSON | string | undefined;
    if (typeof source.getData === 'function') data = await source.getData();
    else data = (source.serialize?.() as { data?: GeoJSON.GeoJSON | string } | undefined)?.data;
    if (!data || typeof data === 'string') return null;
    // A source may hold a bare GEOMETRY ({ type: 'Point', … } — MapLibre's "animate a point" example does):
    // MapLibre renders it as one feature without properties, so that is what it is here too. Originally it
    // was read as "no features", which silently disabled every question the engine asks the source.
    const feats: GeoJSON.Feature[] =
      data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : [{ type: 'Feature', properties: {}, geometry: data }];
    const promoteId = (source as any).promoteId as string | undefined; // public option, echoed on the source
    return feats
      .filter((f) => f.geometry && f.geometry.type !== 'GeometryCollection')
      .map((f) => ({
        layer: layerId,
        source: layer.source,
        id: (promoteId && f.properties ? (f.properties[promoteId] as string | number) : undefined) ?? f.id,
        properties: (f.properties ?? {}) as Record<string, unknown>,
        geometry: f.geometry as Geometry,
      }));
  }

  /** A GeoJSON source with `generateId` (a public option, echoed by the source's serialize()): ids are indexes. */
  private generatesIds(source: { serialize?: () => unknown }): boolean {
    try {
      return !!(source.serialize?.() as { generateId?: unknown } | undefined)?.generateId;
    } catch {
      return false;
    }
  }

  /**
   * MapLibre keeps a feature's id only if it is a non-negative integer: GeoJSON ids go through vt-pbf, which parses a
   * string id as an integer and writes any number as an unsigned varint ('north-gate' -> 0, '4f3a' -> 4, -5 ->
   * 18446744073709552000, 1.5 -> 1; Mapbox GL 1 and older MapLibre drop a non-numeric one), and a vector tile holds
   * nothing else. With `promoteId` the rendered id is the property value itself; with `generateId` (GeoJSON) it is the
   * feature's index, whatever id the data gives it.
   */
  idRoundTrips(layerId: string, id: string | number): boolean | undefined {
    const layer = this.map.getLayer(layerId);
    const source = layer?.source ? (this.map.getSource(layer.source) as { type?: string; promoteId?: unknown; serialize?: () => unknown } | undefined) : undefined;
    if (!layer || !source || (source.type !== 'geojson' && source.type !== 'vector')) return undefined;
    const promoteId = source.promoteId; // public option, echoed on the source: a property name, or one per source-layer
    if (typeof promoteId === 'string' || (promoteId && typeof promoteId === 'object' && layer.sourceLayer && (promoteId as Record<string, unknown>)[layer.sourceLayer])) return true;
    if (source.type === 'geojson' && this.generatesIds(source)) return false;
    const n = typeof id === 'number' ? id : /^(0|[1-9]\d*)$/.test(id) ? Number(id) : NaN;
    return Number.isSafeInteger(n) && n >= 0;
  }

  /** Layer ids, bottom to top. getLayersOrder() is MapLibre >= 3; the style has said the same thing since v1. */
  private layerIds(): string[] {
    return typeof this.map.getLayersOrder === 'function' ? this.map.getLayersOrder() : (this.map.getStyle()?.layers ?? []).map((l) => l.id);
  }

  listLayers(): LayerInfo[] {
    return this.layerIds().map((id) => {
      const l = this.map.getLayer(id)!;
      return {
        id,
        type: l.type,
        source: l.source || undefined,
        sourceType: l.source ? this.map.getSource(l.source)?.type : undefined,
        // not `!== 'none'`: since MapLibre 5.16 visibility may be an expression on global state
        visible: layoutVisible(this.map, id),
      };
    });
  }

  isMoving(): boolean {
    return this.map.isMoving();
  }

  /**
   * MapLibre fires 'idle' only at the END of a rendered frame, when: nothing is dirty, no repaint
   * is requested, !isMoving() and loaded(). If the map is already idle no frame is scheduled and
   * `once('idle')` would hang forever. So: subscribe, then force one frame with triggerRepaint().
   * That frame either fires 'idle' or re-schedules itself until it can. Public API only.
   */
  waitForIdle(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let frames = 0;
      const started = performance.now();
      const onRender = () => frames++;
      // How often did a source START loading new data while we waited? (public 'sourcedataloading'; tile events are
      // not counted.) Once is a load. Again and again is the app calling setData in a loop — most of those updates are
      // abandoned before they finish, which is why counting finished 'sourcedata' events saw nothing — or a load in
      // steps, told apart by the data each start was given (loops()). That is read from the event as it happens (its
      // public `source`, the source's style spec at that moment, in Mapbox GL 1.13 and MapLibre 2-6), not when the wait
      // ends: MapLibre 5 and 6 put the data a URL gave into the source once it has loaded, and from then on the source
      // reads as inline GeoJSON.
      const replaced = new Map<string, Starts>();
      const fresh = new WeakSet<Starts>();
      const onSourceData = (e: { sourceId?: string; tile?: unknown; source?: unknown }) => {
        if (!e.sourceId || e.tile) return;
        const now = performance.now();
        const seen = replaced.get(e.sourceId) ?? { n: 0, inline: true, first: now, last: now, overlapping: 0 };
        const next = { ...seen, first: seen.overlapping ? seen.first : now, n: seen.n + 1, last: now, overlapping: seen.overlapping + 1, inline: seen.inline && inlineGeoJSON(e.source) };
        replaced.set(e.sourceId, next);
        fresh.add(next);
        queueMicrotask(() => fresh.delete(next));
      };
      const onSourceLoaded = (e: { sourceId?: string; sourceDataType?: string; tile?: unknown }) => {
        if (!e.sourceId) return;
        const seen = replaced.get(e.sourceId);
        if (!seen) return;
        // A paged loader can start its next request inside the metadata completion event, before our listener
        // runs. isSourceLoaded() is then false again. That same-turn start follows a completed load; it does not
        // overlap it. Timer-driven queued replacements start after this event and retain their sequence.
        if (!e.tile && e.sourceDataType === 'metadata' && fresh.has(seen)) {
          seen.overlapping = 1;
          seen.first = seen.last;
        } else if (this.sourceLoaded(e.sourceId) === true) {
          seen.overlapping = 0;
          seen.first = performance.now();
        }
      };
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.map.off('idle', onIdle);
        this.map.off('render', onRender);
        this.map.off('sourcedataloading', onSourceData as any);
        this.map.off('sourcedata', onSourceLoaded as any);
        this.lastWait = v ? undefined : { frames, ms: performance.now() - started, moving: this.map.isMoving(), loaded: this.map.loaded(), styled: this.hasStyle(), pending: this.pendingSources(), workerSourcesLoaded: this.workerSourcesLoaded(), loops: this.loops(replaced, started) };
        resolve(v);
      };
      this.pendingSources(); // starts the "pending since" clock of every source that is not loaded yet
      this.map.on('render', onRender);
      this.map.on('sourcedataloading', onSourceData as any);
      this.map.on('sourcedata', onSourceLoaded as any);
      const onIdle = () => {
        // 'idle' does not look at tile state of sources that are still fetching after an error
        // retry etc.; areTilesLoaded() is the public belt-and-braces check.
        if (this.map.areTilesLoaded?.() ?? true) finish(true);
        else this.map.triggerRepaint();
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.map.on('idle', onIdle);
      this.map.triggerRepaint();
    });
  }

  private lastWait?: { frames: number; ms: number; moving: boolean; loaded: boolean; styled: boolean; pending: PendingSource[]; workerSourcesLoaded: number; loops: { id: string; n: number }[] };
  /** When each source was first seen not loaded; forgotten when it loads. */
  private readonly pendingSince = new Map<string, number>();

  /**
   * Whether the map has a style it can describe (public getStyle()). It has none while a style it was given is still
   * loading: the first one, or a new one from setStyle(url, { diff: false }), which throws the old one away at once.
   * MapLibre 3-6 return undefined then; MapLibre 2 and Mapbox GL 1.13 throw.
   */
  private hasStyle(): boolean {
    try {
      return Boolean(this.map.getStyle());
    } catch {
      return false;
    }
  }

  private sourceLoaded(id: string): boolean | undefined {
    try {
      return this.map.isSourceLoaded(id);
    } catch {
      return undefined; // (a source removed in between)
    }
  }

  /**
   * Inline GeoJSON re-set at least twice is a loop. Server-backed sources (images, vector tiles, GeoJSON URLs)
   * also count when at least three starts, without becoming loaded between them, span half the wait and continue
   * near its end. One load, two URLs, or a finite burst followed by waiting for the newest load remain loads.
   * This is observed replacement, not inferred from slow loading or rendering. The trade-off: a sustained finite
   * burst can count as never idle during that wait; assertions take their verdict from the current map.
   */
  private loops(starts: Map<string, Starts>, started: number): { id: string; n: number }[] {
    const now = performance.now();
    return [...starts].filter(([, s]) => (s.n >= 2 && s.inline) || (
      s.overlapping >= 3 && s.last - s.first >= (now - started) / 2 &&
      now - s.last <= 1.5 * (s.last - s.first) / (s.overlapping - 1)
    )).map(([id, s]) => ({ id, n: s.n }));
  }

  /** Sources that are not loaded right now (public isSourceLoaded), with their type and how long they have waited. */
  private pendingSources(): PendingSource[] {
    const sources = this.map.getStyle()?.sources ?? {};
    const now = performance.now();
    const out: PendingSource[] = [];
    for (const id of Object.keys(sources)) {
      const loaded = this.sourceLoaded(id);
      if (loaded !== false) {
        this.pendingSince.delete(id);
        continue;
      }
      if (!this.pendingSince.has(id)) this.pendingSince.set(id, now);
      out.push({ id, type: String((sources[id] as { type?: string }).type), inline: inlineGeoJSON(sources[id]), forMs: now - this.pendingSince.get(id)! });
    }
    return out;
  }

  /** How many GeoJSON / vector sources are loaded: each one is proof that MapLibre's workers run. */
  private workerSourcesLoaded(): number {
    const sources = this.map.getStyle()?.sources ?? {};
    return Object.keys(sources).filter((id) => ['geojson', 'vector'].includes(String((sources[id] as { type?: string }).type)) && this.sourceLoaded(id) === true).length;
  }

  /**
   * Why the last waitForIdle() timed out. A map that renders frame after frame while the camera is at rest and
   * every tile is loaded is being ANIMATED by the app (setData / setPaintProperty in a requestAnimationFrame loop,
   * an animated image/canvas/video source): it will never be idle, by design.
   */
  idleDiagnosis(): string | undefined {
    return this.diagnose()?.why;
  }

  /** The last waitForIdle() timed out on a map that never becomes idle by design — not one that is loading, moving or slow. */
  neverIdle(): boolean {
    return this.diagnose()?.never ?? false;
  }

  private diagnose(): { why?: string; never: boolean } | undefined {
    const w = this.lastWait;
    if (!w) return undefined;
    if (w.moving) return { why: 'the camera is moving (an animation or a gesture in progress)', never: false };
    // A map without a style has no sources to call pending, and it may still render frame after frame: after a style
    // switch, MapLibre 3-6 fade the new placement's symbols in for 300 ms (the default fadeDuration). Those frames read
    // as continuous repainting, the map was "never idle", and a .not that names no layer passed on a map with no style.
    // Until its style is in, a map is loading, whatever it renders.
    if (!w.styled) return { why: 'the style has not finished loading (the first one, or a new one from setStyle)', never: false };
    const never = 'Such a map NEVER becomes idle: do not wait for idle here; retrying assertions and actions work without it';
    // Deterministic, whatever the frame rate: an animated canvas source or a video source repaints the map for ever.
    const animated = animatedSources(this.map);
    // Never idle is a verdict about the WHOLE map: while another source is still loading it is not settled either, and a
    // negative assertion must not conclude absence from a source that has not arrived. So the sources that never settle
    // by design are set aside, and only when nothing else is pending is the map "never idle".
    // Repeated overlapping server loads count too (loops()); finite loads remain pending.
    const looping = w.loops.map((r) => r.id);
    const pending = w.pending.filter((p) => !animated.includes(p.id) && !looping.includes(p.id));
    if (!pending.length) {
      if (animated.length) return { why: `source(s) ${animated.join(', ')}: an animated canvas / video source repaints the map on every frame. ${never}`, never: true };
      // OBSERVED, not inferred: the data of a source was replaced again and again while we waited. (The first version
      // inferred it from "a GeoJSON source is pending and frames are rendered" and blamed a setData loop on an app that
      // merely loaded slowly on an overloaded machine. A wrong diagnosis is worse than none.)
      if (w.loops.length) return { why: `the app keeps replacing the data of source(s) ${w.loops.map((r) => `${r.id} (${r.n} times in ${Math.round(w.ms)}ms)`).join(', ')} — setData in a requestAnimationFrame loop or a timer. ${never}`, never: true };
    }
    // Before "tiles are still loading": inline GeoJSON needs no network, so a dead worker is the stronger explanation.
    const dead = deadWorkerDiagnosis(pending, w.workerSourcesLoaded);
    if (dead) return { why: dead, never: false };
    const tiled = pending.filter((p) => ['vector', 'raster', 'raster-dem'].includes(p.type));
    if (tiled.length) return { why: `tiles of source(s) ${tiled.map((p) => p.id).join(', ')} are still loading (a slow or unanswered tile request?)`, never: false };
    if (pending.length) return { why: `source(s) ${pending.map((p) => p.id).join(', ')} have not finished loading`, never: false };
    // (loaded() stays false for a map with an animated source, so it cannot be a condition here)
    // Few frames prove nothing: a page that is merely SLOW (software GL on a starved CI machine: 3 frames in 2.5s) looks
    // the same as one that animates. Found on Linux in a container, where this line accused five static apps of animating.
    const fps = w.frames / (w.ms / 1000);
    if (w.frames >= 10 && fps >= 4) return { why: `the map rendered ${w.frames} frames in ${Math.round(w.ms)}ms with the camera at rest and no source loading: the app repaints it continuously (a paint property in a requestAnimationFrame loop, an animated image). ${never}`, never: true };
    if (w.frames >= 2) return { why: `the map rendered ${w.frames} frames in ${Math.round(w.ms)}ms (${fps.toFixed(1)} per second) with the camera at rest and no source loading. Either the page is slow and still settling (raise the timeout: test.slow()), or the app repaints the map continuously — in which case it never becomes idle and waiting for idle is the mistake`, never: false };
    return { why: w.loaded ? undefined : 'the style or a source has not finished loading', never: false };
  }

  visibility(f: RenderedFeature): Visibility {
    return paintVisibility(this.map, f);
  }

  explainInvisible(f: RenderedFeature): StyleCause[] {
    return explainPaint(this.map, f);
  }

  explainLayerHidden(layer: string): StyleCause[] {
    return explainLayerHidden(this.map, layer);
  }

  colour(f: RenderedFeature) {
    return paintColour(this.map, f);
  }

  filterAdmits(f: RenderedFeature): boolean | undefined {
    return filterAdmits(this.map, f);
  }

  /**
   * A vertical metre at a ground point appears as (local scale across the view direction) x sin(pitch)
   * pixels. The scale is measured along the screen's horizontal, which pitch does not foreshorten.
   * Public API only (project/unproject); perspective makes it approximate, the hit test makes it safe.
   */
  lift(f: RenderedFeature, at: PixelPoint): number {
    return this.liftOf(extrusionHeight(this.map, f), at);
  }

  liftBase(f: RenderedFeature, at: PixelPoint): number {
    return this.liftOf(extrusionBase(this.map, f), at);
  }

  private liftOf(height: number, at: PixelPoint): number {
    const pitch = this.map.getPitch();
    if (!pitch) return 0;
    if (!height) return 0;
    const metres = this.map.unproject([at.x, at.y]).distanceTo(this.map.unproject([at.x + 10, at.y]));
    return metres > 0 ? height * (10 / metres) * Math.sin((pitch * Math.PI) / 180) : 0;
  }

  wrapPx(): number | undefined {
    if (projectionOf(this.map).globe || !(this.map.getRenderWorldCopies?.() ?? true)) return undefined;
    const c = this.map.getCenter();
    const a = this.map.project([c.lng, c.lat]), b = this.map.project([c.lng + 360, c.lat]);
    // The period is a horizontal pixel distance only on an unrotated map; rotated, the next copy is also up or down
    // and folding x alone would pair the wrong pieces. No folding then: a copy counts as another piece.
    if (Math.abs(b.y - a.y) > 0.5) return undefined;
    const w = b.x - a.x;
    return w > 0 && w < this.map.getCanvas().clientWidth * 2 ? w : undefined; // only when a second copy can be on screen
  }

  whyNotRendered(f: RenderedFeature): string | undefined {
    const icon = missingIcon(this.map, f);
    return icon ? `its icon image "${icon}" is not in the style (missing from the sprite / never added): MapLibre draws nothing for it` : undefined;
  }

  caveats(): string[] {
    const out = unparseableReasons(this.map).map(([p, why]) =>
      why === 'newer'
        ? `visibility unknown for layer ${p} — unsupported expression (newer than the bundled style-spec evaluator); treated as visible`
        : `visibility unknown for layer ${p} — "${why}" depends on the feature's tile geometry, which the style evaluator does not have; treated as visible`,
    );
    for (const p of nullUncertainProperties(this.map)) out.push(`visibility uncertain for layer ${p} — it tests ['has', …] on a GeoJSON property that may be there with the value null (MapLibre draws with it; the hit test drops it); treated as visible`);
    for (const p of zoomUncertainProperties(this.map)) out.push(`visibility uncertain for layer ${p} — a zoom-and-data expression is drawn per tile zoom, and tile zooms vary across this view (pitch, terrain or globe); treated as visible where some tile zoom draws it`);
    // What THIS version of the map library cannot do (feature-detected). Said once, in diagnostics and the snapshot.
    if (typeof this.map.redraw !== 'function') out.push('this map library version has no synchronous redraw(): the pixel probe renders through the frame loop instead (four real frames; the frame without the layer may be seen as a one-frame flicker)');
    if (typeof this.map.getLayersOrder !== 'function') out.push('this map library version has no getLayersOrder(): custom layers (a WebGL overlay such as deck.gl\'s) are missing from the layer order it reports, so an action does not check one drawn over its target, and layers() and this snapshot do not list them');
    if (this.geojsonWithoutData().length) out.push(`source(s) ${this.geojsonWithoutData().join(', ')}: this map library version has no GeoJSONSource.getData() and the source was given a URL — features outside the viewport and full geometries are unknowable (as for tiled sources)`);
    return out;
  }

  private geojsonWithoutData(): string[] {
    const sources = this.map.getStyle()?.sources ?? {};
    return Object.keys(sources).filter((id) => {
      const s = this.map.getSource(id) as GeoJSONSource | undefined;
      return s?.type === 'geojson' && typeof s.getData !== 'function' && typeof (s.serialize?.() as { data?: unknown } | undefined)?.data === 'string';
    });
  }

  /**
   * Pixel probe. A WebGL canvas without preserveDrawingBuffer reads back zeros — except in the
   * same task as the draw. `redraw()` (public, MapLibre >= 2) renders synchronously, so: draw, read, draw, read again
   * (the CONTROL), hide the layer, draw, read, restore, draw (and read, where it was hidden by its opacity). All in one
   * task, so the intermediate frame is never composited (no flicker). Costs four renders (~50ms each on SwiftShader)
   * and fires 'styledata' — a probe, not something to run per poll. The layer is hidden by its opacity; only where
   * that is data-driven (or the type has none) by `visibility`, and then MapLibre reloads the layer's source afterwards
   * (see hide below).
   *
   * The control reads: the "with" and "without" reads are compared, and pixels that change BY THEMSELVES (an overlay
   * whose colour is in a paint transition, a fade, an animation under the feature, a camera that never stops) would
   * pass for the layer's contribution. So the layer-on pixels are read twice before the hide and, where the layer was
   * hidden by its opacity, once more after the restore; hiding the layer must change them by clearly more than they
   * change by themselves (signal against noise: `verdict`); otherwise there is no verdict yet: inconclusive. Hidden by
   * `visibility`, the layer is not drawn again until its source has reloaded, so there is no read after the restore:
   * there a change of one colour level at most is no verdict either, and pixels that change faster only while the
   * layer is hidden can still pass for a contribution — as a transition in progress under the feature can on MapLibre
   * 2–4, which advance it only on a style change, such as the probe's own hide.
   *
   * Without redraw() (Mapbox GL JS v1) the same reads happen inside the public 'render' event, which
   * fires in the task that drew the frame: triggerRepaint(), read on 'render'. Four REAL frames — the one
   * without the layer can be composited (a one-frame flicker), and it takes as long as four frames take: within
   * `budgetMs` (the caller's remaining time), or inconclusive — "not yet", never "no pixels".
   */
  pixelContribution(layer: string, at: PixelPoint, radiusPx = 2): number | undefined | Promise<number | undefined> {
    const r = this.probePixels(layer, at, radiusPx, 2000);
    const diff = (p: ProbeResult) => ('diff' in p ? p.diff : undefined);
    return r instanceof Promise ? r.then(diff) : diff(r);
  }

  probePixels(layer: string, at: PixelPoint, radiusPx = 2, budgetMs = 2000): ProbeResult | Promise<ProbeResult> {
    const canvas = this.map.getCanvas();
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { unavailable: 'no WebGL context to read from' };
    if (!this.map.getLayer(layer)) return { unavailable: `layer "${layer}" does not exist` };
    // not `=== 'none'`: since MapLibre 5.16 visibility may be an expression on global state
    if (!layoutVisible(this.map, layer)) return { unavailable: `layer "${layer}" is hidden` };
    const dpr = canvas.width / canvas.clientWidth;
    const R = Math.max(1, Math.round(radiusPx * dpr)); // radiusPx is in CSS pixels, as every other pixel here: (2R+1)² device pixels
    const grab = () => {
      const px = new Uint8Array(4 * (2 * R + 1) ** 2);
      gl.readPixels(Math.round(at.x * dpr) - R, canvas.height - Math.round(at.y * dpr) - R - 1, 2 * R + 1, 2 * R + 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const difference = (a: Uint8Array, b: Uint8Array) => {
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
      return diff;
    };
    const largestStep = (a: Uint8Array, b: Uint8Array) => {
      let step = 0;
      for (let i = 0; i < a.length; i++) step = Math.max(step, Math.abs(a[i] - b[i]));
      return step;
    };
    // Signal against noise. `noise`: how much the pixels changed by themselves between reads with the layer drawn — the
    // two before the hide (the control) and, where the layer is drawn again in the frame that restores it (hidden by its
    // opacity), the one before the hide against the one after the restore, which spans the hide. Hiding the layer must
    // change the pixels by clearly more than that (twice: a steady drift over one more read gives about the same again).
    // The span matters: pixels drift in whole 8-bit levels, so a level can move between the read with the layer and the
    // read without it and not between the two reads before (a control of 0) — an overlay's own colour change taken for
    // the layer showing through it. Across the span a drift moves the pixels at least as far as across the hide, which
    // never counts. Without the span (hidden by `visibility`, or no frame after the restore in time) a change of at most
    // one level everywhere, after a control of 0, is no verdict: a slow drift between two reads looks just like that.
    const verdict = (first: Uint8Array, withLayer: Uint8Array, without: Uint8Array, after?: Uint8Array): ProbeResult => {
      const diff = difference(withLayer, without);
      const noise = Math.max(difference(first, withLayer), after ? difference(withLayer, after) : 0);
      if (noise > 0 && diff <= 2 * noise) return { inconclusive: `the pixels there changed by ${noise} between two reads with the layer drawn, and hiding the layer changed them by ${diff}, not clearly more than that — something is animating or still fading in there` };
      if (noise === 0 && !after && diff > 0 && largestStep(withLayer, without) <= 1) return { inconclusive: `hiding the layer changed the pixels there by one colour level at most (${diff} in all), which is also what pixels changing colour by themselves do between two reads — something may be fading there, or the layer draws next to nothing` };
      return { diff };
    };
    // Hide the layer by its opacity where that reloads nothing (reloadFreeOpacity): hidden by `visibility: none`, the
    // layer's source reloads, and the tiles that come back lack the layer, so right after the probe the feature is
    // missing from the rendering and the hit test until a second reload lands. Set with a zero transition, so the
    // hide and the restore are instant; the app's transitions go back only after a frame has drawn the restored value
    // (before that, the restore itself would fade in). An opacity transition the app had in progress ends at its target.
    const opacity = reloadFreeOpacity(this.map, layer);
    // Hidden by `visibility`: what its reload must bring back before the layer counts as drawn again, and what the app had
    // then (settleAfterProbe). Taken before the first read, never between reads: the hit test of a whole layer takes as long
    // as several renders on a big one, and taken in the hide it put that time between the second read with the layer and
    // the read without it. An overlay changing colour by itself moved further across the hide than between the two reads
    // before it, and passed for the layer showing through.
    const start = opacity ? undefined : this.reloadStart(layer);
    const saved: { name: string; value: unknown; transition: unknown }[] = [];
    // Put back what the app had: since MapLibre 5.16 visibility may be an EXPRESSION on global state, and writing back
    // the constant "visible" replaced it (and turned on a layer the app had hidden). A visibility the app never set is
    // put back unset (undefined: every version takes it without validating and draws the layer; an explicit "visible"
    // showed up in the app's getLayoutProperty() and getStyle()). Read right before hiding, and put back only if it is
    // still the probe's own value (the app may have set something else in between).
    let restore: unknown;
    const hide = () => {
      if (!opacity) {
        this.reloads.set(layer, start!);
        restore = this.map.getLayoutProperty(layer, 'visibility');
        this.map.setLayoutProperty(layer, 'visibility', 'none');
        return;
      }
      for (const name of opacity) {
        saved.push({ name, value: this.map.getPaintProperty(layer, name as any), transition: this.map.getPaintProperty(layer, `${name}-transition` as any) });
        this.map.setPaintProperty(layer, `${name}-transition` as any, { duration: 0, delay: 0 });
        this.map.setPaintProperty(layer, name as any, 0);
      }
    };
    const unhide = () => {
      if (!opacity) {
        if (this.map.getLayoutProperty(layer, 'visibility') === 'none') this.map.setLayoutProperty(layer, 'visibility', restore as any);
        return;
      }
      for (const s of saved) if (this.map.getPaintProperty(layer, s.name as any) === 0) this.map.setPaintProperty(layer, s.name as any, s.value);
    };
    const restoreTransitions = () => {
      if (!this.map.getLayer(layer)) return;
      for (const s of saved) {
        const t = this.map.getPaintProperty(layer, `${s.name}-transition` as any) as { duration?: number; delay?: number } | undefined;
        if (t?.duration === 0 && t.delay === 0) this.map.setPaintProperty(layer, `${s.name}-transition` as any, s.transition);
      }
    };
    const reloading = (r: ProbeResult): ProbeResult => (!opacity && 'diff' in r ? { ...r, reloads: true } : r);
    if (typeof this.map.redraw === 'function') {
      const read = () => (this.map.redraw(), grab());
      const first = read();
      const withLayer = read();
      let without: Uint8Array;
      let after: Uint8Array | undefined;
      try {
        hide();
        without = read();
      } finally {
        unhide();
        this.map.redraw();
        if (opacity) after = grab(); // drawn again in this frame (by `visibility`, not until its source has reloaded)
        restoreTransitions();
      }
      return reloading(verdict(first, withLayer, without, after));
    }
    // (a browser's timer delay is a 32-bit number: beyond it, as for Infinity, the timer fires at once)
    const deadline = performance.now() + Math.min(Math.max(0, budgetMs), 2 ** 31 - 1);
    const frame = () =>
      new Promise<Uint8Array | undefined>((resolve) => {
        // A hidden tab renders no frames; a starved machine renders them late. Either way: not within the budget.
        const timer = setTimeout(() => (this.map.off('render', onRender), resolve(undefined)), Math.max(0, deadline - performance.now()));
        const onRender = () => (clearTimeout(timer), this.map.off('render', onRender), resolve(grab()));
        this.map.on('render', onRender);
        this.map.triggerRepaint();
      });
    const late: ProbeResult = { inconclusive: `no frame was rendered within ${Math.round(budgetMs)}ms (a slow machine, or a hidden tab, which renders none)` };
    return (async (): Promise<ProbeResult> => {
      const first = await frame();
      const withLayer = first && (await frame());
      if (!first || !withLayer) return late;
      let without: Uint8Array | undefined;
      try {
        hide();
        without = await frame();
      } finally {
        unhide();
        if (saved.length) this.map.once('render', restoreTransitions);
        this.map.triggerRepaint();
      }
      if (!without) return late;
      // the frame that restores the layer: drawn again in it where it was hidden by its opacity (none in time: no span)
      const after = opacity ? await frame() : undefined;
      return reloading(verdict(first, withLayer, without, after));
    })();
  }

  /** `sourcedata` events per source, counted from the first gate on: what an overlay draws may have changed since. */
  private dataEvents?: Map<string, number>;

  /** Data replacements per source (`sourcedataloading` without a tile: setData, a new URL), counted from the first ask on. */
  private dataVersions?: Map<string, number>;

  dataVersion(source: string): number {
    if (!this.dataVersions) {
      const versions = (this.dataVersions = new Map());
      this.map.on('sourcedataloading', (e: { sourceId?: string; tile?: unknown }) => void (e.sourceId && !e.tile && versions.set(e.sourceId, (versions.get(e.sourceId) ?? 0) + 1)));
    }
    return this.dataVersions.get(source) ?? 0;
  }

  pixelOnly(layer: string): boolean {
    return isPixelOnlyType(this.map.getLayer(layer)?.type);
  }

  pixelOccluders(layer: string, at: PixelPoint): PixelOccluder[] {
    if (!this.dataEvents) {
      const counts = (this.dataEvents = new Map());
      this.map.on('sourcedata', (e: { sourceId?: string }) => void (e.sourceId && counts.set(e.sourceId, (counts.get(e.sourceId) ?? 0) + 1)));
    }
    const counts = this.dataEvents;
    return pixelOccluders(this.map, layer, at, this.layerIds(), (source) => counts.get(source) ?? 0);
  }

  /** Per layer, set by a probe that hides it by `visibility`: what it was before the probe (settleAfterProbe). */
  private reloads = new Map<string, ReloadStart>();

  private reloadStart(layer: string): ReloadStart {
    const source = this.map.getLayer(layer)?.source;
    return {
      had: this.queryFeatures({ layers: [layer] }).length > 0,
      filter: JSON.stringify(this.map.getFilter(layer) ?? null),
      data: source === undefined ? 0 : this.dataVersion(source),
      ...this.drawnWith(),
    };
  }

  /** What else decides which features the hit test finds, besides the layer's own filter and visibility and its source. */
  private drawnWith(): { camera: string; global: string } {
    const c = this.map.getCenter();
    return {
      camera: JSON.stringify([c.lng, c.lat, this.map.getZoom(), this.map.getBearing(), this.map.getPitch()]),
      // global state: where the map has it (not MapLibre 2-4, Mapbox GL 1)
      global: typeof this.map.getGlobalState === 'function' ? JSON.stringify(this.map.getGlobalState() ?? null) : '',
    };
  }

  /**
   * After a probe that hid the layer by `visibility` (its opacity is data-driven): MapLibre reloads the layer's source,
   * and the tiles that come back first lack the layer. On Mapbox GL v1 the reload starts only in the next frame.
   * So: a frame, then the source loaded again and, where the layer had features in the hit test before the probe, some
   * again — checked on every rendered frame, within the budget. The source loaded is not enough for a symbol layer: its
   * features are hit-tested again only once they have been placed again, and a read right after a matcher that waited
   * for the source alone missed a symbol every time (MapLibre 6).
   *
   * The app may take the layer's features away meanwhile (a selected marker removed after a click: new data, a filter,
   * the layer hidden). They never come back then, and the wait for them lasted the caller's whole budget: a matcher's
   * `.not` then reported the "visible" of a feature that was gone. So that wait also ends at once when the layer has been
   * hidden since the probe, and otherwise when the map goes idle: by then every symbol has been placed again too, however
   * long the app's fade duration. A map seen never to go idle (repaint on, an animated canvas or video source, or so
   * diagnosed by the last waitForIdle) gives up on them once its source has been loaded again for SETTLE_GRACE_MS and
   * SETTLE_GRACE_FRAMES: there, too, the wait lasted the whole budget. Only such a map: on one that goes idle, a give-up
   * after a fixed time ended the wait before a symbol placed after a longer fade (an app's `fadeDuration`) was back. A map
   * the app animates otherwise (a paint property or the global state set on every frame) is not seen as one: there a
   * change since the probe of the layer's filter, its source's data, the camera or the global state (which may have taken
   * the features away, or not) starts that give-up too, and a change none of the checks see (the layer's zoom range)
   * still waits out the budget. Such a change does not end the wait by itself: it need not take anything away (the same
   * marker set again, a filter that keeps it, a camera moved by a hair, the global state of another layer set on every
   * frame), and a symbol is hit-tested again only at the next placement, so a read right after the matcher missed it (18
   * reads in 18; 4 in 6 after new data or a new filter). A live feed, a filter animation or a camera moved on to new
   * tiles reloads the source at every step, and a frame with the source not loaded restarts the give-up's count:
   * restarted at every step, a step every 250 or 500 ms kept it from completing, and `.not` failed with "visible" on a
   * feature the app took away or out of view (8 in 8 each). After any change that starts the give-up it restarts only
   * once, at the first reload after it: `.not` then passes in 1.9 to 2.2 s under a feed (1.4 to 2.1 s when the change
   * ended the wait) and in 2.0 to 2.7 s under the camera's steps, on a map that never goes idle. The give-up still
   * needs SETTLE_GRACE_FRAMES rendered frames with the source loaded after that reload (read from the code), so a
   * source loaded in fewer within the budget still waits it out: a feed about as fast as the reload (3000 points set on
   * every frame) did in 11 runs of 16 on a loaded machine, with the source loaded in 0 to 3 frames, and in none of 4
   * alone.
   */
  settleAfterProbe(layer: string, budgetMs: number): Promise<boolean> {
    const source = this.map.getLayer(layer)?.source;
    const start = this.reloads.get(layer);
    this.reloads.delete(layer);
    let idle = false;
    const onIdle = () => void (idle = true);
    const loaded = () => {
      try {
        return !source || !this.map.getSource(source) || this.map.isSourceLoaded(source);
      } catch {
        return true;
      }
    };
    // the layer hidden since the probe: its features are gone until the app shows it again, and the wait ends at once
    const hidden = () => !layoutVisible(this.map, layer);
    // the app's own change of the layer since the probe: a new filter, or new data in its source
    const layerChanged = () => {
      if (!start) return false;
      try {
        return JSON.stringify(this.map.getFilter(layer) ?? null) !== start.filter || (source !== undefined && this.dataVersion(source) !== start.data);
      } catch {
        return false;
      }
    };
    // that, the camera or the global state changed since the probe: the features may be gone for good, or merely not
    // placed again yet; the grace below decides, not the change itself
    const drawnChanged = () => {
      if (!start) return false;
      try {
        const now = this.drawnWith();
        return now.camera !== start.camera || now.global !== start.global || layerChanged();
      } catch {
        return false;
      }
    };
    // the grace below: only on a map seen never to go idle (its `repaint` is read on every frame)
    let neverIdle = false;
    try {
      neverIdle = this.neverIdle() || animatedSources(this.map).length > 0;
    } catch {
      // no style to read: not seen
    }
    const back = () => {
      try {
        return !start?.had || !this.map.getLayer(layer) || idle || hidden() || this.queryFeatures({ layers: [layer] }).length > 0;
      } catch {
        return true;
      }
    };
    // Since when, and for how many rendered frames, the source has been loaded again (it loads again after a camera move).
    let loadedSince = 0;
    let loadedFrames = 0;
    // A frame with the source not loaded restarts that count, but after a change that starts the give-up (the layer's
    // filter, its source's data, the camera or the global state) only once, at the first reload after it. A live feed,
    // a filter animation or a camera moved on to new tiles reloads the source again at every step, and with the count
    // restarted at each, a step every 250 or 500 ms kept it from completing: the wait lasted the whole budget. (Set
    // after the app's new filter or new data alone, the camera's steps still restarted it.)
    let restartedForChange = false;
    return new Promise((resolve) => {
      const done = (ok: boolean) => (clearTimeout(timer), this.map.off('render', onRender), this.map.off('idle', onIdle), resolve(ok));
      const timer = setTimeout(() => done(false), Math.min(Math.max(0, budgetMs), 2 ** 31 - 1));
      const onRender = () => {
        if (!loaded()) {
          if (!restartedForChange) loadedFrames = 0;
          if (drawnChanged()) restartedForChange = true;
          return this.map.triggerRepaint();
        }
        if (loadedFrames++ === 0) loadedSince = performance.now();
        const givenUp = loadedFrames >= SETTLE_GRACE_FRAMES && performance.now() - loadedSince >= SETTLE_GRACE_MS && (neverIdle || this.map.repaint || drawnChanged());
        return back() || givenUp ? done(true) : this.map.triggerRepaint();
      };
      this.map.on('idle', onIdle);
      this.map.on('render', onRender);
      this.map.triggerRepaint();
    });
  }

  /**
   * Markers and popups, found by MapLibre's documented CSS classes inside this map's container
   * (there is no public `map.getMarkers()`). A popup's anchor pixel follows from its
   * `maplibregl-popup-anchor-<side>` class: the tip sits on that side of its box.
   * The class prefix is `mapboxgl-` on Mapbox GL JS v1 and MapLibre 1; MapLibre 2 writes both.
   */
  overlays(): Overlay[] {
    const container = this.map.getContainer();
    // Surface pixels, like everything else the engine compares: under a CSS transform: scale() the client box is scaled.
    const frame = clientFrame(this.map.getCanvas());
    const out: Overlay[] = [];
    const prefix = container.classList.contains('maplibregl-map') ? 'maplibregl' : 'mapboxgl';
    for (const [kind, selector] of [['marker', `.${prefix}-marker`], ['popup', `.${prefix}-popup`]] as const) {
      // Scoped to the container, not the document: a map inside a web component's shadow root is invisible to a
      // document-wide query, and another map's overlays are not this one's.
      container.querySelectorAll(selector).forEach((el, index) => {
        const r = el.getBoundingClientRect();
        const topLeft = toSurface(frame, { x: r.left, y: r.top });
        const rect = { x: topLeft.x, y: topLeft.y, width: r.width / frame.sx, height: r.height / frame.sy };
        const side = [...el.classList].find((c) => c.startsWith(`${prefix}-${kind}-anchor-`))?.slice(`${prefix}-${kind}-anchor-`.length);
        let anchor: PixelPoint | undefined;
        if (side && kind === 'popup') {
          anchor = {
            x: side.includes('left') ? rect.x : side.includes('right') ? rect.x + rect.width : rect.x + rect.width / 2,
            y: side.startsWith('top') ? rect.y : side.startsWith('bottom') ? rect.y + rect.height : rect.y + rect.height / 2,
          };
        }
        // innerText-like: the popup's close button ("×") is chrome, not content
        const text = [...(el.querySelector(`.${prefix}-popup-content`) ?? el).childNodes]
          .filter((n) => !(n instanceof Element && n.classList.contains(`${prefix}-popup-close-button`)))
          .map((n) => n.textContent ?? '')
          .join(' ');
        out.push({ kind, selector, index, rect, anchor, text: text.replace(/\s+/g, ' ').trim().slice(0, 200) });
      });
    }
    return out;
  }

  overlayElement(o: Overlay): Element | undefined {
    return this.map.getContainer().querySelectorAll(o.selector)[o.index];
  }

  subscribe(cb: () => void): () => void {
    this.map.on('idle', cb);
    return () => this.map.off('idle', cb);
  }

  async reveal(w: LngLat): Promise<void> {
    this.map.jumpTo({ center: [w.lng, w.lat] });
  }
}

/** A layer before a probe hid it by `visibility`: features in the hit test, its filter, its source's data version, the camera and the global state. */
type ReloadStart = { had: boolean; filter: string; data: number; camera: string; global: string };

/** The sources that repaint the map on every frame: a video source, a canvas source that animates. */
function animatedSources(map: MlMap): string[] {
  const sources = map.getStyle()?.sources ?? {};
  return Object.keys(sources).filter((id) => {
    const spec = sources[id] as { type?: string; animate?: boolean };
    return spec.type === 'video' || (spec.type === 'canvas' && spec.animate !== false);
  });
}

function toRendered(f: MapGeoJSONFeature): InternalRenderedFeature {
  return {
    layer: f.layer.id,
    source: f.source,
    sourceLayer: f.sourceLayer || undefined,
    id: f.id,
    properties: (f.properties ?? {}) as Record<string, unknown>,
    geometry: f.geometry as Geometry,
    state: f.state as Record<string, unknown> | undefined,
  };
}
