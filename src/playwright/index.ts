import { expect as baseExpect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  ActionPointOptions,
  ActionPointResult,
  ClickVerdict,
  FeatureQuery as WireQuery,
  FeatureSummary as WireSummary,
  LayerInfo,
  LngLat,
  SnapshotOptions,
  WhereOp,
  WhereValue,
} from '../inpage/types';

export type { LngLat, WhereOp };

/** Query as written in tests: like the wire format, but `where` values may also be a RegExp. */
export interface FeatureQuery extends Omit<WireQuery, 'where'> {
  where?: Record<string, WhereValue | RegExp | WhereOp>;
}

export interface FeatureSummary extends Omit<WireSummary, 'world'> {
  /** lng/lat under the feature's representative pixel. */
  lngLat?: LngLat;
}

function toWire(q: FeatureQuery): WireQuery {
  if (!q.where) return q as WireQuery;
  const where: WireQuery['where'] = {};
  for (const [k, v] of Object.entries(q.where)) where[k] = v instanceof RegExp ? { matches: v.source, flags: v.flags.replace(/[gy]/g, '') } : v;
  return { ...q, where };
}

const fromWire = (f: WireSummary): FeatureSummary => {
  const { world, ...rest } = f;
  return { ...rest, lngLat: world as LngLat | undefined };
};

const show = (q: FeatureQuery) =>
  JSON.stringify(q, (_k, v) => (v instanceof RegExp ? String(v) : v));

/* ------------------------------------------------------------------ in-page bundle */

let inpageSource: Promise<string> | undefined;
/**
 * Source of the in-page adapter. A packed build ships it prebuilt next to this module
 * (dist/inpage.js). Running from the repo, it is bundled on the fly with esbuild.
 */
