import type { Map as MlMap, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import { explainLayerHidden, explainPaint, extrusionBase, extrusionHeight, layoutVisible, missingIcon, paintColour, paintVisibility, projectionOf, unparseableReasons, zoomUncertainProperties } from './maplibre-paint';
import type { Geometry, LayerInfo, LngLat, Overlay, Pt, RenderedFeature, Visibility } from './types';
import type { InternalCanvasAdapter, ProbeResult, StyleCause } from './types-internal';

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

  project(w: LngLat): Pt {
    const p = this.map.project([w.lng, w.lat]);
    return { x: p.x, y: p.y };
  }

  unproject(pt: Pt): LngLat {
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

  queryFeatures(q: { layers?: string[]; at?: Pt }): RenderedFeature[] {
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
      // abandoned before they finish, which is why counting finished 'sourcedata' events saw nothing.
      const replaced = new Map<string, number>();
      const onSourceData = (e: { sourceId?: string; tile?: unknown }) => {
        if (e.sourceId && !e.tile) replaced.set(e.sourceId, (replaced.get(e.sourceId) ?? 0) + 1);
      };
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.map.off('idle', onIdle);
        this.map.off('render', onRender);
        this.map.off('sourcedataloading', onSourceData as any);
        this.lastWait = v ? undefined : { frames, ms: performance.now() - started, moving: this.map.isMoving(), loaded: this.map.loaded(), pending: this.pendingSources(), workerSourcesLoaded: this.workerSourcesLoaded(), replaced: [...replaced].filter(([, n]) => n >= 2).map(([id, n]) => ({ id, n })) };
        resolve(v);
      };
      this.pendingSources(); // starts the "pending since" clock of every source that is not loaded yet
      this.map.on('render', onRender);
      this.map.on('sourcedataloading', onSourceData as any);
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

  private lastWait?: { frames: number; ms: number; moving: boolean; loaded: boolean; pending: PendingSource[]; workerSourcesLoaded: number; replaced: { id: string; n: number }[] };
  /** When each source was first seen not loaded; forgotten when it loads. */
  private readonly pendingSince = new Map<string, number>();

  private sourceLoaded(id: string): boolean | undefined {
    try {
      return this.map.isSourceLoaded(id);
    } catch {
      return undefined; // (a source removed in between)
    }
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
      const spec = sources[id] as { type?: string; data?: unknown };
      out.push({ id, type: String(spec.type), inline: spec.type === 'geojson' && typeof spec.data === 'object' && spec.data !== null, forMs: now - this.pendingSince.get(id)! });
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
    const never = 'Such a map NEVER becomes idle: do not wait for idle here; retrying assertions and actions work without it';
    // Deterministic, whatever the frame rate: an animated canvas source or a video source repaints the map for ever.
    const sources = this.map.getStyle()?.sources ?? {};
    const animated = Object.keys(sources).filter((id) => {
      const spec = sources[id] as { type?: string; animate?: boolean };
      return spec.type === 'video' || (spec.type === 'canvas' && spec.animate !== false);
    });
    if (animated.length) return { why: `source(s) ${animated.join(', ')}: an animated canvas / video source repaints the map on every frame. ${never}`, never: true };
    // OBSERVED, not inferred: the data of a source was replaced again and again while we waited. (The first version
    // inferred it from "a GeoJSON source is pending and frames are rendered" and blamed a setData loop on an app that
    // merely loaded slowly on an overloaded machine. A wrong diagnosis is worse than none.)
    if (w.replaced.length) return { why: `the app keeps replacing the data of source(s) ${w.replaced.map((r) => `${r.id} (${r.n} times in ${Math.round(w.ms)}ms)`).join(', ')} — setData in a requestAnimationFrame loop or a timer. ${never}`, never: true };
    // Before "tiles are still loading": inline GeoJSON needs no network, so a dead worker is the stronger explanation.
    const dead = deadWorkerDiagnosis(w.pending, w.workerSourcesLoaded);
    if (dead) return { why: dead, never: false };
    const tiled = w.pending.filter((p) => ['vector', 'raster', 'raster-dem'].includes(p.type));
    if (tiled.length) return { why: `tiles of source(s) ${tiled.map((p) => p.id).join(', ')} are still loading (a slow or unanswered tile request?)`, never: false };
    if (w.pending.length) return { why: `source(s) ${w.pending.map((p) => p.id).join(', ')} have not finished loading`, never: false };
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

  /**
   * A vertical metre at a ground point appears as (local scale across the view direction) x sin(pitch)
   * pixels. The scale is measured along the screen's horizontal, which pitch does not foreshorten.
   * Public API only (project/unproject); perspective makes it approximate, the hit test makes it safe.
   */
  lift(f: RenderedFeature, at: Pt): number {
    return this.liftOf(extrusionHeight(this.map, f), at);
  }

  liftBase(f: RenderedFeature, at: Pt): number {
    return this.liftOf(extrusionBase(this.map, f), at);
  }

  private liftOf(height: number, at: Pt): number {
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
    const out = unparseableReasons().map(([p, why]) =>
      why === 'newer'
        ? `visibility unknown for layer ${p} — unsupported expression (newer than the bundled style-spec evaluator); treated as visible`
        : `visibility unknown for layer ${p} — "${why}" depends on the feature's tile geometry, which the style evaluator does not have; treated as visible`,
    );
    for (const p of zoomUncertainProperties()) out.push(`visibility uncertain for layer ${p} — a zoom-and-data expression is drawn per tile zoom, and tile zooms vary across this view (pitch, terrain or globe); treated as visible where some tile zoom draws it`);
    // What THIS version of the map library cannot do (feature-detected). Said once, in diagnostics and the snapshot.
    if (typeof this.map.redraw !== 'function') out.push('this map library version has no synchronous redraw(): the pixel probe renders through the frame loop instead (three real frames; the frame without the layer may be seen as a one-frame flicker)');
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
   * (the CONTROL), hide the layer, draw, read, restore, draw. All in one task, so the intermediate frame is never
   * composited (no flicker). Costs four renders (~50ms each on SwiftShader), fires 'styledata'
   * and makes MapLibre reload the layer's source afterwards — a probe, not something to run per poll.
   *
   * The control read: the "with" and "without" reads are compared, and pixels that change BY THEMSELVES (a
   * fade, an animation under the feature, a camera that never stops) would pass for the layer's contribution. So the
   * layer-on pixels are read twice, and hiding the layer must change them by clearly more than they change by
   * themselves (signal against noise); otherwise there is no verdict yet: inconclusive. Not a control after the
   * restore: the layer is not drawn again until its source has reloaded. MapLibre 2–4 advance a paint transition only
   * on a style change — the probe's own hide is one — so there a transition in progress under the feature can still
   * pass for a contribution.
   *
   * Without redraw() (Mapbox GL JS v1) the same reads happen inside the public 'render' event, which
   * fires in the task that drew the frame: triggerRepaint(), read on 'render'. Four REAL frames — the one
   * without the layer can be composited (a one-frame flicker), and it takes as long as four frames take: within
   * `budgetMs` (the caller's remaining time), or inconclusive — "not yet", never "no pixels".
   */
  pixelContribution(layer: string, at: Pt, radiusPx = 2): number | undefined | Promise<number | undefined> {
    const r = this.probePixels(layer, at, radiusPx, 2000);
    const diff = (p: ProbeResult) => ('diff' in p ? p.diff : undefined);
    return r instanceof Promise ? r.then(diff) : diff(r);
  }

  probePixels(layer: string, at: Pt, radiusPx = 2, budgetMs = 2000): ProbeResult | Promise<ProbeResult> {
    const canvas = this.map.getCanvas();
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { unavailable: 'no WebGL context to read from' };
    if (!this.map.getLayer(layer)) return { unavailable: `layer "${layer}" does not exist` };
    // not `=== 'none'`: since MapLibre 5.16 visibility may be an expression on global state
    if (!layoutVisible(this.map, layer)) return { unavailable: `layer "${layer}" is hidden` };
    const dpr = canvas.width / canvas.clientWidth;
    const R = Math.max(1, Math.round(radiusPx)); // (2R+1)² device pixels around the point
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
    // Signal against noise: the reads with the layer drawn differ by `control` by themselves; hiding the layer must change
    // the pixels by clearly more than that (twice: a steady drift over one more read gives about the same again).
    const verdict = (control: number, diff: number): ProbeResult =>
      control === 0 || diff > 2 * control
        ? { diff }
        : { inconclusive: `the pixels there changed by ${control} between two reads with the layer drawn, and hiding the layer changed them by ${diff}, not clearly more than that — something is animating or still fading in there` };
    // Put back what the app had: since MapLibre 5.16 visibility may be an EXPRESSION on global state, and writing back
    // the constant "visible" replaced it (and turned on a layer the app had hidden). Read right before hiding, and put
    // back only if it is still the probe's own "none" (the app may have set something else in between).
    let restore: unknown;
    const hide = () => {
      restore = this.map.getLayoutProperty(layer, 'visibility') ?? 'visible';
      this.map.setLayoutProperty(layer, 'visibility', 'none');
    };
    const unhide = () => {
      if (this.map.getLayoutProperty(layer, 'visibility') === 'none') this.map.setLayoutProperty(layer, 'visibility', restore as any);
    };
    if (typeof this.map.redraw === 'function') {
      const read = () => (this.map.redraw(), grab());
      const first = read();
      const withLayer = read();
      let without: Uint8Array;
      try {
        hide();
        without = read();
      } finally {
        unhide();
        this.map.redraw();
      }
      return verdict(difference(first, withLayer), difference(withLayer, without));
    }
    const deadline = performance.now() + Math.max(0, budgetMs);
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
        this.map.triggerRepaint();
      }
      return without ? verdict(difference(first, withLayer), difference(withLayer, without)) : late;
    })();
  }

  /**
   * Markers and popups, found by MapLibre's documented CSS classes inside this map's container
   * (there is no public `map.getMarkers()`). A popup's anchor pixel follows from its
   * `maplibregl-popup-anchor-<side>` class: the tip sits on that side of its box.
   * The class prefix is `mapboxgl-` on Mapbox GL JS v1 and MapLibre 1; MapLibre 2 writes both.
   */
  overlays(): Overlay[] {
    const container = this.map.getContainer();
    const origin = this.map.getCanvas().getBoundingClientRect();
    const out: Overlay[] = [];
    const prefix = container.classList.contains('maplibregl-map') ? 'maplibregl' : 'mapboxgl';
    for (const [kind, selector] of [['marker', `.${prefix}-marker`], ['popup', `.${prefix}-popup`]] as const) {
      // Scoped to the container, not the document: a map inside a web component's shadow root is invisible to a
      // document-wide query, and another map's overlays are not this one's.
      container.querySelectorAll(selector).forEach((el, index) => {
        const r = el.getBoundingClientRect();
        const rect = { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
        const side = [...el.classList].find((c) => c.startsWith(`${prefix}-${kind}-anchor-`))?.slice(`${prefix}-${kind}-anchor-`.length);
        let anchor: Pt | undefined;
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

function toRendered(f: MapGeoJSONFeature): RenderedFeature {
  return {
    layer: f.layer.id,
    source: f.source,
    id: f.id,
    properties: (f.properties ?? {}) as Record<string, unknown>,
    geometry: f.geometry as Geometry,
    state: f.state as Record<string, unknown> | undefined,
  };
}
