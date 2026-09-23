import type {
  ActionPointOptions,
  ActionPointResult,
  CanvasAdapter,
  ClickVerdict,
  DebugMark,
  EntityView,
  GeometryExpectation,
  GeometryVerdict,
  LayerInfo,
  Overlay,
  SnapshotOptions,
  WhereOp,
  FeatureQuery,
  FeatureSummary,
  Geometry,
  Pt,
  RenderedFeature,
  StyleBranch,
  StyleCause,
} from './types';

/** Library-agnostic logic. Knows nothing about MapLibre; only the adapter seam. */
export class Engine<W = unknown> {
  constructor(readonly adapter: CanvasAdapter<W>) {}

  /* ---------------- matching ---------------- */

  private layersOf(q: FeatureQuery): string[] | undefined {
    const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
    const ids = list(q.layer), types = list(q.layerType), sources = list(q.source);
    if (!types && !sources) return ids;
    // by what the layer IS (generated ids): resolved against the style on every call, so it follows the app
    return this.adapter
      .listLayers()
      .filter((l) => (!ids || ids.includes(l.id)) && (!types || types.includes(l.type)) && (!sources || (l.source !== undefined && sources.includes(l.source))))
      .map((l) => l.id);
  }

  /** `rendered: false` for features that come from source DATA: paint visibility does not apply. */
  private matches(f: RenderedFeature, q: FeatureQuery, rendered = true): boolean {
    if (q.id !== undefined && String(f.id) !== String(q.id)) return false;
    const want = q.visible ?? true; // visible by default: "the map has a feature" means a user can see it
    if (rendered && want !== 'any' && this.visibility(f).visible !== want) return false;
    if (q.where) {
      for (const [k, v] of Object.entries(q.where)) {
        if (!testWhere(f.properties[k], v)) return false;
      }
    }
    return true;
  }

  private visibility(f: RenderedFeature) {
    return this.adapter.visibility?.(f) ?? { visible: true };
  }

  /**
   * Identity of a logical feature. Tiling returns the same feature as several pieces, so pieces
   * must merge — but the renderer's `id` alone is NOT trustworthy: MapLibre coerces non-integer
   * ids (terra-draw uses UUID strings) into colliding numbers like 0, 4, 75. Pieces of one feature
   * always share identical properties, so id + properties is both safe and collision-free.
   */
  private key(f: RenderedFeature): string {
    return `${f.layer}|${f.id ?? ''}|${stableProperties(f.properties)}`;
  }

  /**
   * Identity of the underlying DATA feature, independent of which layer drew it. A circle and its
   * text label are two rendered features of one entity; the label on top is not an occluder — to a
   * user it is the same thing. Without this, every labelled point is "occluded" by its own label.
   */
  private entityKey(f: RenderedFeature): string {
    return `${f.source ?? f.layer}|${f.id ?? ''}|${stableProperties(f.properties)}`;
  }

