import type { Map as MlMap, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import { extrusionHeight, missingIcon, paintColour, paintVisibility, unparseableProperties } from './maplibre-paint';
import type { CanvasAdapter, Geometry, LayerInfo, LngLat, Overlay, Pt, RenderedFeature, Visibility } from './types';

/**
 * MapLibre GL JS adapter. PUBLIC API ONLY — no underscore fields. (MapGrab, the archived prior
 * art, relied on _styleDirty/_frameRequest/_placementDirty/...; that is what we are avoiding.)
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
    const raw: MapGeoJSONFeature[] = q.at
      ? this.map.queryRenderedFeatures([q.at.x, q.at.y], opts)
      : this.map.queryRenderedFeatures(opts);
    return raw.map(toRendered);
  }

  async queryData(layerId: string): Promise<RenderedFeature[] | null> {
    const layer = this.map.getLayer(layerId);
    if (!layer) return null;
    const source = this.map.getSource(layer.source) as GeoJSONSource | undefined;
    if (!source || source.type !== 'geojson' || typeof source.getData !== 'function') return null;
    const data = await source.getData();
    const feats = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : [];
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

  listLayers(): LayerInfo[] {
    return this.map.getLayersOrder().map((id) => {
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
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.map.off('idle', onIdle);
        resolve(v);
      };
      const onIdle = () => {
        // 'idle' does not look at tile state of sources that are still fetching after an error
        // retry etc.; areTilesLoaded() is the public belt-and-braces check.
        if (this.map.areTilesLoaded()) finish(true);
        else this.map.triggerRepaint();
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.map.on('idle', onIdle);
      this.map.triggerRepaint();
    });
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

  whyNotRendered(f: RenderedFeature): string | undefined {
    const icon = missingIcon(this.map, f);
    return icon ? `its icon image "${icon}" is not in the style (missing from the sprite / never added): MapLibre draws nothing for it` : undefined;
  }

  caveats(): string[] {
    return unparseableProperties().map((p) => `visibility unknown for layer ${p} — unsupported expression (newer than the bundled style-spec evaluator); treated as visible`);
  }

  /**
   * Pixel probe. A WebGL canvas without preserveDrawingBuffer reads back zeros — except in the
   * same task as the draw. `redraw()` (public) renders synchronously, so: draw, read, hide the
   * layer, draw, read, restore, draw. All in one task, so the intermediate frame is never
   * composited (no flicker). Costs three renders (~50ms each on SwiftShader), fires 'styledata'
   * and makes MapLibre reload the layer's source afterwards — a probe, not something to run per poll.
   */
  pixelContribution(layer: string, at: Pt): number | undefined {
    const canvas = this.map.getCanvas();
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl || !this.map.getLayer(layer) || this.map.getLayoutProperty(layer, 'visibility') === 'none') return undefined;
    const dpr = canvas.width / canvas.clientWidth;
    const R = 2; // (2R+1)² device pixels around the point
    const read = () => {
      this.map.redraw();
      const px = new Uint8Array(4 * (2 * R + 1) ** 2);
      gl.readPixels(Math.round(at.x * dpr) - R, canvas.height - Math.round(at.y * dpr) - R - 1, 2 * R + 1, 2 * R + 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const withLayer = read();
    let without: Uint8Array;
    try {
      this.map.setLayoutProperty(layer, 'visibility', 'none');
      without = read();
    } finally {
      this.map.setLayoutProperty(layer, 'visibility', 'visible');
      this.map.redraw();
    }
    let diff = 0;
    for (let i = 0; i < withLayer.length; i++) diff += Math.abs(withLayer[i] - without[i]);
    return diff;
  }

  /**
   * Markers and popups, found by MapLibre's documented CSS classes inside this map's container
   * (there is no public `map.getMarkers()`). A popup's anchor pixel follows from its
   * `maplibregl-popup-anchor-<side>` class: the tip sits on that side of its box.
   */
  overlays(): Overlay[] {
    const container = this.map.getContainer();
    const origin = this.map.getCanvas().getBoundingClientRect();
    const out: Overlay[] = [];
    for (const [kind, selector] of [['marker', '.maplibregl-marker'], ['popup', '.maplibregl-popup']] as const) {
      const all = [...document.querySelectorAll(selector)];
      all.forEach((el, index) => {
        if (!container.contains(el)) return;
        const r = el.getBoundingClientRect();
        const rect = { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
        const side = [...el.classList].find((c) => c.startsWith(`maplibregl-${kind}-anchor-`))?.slice(`maplibregl-${kind}-anchor-`.length);
        let anchor: Pt | undefined;
        if (side && kind === 'popup') {
          anchor = {
            x: side.includes('left') ? rect.x : side.includes('right') ? rect.x + rect.width : rect.x + rect.width / 2,
            y: side.startsWith('top') ? rect.y : side.startsWith('bottom') ? rect.y + rect.height : rect.y + rect.height / 2,
          };
        }
        // innerText-like: the popup's close button ("×") is chrome, not content
        const text = [...(el.querySelector('.maplibregl-popup-content') ?? el).childNodes]
          .filter((n) => !(n instanceof Element && n.classList.contains('maplibregl-popup-close-button')))
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
