import type {
  ActionPointOptions,
  ActionPointResult,
  CanvasAdapter,
  ClickVerdict,
  EntityView,
  SnapshotOptions,
  WhereOp,
  FeatureQuery,
  FeatureSummary,
  Geometry,
  Pt,
  RenderedFeature,
} from './types';

/** Library-agnostic logic. Knows nothing about MapLibre; only the adapter seam. */
export class Engine<W = unknown> {
  constructor(readonly adapter: CanvasAdapter<W>) {}

  /* ---------------- matching ---------------- */

  private layersOf(q: FeatureQuery): string[] | undefined {
    return q.layer === undefined ? undefined : Array.isArray(q.layer) ? q.layer : [q.layer];
  }

  /** `rendered: false` for features that come from source DATA: paint visibility does not apply. */
  private matches(f: RenderedFeature, q: FeatureQuery, rendered = true): boolean {
    if (q.id !== undefined && String(f.id) !== String(q.id)) return false;
    if (rendered && q.visible !== undefined && this.visibility(f).visible !== q.visible) return false;
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
    return `${f.layer}|${f.id ?? ''}|${JSON.stringify(f.properties)}`;
  }

  /**
   * Identity of the underlying DATA feature, independent of which layer drew it. A circle and its
   * text label are two rendered features of one entity; the label on top is not an occluder — to a
   * user it is the same thing. Without this, every labelled point is "occluded" by its own label.
   */
  private entityKey(f: RenderedFeature): string {
    return `${f.source ?? f.layer}|${f.id ?? ''}|${JSON.stringify(f.properties)}`;
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
    };
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
    if (this.adapter.isMoving()) return fail('moving', 'map is moving (camera animation or user gesture in progress)');
    const first = this.actionPointOnce(q, opts);
    if (!first.ok) return first;
    await twoFrames();
    if (this.adapter.isMoving()) return fail('moving', 'map started moving');
    const second = this.actionPointOnce(q, opts);
    if (!second.ok) return second;
    if (Math.hypot(first.surface.x - second.surface.x, first.surface.y - second.surface.y) > 1) {
      return fail('unstable', 'feature position changed between two animation frames');
    }
    return second;
  }

  private actionPointOnce(q: FeatureQuery, opts: ActionPointOptions): ActionPointResult {
    const groups = [...this.group(q).values()];
    if (groups.length === 0) return fail('not-found', 'no rendered feature matches');
    if (groups.length > 1) {
      const list = groups.slice(0, 5).map((g) => describe(this.summarize(g))).join('; ');
      return fail('ambiguous', `strict mode violation: query resolved to ${groups.length} features: ${list}`);
    }
    const pieces = groups[0];
    const vis = this.visibility(pieces[0]);
    if (!vis.visible && !opts.force) {
      return fail('invisible', `feature is rendered but not visible: ${vis.reason}. A user cannot see it; use { force: true } to act on it anyway.`);
    }
    const targetKey = this.key(pieces[0]);
    const targetEntity = this.entityKey(pieces[0]);
    const size = this.surfaceSize();
    const cands = this.candidates(pieces, size);
    if (cands.length === 0) return fail('offscreen', 'feature is rendered but no part of it is inside the viewport');

    const ignore = new Set(opts.ignoreLayers ?? []);
    const rect = this.adapter.surface().getBoundingClientRect();
    let occluder: RenderedFeature | undefined;
    let domCover: Element | undefined;

    for (const c of cands) {
      const hits = this.adapter.queryFeatures({ at: c }).filter((h) => !ignore.has(h.layer));
      const onTarget = hits.some((h) => this.key(h) === targetKey);
      if (!onTarget) continue; // candidate is not actually on the rendered feature (e.g. icon offset)
      if (!opts.force && this.entityKey(hits[0]) !== targetEntity) {
        occluder ??= hits[0];
        continue;
      }
      const client = { x: rect.left + c.x, y: rect.top + c.y };
      const el = topElementAt(client.x, client.y);
      if (el !== this.adapter.surface()) {
        domCover ??= el ?? undefined;
        continue;
      }
      return { ok: true, client: round(client), surface: round(c), feature: this.summarize(pieces) };
    }
    if (domCover) return fail('dom-covered', `every candidate point is covered by DOM element ${describeEl(domCover)}`);
    if (occluder) {
      return fail(
        'occluded',
        `every candidate point is covered by another feature; topmost is ${describe({ ...occluder, geometryType: occluder.geometry.type })}. ` +
          `Use { force: true } to click anyway, or { ignoreLayers: ['${occluder.layer}'] }.`,
      );
    }
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
  private candidates(pieces: RenderedFeature[], size: { w: number; h: number }): Pt[] {
    const inView = (p: Pt) => p.x >= 2 && p.y >= 2 && p.x <= size.w - 2 && p.y <= size.h - 2;
    const proj = (c: number[]) => this.adapter.project(this.adapter.worldFromCoord(c));
    const out: Pt[] = [];
    for (const piece of pieces) {
      const g = piece.geometry;
      for (const part of explode(g)) {
        if (part.kind === 'point') out.push(proj(part.coord));
        else if (part.kind === 'line') out.push(...lineCandidates(part.coords.map(proj)));
        else out.push(...polygonCandidates(part.rings.map((r) => r.map(proj)), size));
      }
    }
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
  pixelProbe(q: FeatureQuery): { ok: true; diff: number | undefined; surface: Pt; layer: string } | { ok: false; message: string } {
    const r = this.actionPointOnce(q, {});
    if (!r.ok) return { ok: false, message: `${r.reason}: ${r.message}` };
    return { ok: true, diff: this.adapter.pixelContribution?.(r.feature.layer, r.surface), surface: r.surface, layer: r.feature.layer };
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
        if (!mine) verdict.reason = 'target was no longer under the pointer when the click arrived';
        else if (!opts.force && this.entityKey(hits[0]) !== this.entityKey(mine)) {
          verdict.reason = `target was covered by ${describe({ ...hits[0], geometryType: hits[0].geometry.type })} when the click arrived`;
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
    const lines: string[] = [];
    const layers = this.layersOf(q);
    const known = this.adapter.listLayers();
    const view = this.adapter.getViewState();
    lines.push(`view: ${JSON.stringify(view, (_k, v) => (typeof v === 'number' ? +v.toFixed(5) : v))}`);
    for (const id of layers ?? []) {
      const info = known.find((l) => l.id === id);
      if (!info) {
        lines.push(`layer "${id}": does not exist. Layers: ${known.map((l) => l.id).join(', ')}`);
        continue;
      }
      if (!info.visible) lines.push(`layer "${id}": visibility is "none"`);
      const rendered = this.find({ layer: id });
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
      if (q.visible !== undefined) {
        const { visible: _v, ...anyVisibility } = q;
        const other = this.find({ ...anyVisibility, layer: id }).filter((f) => f.visible !== q.visible);
        if (other.length) {
          lines.push(
            `  ${other.length} feature(s) match but are ${q.visible ? 'NOT VISIBLE' : 'visible'}` +
              (q.visible ? `: ${other.slice(0, 3).map((f) => `${f.layer}${f.id !== undefined ? '#' + f.id : ''} (${f.invisibleBecause})`).join('; ')}` : ''),
          );
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
    return lines.join('\n');
  }

  /* ---------------- entities (shared by snapshot + accessibility mirror) ---------------- */

  /**
   * Rendered features folded into data entities, each with a clean clickable pixel if one exists.
   * `ignoreDom` lets a caller declare DOM it owns (the mirror's own buttons) as transparent.
   */
  entities(o: { layers?: string[]; skipLayers?: string[]; ignoreDom?: (el: Element) => boolean } = {}): EntityView[] {
    const a = this.adapter;
    const surface = a.surface();
    const rect = surface.getBoundingClientRect();
    const size = this.surfaceSize();
    const typeOf = new Map(a.listLayers().map((l) => [l.id, l.type]));
    const rank = (layerId: string) => (typeOf.get(layerId) === 'symbol' ? 0 : typeOf.get(layerId) === 'line' ? 1 : 2);
    const skip = new Set(o.skipLayers ?? []);
    const only = o.layers && new Set(o.layers);
    const found = new Map<string, { owner: string; byLayer: Map<string, RenderedFeature[]> }>();
    for (const f of a.queryFeatures({})) {
      if (skip.has(f.layer) || (only && !only.has(f.layer))) continue;
      const k = this.entityKey(f);
      let e = found.get(k);
      if (!e) found.set(k, (e = { owner: f.layer, byLayer: new Map() }));
      if (!e.byLayer.has(f.layer)) e.byLayer.set(f.layer, []);
      e.byLayer.get(f.layer)!.push(f);
      if (rank(f.layer) > rank(e.owner)) e.owner = f.layer;
    }
    const topEl = (c: Pt) => {
      const stack = document.elementsFromPoint(rect.left + c.x, rect.top + c.y);
      return stack.find((el) => !o.ignoreDom?.(el));
    };
    return [...found.entries()].map(([ek, e]) => {
      const pieces = e.byLayer.get(e.owner)!;
      const f = pieces[0];
      let pixel: Pt | undefined;
      let blocked: string | undefined = 'no part of it is inside the view';
      for (const c of this.candidates(pieces, size).slice(0, 40)) {
        const hits = a.queryFeatures({ at: c });
        if (!hits.some((h) => this.entityKey(h) === ek)) continue;
        const el = topEl(c);
        if (this.entityKey(hits[0]) === ek && el === surface) {
          pixel = round(c);
          blocked = undefined;
          break;
        }
        blocked = el !== surface ? `covered-by-dom:${el ? describeEl(el) : '?'}` : `covered-by:${hits[0].layer}${hits[0].id !== undefined ? '#' + hits[0].id : ''}`;
      }
      return { key: ek, layer: e.owner, alsoLayers: [...e.byLayer.keys()].filter((l) => l !== e.owner), id: f.id, geometryType: f.geometry.type, properties: f.properties, pixel, blocked, invisible: this.entityInvisible(e.byLayer) };
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
    const perLayer = o.perLayer ?? 15;
    const maxProps = o.maxProps ?? 6;
    const a = this.adapter;
    const view = a.getViewState() as any;
    const surface = a.surface();
    const rect = surface.getBoundingClientRect();
    const size = this.surfaceSize();
    const layers = a.listLayers();
    const skip = new Set(o.skipLayers ?? []);
    const only = o.layers && new Set(o.layers);
    const n = (v: number, d = 5) => +v.toFixed(d);
    const out: string[] = [];

    out.push(`MAP (${a.kind}) canvas ${size.w}x${size.h} at client (${Math.round(rect.left)},${Math.round(rect.top)})${a.isMoving() ? '  ** MOVING: positions are changing, re-snapshot before acting **' : ''}`);
    if (view.center) out.push(`view: center ${n(view.center.lng)},${n(view.center.lat)} zoom ${n(view.zoom, 2)} bearing ${n(view.bearing, 1)} pitch ${n(view.pitch, 1)}`);
    if (view.bounds) out.push(`bounds: west ${n(view.bounds.west)} south ${n(view.bounds.south)} east ${n(view.bounds.east)} north ${n(view.bounds.north)}`);

    // Group rendered features into entities. The OWNER layer is the entity's main body, not its
    // decoration: circle/fill beat line (outlines), which beats symbol (labels). Ties: topmost.
    const typeOf = new Map(layers.map((l) => [l.id, l.type]));
    const rank = (layerId: string) => {
      const t = typeOf.get(layerId);
      return t === 'symbol' ? 0 : t === 'line' ? 1 : 2;
    };
    const entities = new Map<string, { owner: string; byLayer: Map<string, RenderedFeature[]> }>();
    for (const f of a.queryFeatures({})) {
      if (skip.has(f.layer) || (only && !only.has(f.layer))) continue;
      const k = this.entityKey(f);
      let e = entities.get(k);
      if (!e) entities.set(k, (e = { owner: f.layer, byLayer: new Map() }));
      if (!e.byLayer.has(f.layer)) e.byLayer.set(f.layer, []);
      e.byLayer.get(f.layer)!.push(f);
      if (rank(f.layer) > rank(e.owner)) e.owner = f.layer;
    }
    const byLayer = new Map<string, { pieces: RenderedFeature[]; also: Set<string>; invisible?: string }[]>();
    for (const e of entities.values()) {
      if (!byLayer.has(e.owner)) byLayer.set(e.owner, []);
      byLayer.get(e.owner)!.push({ pieces: e.byLayer.get(e.owner)!, also: new Set([...e.byLayer.keys()].filter((l) => l !== e.owner)), invisible: this.entityInvisible(e.byLayer) });
    }

    const visible = layers.filter((l) => l.visible);
    const hidden = layers.filter((l) => !l.visible);
    const drawn = new Set([...entities.values()].flatMap((e) => [...e.byLayer.keys()]));
    const fmtLayer = (l: (typeof layers)[number]) => `${l.id}(${l.type}${l.sourceType ? ',' + l.sourceType : ''})`;
    out.push(`layers with content, top to bottom: ${[...visible].reverse().filter((l) => drawn.has(l.id)).map(fmtLayer).join(' ')}`);
    const empty = visible.filter((l) => !drawn.has(l.id) && l.source);
    if (empty.length) out.push(`visible but empty in this view: ${empty.map((l) => l.id).join(' ')}`);
    if (hidden.length) out.push(`hidden layers: ${hidden.map((l) => l.id).join(' ')}`);
    out.push(`entities rendered in viewport: ${entities.size}. Pixels are CLIENT coordinates: click them directly.`);

    const centre = { x: size.w / 2, y: size.h / 2 };
    for (const l of [...visible].reverse()) {
      const list = byLayer.get(l.id);
      if (!list) continue;
      const also = [...new Set(list.flatMap((e) => [...e.also]))];
      out.push('');
      out.push(`[${l.id}] ${list.length} ${l.type} entit${list.length === 1 ? 'y' : 'ies'}${also.length ? ` (also drawn by: ${also.join(', ')})` : ''}`);
      const rows = list
        .map((e) => {
          const cands = this.candidates(e.pieces, size);
          let pt: Pt | undefined;
          let note = '';
          const ek = this.entityKey(e.pieces[0]);
          for (const c of cands.slice(0, 40)) {
            const hits = a.queryFeatures({ at: c });
            if (!hits.some((h) => this.entityKey(h) === ek)) continue;
            pt ??= c;
            const top = hits[0];
            const el = document.elementFromPoint(rect.left + c.x, rect.top + c.y);
            if (this.entityKey(top) === ek && el === surface) {
              pt = c;
              note = '';
              break;
            }
            note = el !== surface ? ` covered-by-dom:${describeEl(el!)}` : ` covered-by:${top.layer}${top.id !== undefined ? '#' + top.id : ''}`;
          }
          return { e, pt, note, d: pt ? Math.hypot(pt.x - centre.x, pt.y - centre.y) : Infinity };
        })
        .sort((x, y) => x.d - y.d);
      for (const r of rows.slice(0, perLayer)) {
        const f = r.e.pieces[0];
        const pos = r.pt ? `@(${Math.round(rect.left + r.pt.x)},${Math.round(rect.top + r.pt.y)})` : '@(edge: no clickable pixel in view)';
        const inv = r.e.invisible ? ` NOT-VISIBLE(${r.e.invisible})` : '';
        out.push(`  ${f.id !== undefined ? '#' + f.id : '-'} ${f.geometry.type} ${pos}${r.note}${inv} ${fmtProps(f.properties, maxProps)}`);
      }
      const rest = rows.slice(perLayer);
      if (rest.length) out.push(`  … ${rest.length} more not listed. ${histogram(rest.map((r) => r.e.pieces[0].properties))}`);
    }

    // What the viewport hides (only knowable for sources that hold their full data client-side).
    const seenSources = new Set<string>();
    for (const l of visible) {
      if (!l.source || seenSources.has(l.source) || skip.has(l.id) || (only && !only.has(l.id))) continue;
      const data = await a.queryData?.(l.id);
      if (!data) continue;
      seenSources.add(l.source);
      const renderedIds = new Set(a.queryFeatures({}).filter((f) => f.source === l.source).map((f) => this.entityKey(f)));
      const off = data.filter((f) => !renderedIds.has(this.entityKey({ ...f, source: l.source })));
      if (!off.length || view.bounds === undefined) continue;
      const b = view.bounds;
      const firstCoord = (f: RenderedFeature) => {
        const first = explode(f.geometry)[0];
        return first.kind === 'point' ? first.coord : first.kind === 'line' ? first.coords[0] : first.rings[0][0];
      };
      const inView = (c: number[]) => c[0] >= b.west && c[0] <= b.east && c[1] >= b.south && c[1] <= b.north;
      const outside = off.filter((f) => !inView(firstCoord(f)));
      const undrawn = off.length - outside.length;
      out.push('');
      if (undrawn) out.push(`[source ${l.source}] ${undrawn} feature(s) are inside the view but not drawn individually (clustered, filtered out, or label collision)`);
      if (outside.length) {
        const dirs = outside.slice(0, 5).map((f) => {
          const c = firstCoord(f);
          const ew = c[0] > b.east ? 'east' : c[0] < b.west ? 'west' : '';
          const ns = c[1] > b.north ? 'north' : c[1] < b.south ? 'south' : '';
          return `${f.id !== undefined ? '#' + f.id : ''} to the ${ns}${ns && ew ? '-' : ''}${ew} at ${n(c[0])},${n(c[1])} ${fmtProps(f.properties, 3)}`;
        });
        out.push(`[source ${l.source}] ${outside.length} feature(s) OUTSIDE the viewport (pan to see them): ${dirs.join(' | ')}${outside.length > 5 ? ' | …' : ''}`);
      }
    }
    const blind = visible.filter((l) => l.sourceType && l.sourceType !== 'geojson' && l.sourceType !== 'raster');
    if (blind.length) out.push(`\nnote: ${blind.map((l) => l.id).join(', ')} use${blind.length === 1 ? '' : ''} tiled sources; features outside the viewport are unknowable from here.`);
    return out.join('\n');
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

type Part =
  | { kind: 'point'; coord: number[] }
  | { kind: 'line'; coords: number[][] }
  | { kind: 'polygon'; rings: number[][][] };

function explode(g: Geometry): Part[] {
  switch (g.type) {
    case 'Point': return [{ kind: 'point', coord: g.coordinates }];
    case 'MultiPoint': return g.coordinates.map((coord) => ({ kind: 'point', coord }));
    case 'LineString': return [{ kind: 'line', coords: g.coordinates }];
    case 'MultiLineString': return g.coordinates.map((coords) => ({ kind: 'line', coords }));
    case 'Polygon': return [{ kind: 'polygon', rings: g.coordinates }];
    case 'MultiPolygon': return g.coordinates.map((rings) => ({ kind: 'polygon', rings }));
  }
}

function lineCandidates(pts: Pt[]): Pt[] {
  const c: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    c.push({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 });
  }
  c.push(...pts);
  const mid = (c.length - 1) / 2; // prefer the middle of the line
  return c.map((p, i) => ({ p, d: Math.abs(i - mid) })).sort((a, b) => a.d - b.d).map((e) => e.p);
}

function polygonCandidates(rings: Pt[][], size: { w: number; h: number }): Pt[] {
  const xs = rings[0].map((p) => p.x);
  const ys = rings[0].map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(size.w, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(size.h, Math.max(...ys));
  if (x1 <= x0 || y1 <= y0) return [];
  const N = 12;
  const scored: { p: Pt; d: number }[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = { x: x0 + ((i + 0.5) / N) * (x1 - x0), y: y0 + ((j + 0.5) / N) * (y1 - y0) };
      if (!inPolygon(p, rings)) continue;
      scored.push({ p, d: Math.min(...rings.map((r) => distToRing(p, r))) });
    }
  }
  return scored.sort((a, b) => b.d - a.d).map((s) => s.p);
}

function inPolygon(p: Pt, rings: Pt[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

function distToRing(p: Pt, ring: Pt[]): number {
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

function fmtProps(p: Record<string, unknown>, max: number): string {
  const keys = Object.keys(p);
  const shown = keys.slice(0, max).map((k) => {
    let v = typeof p[k] === 'string' ? JSON.stringify(p[k]) : String(p[k]);
    if (v.length > 42) v = v.slice(0, 40) + '…"';
    return `${k}=${v}`;
  });
  return shown.join(' ') + (keys.length > max ? ` (+${keys.length - max} props)` : '');
}

/** "zoning: residential×20, commercial×15" for low-cardinality props; ranges for numbers. */
function histogram(props: Record<string, unknown>[]): string {
  const keys = [...new Set(props.flatMap((p) => Object.keys(p)))].slice(0, 6);
  const parts: string[] = [];
  for (const k of keys) {
    const vals = props.map((p) => p[k]).filter((v) => v !== undefined && v !== null);
    const distinct = new Map<string, number>();
    for (const v of vals) distinct.set(String(v), (distinct.get(String(v)) ?? 0) + 1);
    if (distinct.size > 0 && distinct.size <= 5) {
      parts.push(`${k}: ${[...distinct].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v}×${c}`).join(', ')}`);
    } else if (vals.length && vals.every((v) => typeof v === 'number')) {
      parts.push(`${k}: ${Math.min(...(vals as number[]))}..${Math.max(...(vals as number[]))}`);
    }
  }
  return parts.length ? `Summary — ${parts.join('; ')}` : '';
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

function testWhere(actual: unknown, want: unknown): boolean {
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

const avg = (n: number[]) => n.reduce((s, v) => s + v, 0) / n.length;
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

function describeEl(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  const tid = el.getAttribute('data-testid');
  return `<${el.tagName.toLowerCase()}${id}${cls}${tid ? ` data-testid="${tid}"` : ''}>`;
}