  /**
   * Features with NO id and IDENTICAL properties — three POIs that are all just `{ icon: "music" }`, buildings
   * with no attributes at all — have the same key, and originally they silently became ONE feature (found on
   * MapLibre's own symbol examples). Geometry is all that tells them apart, but it cannot simply go into the
   * key: pieces of one tiled polygon have different (clipped) geometries. What pieces of ONE feature do is
   * touch: neighbouring tiles overlap by their buffer. So same-key, id-less pieces are split into connected
   * components of their on-screen boxes. Limit: two id-less, property-identical shapes that touch stay one.
   */
  private split(pieces: RenderedFeature[]): RenderedFeature[][] {
    if (pieces.length < 2 || pieces[0].id !== undefined || this.single.has(this.key(pieces[0]))) return [pieces];
    // Sweep along x so that thousands of look-alike points cost n·log n, not n².
    // World copies: the same feature drawn once per visible copy of the world is one feature — fold x by the period.
    const wrap = this.adapter.wrapPx?.();
    const fold = (b: ReturnType<Engine<W>['box']>) => {
      if (!wrap) return b;
      const shift = Math.floor(b.x0 / wrap) * wrap;
      return { ...b, x0: b.x0 - shift, x1: b.x1 - shift };
    };
    const boxes = pieces.map((p, i) => ({ i, ...fold(this.box(p)) })).sort((a, b) => a.x0 - b.x0);
    const parent = pieces.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let m = 0; m < boxes.length; m++) {
      for (let n = m + 1; n < boxes.length && boxes[n].x0 <= boxes[m].x1 + TOUCH_PX; n++) {
        if (boxes[m].y0 <= boxes[n].y1 + TOUCH_PX && boxes[n].y0 <= boxes[m].y1 + TOUCH_PX) parent[root(boxes[m].i)] = root(boxes[n].i);
      }
    }
    const out = new Map<number, RenderedFeature[]>();
    pieces.forEach((p, i) => out.set(root(i), [...(out.get(root(i)) ?? []), p]));
    return [...out.values()];
  }

  /**
   * Keys PROVEN to be one feature although their pieces do not touch. The split above has a failure mode,
   * found by the 20x on MapLibre's "animate a point": a source that is re-set every frame is, for an
   * instant, rendered from two tile generations — one moving dot comes back at two positions, 30px apart,
   * and read as "2 features" (before the split existed they merged). Rendered pieces cannot tell that
   * from two look-alike POIs; the SOURCE can: if its data holds exactly one feature with these properties,
   * it is one. Asked only when a split actually happened, and only of sources that can answer (GeoJSON).
   */
  private single = new Set<string>();

  async learnIdentity(q: FeatureQuery): Promise<void> {
    // A registered map may have been removed while Playwright was waiting. MapLibre's
    // feature query then throws inside getProjection instead of returning no features.
    if (this.adapter.surface().isConnected === false) return;
    if (!this.adapter.queryData) return;
    const at = q.at ? this.adapter.project(q.at as W) : undefined;
    const byKey = new Map<string, RenderedFeature[]>();
    for (const f of this.adapter.queryFeatures({ layers: this.layersOf(q), at })) {
      if (f.id !== undefined) continue;
      const k = this.key(f);
      byKey.set(k, [...(byKey.get(k) ?? []), f]);
    }
    const data = new Map<string, RenderedFeature[] | null>();
    for (const [k, pieces] of byKey) {
      // Only a moment in which the pieces do NOT touch can be decided; what was learnt then stays learnt
      // until the data says otherwise (the two-generation instant comes and goes between calls).
      if (pieces.length < 2 || this.splitAlways(pieces).length < 2) continue;
      const layer = pieces[0].layer;
      if (!data.has(layer)) data.set(layer, (await this.adapter.queryData(layer)) ?? null);
      const props = stableProperties(pieces[0].properties);
      const n = data.get(layer)?.filter((d) => stableProperties(d.properties) === props).length;
      if (n === 1) this.single.add(k);
      else this.single.delete(k);
    }
  }

  private splitAlways(pieces: RenderedFeature[]): RenderedFeature[][] {
    const k = this.key(pieces[0]);
    const was = this.single.delete(k);
    try {
      return this.split(pieces);
    } finally {
      if (was) this.single.add(k);
    }
  }

  /** On-screen bounding box of a piece's geometry. */
  private box(f: RenderedFeature) {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const part of explode(f.geometry)) {
      for (const c of part.kind === 'point' ? [part.coord] : part.kind === 'line' ? part.coords : part.rings[0]) {
        const p = this.adapter.project(this.adapter.worldFromCoord(c));
        b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
      }
    }
    return b;
  }

  private touch(a: RenderedFeature, b: RenderedFeature): boolean {
    const wrap = this.adapter.wrapPx?.();
    const fold = (v: ReturnType<Engine<W>['box']>) => (wrap ? { ...v, x0: v.x0 - Math.floor(v.x0 / wrap) * wrap, x1: v.x1 - Math.floor(v.x0 / wrap) * wrap } : v);
    const p = fold(this.box(a)), q = fold(this.box(b));
    return p.x0 <= q.x1 + TOUCH_PX && q.x0 <= p.x1 + TOUCH_PX && p.y0 <= q.y1 + TOUCH_PX && q.y0 <= p.y1 + TOUCH_PX;
  }

  /** Is this hit a piece of THAT feature? The key decides, plus — for id-less features — touching it. */
  private isPieceOf(h: RenderedFeature, pieces: RenderedFeature[]): boolean {
    return this.key(h) === this.key(pieces[0]) && (h.id !== undefined || this.single.has(this.key(h)) || pieces.some((p) => this.touch(h, p)));
  }

  /** Same DATA entity (whatever layer drew it): a circle and its own label, a fill and its outline. */
  private sameEntity(h: RenderedFeature, pieces: RenderedFeature[]): boolean {
    return this.entityKey(h) === this.entityKey(pieces[0]) && (h.id !== undefined || this.single.has(this.key(h)) || pieces.some((p) => this.touch(h, p)));
  }

  /** Rendered features matching the query, grouped into logical features (pieces merged). */
  private group(q: FeatureQuery): Map<string, RenderedFeature[]> {
    const at = q.at ? this.adapter.project(q.at as W) : undefined;
    const groups = new Map<string, RenderedFeature[]>();
    for (const f of this.adapter.queryFeatures({ layers: this.layersOf(q), at })) {
      if (!this.matches(f, q)) continue;
      const k = this.key(f);
      const g = groups.get(k);
      if (g) g.push(f);
      else groups.set(k, [f]);
    }
    for (const [k, pieces] of [...groups]) {
      const parts = this.split(pieces);
      if (parts.length < 2) continue;
      groups.delete(k);
      parts.forEach((part, i) => groups.set(`${k}#${i}`, part));
    }
    return groups;
  }

  find(q: FeatureQuery): FeatureSummary[] {
    return [...this.group(q).values()].map((pieces) => this.summarize(pieces));
  }

  private summarize(pieces: RenderedFeature[]): FeatureSummary {
    const f = pieces[0];
    const size = this.surfaceSize();
    const best = this.candidates(pieces, size)[0];
    const rect = this.adapter.surface().getBoundingClientRect();
    const vis = this.visibility(f);
    return {
      visible: vis.visible,
      invisibleBecause: vis.visible ? undefined : vis.reason,
      layer: f.layer,
      id: f.id,
      properties: f.properties,
      geometryType: f.geometry.type,
      pixel: best && round(best),
      client: best && round({ x: rect.left + best.x, y: rect.top + best.y }),
      world: best && this.adapter.unproject(best),
      state: f.state && Object.keys(f.state).length ? f.state : undefined,
    };
  }

  /**
   * The feature a USER sees at the top of a pixel. Features the style paints invisibly (an opacity-0
   * hit area, a muted symbol) hide nothing, so they are not occluders — originally they were.
   * (MapLibre delivers layer-scoped events to every layer under the pointer, so "on top" was never
   * about who gets the click; it is about what the person clicking can see.)
   */
  private topVisible(hits: RenderedFeature[]): RenderedFeature | undefined {
    return hits.find((h) => this.visibility(h).visible) ?? hits[0];
  }

  /* ---------------- action point ("actionability") ---------------- */

  /**
   * Pick the pixel to act on, in the spirit of Playwright's actionability checks:
   *  1. resolves to exactly one logical feature (strictness)
   *  2. the surface is not animating, and the point is stable across two frames
   *  3. the point is ON the feature (polygon interior, not bbox centre/centroid)
   *  4. the feature is the topmost hit at that pixel (not occluded by another feature)
   *  5. the pixel is not covered by a DOM element (popup, control, sidebar overlay)
   */
  async actionPoint(q: FeatureQuery, opts: ActionPointOptions = {}): Promise<ActionPointResult> {
    if (opts.moving === 'allow') return this.movingActionPoint(q, opts);
    if (this.adapter.isMoving()) return fail('moving', 'map is moving (camera animation or user gesture in progress)');
    // Look-alikes, or ONE id-less feature caught in two tile generations? On 'ambiguous', ask the source — now,
    // while the split is visible — and look again.
    const once = async (): Promise<ActionPointResult> => {
      const r = this.actionPointOnce(q, opts);
      if (r.ok || r.reason !== 'ambiguous') return r;
      await this.learnIdentity(q);
      return this.actionPointOnce(q, opts);
    };
    const first = await once();
    if (!first.ok) return first;
    await twoFrames();
    if (this.adapter.isMoving()) return fail('moving', 'map started moving');
    const second = await once();
    if (!second.ok) return second;
    if (Math.hypot(first.surface.x - second.surface.x, first.surface.y - second.surface.y) > 1) {
      return fail('unstable', 'feature position changed between two animation frames');
    }
    return second;
  }

  /**
   * { moving: 'allow' }: a person can click a slowly moving dot, and so can we — by giving up the two checks
   * that a moving target can never pass (map at rest, same pixel two frames running) and keeping every other
   * one. What protects against acting on the wrong thing is the verification at the instant the real event
   * arrives (armClick / armHover), which the Playwright side turns into "swallowed, try again".
   *
   * Aiming. Measured first: on a small page the pixel from the freshest frame is good enough up to ~200px/s
   * for a 9px dot (20/20 first try) — and on MapLibre's own "animate a point" (full-screen basemap in software
   * GL, 114px/s, 10px dot) it NEVER hit in 30s, because real input arrives later than the dot's radius allows.
   * So the pointer leads the target: velocity is measured here over two frames, and how many ms to lead by is
   * learnt by the caller from each miss (the verdict says where the target was when the event arrived).
   */
  private async movingActionPoint(q: FeatureQuery, opts: ActionPointOptions): Promise<ActionPointResult> {
    const look = async () => {
      const t = await new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())));
      let r = this.actionPointOnce(q, opts);
      if (!r.ok && r.reason === 'ambiguous') {
        await this.learnIdentity(q);
        r = this.actionPointOnce(q, opts);
      }
      return { t, r };
    };
    // Three looks, one frame apart: velocity AND acceleration, so that a lead follows a curve (a straight-line
    // lead of 300ms leaves a 114px-radius circle by 5px; a 10px dot is then half missed before latency jitter).
    const a = await look();
    if (!a.r.ok) return a.r;
    const m = await look();
    if (!m.r.ok) return m.r;
    const b = await look();
    if (!b.r.ok) return b.r;
    const d1 = Math.max(1, m.t - a.t), d2 = Math.max(1, b.t - m.t);
    const v1 = { x: (m.r.surface.x - a.r.surface.x) / d1, y: (m.r.surface.y - a.r.surface.y) / d1 };
    const v2 = { x: (b.r.surface.x - m.r.surface.x) / d2, y: (b.r.surface.y - m.r.surface.y) / d2 };
    const acc = { x: (v2.x - v1.x) / ((d1 + d2) / 2), y: (v2.y - v1.y) / ((d1 + d2) / 2) };
    const velocity = { x: v2.x + (acc.x * d2) / 2, y: v2.y + (acc.y * d2) / 2 }; // at the time of the last look
    const lead = opts.leadMs ?? 0;
    let surface = { x: b.r.surface.x + velocity.x * lead + (acc.x * lead * lead) / 2, y: b.r.surface.y + velocity.y * lead + (acc.y * lead * lead) / 2 };
    const rect = this.adapter.surface().getBoundingClientRect();
    const size = this.surfaceSize();
    // Where it WILL be cannot be hit-tested now; it must at least be a pixel of the map that a pointer can reach.
    const reachable = surface.x >= 2 && surface.y >= 2 && surface.x <= size.w - 2 && surface.y <= size.h - 2 && topElementAt(rect.left + surface.x, rect.top + surface.y) === this.adapter.surface();
    if (!reachable) surface = b.r.surface;
    const speed = Math.hypot(velocity.x, velocity.y) * 1000;
    return {
      ...b.r,
      surface: round(surface),
      client: { x: Math.round(rect.left + surface.x), y: Math.round(rect.top + surface.y) },
      velocity,
      why: `${b.r.why}; moving: 'allow' — target moves at ${Math.round(speed)}px/s, aimed ${Math.round(reachable ? lead : 0)}ms ahead of where it was drawn; the real event is verified when it arrives`,
    };
  }

  /**
   * Real input can only reach what is inside the BROWSER viewport. A map further down a scrolling page
   * (found on svelte-maplibre-gl's docs example: canvas at y=720 of a 720px window) has perfectly good
   * surface pixels that no mouse can touch. Playwright scrolls a locator into view before acting; so do we.
   */
  scrollIntoView(): void {
    const el = this.adapter.surface();
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  private actionPointOnce(q: FeatureQuery, opts: ActionPointOptions): ActionPointResult {
    if (this.adapter.surface().isConnected === false) {
      return fail('offscreen', 'map canvas is detached from the document; the map was removed or its container was detached');
    }
    this.scrollIntoView();
    const size = this.surfaceSize();
    if (size.w < 1 || size.h < 1) {
      return fail('offscreen', `map canvas is ${size.w}x${size.h}; show or size the map container and call map.resize() before acting`);
    }
    const groups = [...this.group(q).values()];
    if (groups.length === 0) {
      // Say WHY when the only match is painted invisibly — "not found" would send people hunting.
      const hidden = q.visible === undefined ? [...this.group({ ...q, visible: 'any' }).values()] : [];
      if (hidden.length === 1) {
        return fail('invisible', `feature is rendered but not visible: ${this.visibility(hidden[0][0]).reason}. A user cannot see it; use { force: true } to act on it anyway.`);
      }
      return fail('not-found', 'no rendered feature matches');
    }
    if (groups.length > 1) {
      const list = groups.slice(0, 5).map((g) => describe(this.summarize(g))).join('; ');
      return fail('ambiguous', `strict mode violation: query resolved to ${groups.length} features: ${list}`);
    }
    const pieces = groups[0];
    const vis = this.visibility(pieces[0]);
    if (!vis.visible && !opts.force) {
      return fail('invisible', `feature is rendered but not visible: ${vis.reason}. A user cannot see it; use { force: true } to act on it anyway.`);
    }
    const stats = { outside: 0 };
    const cands = this.candidates(pieces, size, stats);
    if (cands.length === 0) return fail('offscreen', 'feature is rendered but no part of it is inside the viewport');

    const ignore = new Set(opts.ignoreLayers ?? []);
    const rect = this.adapter.surface().getBoundingClientRect();
    let occluder: RenderedFeature | undefined;
    let domCover: Element | undefined;
    const skipped = { miss: 0, occluded: 0, dom: 0, offview: 0 };

    // WHOLE client pixels only. Real input arrives with fractional coordinates (pointerdown at 339.6, 641.4), but the
    // map library handles `click` / `mousedown` MouseEvents, whose coordinates the browser truncates (339, 641) — so a
    // pixel verified at 339.6 is not the pixel the app hit-tests. Found on the dense basemap: the edge of a POI label
    // ran between the two, we said "the building is on top" and MapLibre said "the label is". Snap first, then verify.
    // A shape thinner than a pixel (a country squeezed against the limb of a globe) may contain the candidate but not
    // its nearest whole pixel: the four whole pixels around it are tried too, each verified like any other candidate.
    const whole = wholePixels(cands, rect);
    for (const [i, c] of whole.entries()) {
      // Bounded: a big shape that is almost entirely under another layer has thousands of covered
      // candidates (a country under the app's own polygons: 25,000, ~0.4ms each, twice per action).
      // A user does not hunt for the one uncovered sliver either; after MAX_TRIES it is "occluded".
      if (i >= MAX_TRIES) break;
      const hits = this.adapter.queryFeatures({ at: c }).filter((h) => !ignore.has(h.layer));
      const onTarget = hits.some((h) => this.isPieceOf(h, pieces));
      if (!onTarget) {
        skipped.miss++; // candidate is not actually on the rendered feature (e.g. icon offset)
        continue;
      }
      const top = this.topVisible(hits)!;
      if (!opts.force && !this.sameEntity(top, pieces)) {
        occluder ??= top;
        skipped.occluded++;
        continue;
      }
      const client = { x: rect.left + c.x, y: rect.top + c.y };
      if (client.x < 0 || client.y < 0 || client.x > window.innerWidth || client.y > window.innerHeight) {
        skipped.offview++; // the map is bigger than the window: this part of it cannot be reached by a pointer
        continue;
      }
      const el = topElementAt(client.x, client.y);
      if (el !== this.adapter.surface()) {
        domCover ??= el ?? undefined;
        skipped.dom++;
        continue;
      }
      const why =
        `candidate ${i + 1} of ${whole.length} (${pieces[0].geometry.type.includes('Polygon') ? `interior points, farthest from the edge first${this.adapter.lift?.(pieces[0], c) ? '; extruded: roof, then walls, then footprint' : ''}` : pieces[0].geometry.type.includes('Line') ? 'middle of the line first' : 'centre first, then a ring around it'})` +
        (i ? `; skipped before it: ${skipped.occluded} under another feature${occluder ? ` (${occluder.layer}${occluder.id !== undefined ? '#' + occluder.id : ''})` : ''}, ${skipped.dom} under DOM${domCover ? ` (${describeEl(domCover)})` : ''}, ${skipped.miss} not on the feature` : '') +
        (opts.force ? '; force: occlusion not checked' : '');
      return { ok: true, client: { x: Math.round(client.x), y: Math.round(client.y) }, surface: round(c), feature: this.summarize(pieces), why };
    }
    if (domCover) return fail('dom-covered', `every candidate point is covered by DOM element ${describeEl(domCover)}`);
    if (occluder) {
      return fail(
        'occluded',
        `${whole.length > MAX_TRIES ? `the ${MAX_TRIES} best of ${whole.length} candidate points are all` : 'every candidate point is'} covered by another feature; topmost is ${describe({ ...occluder, geometryType: occluder.geometry.type })}. ` +
          `Use { force: true } to click anyway, or { ignoreLayers: ['${occluder.layer}'] }.`,
      );
    }
    if (skipped.offview) return fail('offscreen', 'the feature is on the map, but that part of the map is outside the browser window (the map is larger than the viewport and cannot be scrolled fully into it)');
    // Found on a dense 3D city: a building whose footprint is below the viewport edge with a sliver of wall in view.
    // "not found" sent the reader looking for a missing feature; what is true is that it is (almost) off screen.
    const b = pieces.map((p) => this.box(p));
    const geometryOutside = b.every((v) => v.x1 < 0 || v.y1 < 0 || v.x0 > size.w || v.y0 > size.h);
    if (geometryOutside) return fail('offscreen', 'the geometry of the feature is outside the viewport. It is an extrusion and part of it may reach into view, but none of the estimated roof / wall points hit-tests back to it: at most a sliver is visible. Move the camera, or pass { autoPan: true }.');
    if (stats.outside > cands.length) return fail('offscreen', `most of the feature is outside the viewport (${stats.outside} of ${stats.outside + cands.length} candidate points), and none of the points inside hit-tests back to it: only a sliver is in view. Move the camera, or pass { autoPan: true }.`);
    return fail('not-found', 'feature matched but no candidate pixel hit-tests back to it');
  }

  /**
   * Candidate pixels for a feature, best first. Geometry algorithms are kept dumb on purpose:
   * candidates are verified by a real hit test afterwards, so they only need to be plausible.
   *  - points: the projected coordinate
   *  - lines: vertices + segment midpoints, middle of the line first
   *  - polygons: a grid over the on-screen bbox, keeping interior points, ranked by distance
   *    from the polygon edge (a cheap pole-of-inaccessibility). Never the centroid: for a
   *    concave polygon the centroid can be outside.
   */
  private candidates(pieces: RenderedFeature[], size: { w: number; h: number }, stats?: { outside: number }): Pt[] {
    const inView = (p: Pt) => p.x >= 2 && p.y >= 2 && p.x <= size.w - 2 && p.y <= size.h - 2;
    const proj = (c: number[]) => this.adapter.project(this.adapter.worldFromCoord(c));
    const out: Pt[] = [];
    // Polygon candidates of ALL parts and pieces are ranked together (deepest interior first): a country
    // is a hundred islands and tile pieces, and the good pixel is in the mainland, not in whichever
    // piece happens to come first. `tier` keeps an extrusion's roof before its walls before its footprint.
    const poly: { p: Pt; d: number; tier: number }[] = [];
    for (const piece of pieces) {
      const g = piece.geometry;
      for (const part of explode(g)) {
        if (part.kind === 'point') out.push(...pointCandidates(proj(part.coord)));
        else if (part.kind === 'line') out.push(...lineCandidates(part.coords.map(proj)));
        else {
          const rings = part.rings.map((r) => r.map(proj));
          // An extruded polygon is drawn ABOVE its footprint: the roof first, then half-way up the walls,
          // then the ground. Every lifted copy of the footprint lies inside the building's silhouette.
          const lift = this.adapter.lift?.(piece, rings[0][0]) ?? 0;
          // A part that floats (real OSM building:part: a slab from 120m to 132m) is drawn between its base and its
          // top only: half-way up from the GROUND is thin air. Found on a real basemap; the synthetic city has no bases.
          const base = lift > 1 ? Math.min(1, (this.adapter.liftBase?.(piece, rings[0][0]) ?? 0) / lift) : 0;
          const tiers = lift > 1 ? (base > 0 ? [1, (1 + base) / 2, base, 0] : [1, 0.5, 0]) : [0];
          tiers.forEach((t, tier) => {
            for (const c of scoredPolygonCandidates(t ? rings.map((r) => r.map((p) => ({ x: p.x, y: p.y - lift * t }))) : rings, size)) poly.push({ ...c, tier });
          });
        }
      }
    }
    poly.sort((a, b) => a.tier - b.tier || b.d - a.d);
    for (const c of poly) out.push(c.p);
    if (stats) stats.outside = out.filter((p) => !inView(p)).length;
    return out.filter(inView);
  }

  private surfaceSize() {
    const el = this.adapter.surface();
    return { w: el.clientWidth, h: el.clientHeight };
  }

  /**
   * Ground-truth visibility: do the pixels at the feature's action point change when its layer is
   * not drawn? Catches what paint evaluation cannot (transparent icon image, colour identical to
   * what is underneath). Layer-level differential at a pixel that hit-tests to the feature.
   */
  async pixelProbe(q: FeatureQuery): Promise<{ ok: true; diff: number | undefined; surface: Pt; layer: string } | { ok: false; message: string }> {
    const r = this.actionPointOnce(q, {});
    if (!r.ok) return { ok: false, message: `${r.reason}: ${r.message}` };
    return { ok: true, diff: await this.adapter.pixelContribution?.(r.feature.layer, r.surface), surface: r.surface, layer: r.feature.layer };
  }

  /* ---------------- failure artefacts ---------------- */

  /**
   * What to draw on a failure screenshot: for every feature the query matches, its candidate pixels
   * classified the same way `actionPoint` classifies them, plus the asked-for location if any.
   */
  debugMarks(q: FeatureQuery, opts: ActionPointOptions = {}): DebugMark[] {
    const rect = this.adapter.surface().getBoundingClientRect();
    const size = this.surfaceSize();
    const ignore = new Set(opts.ignoreLayers ?? []);
    const marks: DebugMark[] = [];
    if (q.at) {
      const p = this.adapter.project(q.at as W);
      marks.push({ x: rect.left + p.x, y: rect.top + p.y, kind: 'target', label: 'at' });
    }
    for (const pieces of [...this.group(q).values()].slice(0, 8)) {
      let labelled = false;
      for (const c of this.candidates(pieces, size).slice(0, 25)) {
        const hits = this.adapter.queryFeatures({ at: c }).filter((h) => !ignore.has(h.layer));
        const client = { x: rect.left + c.x, y: rect.top + c.y };
        const el = topElementAt(client.x, client.y);
        const top = this.topVisible(hits);
        const kind: DebugMark['kind'] = !hits.some((h) => this.isPieceOf(h, pieces)) ? 'miss' : !this.sameEntity(top!, pieces) ? 'occluded' : el !== this.adapter.surface() ? 'dom' : 'ok';
        const label = labelled
          ? undefined
          : `${pieces[0].layer}${pieces[0].id !== undefined ? '#' + pieces[0].id : ''}` +
            (kind === 'occluded' ? ` under ${top!.layer}${top!.id !== undefined ? '#' + top!.id : ''}` : kind === 'dom' && el ? ` under ${describeEl(el)}` : '');
        labelled = true;
        marks.push({ ...client, kind, label });
      }
    }
    return marks;
  }

  /* ---------------- DOM overlays (markers, popups) ---------------- */

  /**
   * Overlays of a kind, optionally only those AT a location or ON a feature, nearest first.
   *  - `at`: distance from the location's pixel to the overlay's anchor (popups) or box (markers)
   *  - `feature`: the overlay's anchor pixel (or box centre-bottom) hit-tests to that feature
   */
  overlaysAt(kind: Overlay['kind'], o: { at?: unknown; feature?: FeatureQuery; tolerancePx?: number } = {}): (Overlay & { distance?: number })[] {
    const tol = o.tolerancePx ?? 8;
    let list: (Overlay & { distance?: number })[] = (this.adapter.overlays?.() ?? []).filter((v) => v.kind === kind);
    const toBox = (p: Pt, r: Overlay['rect']) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.width)), Math.max(r.y - p.y, 0, p.y - (r.y + r.height)));
    if (o.at) {
      const p = this.adapter.project(o.at as W);
      list = list.map((v) => ({ ...v, distance: v.anchor ? Math.hypot(v.anchor.x - p.x, v.anchor.y - p.y) : toBox(p, v.rect) })).filter((v) => v.distance! <= tol);
      list.sort((x, y) => x.distance! - y.distance!);
    }
    if (o.feature) {
      const q = o.feature;
      const layers = this.layersOf(q);
      list = list.filter((v) => {
        const p = v.anchor ?? { x: v.rect.x + v.rect.width / 2, y: v.rect.y + v.rect.height };
        return this.adapter.queryFeatures({ layers, at: p }).some((f) => this.matches(f, q));
      });
    }
    return list;
  }

  /* ---------------- geometry ---------------- */

  /**
   * The feature's FULL geometry, read from the map — not from the app's own state. What the renderer
   * returns is one clipped piece per internal tile, so it is never the full shape; sources that keep
   * their data client-side (GeoJSON) can give it back whole. The data feature is matched to the
   * rendered one by properties (the renderer's id may be a coerced, colliding number), then by id.
   */
  async geometry(q: FeatureQuery): Promise<{ ok: true; geometry: Geometry; from: 'data' | 'rendered' } | { ok: false; message: string }> {
    const groups = [...this.group(q).values()];
    if (groups.length === 0) return { ok: false, message: 'no rendered feature matches' };
    if (groups.length > 1) return { ok: false, message: `strict mode violation: query resolved to ${groups.length} features` };
    const f = groups[0][0];
    const data = await this.adapter.queryData?.(f.layer);
    const props = stableProperties(f.properties);
    const sameProps = data?.filter((d) => stableProperties(d.properties) === props) ?? [];
    const hit = sameProps.length === 1 ? sameProps[0] : (sameProps.length ? sameProps : data ?? []).find((d) => d.id !== undefined && String(d.id) === String(f.id));
    if (hit) return { ok: true, geometry: hit.geometry, from: 'data' };
    return { ok: true, geometry: f.geometry, from: 'rendered' };
  }

  /** Compare in PIXELS (what a user sees, and zoom-independent to reason about), vertex by vertex. */
  async compareGeometry(q: FeatureQuery, expected: GeometryExpectation, tolerancePx: number): Promise<GeometryVerdict> {
    const g = await this.geometry(q);
    if (!g.ok) return { ok: false, reason: g.message };
    const px = (c: number[]) => this.adapter.project(this.adapter.worldFromCoord(c));
    const base = { actual: g.geometry, from: g.from };
    const clipped = g.from === 'rendered' ? ' (NOTE: compared against RENDERED geometry, which may be clipped at tile borders — the source cannot return its data)' : '';
    if ('circle' in expected) {
      const parts = explode(g.geometry);
      if (parts.length !== 1 || parts[0].kind !== 'polygon') return { ok: false, reason: `expected a circle polygon, got ${g.geometry.type}`, ...base };
      const c = this.adapter.project(expected.circle.center as W);
      const e = this.adapter.project(expected.circle.edge as W);
      const r = Math.hypot(e.x - c.x, e.y - c.y);
      const worst = Math.max(...parts[0].rings[0].map((v) => Math.abs(Math.hypot(px(v).x - c.x, px(v).y - c.y) - r)));
      return worst <= tolerancePx ? { ok: true, ...base } : { ok: false, reason: `a vertex is ${worst.toFixed(1)}px off the expected circle of radius ${r.toFixed(1)}px (tolerance ${tolerancePx}px)${clipped}`, ...base };
    }
    if (expected.type !== g.geometry.type) return { ok: false, reason: `geometry type is ${g.geometry.type}, expected ${expected.type}`, ...base };
    const A = explode(g.geometry), E = explode(expected);
    if (A.length !== E.length) return { ok: false, reason: `${A.length} part(s), expected ${E.length}${clipped}`, ...base };
    for (let i = 0; i < E.length; i++) {
      const a = A[i], e = E[i];
      const seqs: [Pt[], Pt[], boolean][] =
        a.kind === 'point' && e.kind === 'point' ? [[[px(a.coord)], [px(e.coord)], false]]
        : a.kind === 'line' && e.kind === 'line' ? [[a.coords.map(px), e.coords.map(px), false]]
        : a.kind === 'polygon' && e.kind === 'polygon' ? (a.rings.length === e.rings.length ? a.rings.map((ring, k) => [openRing(ring).map(px), openRing(e.rings[k]).map(px), true] as [Pt[], Pt[], boolean]) : [])
        : [];
      if (!seqs.length) return { ok: false, reason: `part ${i}: ring count or kind differs${clipped}`, ...base };
      for (const [act, exp, cyclic] of seqs) {
        if (act.length !== exp.length) return { ok: false, reason: `part ${i}: ${act.length} vertices, expected ${exp.length}${clipped}`, ...base };
        const worst = sequenceDistance(act, exp, cyclic);
        if (worst > tolerancePx) return { ok: false, reason: `part ${i}: a vertex is ${worst.toFixed(1)}px from where it was expected (tolerance ${tolerancePx}px)${clipped}`, ...base };
      }
    }
    return { ok: true, ...base };
  }

  /* ---------------- click-time verification ---------------- */

  private armed = new Map<string, { verdict: ClickVerdict; dispose: () => void }>();

  /**
   * Closes the race between "point computed" and "real click arrives": the app may have moved the
   * map or drawn something on top in between. Same idea as Playwright's hit-target interception:
   * a capture-phase listener re-runs the hit test at the exact pixel of the real pointerdown, and if
   * the target is no longer what is there, the whole click is swallowed so the caller can retry.
   */
  armClick(q: FeatureQuery, opts: ActionPointOptions = {}): string {
    const token = Math.random().toString(36).slice(2);
    const verdict: ClickVerdict = { fired: false, ok: false };
    const ignore = new Set(opts.ignoreLayers ?? []);
    let blocking = false;
    const swallow = (e: Event) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    const onDown = (e: Event) => {
      if (verdict.fired) return blocking ? swallow(e) : undefined;
      verdict.fired = true;
      const me = e as MouseEvent;
      const surface = this.adapter.surface();
      const rect = surface.getBoundingClientRect();
      if (me.target !== surface && !isMirrorNode(me.target)) {
        verdict.reason = `pointer event landed on ${describeEl(me.target as Element)}, not the map canvas`;
      } else {
        const hits = this.adapter.queryFeatures({ at: { x: me.clientX - rect.left, y: me.clientY - rect.top } }).filter((h) => !ignore.has(h.layer));
        const layers = this.layersOf(q);
        const mine = hits.find((h) => (!layers || layers.includes(h.layer)) && this.matches(h, q));
        if (!mine) {
          verdict.reason = 'target was no longer under the pointer when the click arrived';
          if (opts.moving === 'allow') verdict.offset = this.offsetFrom({ x: me.clientX - rect.left, y: me.clientY - rect.top }, q, opts);
        }
        else if (!opts.force && !this.sameEntity(this.topVisible(hits)!, [mine])) {
          const top = this.topVisible(hits)!;
          verdict.reason = `target was covered by ${describe({ ...top, geometryType: top.geometry.type })} when the click arrived`;
        } else verdict.ok = true;
      }
      if (!verdict.ok) {
        blocking = true;
        swallow(e);
      }
    };
    const onRest = (e: Event) => {
      if (blocking) swallow(e);
    };
    const downs = ['pointerdown', 'mousedown'];
    const rest = ['pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick'];
    downs.forEach((t) => window.addEventListener(t, onDown, true));
    rest.forEach((t) => window.addEventListener(t, onRest, true));
    this.armed.set(token, {
      verdict,
      dispose: () => {
        downs.forEach((t) => window.removeEventListener(t, onDown, true));
        rest.forEach((t) => window.removeEventListener(t, onRest, true));
      },
    });
    return token;
  }

  /**
   * The hover counterpart of armClick, for moving targets: was the target under the pointer at the LAST real
   * mousemove? Nothing is swallowed — a pointer that arrives late has merely hovered whatever is there, as a
   * person's would — but the caller learns that it missed and tries again.
   */
  armHover(q: FeatureQuery, opts: ActionPointOptions = {}): string {
    const token = Math.random().toString(36).slice(2);
    const verdict: ClickVerdict = { fired: false, ok: false };
    const ignore = new Set(opts.ignoreLayers ?? []);
    const onMove = (e: Event) => {
      verdict.fired = true;
      const me = e as MouseEvent;
      const surface = this.adapter.surface();
      const rect = surface.getBoundingClientRect();
      verdict.ok = false;
      if (me.target !== surface && !isMirrorNode(me.target)) {
        verdict.reason = `the pointer is over ${describeEl(me.target as Element)}, not the map canvas`;
        return;
      }
      const hits = this.adapter.queryFeatures({ at: { x: me.clientX - rect.left, y: me.clientY - rect.top } }).filter((h) => !ignore.has(h.layer));
      const layers = this.layersOf(q);
      const mine = hits.find((h) => (!layers || layers.includes(h.layer)) && this.matches(h, q));
      if (!mine) {
        verdict.reason = 'target was no longer under the pointer when it arrived';
        verdict.offset = this.offsetFrom({ x: me.clientX - rect.left, y: me.clientY - rect.top }, q, opts);
      }
      else if (!opts.force && !this.sameEntity(this.topVisible(hits)!, [mine])) verdict.reason = 'target was covered by another feature when the pointer arrived';
      else (verdict.ok = true), (verdict.reason = undefined);
    };
    window.addEventListener('mousemove', onMove, true);
    this.armed.set(token, { verdict, dispose: () => window.removeEventListener('mousemove', onMove, true) });
    return token;
  }

  /** Where the (moving) target is drawn right now, relative to where the pointer arrived. */
  private offsetFrom(pointer: Pt, q: FeatureQuery, opts: ActionPointOptions): Pt | undefined {
    const now = this.actionPointOnce(q, { ...opts, force: true });
    return now.ok ? { x: now.surface.x - pointer.x, y: now.surface.y - pointer.y } : undefined;
  }

  disarmClick(token: string): ClickVerdict {
    const a = this.armed.get(token);
    if (!a) return { fired: false, ok: false, reason: 'unknown token' };
    a.dispose();
    this.armed.delete(token);
    return a.verdict;
  }

  /* ---------------- diagnostics ---------------- */

  /** What IS there, for failure messages: same-layer features, layer visibility, off-screen matches. */
  async explain(q: FeatureQuery): Promise<string> {
    if (this.adapter.surface().isConnected === false) {
      return 'map canvas is detached from the document; the map was removed or its container was detached';
    }
    const lines: string[] = [];
    const layers = this.layersOf(q);
    const known = this.adapter.listLayers();
    const view = this.adapter.getViewState();
    lines.push(`view: ${JSON.stringify(view, (_k, v) => (typeof v === 'number' ? +v.toFixed(5) : v))}`);
    const size = this.surfaceSize();
    if (size.w < 1 || size.h < 1) {
      lines.push(`map canvas is ${size.w}x${size.h}; rendered-feature queries may be stale until the container is shown and the map is resized`);
      return lines.join('\n');
    }
    if (layers && !layers.length && (q.layerType !== undefined || q.source !== undefined)) {
      lines.push(`no layer matches ${JSON.stringify({ layer: q.layer, layerType: q.layerType, source: q.source })}. Layers: ${known.map((l) => `${l.id}(${l.type}${l.source ? ',' + l.source : ''})`).join(' ')}`);
    }
    for (const id of layers ?? []) {
      const info = known.find((l) => l.id === id);
      if (!info) {
        lines.push(`layer "${id}": does not exist. Layers: ${known.map((l) => l.id).join(', ')}`);
        continue;
      }
      const hiddenBy = this.adapter.explainLayerHidden?.(id) ?? [];
      if (hiddenBy.length) lines.push(...hiddenBy.map(describeLayerHidden));
      else if (!info.visible) lines.push(`layer "${id}": visibility is "none"`);
      const rendered = this.find({ layer: id, visible: 'any' });
      lines.push(`layer "${id}": ${rendered.length} feature(s) rendered in viewport`);
      for (const f of rendered.slice(0, 8)) lines.push(`  - ${describe(f)}`);
      if (rendered.length > 8) lines.push(`  … ${rendered.length - 8} more`);
      // Near misses: for each property the query constrains, what values ARE present.
      for (const k of Object.keys(q.where ?? {})) {
        const values = [...new Set(rendered.map((f) => JSON.stringify(f.properties[k])))];
        lines.push(
          `  "${k}" wanted ${showWant(q.where![k])}; rendered values: ` +
            (values.length ? values.slice(0, 10).join(', ') + (values.length > 10 ? ', …' : '') : '(none)'),
        );
      }
      const want = q.visible ?? true;
      let someInvisible = want === 'any' && rendered.some((f) => !f.visible);
      if (want !== 'any') {
        const other = this.find({ ...q, layer: id, visible: 'any' }).filter((f) => f.visible !== want);
        someInvisible = want && other.length > 0;
        if (other.length) {
          lines.push(
            `  ${other.length} feature(s) match but are ${want ? 'NOT VISIBLE' : 'visible'}` +
              (want ? `: ${other.slice(0, 3).map((f) => `${f.layer}${f.id !== undefined ? '#' + f.id : ''} (${f.invisibleBecause})`).join('; ')}. Rendered-but-invisible features match only with { visible: 'any' }.` : ''),
          );
        }
      }
      // WHY the style paints a match invisibly: property, value, expression branch, zoom. Computed here, on failure
      // only — the verdict itself never needs it.
      if (someInvisible && this.adapter.explainInvisible) {
        for (const pieces of [...this.group({ ...q, layer: id, visible: false }).values()].slice(0, 3)) {
          const causes = this.adapter.explainInvisible(pieces[0]);
          const f = pieces[0];
          if (causes.length) lines.push(`  -> ${f.layer}${f.id !== undefined ? '#' + f.id : ''} is not visible ${describeStyleCauses(causes)}`);
        }
      }
      if (q.id !== undefined && rendered.length) {
        lines.push(`  id wanted ${JSON.stringify(q.id)}; rendered ids: ${rendered.slice(0, 15).map((f) => JSON.stringify(f.id)).join(', ')}`);
      }
      const data = await this.adapter.queryData?.(id);
      if (!data && info.sourceType && info.sourceType !== 'geojson' && !this.find(q).length) {
        lines.push(
          `  layer "${id}" uses a tiled (${info.sourceType}) source: whether a match exists OUTSIDE the viewport cannot be known ` +
            `from the browser. To act on an off-screen feature pass a location: { autoPan: { lng, lat } }.`,
        );
      }
      if (data) {
        const offscreen = data.filter((f) => this.matches(f, q, false));
        if (offscreen.length && !this.find(q).length) {
          lines.push(
            `  ${offscreen.length} matching feature(s) exist in the source but are not rendered ` +
              `(off-screen, hidden layer, filtered out${info.type === 'symbol' ? ', or hidden by label/icon collision' : ''}): ` +
              offscreen.slice(0, 3).map((f) => describe({ ...f, geometryType: f.geometry.type })).join('; '),
          );
          const why = [...new Set(offscreen.slice(0, 20).map((f) => this.adapter.whyNotRendered?.(f)).filter(Boolean))];
          for (const w of why) lines.push(`  -> ${w}`);
        }
      }
    }
    if (q.at) {
      const at = this.adapter.project(q.at as W);
      const under = this.adapter.queryFeatures({ at });
      lines.push(
        `at ${JSON.stringify(q.at)} = pixel (${Math.round(at.x)},${Math.round(at.y)}): ` +
          (under.length ? under.slice(0, 5).map((f) => describe({ ...f, geometryType: f.geometry.type })).join('; ') : 'nothing rendered there'),
      );
      const { at: _at, ...rest } = q;
      const nearest = this.find(rest)
        .filter((f) => f.pixel)
        .map((f) => ({ f, d: Math.hypot(f.pixel!.x - at.x, f.pixel!.y - at.y) }))
        .sort((a, b) => a.d - b.d)[0];
      if (nearest) lines.push(`  nearest match without "at": ${describe(nearest.f)}, ${Math.round(nearest.d)}px away`);
    }
    if (!layers) lines.push(`rendered layers with features: ${[...new Set(this.adapter.queryFeatures({}).map((f) => f.layer))].join(', ')}`);
    for (const c of this.adapter.caveats?.() ?? []) lines.push(`note: ${c}`);
    return lines.join('\n');
  }

  /* ---------------- entities (shared by snapshot + accessibility mirror) ---------------- */

  /**
   * Rendered features folded into data entities (no hit tests yet — this part is cheap even for
   * thousands of features). The OWNER layer is the entity's main body, not its decoration:
   * circle/fill beat line (outlines), which beats symbol (labels). Ties: topmost.
   */
  private collect(o: { layers?: string[]; skipLayers?: string[]; filter?: FeatureQuery }): Map<string, Collected> {
    const a = this.adapter;
    const typeOf = new Map(a.listLayers().map((l) => [l.id, l.type]));
    const rank = (layerId: string) => (typeOf.get(layerId) === 'symbol' ? 0 : typeOf.get(layerId) === 'line' ? 1 : 2);
    const skip = new Set(o.skipLayers ?? []);
    const only = o.layers && new Set(o.layers);
    const filterLayers = o.filter && this.layersOf(o.filter);
    const size = this.surfaceSize();
    const centre = { x: size.w / 2, y: size.h / 2 };
    const found = new Map<string, Collected>();
    const matched = new Set<string>();
    for (const f of a.queryFeatures({})) {
      if (skip.has(f.layer) || (only && !only.has(f.layer))) continue;
      const k = this.entityKey(f);
      if (o.filter && (!filterLayers || filterLayers.includes(f.layer)) && this.matches(f, o.filter)) matched.add(k);
      let e = found.get(k);
      if (!e) found.set(k, (e = { key: k, owner: f.layer, byLayer: new Map(), d: Infinity }));
      if (!e.byLayer.has(f.layer)) e.byLayer.set(f.layer, []);
      e.byLayer.get(f.layer)!.push(f);
      if (rank(f.layer) > rank(e.owner)) e.owner = f.layer;
    }
    for (const [k, e] of [...found]) {
      if (o.filter && !matched.has(k)) {
        found.delete(k);
        continue;
      }
      // id-less look-alikes (see split()): one entity per connected component, over ALL its layers' pieces
      const all = [...e.byLayer.values()].flat();
      const parts = all.some((f) => this.single.has(this.key(f))) ? [all] : this.split(all);
      if (parts.length < 2) continue;
      found.delete(k);
      parts.forEach((part, i) => {
        const byLayer = new Map<string, RenderedFeature[]>();
        for (const f of part) byLayer.set(f.layer, [...(byLayer.get(f.layer) ?? []), f]);
        const owner = [...byLayer.keys()].reduce((best, l) => (rank(l) > rank(best) ? l : best));
        found.set(`${k}#${i}`, { key: `${k}#${i}`, owner, byLayer, d: Infinity });
      });
    }
    for (const e of found.values()) {
      e.cands = this.candidates(e.byLayer.get(e.owner)!, size);
      const c = e.cands[0];
      e.d = c ? Math.hypot(c.x - centre.x, c.y - centre.y) : Infinity;
    }
    return found;
  }

  /** The expensive part, done only for entities that will actually be shown: verified hit tests. */
  private locate(e: Collected, ignoreDom?: (el: Element) => boolean): { pixel?: Pt; coveredPixel?: Pt; blocked?: string } {
    const surface = this.adapter.surface();
    const rect = surface.getBoundingClientRect();
    let coveredPixel: Pt | undefined;
    // Candidates come from the GEOMETRY; what is hit-tested is what is DRAWN. They differ for a label placed
    // along a line, an icon with an offset, or a symbol hidden by collision at the pixels we tried.
    let blocked: string | undefined = e.cands?.length ? 'no-pixel: none of the pixels tried on its geometry hit-tests back to it (label along a line, offset icon?)' : 'no part of it is inside the view';
    // whole client pixels, exactly as actionPointOnce() tries them: what the snapshot lists as clickable is what click() uses
    for (const c of wholePixels((e.cands ?? []).slice(0, 40), rect)) {
      const hits = this.adapter.queryFeatures({ at: c });
      const all = [...e.byLayer.values()].flat();
      if (!hits.some((h) => this.sameEntity(h, all))) continue;
      const el = document.elementsFromPoint(rect.left + c.x, rect.top + c.y).find((x) => !x.closest('[data-geowright-mirror]') && !ignoreDom?.(x));
      const top = this.topVisible(hits)!;
      if (this.sameEntity(top, all) && el === surface) return { pixel: round(c) };
      coveredPixel ??= round(c);
      blocked = el !== surface ? `covered-by-dom:${el ? describeEl(el) : '?'}` : `covered-by:${top.layer}${top.id !== undefined ? '#' + top.id : ''}`;
    }
    return { coveredPixel, blocked };
  }

  /**
   * Entities nearest to the viewport centre first. With `max`, hit-testing stops once `max`
   * entities have a clean clickable pixel; the rest come back with `located: false` (counted, not
   * examined) — on a map with thousands of features, examining every one is the cost that matters.
   */
  entities(o: { layers?: string[]; skipLayers?: string[]; filter?: FeatureQuery; max?: number; ignoreDom?: (el: Element) => boolean } = {}): EntityView[] {
    const sorted = [...this.collect(o).values()].sort((x, y) => x.d - y.d);
    let usable = 0;
    return sorted.map((e) => {
      const f = e.byLayer.get(e.owner)![0];
      const invisible = this.entityInvisible(e.byLayer);
      const base = { key: e.key, layer: e.owner, alsoLayers: [...e.byLayer.keys()].filter((l) => l !== e.owner), id: f.id, geometryType: f.geometry.type, properties: f.properties, invisible };
      if (o.max !== undefined && usable >= o.max) return { ...base, located: false };
      const loc = this.locate(e, o.ignoreDom);
      if (loc.pixel && !invisible) usable++;
      return { ...base, located: true, pixel: loc.pixel, blocked: loc.pixel ? undefined : loc.blocked };
    });
  }

  /** An entity is invisible only if NO layer paints anything for it. Returns the reason, else undefined. */
  private entityInvisible(byLayer: Map<string, RenderedFeature[]>): string | undefined {
    const reasons: string[] = [];
    for (const pieces of byLayer.values()) {
      const v = this.visibility(pieces[0]);
      if (v.visible) return undefined;
      reasons.push(v.reason ?? 'not painted');
    }
    return reasons.join('; ');
  }

  /* ---------------- text snapshot for agents ---------------- */

  /**
   * A text rendering of the surface for an LLM agent — the canvas equivalent of an accessibility
   * snapshot. Design rules:
   *  - one line per ENTITY, not per rendered feature: a circle + its label + its outline are one
   *    thing; listed under the topmost layer that draws it, other layers noted once per layer
   *  - every listed entity carries a client pixel the agent can click, or says why it cannot
   *  - bounded: per-layer cap (nearest to the viewport centre first); the remainder is summarised
   *    as value histograms, never silently dropped
   *  - says what it cannot see: off-screen matches (geojson sources) and their direction
   */
  async snapshot(o: SnapshotOptions = {}): Promise<string> {
    if (this.adapter.surface().isConnected === false) {
      return 'MAP: canvas is detached from the document; the map was removed or its container was detached';
    }
    const perLayer = o.perLayer ?? 15;
    const maxProps = o.maxProps ?? 6;
    const maxChars = o.maxChars ?? 8000;
    const a = this.adapter;
    const view = a.getViewState() as any;
    const rect = a.surface().getBoundingClientRect();
    const size = this.surfaceSize();
    const layers = a.listLayers();
    const skip = new Set(o.skipLayers ?? []);
    const only = o.layers && new Set(o.layers);
    const n = (v: number, d = 5) => +v.toFixed(d);
    const out: string[] = [];

    out.push(`MAP (${a.kind}) canvas ${size.w}x${size.h} at client (${Math.round(rect.left)},${Math.round(rect.top)})${a.isMoving() ? '  ** MOVING: positions are changing, re-snapshot before acting **' : ''}`);
    if (view.center) {
      const extras = [typeof view.projection === 'string' && view.projection !== 'mercator' ? `projection ${view.projection}` : '', view.terrain ? 'terrain on' : ''].filter(Boolean);
      out.push(`view: center ${n(view.center.lng)},${n(view.center.lat)} zoom ${n(view.zoom, 2)} bearing ${n(view.bearing, 1)} pitch ${n(view.pitch, 1)}${extras.length ? ' · ' + extras.join(' · ') : ''}`);
    }
    if (view.bounds) out.push(`bounds: west ${n(view.bounds.west)} south ${n(view.bounds.south)} east ${n(view.bounds.east)} north ${n(view.bounds.north)}`);
    if (size.w < 1 || size.h < 1) {
      out.push('note: zero-sized canvas; map content cannot be acted on until the container is shown and the map is resized');
      return out.join('\n');
    }

    const entities = this.collect({ layers: o.layers, skipLayers: o.skipLayers, filter: o.filter });
    const byLayer = new Map<string, Collected[]>();
    for (const e of entities.values()) {
      if (!byLayer.has(e.owner)) byLayer.set(e.owner, []);
      byLayer.get(e.owner)!.push(e);
    }
    for (const list of byLayer.values()) list.sort((x, y) => x.d - y.d);

    const visible = layers.filter((l) => l.visible);
    const hidden = layers.filter((l) => !l.visible);
    const drawn = new Set([...entities.values()].flatMap((e) => [...e.byLayer.keys()]));
    const fmtLayer = (l: LayerInfo) => `${l.id}(${l.type}${l.sourceType ? ',' + l.sourceType : ''})`;

    // A basemap is a tiled source with many layers on it. Its rows are the least interesting thing on the page to
    // whoever asked for a snapshot of an APP, and originally they ate the budget first (top-down order): "… 54
    // more not listed" for every basemap layer and zero rows for the app's own. Then a production-sized basemap
    // (80-120 layers) showed that giving up its ROWS is not enough (an earlier change): 25+ row-less sections, plus every
    // layer id in the header, still filled the whole budget. So the basemap degrades in stages (see `STAGES` below)
    // before the app's layers lose a single row.
    // A layer the app adds to the basemap's own source (MapLibre's 3D-buildings example extrudes the basemap's
    // building footprints) is told apart by being the only layer of its TYPE there: a basemap style draws each
    // kind of thing with a family of layers (a dozen road lines, a dozen label symbols). Layers asked for by name
    // (`layers`) are never treated as basemap.
    const perSource = new Map<string, number>();
    const perSourceType = new Map<string, number>();
    for (const l of layers) {
      if (!l.source) continue;
      perSource.set(l.source, (perSource.get(l.source) ?? 0) + 1);
      perSourceType.set(`${l.source}\0${l.type}`, (perSourceType.get(`${l.source}\0${l.type}`) ?? 0) + 1);
    }
    const isBasemap = (l: LayerInfo) =>
      !only?.has(l.id) && !!l.source && l.sourceType !== 'geojson' && (perSource.get(l.source) ?? 0) >= 8 && (perSourceType.get(`${l.source}\0${l.type}`) ?? 0) >= 2;
    const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
    // Condensed header lists: basemap layers become a count per source ("(38 basemap layers on openmaptiles)"). In
    // the top-to-bottom list, each RUN of them is counted where it is, so the app's own layers keep their place in
    // the stack (a layer inserted under the basemap's labels is still seen to be under them).
    const runs = (ls: LayerInfo[], condense: boolean) => {
      const tokens: string[] = [];
      let run: LayerInfo[] = [];
      const flush = () => (run.length && tokens.push(`(${plural(run.length, 'basemap layer')} on ${run[0].source})`), (run = []));
      for (const l of ls) {
        if (!condense || !isBasemap(l)) {
          flush();
          tokens.push(fmtLayer(l));
          continue;
        }
        if (run.length && run[0].source !== l.source) flush();
        run.push(l);
      }
      flush();
      return tokens.join(' ');
    };
    const bySourceCount = (ls: LayerInfo[], condense: boolean) => {
      const counts = new Map<string, number>();
      for (const l of ls) if (condense && isBasemap(l)) counts.set(l.source!, (counts.get(l.source!) ?? 0) + 1);
      return [...ls.filter((l) => !condense || !isBasemap(l)).map((l) => l.id), ...[...counts].map(([src, k]) => `(${plural(k, 'basemap layer')} on ${src})`)].join(' ');
    };
    // Raster, hillshade, heatmap... draw pixels, not features: "empty" would be a lie about them.
    const pixelOnly = visible.filter((l) => PIXEL_ONLY.has(l.type));
    const empty = visible.filter((l) => !drawn.has(l.id) && l.source && !PIXEL_ONLY.has(l.type));
    const top = out.splice(0);
    const header = (condense: boolean): string[] => [
      ...top,
      `layers with content, top to bottom: ${runs([...visible].reverse().filter((l) => drawn.has(l.id)), condense)}`,
      ...(empty.length ? [`visible but empty in this view: ${bySourceCount(empty, condense)}`] : []),
      ...(pixelOnly.length ? [`pixel-only layers (nothing to query): ${pixelOnly.map((l) => `${l.id}(${l.type})`).join(' ')}`] : []),
      ...(hidden.length ? [`hidden layers: ${bySourceCount(hidden, condense)}`] : []),
      `entities rendered in viewport: ${entities.size}. Pixels are CLIENT coordinates: click them directly.`,
      ...(o.filter ? [`filter: ${JSON.stringify(o.filter)} — only matching entities are listed below.`] : []),
    ];

    // Entity sections are rendered by a function of the per-layer cap and the basemap's stage, so the character
    // budget can shrink them and re-render. Hit tests, colours and histograms are cached per entity / layer:
    // shrinking costs nothing.
    const located = new Map<string, ReturnType<Engine<W>['locate']>>();
    const coloursOf = new Map<string, ({ property: string; colour: string; dataDriven: boolean } | undefined)[]>();
    const histogramOf = new Map<string, string>();
    const sections = (appCap: number, baseCap: number, stage: Stage): string[] => {
      const sec: string[] = [];
      const base: { l: LayerInfo; n: number }[] = [];
      for (const l of [...visible].reverse()) {
        const list = byLayer.get(l.id);
        if (!list) continue;
        const basemap = isBasemap(l);
        if (basemap) base.push({ l, n: list.length });
        if (basemap && (stage === 'grouped' || stage === 'counts')) continue;
        const entitiesLine = `[${l.id}] ${list.length} ${l.type} entit${list.length === 1 ? 'y' : 'ies'}`;
        sec.push('');
        if (basemap && stage === 'bare') {
          sec.push(entitiesLine, `  … ${list.length} more not listed.`);
          continue;
        }
        const also = [...new Set(list.flatMap((e) => [...e.byLayer.keys()].filter((x) => x !== e.owner)))];
        const cap = basemap ? baseCap : appCap;
        if (!coloursOf.has(l.id)) coloursOf.set(l.id, list.map((e) => this.adapter.colour?.(e.byLayer.get(e.owner)![0])));
        const colours = coloursOf.get(l.id)!;
        const driven = colours.some((c) => c?.dataDriven);
        const constant = !driven && colours[0] ? `, all drawn ${nameColour(colours[0].colour)}` : '';
        sec.push(`${entitiesLine}${constant}${also.length ? ` (also drawn by: ${also.join(', ')})` : ''}`);
        if (driven) {
          // An interpolated colour gives (almost) one hex per feature: then the colour WORD is the useful bucket.
          const manyShades = new Set(colours.map((c) => c?.colour)).size > 8;
          sec.push(`  ${colours[0]!.property} is data-driven: ${tally(colours.map((c) => (c ? (manyShades ? nameColour(c.colour).replace(/\(.*/, '') : nameColour(c.colour)) : 'unknown')))}${manyShades ? ' (a continuous scale; each row shows its exact colour)' : ''}`);
        }
        for (const e of list.slice(0, cap)) {
          let loc = located.get(e.key);
          if (!loc) located.set(e.key, (loc = this.locate(e)));
          const f = e.byLayer.get(e.owner)![0];
          const pt = loc.pixel ?? loc.coveredPixel;
          const pos = pt ? `@(${Math.round(rect.left + pt.x)},${Math.round(rect.top + pt.y)})` : `@(${loc.blocked})`;
          const invisible = this.entityInvisible(e.byLayer);
          const colour = driven ? this.adapter.colour?.(f) : undefined;
          sec.push(`  ${f.id !== undefined ? '#' + f.id : '-'} ${f.geometry.type} ${pos}${loc.pixel || !pt ? '' : ' ' + loc.blocked}${invisible ? ` NOT-VISIBLE(${invisible})` : ''}${colour ? ` drawn ${nameColour(colour.colour)}` : ''}${f.state && Object.keys(f.state).length ? ` state=${JSON.stringify(f.state)}` : ''} ${fmtProps(f.properties, maxProps)}`);
        }
        const rest = list.slice(cap);
        if (rest.length) {
          if (!histogramOf.has(l.id)) histogramOf.set(l.id, histogram(list.map((e) => e.byLayer.get(e.owner)![0].properties), list.length));
          sec.push(`  … ${rest.length} more not listed${cap ? ' (nearest to the view centre are listed)' : ''}. ${histogramOf.get(l.id)}`);
          // past the 'rows' stage, the basemap's per-layer hints give way to ONE shared note (below)
          if (!basemap || stage === 'rows') sec.push(`    to list specific ones: snapshot('<mapId>', { filter: { layer: '${l.id}', where: { <prop>: <value> } } })`);
        }
      }
      if (!base.length || stage === 'rows') return sec;
      if (stage === 'grouped' || stage === 'counts') {
        // One line per basemap source: which layers have content (grouped by type, with entity counts), or at
        // the last stage only how many layers of each type.
        for (const src of new Set(base.map((b) => b.l.source!))) {
          const mine = base.filter((b) => b.l.source === src);
          const types = [...new Set(mine.map((b) => b.l.type))];
          const detail =
            stage === 'grouped'
              ? types.map((t) => `${t}: ${mine.filter((b) => b.l.type === t).map((b) => `${b.l.id} ${b.n}`).join(', ')}`).join('; ')
              : `${types.map((t) => `${mine.filter((b) => b.l.type === t).length} ${t}`).join(', ')} layer${mine.length === 1 ? '' : 's'}`;
          const k = mine.reduce((sum, b) => sum + b.n, 0);
          sec.push('', `[basemap source ${src}] ${k} entit${k === 1 ? 'y' : 'ies'} on ${plural(mine.length, 'layer')}, none listed — ${detail}`);
        }
      }
      sec.push('', `note: basemap layers (a tiled source with many layers) are condensed to fit maxChars=${maxChars}. To list one layer's entities: snapshot('<mapId>', { layers: ['<layer id>'] }), or narrow with filter: { layer: '<layer id>', where: { <prop>: <value> } }`);
      return sec;
    };

    // What the viewport hides (only knowable for sources that hold their full data client-side).
    const seenSources = new Set<string>();
    for (const l of visible) {
      if (!l.source || seenSources.has(l.source) || skip.has(l.id) || (only && !only.has(l.id))) continue;
      const data = await a.queryData?.(l.id);
      if (!data) continue;
      seenSources.add(l.source);
      const renderedIds = new Set(a.queryFeatures({}).filter((f) => f.source === l.source).map((f) => this.entityKey(f)));
      const off = data.filter((f) => !renderedIds.has(this.entityKey({ ...f, source: l.source })) && (!o.filter || this.matches(f, { ...o.filter, at: undefined }, false)));
      if (!off.length || view.center === undefined) continue;
      const firstCoord = (f: RenderedFeature) => {
        const first = explode(f.geometry)[0];
        return first.kind === 'point' ? first.coord : first.kind === 'line' ? first.coords[0] : first.rings[0][0];
      };
      // "In view" is decided in PIXELS, not by lng/lat bounds: on a rotated or pitched map the bounds
      // are the bounding box of a trapezoid and contain plenty that is not on screen.
      const inView = (c: number[]) => {
        const w = a.worldFromCoord(c);
        const p = a.project(w);
        return p.x >= 0 && p.y >= 0 && p.x <= size.w && p.y <= size.h && (a.isOnSurface?.(w) ?? true);
      };
      const outside = off.filter((f) => !inView(firstCoord(f)));
      const undrawn = off.length - outside.length;
      out.push('');
      if (undrawn) out.push(`[source ${l.source}] ${undrawn} feature(s) are inside the view but not drawn individually (clustered, filtered out, or label collision)`);
      if (outside.length) {
        const dirs = outside.slice(0, 5).map((f) => {
          const c = firstCoord(f);
          return `${f.id !== undefined ? '#' + f.id : ''} to the ${compass(c[0] - view.center.lng, c[1] - view.center.lat, view.center.lat)} at ${n(c[0])},${n(c[1])} ${fmtProps(f.properties, 3)}`;
        });
        out.push(`[source ${l.source}] ${outside.length} feature(s) OUTSIDE the viewport (pan to see them; directions are geographic${view.bearing ? `, the map is rotated ${n(view.bearing, 0)}°` : ''}): ${dirs.join(' | ')}${outside.length > 5 ? ' | …' : ''}`);
      }
    }
    const blind = visible.filter((l) => l.sourceType && l.sourceType !== 'geojson' && !PIXEL_ONLY.has(l.type));
    for (const c of a.caveats?.() ?? []) out.push(`\nnote: ${c}`);
    if (blind.length) {
      // By SOURCE: a basemap style has a hundred layers on one tiled source, and listing them all says nothing.
      const bySource = new Map<string, number>();
      for (const l of blind) bySource.set(l.source ?? '?', (bySource.get(l.source ?? '?') ?? 0) + 1);
      out.push(`\nnote: tiled source(s) ${[...bySource].map(([src, n]) => `${src} (${n} layer${n === 1 ? '' : 's'})`).join(', ')}: features outside the viewport are unknowable from here.`);
    }

    // Budget. The basemap degrades first, one stage at a time: its per-layer cap halves down to no rows; then its
    // per-layer hints become one shared note; then the header lists count its layers instead of naming them; then
    // each of its layers keeps only its count line (no colour, no histogram); then one line per source names its
    // layers with counts; then that line only counts layers by type. Only then does the app's own per-layer cap
    // shrink. As a last resort the text is cut, and says so.
    const footer = out;
    const stages: { baseCap: number; stage: Stage }[] = [];
    for (let c = Math.max(0, perLayer); ; c = Math.floor(c / 2)) {
      stages.push({ baseCap: c, stage: 'rows' });
      if (c === 0) break;
    }
    if (layers.some(isBasemap)) for (const stage of STAGES.slice(1)) stages.push({ baseCap: 0, stage });
    const render = (cap: number, i: number) => {
      const { baseCap, stage } = stages[i];
      return [...header(STAGES.indexOf(stage) >= STAGES.indexOf('condensed')), ...sections(cap, baseCap, stage), ...footer].join('\n');
    };
    let cap = perLayer;
    let i = 0;
    let text = '';
    for (;;) {
      text = render(cap, i);
      if (text.length <= maxChars || (cap === 0 && i === stages.length - 1)) break;
      if (i < stages.length - 1) i++;
      else cap = Math.floor(cap / 2);
    }
    // If the app's rows had to shrink, the basemap may have been condensed more than that smaller app part needs:
    // give the room back, least condensed stage first — but never its rows while the app's are capped.
    if (cap < perLayer && text.length <= maxChars) {
      for (let j = stages.findIndex((s) => s.baseCap === 0); j < i; j++) {
        const t = render(cap, j);
        if (t.length <= maxChars) {
          text = t;
          break;
        }
      }
    }
    if (text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - 60)) + `\n… cut to fit maxChars=${maxChars}; use layers/filter to narrow.`;
    return text;
  }

  /** Auto-pan ("scrollIntoView"): bring a not-rendered feature's data position into view. */
  async reveal(q: FeatureQuery): Promise<boolean> {
    if (!this.adapter.reveal || !this.adapter.queryData) return false;
    for (const id of this.layersOf(q) ?? []) {
      const data = await this.adapter.queryData(id);
      const hit = data?.find((f) => this.matches(f, q, false));
      if (!hit) continue;
      const first = explode(hit.geometry)[0];
      const coords = first.kind === 'point' ? [first.coord] : first.kind === 'line' ? first.coords : first.rings[0];
      const mid = [avg(coords.map((c) => c[0])), avg(coords.map((c) => c[1]))];
      await this.adapter.reveal(this.adapter.worldFromCoord(mid));
      return true;
    }
    return false;
  }
}

