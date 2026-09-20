import type {
  ActionPointOptions,
  ActionPointResult,
  CanvasAdapter,
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
        if ((f.properties[k] ?? null) !== v) return false;
      }
    }
    return true;
  }

  /** Identity of a logical feature. Tiling returns the same feature as several pieces. */
  private key(f: RenderedFeature): string {
    return f.layer + '|' + (f.id !== undefined ? `id:${f.id}` : `props:${JSON.stringify(f.properties)}`);
  }

  /** Rendered features matching the query, grouped into logical features (pieces merged). */
  private group(q: FeatureQuery, at?: Pt): Map<string, RenderedFeature[]> {
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
    const cands = this.candidates(pieces, size);
    return {
      layer: f.layer,
      id: f.id,
      properties: f.properties,
      geometryType: f.geometry.type,
      pixel: cands[0] ? round(cands[0]) : undefined,
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
      if (!opts.force && this.key(hits[0]) !== targetKey) {
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
