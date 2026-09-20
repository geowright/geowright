import type { Map as MlMap, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import { extrusionHeight, missingIcon, paintColour, paintVisibility, unparseableProperties } from './maplibre-paint';
import type { CanvasAdapter, Geometry, LayerInfo, LngLat, Overlay, Pt, RenderedFeature, Visibility } from './types';

/**
 * MapLibre GL JS adapter. PUBLIC API ONLY — no underscore fields. (MapGrab, the archived prior
 * art, relied on _styleDirty/_frameRequest/_placementDirty/...; that is what we are avoiding.)
 *
 * Versions: written against MapLibre GL JS 6, run against 2–6 and Mapbox GL JS 1.13 (the same API
 * family) by tests/compat. Newer public methods are FEATURE-DETECTED, never version-sniffed, and what
 * an old version cannot do is said out loud in caveats() instead of being answered wrongly.
 */
export class MapLibreAdapter implements CanvasAdapter<LngLat> {
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
      // Both change what a pixel means (a globe has a far side, terrain hides what is behind a ridge).
      projection: (this.map.getProjection?.()?.type as string | undefined) ?? 'mercator',
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

  queryFeatures(q: { layers?: string[]; at?: Pt }): RenderedFeature[] {
    // queryRenderedFeatures throws for layer ids that do not exist; an unknown layer is a
    // legitimate "nothing there (yet)" for a retrying assertion, so filter them out.
    const layers = q.layers?.filter((id) => this.map.getLayer(id));
    if (q.layers && layers!.length === 0) return [];
    const opts = layers ? { layers } : {};
    if (q.at) return this.map.queryRenderedFeatures([q.at.x, q.at.y], opts).map(toRendered);
    if (this.map.getProjection?.()?.type !== 'globe') return this.map.queryRenderedFeatures(opts).map(toRendered);
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
    const extrusions = (opts.layers ?? this.layerIds()).filter((id) => this.map.getLayer(id)?.type === 'fill-extrusion' && this.map.getLayoutProperty(id, 'visibility') !== 'none');
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
    // MapLibre renders it as one feature without properties, so that is what it is here too. Until an earlier phase it
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
        visible: this.map.getLayoutProperty(id, 'visibility') !== 'none',
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
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.map.off('idle', onIdle);
        this.map.off('render', onRender);
        this.lastWait = v ? undefined : { frames, ms: performance.now() - started, moving: this.map.isMoving(), loaded: this.map.loaded(), pending: this.pendingSources() };
        resolve(v);
      };
      this.map.on('render', onRender);
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

  private lastWait?: { frames: number; ms: number; moving: boolean; loaded: boolean; pending: { id: string; type: string }[] };

  /** Sources that are not loaded right now (public isSourceLoaded), with their type. */
  private pendingSources(): { id: string; type: string }[] {
    const sources = this.map.getStyle()?.sources ?? {};
    return Object.keys(sources)
      .filter((id) => {
        try {
          return !this.map.isSourceLoaded(id);
        } catch {
          return false;
        }
      })
      .map((id) => ({ id, type: String((sources[id] as { type?: string }).type) }));
  }

  /**
   * Why the last waitForIdle() timed out. A map that renders frame after frame while the camera is at rest and
   * every tile is loaded is being ANIMATED by the app (setData / setPaintProperty in a requestAnimationFrame loop,
   * an animated image/canvas/video source): it will never be idle, by design.
   */
  idleDiagnosis(): string | undefined {
    const w = this.lastWait;
    if (!w) return undefined;
    if (w.moving) return 'the camera is moving (an animation or a gesture in progress)';
    const never = 'Such a map NEVER becomes idle: do not wait for idle here; retrying assertions and actions work without it';
    const tiled = w.pending.filter((p) => p.type !== 'geojson');
    if (tiled.length) return `tiles of source(s) ${tiled.map((p) => p.id).join(', ')} are still loading (a slow or unanswered tile request?)`;
    // A GeoJSON source that is "loading" for seconds on end is not the network: it is being re-set faster than it settles.
    if (w.pending.length && w.frames >= 3) return `the app keeps replacing the data of GeoJSON source(s) ${w.pending.map((p) => p.id).join(', ')} (setData in a requestAnimationFrame loop or a timer: ${w.frames} frames rendered in ${Math.round(w.ms)}ms with the camera at rest). ${never}`;
    // (loaded() stays false for a map with an animated source, so it cannot be a condition here)
    if (w.frames >= 3) return `the map rendered ${w.frames} frames in ${Math.round(w.ms)}ms with the camera at rest and no source loading: the app repaints it continuously (a paint property in a requestAnimationFrame loop, an animated image / canvas / video source). ${never}`;
    return w.loaded ? undefined : 'the style or a source has not finished loading';
  }

  visibility(f: RenderedFeature): Visibility {
    return paintVisibility(this.map, f);
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
    const pitch = this.map.getPitch();
    if (!pitch) return 0;
    const height = extrusionHeight(this.map, f);
    if (!height) return 0;
    const metres = this.map.unproject([at.x, at.y]).distanceTo(this.map.unproject([at.x + 10, at.y]));
    return metres > 0 ? height * (10 / metres) * Math.sin((pitch * Math.PI) / 180) : 0;
  }

  wrapPx(): number | undefined {
    if (this.map.getProjection?.()?.type === 'globe' || !(this.map.getRenderWorldCopies?.() ?? true)) return undefined;
    const c = this.map.getCenter();
    const w = this.map.project([c.lng + 360, c.lat]).x - this.map.project([c.lng, c.lat]).x;
    return w > 0 && w < this.map.getCanvas().clientWidth * 2 ? w : undefined; // only when a second copy can be on screen
  }

  whyNotRendered(f: RenderedFeature): string | undefined {
    const icon = missingIcon(this.map, f);
    return icon ? `its icon image "${icon}" is not in the style (missing from the sprite / never added): MapLibre draws nothing for it` : undefined;
  }

  caveats(): string[] {
    const out = unparseableProperties().map((p) => `visibility unknown for layer ${p} — unsupported expression (newer than the bundled style-spec evaluator); treated as visible`);
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
   * same task as the draw. `redraw()` (public, MapLibre >= 2) renders synchronously, so: draw, read, hide
   * the layer, draw, read, restore, draw. All in one task, so the intermediate frame is never
   * composited (no flicker). Costs three renders (~50ms each on SwiftShader), fires 'styledata'
   * and makes MapLibre reload the layer's source afterwards — a probe, not something to run per poll.
   *
   * Without redraw() (Mapbox GL JS v1) the same reads happen inside the public 'render' event, which
   * fires in the task that drew the frame: triggerRepaint(), read on 'render'. Three REAL frames — the one
   * without the layer can be composited (a one-frame flicker), and it takes as long as three frames take.
   */
  pixelContribution(layer: string, at: Pt, radiusPx = 2): number | undefined | Promise<number | undefined> {
    const canvas = this.map.getCanvas();
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl || !this.map.getLayer(layer) || this.map.getLayoutProperty(layer, 'visibility') === 'none') return undefined;
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
    if (typeof this.map.redraw === 'function') {
      const read = () => (this.map.redraw(), grab());
      const withLayer = read();
      let without: Uint8Array;
      try {
        this.map.setLayoutProperty(layer, 'visibility', 'none');
        without = read();
      } finally {
        this.map.setLayoutProperty(layer, 'visibility', 'visible');
        this.map.redraw();
      }
      return difference(withLayer, without);
    }
    const frame = () =>
      new Promise<Uint8Array | undefined>((resolve) => {
        const timer = setTimeout(() => (this.map.off('render', onRender), resolve(undefined)), 2000); // a hidden tab renders no frames
        const onRender = () => (clearTimeout(timer), this.map.off('render', onRender), resolve(grab()));
        this.map.on('render', onRender);
        this.map.triggerRepaint();
      });
    return (async () => {
      const withLayer = await frame();
      let without: Uint8Array | undefined;
      try {
        this.map.setLayoutProperty(layer, 'visibility', 'none');
        without = await frame();
      } finally {
        this.map.setLayoutProperty(layer, 'visibility', 'visible');
        this.map.triggerRepaint();
      }
      return withLayer && without ? difference(withLayer, without) : undefined;
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
      const all = [...document.querySelectorAll(selector)];
      all.forEach((el, index) => {
        if (!container.contains(el)) return;
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