/* ---------------- helpers ---------------- */

/** How far the basemap's part of a snapshot is condensed, least to most (see the budget loop in `snapshot()`). */
const STAGES = ['rows', 'nohint', 'condensed', 'bare', 'grouped', 'counts'] as const;
type Stage = (typeof STAGES)[number];

/** Layer types that paint pixels without features one could query or click. */
const PIXEL_ONLY = new Set(['raster', 'hillshade', 'heatmap', 'background', 'color-relief', 'custom']);

/** Pieces of one id-less feature whose on-screen boxes come this close (px) belong together. */
const TOUCH_PX = 0.75;

/** Hit tests per attempt at finding a clickable pixel on one feature. */
const MAX_TRIES = 600;

/** A data entity before any hit testing: its rendered pieces per layer, and how central it is. */
interface Collected {
  key: string;
  owner: string;
  byLayer: Map<string, RenderedFeature[]>;
  cands?: Pt[];
  /** Distance of its best candidate pixel from the viewport centre (Infinity: nothing in view). */
  d: number;
}

export type Part =
  | { kind: 'point'; coord: number[] }
  | { kind: 'line'; coords: number[][] }
  | { kind: 'polygon'; rings: number[][][] };

/** Candidates as WHOLE client pixels (surface-relative): the nearest one first, then the four around it; no duplicates. */
export function wholePixels(cands: Pt[], rect: { left: number; top: number }): Pt[] {
  const tried = new Set<string>();
  return cands.flatMap((raw) => {
    const fx = rect.left + raw.x, fy = rect.top + raw.y;
    return [[Math.round(fx), Math.round(fy)], [Math.floor(fx), Math.floor(fy)], [Math.ceil(fx), Math.floor(fy)], [Math.floor(fx), Math.ceil(fy)], [Math.ceil(fx), Math.ceil(fy)]]
      .filter(([x, y]) => !tried.has(`${x},${y}`) && !!tried.add(`${x},${y}`))
      .map(([x, y]) => ({ x: x - rect.left, y: y - rect.top }));
  });
}