function getInpageSource(): Promise<string> {
  return (inpageSource ??= (async () => {
    const prebuilt = fileURLToPath(new URL('./inpage.js', import.meta.url));
    if (existsSync(prebuilt)) return readFile(prebuilt, 'utf8');
    const { build } = await import('esbuild');
    const out = await build({
      entryPoints: [fileURLToPath(new URL('../inpage/index.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      target: 'es2022',
      write: false,
    });
    return out.outputFiles[0].text;
  })());
}

/* ------------------------------------------------------------------ options */

export interface MapwrightOptions {
  /** Key under window.__mapwright_maps. Default "main". */
  mapId?: string;
  /** Default timeout for actions and waits (ms). Assertions use Playwright's expect timeout. */
  timeout?: number;
  /**
   * Layers that never count as occluders for any action (basemap labels, highlight overlays...).
   * A feature's OWN label (same source feature, different layer) is already never an occluder.
   */
  ignoreLayers?: string[];
}

export type Modifier = 'Shift' | 'Control' | 'Alt' | 'Meta';

export interface ActionOptions extends ActionPointOptions {
  timeout?: number;
  /** Keys held down during the action (real key events), e.g. ['Shift'] for shift+click. */
  modifiers?: Modifier[];
  /**
   * Map equivalent of scrollIntoView: if the target is not in the viewport, move the camera. Opt-in.
   * `true` looks the feature up in the source data (GeoJSON sources only). For tiled sources the
   * browser cannot know where an off-screen feature is: pass the location, `{ lng, lat }`.
   */
  autoPan?: boolean | LngLat;
}

export interface DrawOptions {
  timeout?: number;
  /**
   * How the app's draw tool completes a shape. There is no standard, so it is explicit:
   *  - 'click-last'  : click the last vertex again (terra-draw default)
   *  - 'click-first' : click the first vertex again
   *  - 'dblclick'    : double-click the last vertex (mapbox-gl-draw style)
   *  - 'enter'       : press Enter
   *  - 'none'        : leave the shape open
   */
  finish?: 'click-last' | 'click-first' | 'dblclick' | 'enter' | 'none';
  /** Optional pause between vertices (ms) for draw tools that debounce clicks. Default 0. */
  vertexDelay?: number;
}

const POLL = [0, 30, 60, 100, 100, 200, 300, 500];

/* ------------------------------------------------------------------ MapHandle */

export class MapHandle {
  readonly mapId: string;
  readonly timeout: number;
  readonly ignoreLayers: string[];

  constructor(readonly page: Page, opts: MapwrightOptions = {}) {
    this.mapId = opts.mapId ?? 'main';
    this.timeout = opts.timeout ?? 10_000;
    this.ignoreLayers = opts.ignoreLayers ?? [];
  }

  /** @internal */
  async _find(q: FeatureQuery): Promise<FeatureSummary[]> {
    return (await this._call<WireSummary[]>('find', toWire(q))).map(fromWire);
  }

  /** @internal */
  _explain(q: FeatureQuery): Promise<string> {
    return this._call<string>('explain', toWire(q)).catch((e) => `(could not inspect the map: ${(e as Error).message.split('\n')[0]})`);
  }

  /** @internal RPC into the in-page engine; (re)injects it on demand, e.g. after navigation. */
  async _call<T>(method: string, ...args: unknown[]): Promise<T> {
    const run = () =>
      this.page.evaluate(
        async ([m, id, a]) => {
          const api = (window as any).__mapwright;
          if (!api) return { missing: true as const };
          return { missing: false as const, value: await api[m as string](id, ...(a as unknown[])) };
        },
        [method, this.mapId, args] as const,
      );
    let res = await run();
    if (res.missing) {
      await this.page.evaluate(await getInpageSource());
      res = await run();
    }
    return (res as { value: T }).value;
  }

  /** @internal poll `attempt` until it returns a value or the timeout elapses. */
  async _retry<T>(what: string, timeout: number, attempt: () => Promise<{ value: T } | { retry: string }>): Promise<T> {
    const deadline = Date.now() + timeout;
    let last = 'never attempted';
    for (let i = 0; ; i++) {
      try {
        const r = await attempt();
        if ('value' in r) return r.value;
        last = r.retry;
      } catch (e) {
        // "no map registered yet" and navigation races are retryable; they surface on timeout.
        last = (e as Error).message.split('\n')[0];
      }
      const wait = POLL[Math.min(i, POLL.length - 1)];
      if (Date.now() + wait > deadline) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    throw new MapwrightError(`${what}: timed out after ${timeout}ms — ${last}`);
  }

  /**
   * Resolves when the map is loaded, not animating, all tiles are loaded and no repaint is
   * pending. NOTE: this cannot see app-level async work (a fetch that will later call setData);
   * use retrying assertions for that, not waitForIdle.
   */
  async waitForIdle(opts: { timeout?: number } = {}): Promise<void> {
    const timeout = opts.timeout ?? this.timeout;
    await step(`map.waitForIdle()`, () =>
      this._retry('map.waitForIdle()', timeout, async () => {
        const ok = await this._call<boolean>('waitForIdle', Math.min(timeout, 2000));
        return ok ? { value: undefined } : { retry: 'map did not become idle (still moving, loading tiles, or repainting)' };
      }),
    );
  }

  feature(query: FeatureQuery): FeatureHandle {
    return new FeatureHandle(this, query);
  }

  features(query: FeatureQuery = {}): FeatureSetHandle {
    return new FeatureSetHandle(this, query);
  }

  viewState(): Promise<{ center: LngLat; zoom: number; bearing: number; pitch: number; bounds: Record<string, number>; size: { width: number; height: number } }> {
    return this._call('viewState');
  }

  /** Text snapshot of the map for humans and LLM agents (the canvas analogue of an aria snapshot). */
  snapshot(opts?: SnapshotOptions): Promise<string> {
    return this._call('snapshot', opts ?? {});
  }

  layers(): Promise<LayerInfo[]> {
    return this._call('layers');
  }

  /** lng/lat under a client (viewport) pixel. */
  lngLatAt(client: { x: number; y: number }): Promise<LngLat> {
    return this._call('worldAt', client);
  }

  /* ---- location actions (the ACT gap at arbitrary coordinates) ---- */

  async clickAt(at: LngLat, opts: ActionOptions & { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<void> {
    await step(`map.clickAt(${fmt(at)}${opts.button ? `, ${opts.button}` : ''})`, async () => {
      const p = await this._pointAt(at, opts, 'map.clickAt');
      await this.page.mouse.move(p.x, p.y);
      await withModifiers(this.page, opts.modifiers, () => this.page.mouse.click(p.x, p.y, { button: opts.button, clickCount: opts.clickCount }));
    });
  }

  dblclickAt(at: LngLat, opts: ActionOptions = {}): Promise<void> {
    return this.clickAt(at, { ...opts, clickCount: 2 });
  }

  /**
   * Real mouse-wheel input with the pointer over a location (MapLibre zooms around the pointer).
   * Negative deltaY zooms in. The zoom is animated: follow with `expect(map).toHaveView(...)` or
   * `waitForIdle()`.
   */
  async wheelAt(at: LngLat, deltaY: number, opts: ActionOptions = {}): Promise<void> {
    await step(`map.wheelAt(${fmt(at)}, ${deltaY})`, async () => {
      const p = await this._pointAt(at, opts, 'map.wheelAt');
      await this.page.mouse.move(p.x, p.y);
      await withModifiers(this.page, opts.modifiers, () => this.page.mouse.wheel(0, deltaY));
    });
  }

  rightClickAt(at: LngLat, opts: ActionOptions = {}): Promise<void> {
    return this.clickAt(at, { ...opts, button: 'right' });
  }

  async hoverAt(at: LngLat, opts: ActionOptions = {}): Promise<void> {
    await step(`map.hoverAt(${fmt(at)})`, async () => {
      const p = await this._pointAt(at, opts, 'map.hoverAt');
      await this.page.mouse.move(p.x, p.y, { steps: 4 });
    });
  }

  /** Real press-move-release. `steps` matters: MapLibre (and draw tools) ignore a single jump. */
  async dragAt(from: LngLat, to: LngLat, opts: ActionOptions & { steps?: number } = {}): Promise<void> {
    await step(`map.dragAt(${fmt(from)} -> ${fmt(to)})`, async () => {
      const a = await this._pointAt(from, opts, 'map.dragAt(from)');
      const b = await this._pointAt(to, { ...opts, autoPan: false }, 'map.dragAt(to)');
      await this._drag(a, b, opts.steps);
    });
  }

  /** @internal */
  async _drag(a: { x: number; y: number }, b: { x: number; y: number }, steps = 12): Promise<void> {
    await this.page.mouse.move(a.x, a.y, { steps: 3 });
    await this.page.mouse.down();
    await this.page.mouse.move(b.x, b.y, { steps });
    await this.page.mouse.up();
  }

  /** @internal lngLat -> client pixel, waiting until it is in view, uncovered and the map is still. */
  _pointAt(at: LngLat, opts: ActionOptions, what: string): Promise<{ x: number; y: number }> {
    return this._retry<{ x: number; y: number }>(`${what} ${fmt(at)}`, opts.timeout ?? this.timeout, async () => {
      const r = await this._call<{ client: { x: number; y: number }; inside: boolean; covered: boolean; moving: boolean }>('clientPoint', at);
      if (r.moving) return { retry: 'map is moving' };
      if (!r.inside) {
        if (!opts.autoPan) return { retry: 'location is outside the viewport (pass { autoPan: true } to move the camera)' };
        await this._call('revealWorld', at);
        await this._call('waitForIdle', 2000);
        return { retry: 'panned to location' };
      }
      if (r.covered && !opts.force) return { retry: 'location is covered by a DOM element (popup, control, overlay)' };
      return { value: r.client };
    });
  }

  /* ---- drawing ---- */

  readonly draw = {
    polygon: (vertices: LngLat[], opts: DrawOptions = {}) => this._drawPath('polygon', vertices, opts),
    line: (vertices: LngLat[], opts: DrawOptions = {}) => this._drawPath('line', vertices, opts),
  };

  private async _drawPath(kind: string, vertices: LngLat[], opts: DrawOptions): Promise<void> {
    const finish = opts.finish ?? 'click-last';
    const delay = opts.vertexDelay ?? 0;
    await step(`map.draw.${kind}(${vertices.length} vertices, finish: ${finish})`, async () => {
      const pts: { x: number; y: number }[] = [];
      for (const v of vertices) pts.push(await this._pointAt(v, opts, `map.draw.${kind} vertex`));
      for (const p of pts) {
        await this.page.mouse.move(p.x, p.y, { steps: 5 });
        await this.page.mouse.click(p.x, p.y);
        if (delay) await this.page.waitForTimeout(delay);
      }
      const last = pts[pts.length - 1];
      const first = pts[0];
      if (finish === 'click-last') await this.page.mouse.click(last.x, last.y);
      else if (finish === 'click-first') {
        await this.page.mouse.move(first.x, first.y, { steps: 5 });
        await this.page.mouse.click(first.x, first.y);
      } else if (finish === 'dblclick') await this.page.mouse.dblclick(last.x, last.y);
      else if (finish === 'enter') await this.page.keyboard.press('Enter');
    });
  }
}

/* ------------------------------------------------------------------ FeatureHandle */

export class FeatureHandle {
  constructor(readonly map: MapHandle, readonly query: FeatureQuery) {}

  toString() {
    return `map.feature(${show(this.query)})`;
  }

  private pointOpts(opts: ActionOptions): ActionPointOptions {
    return { force: opts.force, ignoreLayers: [...this.map.ignoreLayers, ...(opts.ignoreLayers ?? [])] };
  }

  /** @internal Run `act` once the feature is actionable; `act` may ask for a retry. */
  async _withActionPoint(what: string, opts: ActionOptions, act: (p: { x: number; y: number }) => Promise<{ retry: string } | void>): Promise<void> {
    const timeout = opts.timeout ?? this.map.timeout;
    let panned = false;
    try {
      await this.map._retry<true>(what, timeout, async () => {
        const r = await this.map._call<ActionPointResult>('actionPoint', toWire(this.query), this.pointOpts(opts));
        if (!r.ok) {
          if (opts.autoPan && !panned && (r.reason === 'not-found' || r.reason === 'offscreen')) {
            const revealed =
              typeof opts.autoPan === 'object'
                ? (await this.map._call('revealWorld', opts.autoPan), true)
                : await this.map._call<boolean>('reveal', toWire(this.query));
            if (revealed) {
              panned = true;
              await this.map._call('waitForIdle', 2000);
              return { retry: 'auto-panned to feature' };
            }
          }
          return { retry: `${r.reason}: ${r.message}` };
        }
        return (await act(r.client)) ?? { value: true };
      });
    } catch (e) {
      if (!(e instanceof MapwrightError)) throw e;
      const explain = await this.map._explain(this.query);
      await attach(`map state — ${what}`, explain);
      throw new MapwrightError(`${e.message}\n\nWhat is on the map:\n${indent(explain)}`);
    }
  }

  async click(opts: ActionOptions & { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<void> {
    const what = `${this}.${opts.button === 'right' ? 'rightClick' : opts.clickCount === 2 ? 'dblclick' : 'click'}()`;
    await step(what, () =>
      this._withActionPoint(what, opts, async (p) => {
        // Arm an in-page check that re-runs the hit test at the instant the REAL event arrives.
        const token = await this.map._call<string>('armClick', toWire(this.query), this.pointOpts(opts));
        let verdict: ClickVerdict;
        try {
          await this.map.page.mouse.move(p.x, p.y);
          await withModifiers(this.map.page, opts.modifiers, () => this.map.page.mouse.click(p.x, p.y, { button: opts.button, clickCount: opts.clickCount }));
        } finally {
          verdict = await this.map._call<ClickVerdict>('disarmClick', token);
        }
        if (!verdict.fired) return { retry: 'the click never reached the page (is something outside the document covering it?)' };
        if (!verdict.ok) return { retry: `click was intercepted and cancelled: ${verdict.reason}` };
      }),
    );
  }

  rightClick(opts: ActionOptions = {}): Promise<void> {
    return this.click({ ...opts, button: 'right' });
  }

  dblclick(opts: ActionOptions = {}): Promise<void> {
    return this.click({ ...opts, clickCount: 2 });
  }

  async hover(opts: ActionOptions = {}): Promise<void> {
    const what = `${this}.hover()`;
    await step(what, () => this._withActionPoint(what, opts, async (p) => void (await this.map.page.mouse.move(p.x, p.y, { steps: 4 }))));
  }

  /** Drag this feature (e.g. a vertex handle) to a location with real mouse input. */
  async dragTo(to: LngLat, opts: ActionOptions & { steps?: number } = {}): Promise<void> {
    const what = `${this}.dragTo(${fmt(to)})`;
    await step(what, () =>
      this._withActionPoint(what, opts, async (a) => {
        const b = await this.map._pointAt(to, { ...opts, autoPan: false, force: true }, `${what} destination`);
        await this.map._drag(a, b, opts.steps);
      }),
    );
  }

  /** lng/lat of the point on the feature that an action would use. */
  async lngLat(opts: { timeout?: number } = {}): Promise<LngLat> {
    const f = await this.info(opts);
    if (!f.lngLat) throw new MapwrightError(`${this}.lngLat(): feature is rendered but not inside the viewport`);
    return f.lngLat;
  }

  /** The resolved feature (auto-waits until exactly one matches). */
  async info(opts: { timeout?: number } = {}): Promise<FeatureSummary> {
    return this.map._retry<FeatureSummary>(`${this}.info()`, opts.timeout ?? this.map.timeout, async () => {
      const found = await this.map._find(this.query);
      if (found.length === 1) return { value: found[0] };
      return { retry: found.length === 0 ? 'no rendered feature matches' : `strict mode violation: ${found.length} features match` };
    });
  }
}

export class FeatureSetHandle {
  constructor(readonly map: MapHandle, readonly query: FeatureQuery) {}

  toString() {
    return `map.features(${show(this.query)})`;
  }

  /** Snapshot, no waiting (like locator.count()). Prefer expect(...).toHaveFeatureCount(). */
  all(): Promise<FeatureSummary[]> {
    return this.map._find(this.query);
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }
}

/* ------------------------------------------------------------------ assertions */

async function pollFeatures(
  map: MapHandle,
  query: FeatureQuery,
  timeout: number,
  isNot: boolean,
  predicate: (found: FeatureSummary[]) => boolean,
): Promise<{ pass: boolean; found: FeatureSummary[]; error?: string }> {
  const deadline = Date.now() + timeout;
  let found: FeatureSummary[] = [];
  let pass = false;
  let error: string | undefined;
  for (let i = 0; ; i++) {
    try {
      // Let the map settle first so a half-loaded frame is never the basis of a verdict —
      // this matters most for `.not`, which would otherwise pass on a map that has not caught up.
      await map._call('waitForIdle', Math.max(50, Math.min(500, deadline - Date.now())));
      found = await map._find(query);
      pass = predicate(found);
      error = undefined;
      if (pass !== isNot) break;
    } catch (e) {
      error = (e as Error).message.split('\n')[0];
    }
    const wait = POLL[Math.min(i, POLL.length - 1)];
    if (Date.now() + wait >= deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  return { pass, found, error };
}

export interface ViewExpectation {
  center?: LngLat;
  zoom?: number;
  bearing?: number;
  pitch?: number;
}

export const expect = baseExpect.extend({
  /** At least one rendered feature matches. Retries; `.not` waits for none. */
  async toHaveFeature(map: MapHandle, query: FeatureQuery, options?: { timeout?: number }) {
    if (!(map instanceof MapHandle)) throw new Error('toHaveFeature: receiver must be a MapHandle — expect(map).toHaveFeature(...)');
    const timeout = options?.timeout ?? this.timeout;
    const { pass, found, error } = await pollFeatures(map, query, timeout, this.isNot, (f) => f.length > 0);
    const explain = pass === this.isNot ? await map._explain(query) : '';
    if (explain) await attach('map state — toHaveFeature', explain);
    return {
      pass,
      name: 'toHaveFeature',
      expected: query,
      actual: found,
      message: () =>
        `expect(map).${this.isNot ? 'not.' : ''}toHaveFeature(${show(query)})\n\n` +
        `Expected: ${this.isNot ? 'no' : 'at least one'} rendered feature matching, within ${timeout}ms\n` +
        `Received: ${found.length} match(es)${error ? `  (last error: ${error})` : ''}\n` +
        (this.isNot ? found.slice(0, 5).map((f) => `  - ${fmtFeature(f)}`).join('\n') + '\n' : '') +
        `\nWhat is on the map:\n${indent(explain)}`,
    };
  },

  /**
   * Exactly N rendered features match. Deliberately NOT named toHaveCount: expect.extend is keyed
   * by name, and shadowing Playwright's locator matcher makes its failures point into this file.
   */
  async toHaveFeatureCount(received: FeatureSetHandle, expected: number, options?: { timeout?: number }) {
    if (!(received instanceof FeatureSetHandle)) throw new Error('toHaveFeatureCount: receiver must be map.features(...)');
    const timeout = options?.timeout ?? this.timeout;
    const { pass, found, error } = await pollFeatures(received.map, received.query, timeout, this.isNot, (f) => f.length === expected);
    const explain = pass === this.isNot ? await received.map._explain(received.query) : '';
    if (explain) await attach('map state — toHaveFeatureCount', explain);
    return {
      pass,
      name: 'toHaveFeatureCount',
      expected,
      actual: found.length,
      message: () =>
        `expect(${received}).${this.isNot ? 'not.' : ''}toHaveFeatureCount(${expected})\n\n` +
        `Expected: ${this.isNot ? 'not ' : ''}${expected}\nReceived: ${found.length}${error ? `  (last error: ${error})` : ''}\n` +
        found.slice(0, 8).map((f) => `  - ${fmtFeature(f)}`).join('\n') +
        `\n\nWhat is on the map:\n${indent(explain)}`,
    };
  },

  /** Camera matches (only the given fields), once the map has stopped moving. Retries. */
  async toHaveView(map: MapHandle, expected: ViewExpectation, options?: { timeout?: number; zoomTolerance?: number; degreesTolerance?: number }) {
    if (!(map instanceof MapHandle)) throw new Error('toHaveView: receiver must be a MapHandle');
    const timeout = options?.timeout ?? this.timeout;
    const zt = options?.zoomTolerance ?? 0.01;
    const dt = options?.degreesTolerance ?? 0.0005;
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
    const deadline = Date.now() + timeout;
    let view: Awaited<ReturnType<MapHandle['viewState']>> | undefined;
    let pass = false;
    for (let i = 0; ; i++) {
      try {
        const moving = await map._call<boolean>('isMoving');
        view = await map.viewState();
        pass =
          !moving &&
          (expected.zoom === undefined || near(view.zoom, expected.zoom, zt)) &&
          (expected.bearing === undefined || near(view.bearing, expected.bearing, 0.1)) &&
          (expected.pitch === undefined || near(view.pitch, expected.pitch, 0.1)) &&
          (expected.center === undefined || (near(view.center.lng, expected.center.lng, dt) && near(view.center.lat, expected.center.lat, dt)));
        if (pass !== this.isNot) break;
      } catch {
        /* map not registered yet: retry */
      }
      const wait = POLL[Math.min(i, POLL.length - 1)];
      if (Date.now() + wait >= deadline) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    const actual = view && { center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch };
    return {
      pass,
      name: 'toHaveView',
      expected,
      actual,
      message: () =>
        `expect(map).${this.isNot ? 'not.' : ''}toHaveView(${JSON.stringify(expected)})\n\n` +
        `Expected: ${JSON.stringify(expected)} (±${zt} zoom, ±${dt}°), map at rest, within ${timeout}ms\n` +
        `Received: ${JSON.stringify(actual)}`,
    };
  },
});

/* ------------------------------------------------------------------ misc */

export class MapwrightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapwrightError';
  }
}

export function mapwright(page: Page, opts?: MapwrightOptions): MapHandle {
  return new MapHandle(page, opts);
}

/** Hold modifier keys (real keyboard input) around `body`. */
async function withModifiers<T>(page: Page, modifiers: Modifier[] | undefined, body: () => Promise<T>): Promise<T> {
  for (const m of modifiers ?? []) await page.keyboard.down(m);
  try {
    return await body();
  } finally {
    for (const m of [...(modifiers ?? [])].reverse()) await page.keyboard.up(m);
  }
}

/** Show up as one boxed step in traces/reports when running under @playwright/test. */
async function step<T>(title: string, body: () => Promise<T>): Promise<T> {
  let inTest = true;
  try {
    test.info();
  } catch {
    inTest = false;
  }
  return inTest ? test.step(title, body, { box: true }) : body();
}

/** Put the "what is on the map" text into the HTML report / trace as an attachment. */
async function attach(name: string, body: string): Promise<void> {
  try {
    await test.info().attach(name, { body, contentType: 'text/plain' });
  } catch {
    /* not running under @playwright/test */
  }
}

const fmt = (l: LngLat) => `[${+l.lng.toFixed(5)}, ${+l.lat.toFixed(5)}]`;
const fmtFeature = (f: FeatureSummary) =>
  `${f.layer}${f.id !== undefined ? `#${f.id}` : ''} ${JSON.stringify(f.properties)}${f.pixel ? ` @(${f.pixel.x},${f.pixel.y})` : ''}`;
const indent = (s: string) => s.split('\n').map((l) => '  ' + l).join('\n');
