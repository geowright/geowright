import type {
  ActionPointOptions,
  ActionPointResult,
  CanvasAdapter,
  ClickVerdict,
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

  private matches(f: RenderedFeature, q: FeatureQuery): boolean {
    if (q.id !== undefined && String(f.id) !== String(q.id)) return false;
    if (q.where) {
      for (const [k, v] of Object.entries(q.where)) {
        if (!testWhere(f.properties[k], v)) return false;
      }
    }
    return true;
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
    return {
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
      const el = document.elementFromPoint(client.x, client.y);
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
      if (me.target !== surface) {
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
      if (q.id !== undefined && rendered.length) {
        lines.push(`  id wanted ${JSON.stringify(q.id)}; rendered ids: ${rendered.slice(0, 15).map((f) => JSON.stringify(f.id)).join(', ')}`);
      }
      const data = await this.adapter.queryData?.(id);
      if (data) {
        const offscreen = data.filter((f) => this.matches(f, q));
        if (offscreen.length && !this.find(q).length) {
          lines.push(
            `  ${offscreen.length} matching feature(s) exist in the source but are not rendered ` +
              `(off-screen, hidden layer, or filtered out): ` +
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

  /** Auto-pan ("scrollIntoView"): bring a not-rendered feature's data position into view. */
  async reveal(q: FeatureQuery): Promise<boolean> {
    if (!this.adapter.reveal || !this.adapter.queryData) return false;
    for (const id of this.layersOf(q) ?? []) {
      const data = await this.adapter.queryData(id);
      const hit = data?.find((f) => this.matches(f, q));
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

export function describe(f: { layer: string; id?: string | number; properties: Record<string, unknown>; geometryType?: string; pixel?: Pt }): string {
  const props = JSON.stringify(f.properties);
  return `${f.layer}${f.id !== undefined ? `#${f.id}` : ''} ${props.length > 120 ? props.slice(0, 117) + '…' : props}${f.pixel ? ` @(${f.pixel.x},${f.pixel.y})` : ''}`;
}

function describeEl(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  const tid = el.getAttribute('data-testid');
  return `<${el.tagName.toLowerCase()}${id}${cls}${tid ? ` data-testid="${tid}"` : ''}>`;
}