export function explode(g: Geometry): Part[] {
  switch (g.type) {
    case 'Point': return [{ kind: 'point', coord: g.coordinates }];
    case 'MultiPoint': return g.coordinates.map((coord) => ({ kind: 'point', coord }));
    case 'LineString': return [{ kind: 'line', coords: g.coordinates }];
    case 'MultiLineString': return g.coordinates.map((coords) => ({ kind: 'line', coords }));
    case 'Polygon': return [{ kind: 'polygon', rings: g.coordinates }];
    case 'MultiPolygon': return g.coordinates.map((rings) => ({ kind: 'polygon', rings }));
  }
}

/**
 * A point feature is drawn as a disc or icon around its coordinate. The centre is the best pixel,
 * but on a dense map it is often under a NEIGHBOUR while a crescent of the symbol is still visible
 * and clickable — so offer a few pixels around it too. They are verified by the hit test like any
 * other candidate, so a ring pixel that misses a small symbol is simply skipped.
 */
export function pointCandidates(c: Pt): Pt[] {
  const out = [c];
  for (const r of [3, 6, 10]) {
    for (let k = 0; k < 8; k++) out.push({ x: c.x + r * Math.cos((k * Math.PI) / 4), y: c.y + r * Math.sin((k * Math.PI) / 4) });
  }
  return out;
}

const openRing = (ring: number[][]) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);

/** Largest vertex-to-vertex pixel distance under the best alignment. Rings may start anywhere and wind either way. */
export function sequenceDistance(a: Pt[], b: Pt[], cyclic: boolean): number {
  const n = a.length;
  const worstFor = (shift: number, reversed: boolean) => {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const j = ((reversed ? n - 1 - i : i) + shift) % n;
      worst = Math.max(worst, Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y));
    }
    return worst;
  };
  if (!cyclic) return worstFor(0, false);
  let best = Infinity;
  for (let s = 0; s < n; s++) best = Math.min(best, worstFor(s, false), worstFor(s, true));
  return best;
}

export function lineCandidates(pts: Pt[]): Pt[] {
  // In order ALONG the line: v0, m0, v1, m1, ..., so "index distance from the middle" means what it says.
  // (Originally this was [midpoints..., vertices...], whose middle index is always the FIRST vertex:
  // lines were clicked at their start. Found by the unit tests.)
  const c: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    c.push(pts[i]);
    if (i < pts.length - 1) c.push({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 });
  }
  const mid = (c.length - 1) / 2; // prefer the middle of the line
  return c.map((p, i) => ({ p, d: Math.abs(i - mid) })).sort((a, b) => a.d - b.d).map((e) => e.p);
}

export function polygonCandidates(rings: Pt[][], size: { w: number; h: number }): Pt[] {
  return scoredPolygonCandidates(rings, size).sort((a, b) => b.d - a.d).map((s) => s.p);
}

/** Interior grid points with their distance from the edge (unsorted). The grid is as fine as the shape is big: 12x12 at most, 3x3 for a speck. */
export function scoredPolygonCandidates(rings: Pt[][], size: { w: number; h: number }): { p: Pt; d: number }[] {
  const xs = rings[0].map((p) => p.x);
  const ys = rings[0].map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(size.w, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(size.h, Math.max(...ys));
  if (x1 <= x0 || y1 <= y0) return [];
  // A 12x12 grid over a 6px island is 144 candidates (and later 144 hit tests) for nothing.
  const N = Math.max(3, Math.min(12, Math.ceil(Math.max(x1 - x0, y1 - y0) / 5)));
  const scored: { p: Pt; d: number }[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = { x: x0 + ((i + 0.5) / N) * (x1 - x0), y: y0 + ((j + 0.5) / N) * (y1 - y0) };
      if (!inPolygon(p, rings)) continue;
      scored.push({ p, d: Math.min(...rings.map((r) => distToRing(p, r))) });
    }
  }
  return scored;
}

export function inPolygon(p: Pt, rings: Pt[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

export function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

export function fmtProps(p: Record<string, unknown>, max: number): string {
  const keys = Object.keys(p);
  const shown = keys.slice(0, max).map((k) => {
    // Nested values are common in the wild (GeoJSON sources keep objects/arrays as they are): String() would print "[object Object]".
    const isObj = typeof p[k] === 'object' && p[k] !== null;
    let v = typeof p[k] === 'string' || isObj ? JSON.stringify(p[k]) : String(p[k]);
    if (v.length > 42) v = v.slice(0, 40) + (isObj ? '…' : '…"');
    return `${k}=${v}`;
  });
  return shown.join(' ') + (keys.length > max ? ` (+${keys.length - max} props)` : '');
}

/** "zoning: residential×20, commercial×15" for low-cardinality props; ranges for numbers. Covers the WHOLE layer, listed rows included, so counts can be read off directly. */
export function histogram(props: Record<string, unknown>[], total: number): string {
  const keys = [...new Set(props.flatMap((p) => Object.keys(p)))].slice(0, 6);
  const parts: string[] = [];
  for (const k of keys) {
    const vals = props.map((p) => p[k]).filter((v) => v !== undefined && v !== null && typeof v !== 'object'); // nested values make no histogram
    const distinct = new Map<string, number>();
    for (const v of vals) distinct.set(String(v), (distinct.get(String(v)) ?? 0) + 1);
    if (distinct.size > 0 && distinct.size <= 5) {
      parts.push(`${k}: ${[...distinct].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v}×${c}`).join(', ')}`);
    } else if (vals.length && vals.every((v) => typeof v === 'number')) {
      parts.push(`${k}: ${Math.min(...(vals as number[]))}..${Math.max(...(vals as number[]))}`);
    }
  }
  return parts.length ? `Summary of all ${total} — ${parts.join('; ')}` : '';
}

/** "red×75, green×3100": counts, most frequent first, at most 8 distinct values. */
export function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 8).map(([v, c]) => `${v}×${c}`).join(', ') + (sorted.length > 8 ? `, … ${sorted.length - 8} more colours` : '');
}

/** "#d32f2f" -> "red(#d32f2f)": an everyday colour word, because that is how people (and tasks) refer to map symbols. */
export function nameColour(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let name: string;
  if (sat < 0.2 || d < 0.08) name = l < 0.15 ? 'black' : l > 0.9 ? 'white' : l > 0.65 ? 'light grey' : l < 0.35 ? 'dark grey' : 'grey';
  else {
    const hue = (60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) + 360) % 360;
    const base = hue < 15 || hue >= 345 ? 'red' : hue < 45 ? (l < 0.4 ? 'brown' : 'orange') : hue < 70 ? 'yellow' : hue < 165 ? 'green' : hue < 195 ? 'teal' : hue < 255 ? 'blue' : hue < 290 ? 'purple' : 'pink';
    name = base === 'brown' ? base : l < 0.3 ? `dark ${base}` : l > 0.75 ? `light ${base}` : base;
  }
  return `${name}(${hex})`;
}

/**
 * Topmost element at a client point, looking THROUGH the accessibility mirror's own buttons: they
 * sit on top of features by design and forward real clicks to the map, so they are never a cover.
 */
export function topElementAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest('[data-geowright-mirror]')) return el;
  }
  return null;
}

const isMirrorNode = (el: EventTarget | null) => el instanceof Element && !!el.closest('[data-geowright-mirror]');

function showWant(v: unknown): string {
  const op = v as WhereOp | null;
  if (op && typeof op === 'object' && op.matches !== undefined && Object.keys(op).every((k) => k === 'matches' || k === 'flags')) {
    return `/${op.matches}/${op.flags ?? ''}`;
  }
  return JSON.stringify(v);
}

export function testWhere(actual: unknown, want: unknown): boolean {
  if (want === null || typeof want !== 'object') return (actual ?? null) === want;
  const op = want as WhereOp;
  const present = actual !== undefined && actual !== null;
  if (op.exists !== undefined && op.exists !== present) return false;
  if ('eq' in op && (actual ?? null) !== op.eq) return false;
  if ('ne' in op && (actual ?? null) === op.ne) return false;
  if (op.in && !op.in.includes((actual ?? null) as any)) return false;
  if (op.matches !== undefined && !(present && new RegExp(op.matches, op.flags).test(String(actual)))) return false;
  for (const [k, cmp] of [['gt', (a: number, b: number) => a > b], ['gte', (a: number, b: number) => a >= b], ['lt', (a: number, b: number) => a < b], ['lte', (a: number, b: number) => a <= b]] as const) {
    const bound = op[k];
    if (bound !== undefined && !(typeof actual === 'number' && cmp(actual, bound))) return false;
  }
  return true;
}

/** 8-wind geographic direction of an offset in degrees (longitude shrunk by cos(lat)). */
export function compass(dLng: number, dLat: number, atLat: number): string {
  const wrapped = ((((dLng % 360) + 540) % 360) - 180) * Math.cos((atLat * Math.PI) / 180);
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return names[(Math.round(Math.atan2(dLat, wrapped) / (Math.PI / 4)) + 8) % 8];
}

const avg = (n: number[]) => n.reduce((s, v) => s + v, 0) / n.length;
// Tile generations and source data can enumerate the same attributes in different orders.
// Their identity is the values, not the insertion order of the JavaScript object.
function stableProperties(properties: Record<string, unknown>): string {
  return JSON.stringify(properties, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
const round = (p: Pt): Pt => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const fail = (reason: Exclude<ActionPointResult, { ok: true }>['reason'], message: string): ActionPointResult => ({ ok: false, reason, message });

export function describe(f: { layer: string; id?: string | number; properties: Record<string, unknown>; geometryType?: string; pixel?: Pt; visible?: boolean; invisibleBecause?: string }): string {
  const props = JSON.stringify(f.properties);
  return (
    `${f.layer}${f.id !== undefined ? `#${f.id}` : ''} ${props.length > 120 ? props.slice(0, 117) + '…' : props}${f.pixel ? ` @(${f.pixel.x},${f.pixel.y})` : ''}` +
    (f.visible === false ? ` [NOT VISIBLE: ${f.invisibleBecause}]` : '')
  );
}

/* ---------------- wording of style causes (data from the adapter: explainInvisible / explainLayerHidden) ---------------- */

const fmtZoom = (z: number) => String(Math.round(z * 100) / 100);
const fmtJson = (v: unknown) => JSON.stringify(v);
/** An input and its value: `kind="park"` for ["get","kind"], `zoom 11.2` for ["zoom"], else `<json> = <value>`. */
function fmtInput(b: StyleBranch): string {
  const input = b.input as unknown[];
  if (Array.isArray(input) && input[0] === 'zoom' && input.length === 1) return `zoom ${fmtZoom(b.inputValue as number)}`;
  if (Array.isArray(input) && input[0] === 'get' && input.length === 2 && typeof input[1] === 'string') return `${input[1]}=${fmtJson(b.inputValue)}`;
  return `${fmtJson(b.input)} = ${fmtJson(b.inputValue)}`;
}
const fmtOn = (b: StyleBranch) => {
  const input = b.input as unknown[];
  return Array.isArray(input) && input[0] === 'zoom' && input.length === 1 ? 'zoom' : fmtJson(b.input);
};

export function describeBranch(b: StyleBranch): string {
  switch (b.taken) {
    case 'label':
      return `the ${b.op} on ${fmtOn(b)} matched ${fmtInput(b)}`;
    case 'fallback':
      return b.op === 'case' ? `the case took its fallback (no condition was true)` : `the ${b.op} on ${fmtOn(b)} took its fallback for ${fmtInput(b)}`;
    case 'condition':
      return `the case took its branch ${b.at} (the first true condition: ${fmtJson(b.condition)})`;
    case 'base':
      return `the ${b.op} on ${fmtOn(b)} used its base output (${fmtInput(b)} is below its first stop, ${fmtJson(b.at)})`;
    case 'stop':
      return b.op === 'step' ? `the step on ${fmtOn(b)} used the stop at ${fmtJson(b.at)} (${fmtInput(b)})` : `the ${b.op} on ${fmtOn(b)} used its stop at ${fmtJson(b.at)} (${fmtInput(b)}; no interpolation beyond its first and last stops)`;
    case 'between': {
      const [lo, hi] = b.at as [number, number];
      return `the ${b.op} on ${fmtOn(b)} interpolated between its stops at ${lo} and ${hi} (${fmtInput(b)})`;
    }
    case 'argument':
      return `the coalesce used its argument ${b.at} (the ones before it were null)`;
  }
}

/** "fill-opacity is 0 because the match on ["get","kind"] took its fallback for kind="park"" — without the zoom. */
function describeValue(c: StyleCause): string {
  const what = `${c.property} is ${fmtJson(c.value)}`;
  if (c.origin === 'default') return `${what} (not set in the style: the default)`;
  if (c.origin === 'constant') return `${what} (a constant in the style)`;
  const kind = c.origin === 'function' ? 'legacy function' : 'expression';
  if (!c.branches.length) return `${what} (an ${kind}; which of its branches produced this cannot be traced)`;
  return `${what} because ${c.origin === 'function' ? 'its legacy function, read as an expression: ' : ''}${c.branches.map(describeBranch).join(', then ')}`;
}

/** Why one feature is painted invisibly: every cause, and the zoom once. */
export function describeStyleCauses(causes: StyleCause[]): string {
  if (!causes.length) return '';
  return `at zoom ${fmtZoom(causes[0].zoom)}: ${causes.map(describeValue).join('; and ')}`;
}

/** Why a whole layer is not drawn: zoom range or layout visibility. */
export function describeLayerHidden(c: StyleCause): string {
  const head = `layer "${c.layer}" is not drawn at zoom ${fmtZoom(c.zoom)}`;
  if (c.property === 'minzoom') return `${head}: its minzoom is ${c.value} (drawn from zoom ${c.value})`;
  if (c.property === 'maxzoom') return `${head}: its maxzoom is ${c.value} (drawn below zoom ${c.value} only)`;
  return `${head}: layout property ${describeValue(c)}`;
}

function describeEl(el: Element): string {
  const one = (e: Element) => {
    const id = e.id ? `#${e.id}` : '';
    const cls = typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const tid = e.getAttribute('data-testid');
    return { named: !!(id || cls || tid), text: `<${e.tagName.toLowerCase()}${id}${cls}${tid ? ` data-testid="${tid}"` : ''}>` };
  };
  const self = one(el);
  if (self.named) return self.text;
  // An anonymous inner node (an <ellipse> inside a marker's SVG) says nothing: name its nearest identifiable ancestor too.
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const anc = one(p);
    if (anc.named) return `${self.text} in ${anc.text}`;
  }
  return self.text;
}
