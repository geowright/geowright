import { expect as baseExpect, selectors, test, type CDPSession, type Expect, type ExpectMatcherState, type Locator, type MatcherReturnType, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  ActionPointOptions,
  ActionPointResult,
  ClickVerdict,
  DebugMark,
  Geometry,
  GeometryExpectation,
  GeometryVerdict,
  FeatureQuery as WireQuery,
  FeatureSummary as WireSummary,
  LayerInfo,
  LngLat,
  Overlay,
  PixelPoint,
  SnapshotOptions as WireSnapshotOptions,
  WhereOp,
  WhereValue,
} from '../inpage/types.js'; // explicit extension: the published .d.ts must resolve under moduleResolution nodenext

// Every type a public signature names is importable from 'geowright'.
export type { ActionPointOptions, Geometry, GeometryExpectation, LayerInfo, LngLat, PixelPoint, WhereOp, WhereValue };

/** Query as written in tests: like the wire format, but `where` values may also be a RegExp. */
export interface FeatureQuery extends Omit<WireQuery, 'where'> {
  where?: Record<string, WhereValue | RegExp | WhereOp>;
}

/** Options of `map.snapshot()`. */
export interface SnapshotOptions extends Omit<WireSnapshotOptions, 'filter'> {
  /** List only entities matching this query — how to find one feature among thousands of look-alikes. */
  filter?: FeatureQuery;
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

/* ------------------------------------------------------------------ element pins */

/**
 * `map.marker()` / `map.popup()` hand out normal Locators. They used to be `locator(css).nth(i)`:
 * bound to document ORDER, so adding or removing another marker silently re-pointed them at a
 * different element. Now the element itself is pinned in the page (a JS reference in a Map — the
 * app's DOM is not touched) and a custom selector engine resolves the pin lazily, on every use.
 * If the app removes or replaces the element the locator matches nothing, and says so.
 *
 * Playwright wants selector engines registered before the page exists, hence at import time.
 */
const PIN_ENGINE = 'geowright_pin';
const pinEngine: Promise<boolean> = selectors
  .register(PIN_ENGINE, () => ({
    query(root: Document | Element, token: string) {
      return this.queryAll(root, token)[0] ?? null;
    },
    queryAll(root: Document | Element, token: string): Element[] {
      const el = (window as any).__geowright_pins?.get(token) as Element | undefined;
      return el && el.isConnected && (root === document || root.contains(el)) ? [el] : [];
    },
  }))
  .then(() => true, (e: Error) => /already registered/i.test(e.message));

/* ------------------------------------------------------------------ options */

export interface GeowrightOptions {
  /** Key under window.__geowright_maps. Default "main". */
  mapId?: string;
  /** Timeout for actions and waits (ms); default: see `MapHandle.timeout`. 0: no timeout, as in Playwright. Assertions use Playwright's expect timeout. */
  timeout?: number;
  /**
   * Layers that never count as occluders for any action (basemap labels, highlight overlays...).
   * A feature's OWN label (same source feature, different layer) is already never an occluder.
   */
  ignoreLayers?: string[];
  /**
   * Opt-in accessibility mirror: every feature also becomes an invisible real <button> inside the
   * map container, so plain Playwright locators work on the map —
   * `page.getByRole('button', { name: /Gas leak/ }).click()` — alongside the handle API.
   * Trade-off: it adds DOM to the page under test. Off by default.
   */
  mirror?: boolean | { max?: number };
  /**
   * When an action or assertion fails under @playwright/test, attach a screenshot of the map with
   * the expectation drawn on it (candidate pixels, occluders, asked-for location). The drawing is a
   * pointer-events:none overlay that exists only while the screenshot is taken. Default true.
   */
  failureScreenshots?: boolean;
}

/** Which marker / popup: at a location, and/or pointing at a feature. */
export interface OverlayWhere {
  at?: LngLat;
  feature?: FeatureQuery;
  /** How far (px) the overlay's anchor may be from `at`. Default 8. */
  tolerancePx?: number;
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

/**
 * Options of `dragTo`, `dragBy`, `lngLat` and the location actions (`clickAt`, `hoverAt`, `tapAt`…): every action option
 * except `moving`. A drag's press, the answer of `lngLat()` and an action at a location have no check at the instant the
 * real event arrives, so on a target that never stops they would act on a predicted, never-verified pixel.
 * `{ moving: 'allow' }` is refused here — by the type, and at run time.
 */
export type SteadyActionOptions = Omit<ActionOptions, 'moving'> & { moving?: never };

function refuseMoving(method: string, opts: { moving?: unknown }, what = method === 'lngLat' ? 'a lngLat() answer' : 'a drag'): void {
  if (opts.moving !== undefined) {
    throw new GeowrightError(
      `${method}() does not take { moving: '${String(opts.moving)}' }: ${what} has no check at the instant the real event arrives, ` +
        `so on a moving target it would act on a predicted, never-verified pixel. Wait until the target is still (the default), ` +
        `or use click() / tap() / hover(), which verify a moving target when the input arrives.`,
    );
  }
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

export interface TwoPointDrawOptions {
  timeout?: number;
  /**
   * How the app's tool takes the two points of a rectangle / circle. No standard here either:
   *  - 'click-move-click' : click, move, click (terra-draw default)
   *  - 'drag'             : press, move, release (terra-draw `drawInteraction: 'click-drag'`, most plugins)
   */
  gesture?: 'click-move-click' | 'drag';
  /** Intermediate mouse moves; draw tools ignore a single jump. Default 8. */
  steps?: number;
}

/** A location action refuses `moving` (SteadyActionOptions): it has no feature to verify when the input arrives. */
const refuseMovingAt = (method: string, opts: { moving?: unknown }) => refuseMoving(method, opts, 'an action at a location');

const POLL = [0, 30, 60, 100, 100, 200, 300, 500];

/**
 * The least time a round trip into the page is given before it is abandoned at a deadline. A last attempt that started
 * with a few ms left used to be abandoned for want of them, and the timeout then blamed "a busy main thread" on an idle
 * page, burying the real reason. An answer that takes longer than this IS a busy page. Measured, the slowest round
 * trip (actionPoint): 24–59 ms on the demo, 35–206 ms on the dense page at 4x CPU throttling.
 */
const MIN_ANSWER_MS = 500;
/**
 * How long failure diagnostics (the map state, the screenshot) may take after an action or assertion has failed. They
 * wait for the page; without a bound, a page that stopped answering held the failure until it answered. Measured
 * at 4x CPU throttling on the dense page: the map state ≤ 130 ms, the screenshot ≤ 110 ms.
 */
const DIAGNOSTIC_GRACE_MS = 2000;

/**
 * The time an in-page look (actionPoint) may spend on its own waits — pixel probes and the wait after one (decision 0022): what is
 * left, less room for its answer to come back, so that it answers with what it found instead of being abandoned.
 */
const lookBudget = (deadline: number) => (deadline === Infinity ? undefined : Math.max(0, Math.round(deadline - Date.now() - Math.min(MIN_ANSWER_MS, (deadline - Date.now()) / 4))));
/**
 * A matcher's pixel probe may take what is left of its timeout, at least 100 ms. `timeout: 0` (no timeout) leaves an
 * Infinity that the page cannot wait with (`setTimeout(…, Infinity)` fires at once): a probe then gets 5 s, the
 * in-page default of an action's look, and the matcher's own retries go on.
 */
const probeBudget = (deadline: number) => (deadline === Infinity ? 5000 : Math.max(100, deadline - Date.now()));

/** The injection of the in-page engine under way, per page: concurrent first calls share it. */
const injections = new WeakMap<Page, Promise<unknown>>();

/** A token per action: the page keeps a pixel-probe verdict for the retries of that one action only (decision 0022). */
let actionCount = 0;
const actionToken = () => `${process.pid}.${++actionCount}.${Math.random().toString(36).slice(2, 8)}`;

/** The deadline of a timeout. As in Playwright, 0 means no timeout. */
const deadlineOf = (timeout: number) => (timeout === 0 ? Infinity : Date.now() + timeout);

/** A side-effect-free round trip into the page outlived the action's deadline. */
class DeadlineError extends Error {}

/** A call that sends real input threw (`error`). The input may have left: the action ends with `error`, never retries. */
class InputThrew {
  constructor(readonly error: unknown) {}
}

/** A press that reached the page without passing the check: a failure after input, never sent again (as InputThrew). */
const unverified = (what: string, kind: string, why: string) =>
  new InputThrew(new GeowrightError(`${what}: the ${kind} was sent once and reached the page, but it was not verified: ${why}. It is not sent again.`));

/**
 * A press the check let through, whose click event then missed the target (the map library decides what was clicked
 * there, after the release; the app may have moved the map on the press, a moving target moves on): the app's click
 * landed elsewhere. A failure after input, never sent again.
 */
const missedAtClick = (what: string, kind: string, why: string) =>
  new InputThrew(new GeowrightError(`${what}: the ${kind} was sent once and the target was under the pointer when the press arrived, but ${why}: the app's click landed there, not on the target. It is not sent again.`));

/**
 * Real input inside a retry loop. A throw from it may come after the input left (the page got the click, the answer did
 * not come back), and a retry would then click twice: it ends the action with that error instead.
 */
async function sendInput<T>(input: () => Promise<T>): Promise<T> {
  try {
    return await input();
  } catch (e) {
    throw new InputThrew(e);
  }
}

/** `p`, or a DeadlineError from `message()` once `ms` have passed. The loser of the race is left to settle unobserved. */
function within<T>(p: Promise<T>, ms: number, message: () => string): Promise<T> {
  if (ms === Infinity) return p;
  p.catch(() => {}); // if it loses the race, its eventual failure must not become an unhandled rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message())), Math.max(0, ms));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Aiming at a moving target. The pointer arrives some ms after the pixel was computed; how many is not
 * knowable in advance (it is the page's frame time plus the input pipeline), but every miss measures it:
 * the target was `offset` px from the pointer, moving at `velocity` px/ms, so the pointer was late by
 * offset·v/|v|² ms. Closed loop on a scalar; direction comes fresh from the page on every attempt.
 */
class Aim {
  leadMs = 0;
  velocity?: { x: number; y: number };
  private measured: number[] = [];
  /** Returns a note for the retry message. */
  learn(verdict: ClickVerdict): string {
    const v = this.velocity, o = verdict.offset;
    const v2 = v ? v.x * v.x + v.y * v.y : 0;
    if (!v || !o || v2 < 1e-6) return '';
    const late = (o.x * v.x + o.y * v.y) / v2;
    // lead + late IS this attempt's measured latency. The median of the last few, not a full-gain correction:
    // a mousemove is delivered on a frame boundary, so under load single measurements jump by whole frames
    // (seen: "-749ms late" right after "+268ms"), and chasing each one never settles.
    this.measured.push(this.leadMs + late);
    const recent = this.measured.slice(-5).sort((x, y) => x - y);
    this.leadMs = Math.max(0, Math.min(800, recent[Math.floor(recent.length / 2)]));
    return ` (it was ${Math.round(Math.hypot(o.x, o.y))}px away: the pointer was ${Math.round(late)}ms late; now leading by ${Math.round(this.leadMs)}ms)`;
  }
}

/* ------------------------------------------------------------------ MapHandle */

export class MapHandle {
  readonly mapId: string;
  private readonly fixedTimeout?: number;
  readonly ignoreLayers: string[];
  private readonly mirrorOpt: GeowrightOptions['mirror'];
  private readonly failureScreenshots: boolean;

  constructor(readonly page: Page, opts: GeowrightOptions = {}) {
    this.mirrorOpt = opts.mirror;
    this.failureScreenshots = opts.failureScreenshots ?? true;
    this.mapId = opts.mapId ?? 'main';
    this.fixedTimeout = opts.timeout;
    this.ignoreLayers = opts.ignoreLayers ?? [];
  }

  /**
   * Default timeout for actions and waits. An explicit `geowright(page, { timeout })` wins. Otherwise 10s — a
   * third of Playwright's default 30s test timeout — and it SCALES with the test's timeout: `test.slow()` triples
   * Playwright's budget precisely because the page is slow (software GL, terrain, a globe's first paint), and a
   * default that stayed at 10s made every such spec set its own. Read when used, so `test.slow()` may come later.
   */
  get timeout(): number {
    if (this.fixedTimeout !== undefined) return this.fixedTimeout;
    let testTimeout = 0;
    try {
      testTimeout = test.info().timeout; // 0 = no timeout (debugging): keep the plain default
    } catch {
      /* not under @playwright/test */
    }
    return Math.max(10_000, Math.round(testTimeout / 3));
  }

  /**
   * Default timeout of `waitForIdle()`: two thirds of the test's timeout (20s under Playwright's default 30s), at least
   * `timeout`. The first idle after a navigation is a LOAD — style, sources, tiles, first render — not an action on a
   * page that is already there, and Playwright bounds loads by the test timeout only. Measured on 5 third-party apps
   * with five parallel software-GL workers on a busy machine: 4–9s to the first idle (1.7–2.2s alone) — a 10s budget
   * was a coin toss exactly where CI is slow. An explicit `geowright(page, { timeout })` still applies to everything.
   */
  get idleTimeout(): number {
    if (this.fixedTimeout !== undefined) return this.fixedTimeout;
    let testTimeout = 0;
    try {
      testTimeout = test.info().timeout;
    } catch {
      /* not under @playwright/test */
    }
    return Math.max(this.timeout, Math.round((testTimeout * 2) / 3));
  }

  /** @internal */
  async _find(q: FeatureQuery, deadline = Infinity): Promise<FeatureSummary[]> {
    return (await this._callBy<WireSummary[]>(deadline, 'find', toWire(q))).map(fromWire);
  }

  /**
   * @internal `_find`, plus the reason when the query names a layer the style does not have (the matchers: no verdict).
   * Abandoned at `deadline` (a matcher's: it has no side effects).
   */
  async _findChecked(q: FeatureQuery, deadline = Infinity): Promise<{ found: FeatureSummary[]; missingLayer?: string }> {
    const r = await this._callBy<{ found: WireSummary[]; missingLayer?: string }>(deadline, 'findChecked', toWire(q));
    return { found: r.found.map(fromWire), missingLayer: r.missingLayer };
  }

  /** @internal The map state for a failure message; bounded (`by`): it must not hold up the failure it explains. */
  _explain(q: FeatureQuery, by = Date.now() + DIAGNOSTIC_GRACE_MS): Promise<string> {
    return this._callBy<string>(by, 'explain', toWire(q)).catch((e) => `(could not inspect the map: ${(e as Error).message.split('\n')[0]})`);
  }

  /**
   * @internal Failure artefact: the map as it is NOW, with marks drawn on it. The overlay is added,
   * screenshotted and removed in one go (never left in the app's DOM), and nothing here may throw:
   * a failing artefact must not mask the real failure — nor hold it up: it gives up at `by`.
   */
  async _attachFailureScreenshot(name: string, query: FeatureQuery | undefined, extra: DebugMark[] = [], opts: ActionPointOptions = {}, by = Date.now() + DIAGNOSTIC_GRACE_MS): Promise<void> {
    if (!this.failureScreenshots) return;
    try {
      test.info();
    } catch {
      return; // not under @playwright/test: nowhere to attach
    }
    const id = `geowright-marks-${Math.random().toString(36).slice(2)}`;
    try {
      const left = () => by - Date.now();
      const marks = [...extra, ...(query ? await this._callBy<DebugMark[]>(by, 'debugMarks', toWire(query), opts) : [])];
      const drawn = this.page.evaluate(
        ([overlayId, mapId, list]) => {
          const map = (window as any).__geowright_maps?.[mapId as string];
          const r = (map?.getCanvas?.() as HTMLElement | undefined)?.getBoundingClientRect();
          const color = { ok: '#00c853', miss: '#9e9e9e', occluded: '#d50000', dom: '#ff6d00', target: '#2962ff' } as Record<string, string>;
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.id = overlayId as string;
          svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;');
          for (const m of list as DebugMark[]) {
            const g = document.createElementNS(ns, 'g');
            const c = color[m.kind];
            const arm = m.kind === 'target' ? 9 : 5;
            g.innerHTML =
              `<path d="M${m.x - arm},${m.y}H${m.x + arm}M${m.x},${m.y - arm}V${m.y + arm}" stroke="#fff" stroke-width="4"/>` +
              `<path d="M${m.x - arm},${m.y}H${m.x + arm}M${m.x},${m.y - arm}V${m.y + arm}" stroke="${c}" stroke-width="2"/>` +
              (m.kind === 'target' ? `<circle cx="${m.x}" cy="${m.y}" r="12" fill="none" stroke="${c}" stroke-width="2"/>` : '');
            if (m.label) {
              const t = document.createElementNS(ns, 'text');
              const flip = m.x + 10 + m.label.length * 7 > (r?.right ?? Infinity); // keep the label inside the clip
              if (flip) t.setAttribute('text-anchor', 'end');
              t.setAttribute('x', String(flip ? m.x - 10 : m.x + 10));
              t.setAttribute('y', String(m.y - 8));
              t.setAttribute('style', `font:bold 12px system-ui;fill:${c};paint-order:stroke;stroke:#fff;stroke-width:3px;`);
              t.textContent = m.label;
              g.appendChild(t);
            }
            svg.appendChild(g);
          }
          const legend = document.createElementNS(ns, 'text');
          legend.setAttribute('x', String((r?.left ?? 0) + 8));
          legend.setAttribute('y', String((r?.bottom ?? 20) - 8));
          legend.setAttribute('style', 'font:12px system-ui;fill:#000;paint-order:stroke;stroke:#fff;stroke-width:3px;');
          legend.textContent = 'geowright: green = clickable pixel · red = under another feature · orange = under DOM · grey = not on the feature · blue = asked location';
          svg.appendChild(legend);
          document.documentElement.appendChild(svg);
          return r ? { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height } : null;
        },
        [id, this.mapId, marks] as const,
      );
      const clip = await within(drawn, left(), () => 'no time left');
      if (left() <= 0) return;
      const body = await this.page.screenshot({ clip: clip ?? undefined, animations: 'disabled', caret: 'initial', timeout: Math.max(1, left()) });
      await test.info().attach(name, { body, contentType: 'image/png' });
    } catch {
      /* best effort */
    } finally {
      // Sent even when out of time: the page runs it after the drawing, whenever it gets to them.
      await within(this.page.evaluate((overlayId) => document.getElementById(overlayId)?.remove(), id), Math.max(0, by - Date.now()), () => '').catch(() => {});
    }
  }

  /**
   * @internal `_call`, but gives up at `deadline`. ONLY for calls without side effects the app can act on (queries,
   * waits, an action's look, whose pixel probe puts the style back by itself): the abandoned evaluate keeps running in
   * the page and its answer is dropped. Never wrap real input.
   */
  _callBy<T>(deadline: number, method: string, ...args: unknown[]): Promise<T> {
    return this._answerBy(deadline, method, this._call<T>(method, ...args));
  }

  /** @internal `call` (a round trip into the page, `method`), abandoned at `deadline` — but never before MIN_ANSWER_MS. */
  _answerBy<T>(deadline: number, method: string, call: Promise<T>): Promise<T> {
    const budget = deadline === Infinity ? Infinity : Math.max(MIN_ANSWER_MS, Math.round(deadline - Date.now()));
    return within(call, budget, () => `the page did not answer "${method}" in the time that was left (${budget}ms; a busy main thread: heavy rendering, or an overloaded machine)`);
  }

  /**
   * @internal `_answerBy` for arming a click-time (hover-time) check. No input has left yet, so the wait is abandoned at
   * `deadline` like a query's; the page arms the check all the same whenever it gets to it, and it is disarmed then.
   */
  _armBy(deadline: number, method: string, arming: Promise<string>): Promise<string> {
    return this._answerBy(deadline, method, arming).catch((e) => {
      if (e instanceof DeadlineError) arming.then((token) => void this._disarm(token), () => {}); // armed after all, later
      throw e;
    });
  }

  /**
   * @internal Ends a click-time (hover-time) check and returns what it saw. `undefined`: the check is gone with the page
   * it was armed in — the input navigated, so the round trip failed or reached a fresh page. Real input left, so it is
   * taken as DELIVERED, as Playwright takes a click that navigates: it must never be sent again.
   */
  async _disarm(token: string): Promise<ClickVerdict | undefined> {
    try {
      return (await this._call<ClickVerdict | null>('disarmClick', token)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** @internal RPC into the in-page engine; (re)injects it on demand, e.g. after navigation. */
  async _call<T>(method: string, ...args: unknown[]): Promise<T> {
    const run = () =>
      this.page.evaluate(
        async ([m, id, a]) => {
          const api = (window as any).__geowright;
          if (!api) return { missing: true as const };
          return { missing: false as const, value: await api[m as string](id, ...(a as unknown[])) };
        },
        [method, this.mapId, args] as const,
      );
    let res = await run();
    if (res.missing) {
      // One injection per document, however many first calls find it missing at once (the evaluate is ~400 KB).
      let injecting = injections.get(this.page);
      if (!injecting) {
        injecting = getInpageSource().then((src) => this.page.evaluate(src)).finally(() => injections.delete(this.page));
        injections.set(this.page, injecting);
      }
      await injecting;
      res = await run();
    }
    return (res as { value: T }).value;
  }

  /**
   * @internal poll `attempt` until it returns a value or the timeout elapses (0: no timeout). `deadline`: when a call
   * shares its timeout between several steps (a drag's two points), the one they share; `timeout` names it in messages.
   */
  async _retry<T>(what: string, timeout: number, attempt: (deadline: number) => Promise<{ value: T } | { retry: string }>, deadline = deadlineOf(timeout)): Promise<T> {
    let last = 'never attempted';
    let slowest = -1; // ms, the longest attempt the page answered (-1: none)
    for (let i = 0; ; i++) {
      const started = Date.now();
      try {
        const r = await attempt(deadline);
        if ('value' in r) return r.value;
        last = r.retry;
        slowest = Math.max(slowest, Date.now() - started);
      } catch (e) {
        if (e instanceof InputThrew) throw e.error; // real input may have left: never sent again
        if (e instanceof DeadlineError) {
          // `timeout` is a wall-clock promise. One slow round trip into a busy page used to run on for as long as it
          // liked (measured: 33s for { timeout: 2000 } on an overloaded machine); it is abandoned instead. A page that is
          // not answering is left alone: the caller skips the diagnostics that would wait for it. But a page that
          // answered the attempts before, whose last attempt started with less time left than its slowest answered one
          // took, is slow, not stalled (the matchers' rule): the failure is what it answered, with the map state.
          if (slowest < 0 || deadline - started >= slowest) throw new UnresponsiveError(`${what}: timed out after ${timeout}ms — ${e.message}; before that: ${last}`);
          throw new GeowrightError(`${what}: timed out after ${timeout}ms — ${last} (the attempt still running at the deadline was abandoned: the page was slow to answer it)`);
        }
        // "no map registered yet" and navigation races are retryable; they surface on timeout.
        last = (e as Error).message.split('\n')[0];
        slowest = Math.max(slowest, Date.now() - started);
      }
      const wait = POLL[Math.min(i, POLL.length - 1)];
      if (Date.now() + wait > deadline) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    throw new GeowrightError(`${what}: timed out after ${timeout}ms — ${last}`);
  }

  /**
   * Resolves when the map is loaded, not animating, all tiles are loaded and no repaint is
   * pending. NOTE: this cannot see app-level async work (a fetch that will later call setData);
   * use retrying assertions for that, not waitForIdle.
   */
  async waitForIdle(opts: { timeout?: number } = {}): Promise<void> {
    const timeout = opts.timeout ?? this.idleTimeout;
    await step(`map.waitForIdle()`, () =>
      this._retry('map.waitForIdle()', timeout, async (deadline) => {
        // Abandoned at the deadline like every other wait: the in-page wait bounds itself (<= 2s), but a page whose main
        // thread is busy answers when it can. The in-page wait takes half the time left, so that its answer, with the
        // diagnosis ("the app keeps replacing the data: never idle") that is the point of the error message, comes back
        // in time on a page that animates itself (a setData loop answered late when the wait took all but 500 ms).
        const left = deadline === Infinity ? 4000 : deadline - Date.now();
        const ok = await this._callBy<boolean>(deadline, 'waitForIdle', Math.round(Math.max(50, Math.min(left / 2, 2000))));
        if (!ok) {
          const why = await this._callBy<string | undefined>(Date.now() + DIAGNOSTIC_GRACE_MS, 'idleDiagnosis').catch(() => undefined);
          return { retry: `map did not become idle (still moving, loading tiles, or repainting)${why ? ` — ${why}` : ''}` };
        }
        // The mirror is (re)started here: after a navigation the page is new and it is gone.
        if (this.mirrorOpt && !(await this._callBy<boolean>(deadline, 'hasMirror'))) {
          await this._callBy(deadline, 'mirror', typeof this.mirrorOpt === 'object' ? this.mirrorOpt : {});
        }
        return { value: undefined };
      }),
    );
  }

  feature(query: FeatureQuery): FeatureHandle {
    return new FeatureHandle(this, query);
  }

  features(query: FeatureQuery = {}): FeatureSetHandle {
    return new FeatureSetHandle(this, query);
  }

  viewState(): Promise<{ center: LngLat; zoom: number; bearing: number; pitch: number; bounds: Record<string, number>; size: { width: number; height: number }; projection: string; terrain: boolean }> {
    return this._call('viewState');
  }

  /** Text snapshot of the map for humans and LLM agents (the canvas analogue of an aria snapshot). */
  snapshot(opts: SnapshotOptions = {}): Promise<string> {
    return this._call('snapshot', { ...opts, filter: opts.filter && toWire(opts.filter) });
  }

  layers(): Promise<LayerInfo[]> {
    return this._call('layers');
  }

  /**
   * Client (viewport) pixel of a location, once it is inside the view and the map is still. The
   * bridge to plain Playwright for DOM things on the map: `page.mouse`, `locator.dragTo`, markers.
   */
  clientPoint(at: LngLat, opts: { timeout?: number } = {}): Promise<{ x: number; y: number }> {
    return this._pointAt(at, { ...opts, force: true }, 'map.clientPoint');
  }

  /* ---- DOM overlays: MapLibre Marker / Popup ---- */

  /**
   * A normal Playwright Locator for the DOM marker at a location (or on a feature). Markers are
   * elements, so everything Playwright can do applies — click(), hover(), toBeVisible(), dragTo().
   * Auto-waits until exactly one marker is there; the Locator is then pinned to THAT element (not to
   * its position in the document): other markers may come and go, and if the app removes or replaces
   * this one the Locator matches nothing — resolve again.
   */
  marker(where: OverlayWhere, opts: { timeout?: number } = {}): Promise<Locator> {
    return this._overlay('marker', where, opts);
  }

  /** Locator for a popup; with no `where`, the only popup on the map. */
  popup(where: OverlayWhere = {}, opts: { timeout?: number } = {}): Promise<Locator> {
    return this._overlay('popup', where, opts);
  }

  /** @internal Abandoned at `deadline` (it has no side effects). */
  _overlays(kind: Overlay['kind'], where: OverlayWhere, deadline = Infinity): Promise<(Overlay & { distance?: number })[]> {
    return this._callBy(deadline, 'overlaysAt', kind, { ...where, feature: where.feature && toWire(where.feature) });
  }

  private async _overlay(kind: Overlay['kind'], where: OverlayWhere, opts: { timeout?: number }): Promise<Locator> {
    const what = `map.${kind}(${JSON.stringify(where)})`;
    // Matched and pinned in ONE in-page call: in two round trips, an overlay inserted in between could re-point
    // the pin at a different element.
    const found = await step(what, () =>
      this._retry<{ overlay: Overlay; token?: string; docIndex?: number }>(what, opts.timeout ?? this.timeout, async (deadline) => {
        // Abandoned at the deadline on a page that cannot answer. A pin whose answer is dropped only leaves an unused
        // entry in the page's pin table: nothing the app sees.
        if (await this._callBy<boolean>(deadline, 'isMoving')) return { retry: 'map is moving' };
        const r = await this._callBy<{ list: (Overlay & { distance?: number })[]; token?: string; docIndex?: number }>(deadline, 'pinOverlay', kind, { ...where, feature: where.feature && toWire(where.feature) });
        const list = r.list;
        if (list.length === 1) return { value: { overlay: list[0], token: r.token, docIndex: r.docIndex } };
        if (list.length === 0) {
          const all = await this._overlays(kind, {}, deadline);
          return { retry: `no ${kind} there; ${all.length} ${kind}(s) on the map${all.length ? ': ' + all.slice(0, 5).map((o) => `"${o.text.slice(0, 40)}" @(${Math.round(o.rect.x)},${Math.round(o.rect.y)})`).join(', ') : ''}` };
        }
        return { retry: `strict mode violation: ${list.length} ${kind}s match` };
      }),
    );
    // engine unavailable: order-bound fallback (by document order; an element in a shadow root has none)
    if (!(await pinEngine) || !found.token) return this.page.locator(found.overlay.selector).nth(Math.max(0, found.docIndex ?? 0));
    return this.page.locator(`${PIN_ENGINE}=${found.token}`);
  }

  /** lng/lat under a client (viewport) pixel. */
  lngLatAt(client: { x: number; y: number }): Promise<LngLat> {
    return this._call('worldAt', client);
  }

  /* ---- location actions (the ACT gap at arbitrary coordinates) ---- */

  async clickAt(at: LngLat, opts: SteadyActionOptions & { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<void> {
    refuseMovingAt('clickAt', opts);
    await step(`map.clickAt(${fmt(at)}${opts.button ? `, ${opts.button}` : ''})`, async () => {
      const p = await this._pointAt(at, opts, 'map.clickAt');
      await this.page.mouse.move(p.x, p.y);
      await withModifiers(this.page, opts.modifiers, () => this.page.mouse.click(p.x, p.y, { button: opts.button, clickCount: opts.clickCount }));
    });
  }

  async dblclickAt(at: LngLat, opts: SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('dblclickAt', opts);
    return this.clickAt(at, { ...opts, clickCount: 2 });
  }

  /**
   * Real mouse-wheel input with the pointer over a location (MapLibre zooms around the pointer).
   * Negative deltaY zooms in. The zoom is animated: follow with `expect(map).toHaveView(...)` or
   * `waitForIdle()`.
   */
  async wheelAt(at: LngLat, deltaY: number, opts: SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('wheelAt', opts);
    await step(`map.wheelAt(${fmt(at)}, ${deltaY})`, async () => {
      const p = await this._pointAt(at, opts, 'map.wheelAt');
      await this.page.mouse.move(p.x, p.y);
      await withModifiers(this.page, opts.modifiers, () => this.page.mouse.wheel(0, deltaY));
    });
  }

  async rightClickAt(at: LngLat, opts: SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('rightClickAt', opts);
    return this.clickAt(at, { ...opts, button: 'right' });
  }

  async hoverAt(at: LngLat, opts: SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('hoverAt', opts);
    await step(`map.hoverAt(${fmt(at)})`, async () => {
      const p = await this._pointAt(at, opts, 'map.hoverAt');
      await this.page.mouse.move(p.x, p.y, { steps: 4 });
    });
  }

  /** Real press-move-release. `steps` matters: MapLibre (and draw tools) ignore a single jump. */
  async dragAt(from: LngLat, to: LngLat, opts: SteadyActionOptions & { steps?: number } = {}): Promise<void> {
    refuseMovingAt('dragAt', opts);
    await step(`map.dragAt(${fmt(from)} -> ${fmt(to)})`, async () => {
      const deadline = deadlineOf(opts.timeout ?? this.timeout); // one timeout for the whole drag
      const a = await this._pointAt(from, opts, 'map.dragAt(from)', deadline);
      const b = await this._pointAt(to, { ...opts, autoPan: false }, 'map.dragAt(to)', deadline);
      await this._drag(a, b, opts.steps, opts.modifiers);
    });
  }

  /** @internal */
  async _drag(a: { x: number; y: number }, b: { x: number; y: number }, steps = 12, modifiers?: Modifier[]): Promise<void> {
    await this.page.mouse.move(a.x, a.y, { steps: 3 });
    // The keys go down BEFORE the button (shift+drag = MapLibre box zoom, not a pan). Originally drags
    // accepted `modifiers` in their type and silently ignored them — found on MapLibre's boxzoom example.
    await withModifiers(this.page, modifiers, async () => {
      await this.page.mouse.down();
      await this.page.mouse.move(b.x, b.y, { steps });
      await this.page.mouse.up();
    });
  }

  /**
   * @internal lngLat -> client pixel, waiting until it is in view, uncovered and the map is still. `deadline`: the one of
   * the whole action, when it has several points; by default its own timeout.
   */
  async _pointAt(at: LngLat, opts: ActionOptions, what: string, deadline?: number): Promise<{ x: number; y: number }> {
    let last: { x: number; y: number } | undefined;
    try {
      return await this._pointAtOnce(at, opts, what, (c) => (last = c), deadline);
    } catch (e) {
      // A page that is not answering would hold the screenshot up as long as it does not answer.
      if (e instanceof GeowrightError && !(e instanceof UnresponsiveError)) await this._attachFailureScreenshot(`map screenshot — ${what}`, undefined, last ? [{ ...last, kind: 'target', label: fmt(at) }] : []);
      throw e;
    }
  }

  private _pointAtOnce(at: LngLat, opts: ActionOptions, what: string, seen: (client: { x: number; y: number }) => void, deadline?: number): Promise<{ x: number; y: number }> {
    const timeout = opts.timeout ?? this.timeout;
    // Once per action, as for a feature: a location a pan cannot bring into the window (a map more than twice the
    // window's size) would otherwise be panned to on every attempt, and the timeout would say only "panned".
    let panned = false;
    return this._retry<{ x: number; y: number }>(`${what} ${fmt(at)}`, timeout, async (by) => {
      const r = await this._pointNow(at, opts, seen, by);
      if ('outside' in r && opts.autoPan && !panned) {
        panned = true;
        await this._answerBy(by, 'revealWorld', this._call('revealWorld', at)); // the pan is sent either way; its answer is not waited for past the deadline
        await this._callBy(by, 'waitForIdle', 2000);
        return { retry: 'panned to location' };
      }
      return 'retry' in r ? { retry: r.retry } : r;
    }, deadline ?? deadlineOf(timeout));
  }

  /**
   * @internal ONE look, no waiting and no panning: the client pixel of a location if an action could use it right now.
   * `deadline`: the look is abandoned then (it has no side effects).
   */
  async _pointNow(at: LngLat, opts: ActionOptions, seen?: (client: { x: number; y: number }) => void, deadline = Infinity): Promise<{ value: { x: number; y: number } } | { retry: string; outside?: true }> {
    const r = await this._callBy<{ client: { x: number; y: number }; inside: boolean; offview?: boolean; hidden: boolean; covered: boolean; moving: boolean }>(deadline, 'clientPoint', at);
    seen?.(r.client);
    if (r.moving) return { retry: 'map is moving' };
    if (!r.inside) return { retry: `location is outside the viewport${!opts.autoPan ? ' (pass { autoPan: true } to move the camera)' : ''}`, outside: true };
    // Not reachable by any pointer, `force` or not (force skips the cover check, not this): the input would land outside
    // the page and the app would never get it. autoPan may bring it into the window, as for a feature action.
    if (r.offview) return { retry: 'the location is on the map, but that part of the map is outside the browser window (the map is larger than the viewport and cannot be scrolled fully into it)', outside: true };
    if (r.hidden) return { retry: 'location is not on the visible map surface (far side of the globe, beyond the horizon, or behind the camera): its pixel shows something else' };
    if (r.covered && !opts.force) return { retry: 'location is covered by a DOM element (popup, control, overlay)' };
    return { value: r.client };
  }

  /* ---- touch (mobile map apps) ---- */

  /**
   * Real touch tap at a location. Needs a touch-enabled context (`test.use({ hasTouch: true })`).
   * Playwright's touchscreen API has exactly one gesture: tap.
   */
  async tapAt(at: LngLat, opts: SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('tapAt', opts);
    await step(`map.tapAt(${fmt(at)})`, async () => {
      const p = await this._pointAt(at, opts, 'map.tapAt');
      await this.page.touchscreen.tap(p.x, p.y);
    });
  }

  /**
   * Two-finger pinch around a location: `scale` 2 spreads the fingers to twice their distance
   * (MapLibre: about +1 zoom), 0.5 pinches in. Multi-touch does not exist in Playwright's API, so
   * this goes through CDP `Input.dispatchTouchEvent` — the same browser input layer Playwright's
   * own mouse uses, real touch events for the page — and is therefore CHROMIUM ONLY.
   * The map keeps moving after release (inertia): follow with `toHaveView` / `waitForIdle`.
   */
  async pinchAt(at: LngLat, o: { scale: number; steps?: number; startDistancePx?: number } & SteadyActionOptions): Promise<void> {
    refuseMovingAt('pinchAt', o);
    await step(`map.pinchAt(${fmt(at)}, scale ${o.scale})`, async () => {
      const c = await this._pointAt(at, o, 'map.pinchAt');
      const d0 = (o.startDistancePx ?? 120) / 2;
      await this._twoFingers(o.steps ?? 12, (t) => {
        const d = d0 * (1 + (o.scale - 1) * t);
        return [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }];
      });
    });
  }

  /** Two-finger rotate around a location, clockwise degrees of the FINGERS (the map's bearing follows them, negated). Chromium only. */
  async twoFingerRotateAt(at: LngLat, o: { degrees: number; steps?: number; radiusPx?: number } & SteadyActionOptions): Promise<void> {
    refuseMovingAt('twoFingerRotateAt', o);
    await step(`map.twoFingerRotateAt(${fmt(at)}, ${o.degrees}°)`, async () => {
      const c = await this._pointAt(at, o, 'map.twoFingerRotateAt');
      const r = o.radiusPx ?? 80;
      await this._twoFingers(o.steps ?? 16, (t) => {
        const a = (o.degrees * t * Math.PI) / 180;
        return [{ x: c.x - r * Math.cos(a), y: c.y - r * Math.sin(a) }, { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }];
      });
    });
  }

  /**
   * One-finger drag (pan) from one location to another. CDP touch input, Chromium only. MapLibre adds
   * INERTIA when the finger leaves while still moving, as for a real swipe: the map travels further
   * than the finger did. Assert with `toHaveView` after it settles, with a tolerance — or look at
   * where a known feature ended up.
   */
  async touchDragAt(from: LngLat, to: LngLat, o: { steps?: number } & SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('touchDragAt', o);
    await step(`map.touchDragAt(${fmt(from)} -> ${fmt(to)})`, async () => {
      const deadline = deadlineOf(o.timeout ?? this.timeout); // one timeout for the whole gesture
      const a = await this._pointAt(from, o, 'map.touchDragAt(from)', deadline);
      const b = await this._pointAt(to, { ...o, autoPan: false }, 'map.touchDragAt(to)', deadline);
      await this._twoFingers(o.steps ?? 12, (t) => [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }]);
    });
  }

  /** Double tap at a location (MapLibre: zoom in by one, around the finger). CDP touch input, Chromium only. */
  async doubleTapAt(at: LngLat, o: SteadyActionOptions = {}): Promise<void> {
    refuseMovingAt('doubleTapAt', o);
    await step(`map.doubleTapAt(${fmt(at)})`, async () => {
      const p = await this._pointAt(at, o, 'map.doubleTapAt');
      for (let i = 0; i < 2; i++) await this._twoFingers(0, () => [p]);
    });
  }

  private cdp?: Promise<CDPSession>;
  /** Touch points over time (one finger or several), sent as real browser-level touch input. */
  private async _twoFingers(steps: number, at: (t: number) => { x: number; y: number }[]): Promise<void> {
    const browser = this.page.context().browser();
    if (browser && browser.browserType().name() !== 'chromium') {
      throw new GeowrightError('touch gestures need Chromium: Playwright has no touch-move or multi-touch API (touchscreen.tap only), this uses CDP Input.dispatchTouchEvent');
    }
    // A session that could not be made is not cached: the next gesture tries again. (It ends with the page.)
    const cdp = await (this.cdp ??= this.page.context().newCDPSession(this.page).catch((e: Error) => {
      this.cdp = undefined;
      throw e;
    }));
    const points = (t: number) => at(t).map((p, id) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, id }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
    for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(i / steps) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /* ---- keyboard ---- */

  /**
   * Real key presses with the MAP focused (MapLibre: arrows pan 100px, +/- zoom, Shift+arrows
   * rotate / pitch). Focus is moved the way Playwright's own `locator.press` does it.
   */
  readonly keyboard = {
    press: (key: string) =>
      step(`map.keyboard.press(${key})`, async () => {
        const canvas = await this.page.evaluateHandle((id) => (window as any).__geowright_maps?.[id]?.getCanvas?.() as HTMLElement | undefined, this.mapId);
        try {
          const el = canvas.asElement();
          if (!el) throw new GeowrightError(`map.keyboard.press: no map registered as "${this.mapId}"`);
          await el.focus();
        } finally {
          await canvas.dispose().catch(() => {});
        }
        await this.page.keyboard.press(key);
      }),
  };

  /* ---- drawing ---- */

  readonly draw = {
    polygon: (vertices: LngLat[], opts: DrawOptions = {}) => this._drawPath('polygon', vertices, opts),
    line: (vertices: LngLat[], opts: DrawOptions = {}) => this._drawPath('line', vertices, opts),
    /** Rectangle from two opposite corners. */
    rectangle: (corner: LngLat, opposite: LngLat, opts: TwoPointDrawOptions = {}) => this._drawTwoPoint('rectangle', corner, opposite, opts),
    /** Circle from its centre and a point on its edge. */
    circle: (center: LngLat, edge: LngLat, opts: TwoPointDrawOptions = {}) => this._drawTwoPoint('circle', center, edge, opts),
    /** Abandon the shape in progress the way a user would: Escape (real key press). */
    cancel: () => step('map.draw.cancel()', () => this.page.keyboard.press('Escape')),
  };

  private async _drawTwoPoint(kind: string, from: LngLat, to: LngLat, opts: TwoPointDrawOptions): Promise<void> {
    const gesture = opts.gesture ?? 'click-move-click';
    const steps = opts.steps ?? 8;
    await step(`map.draw.${kind}(${fmt(from)} -> ${fmt(to)}, ${gesture})`, async () => {
      const deadline = deadlineOf(opts.timeout ?? this.timeout); // one timeout for the whole shape
      const a = await this._pointAt(from, opts, `map.draw.${kind} start`, deadline);
      const b = await this._pointAt(to, opts, `map.draw.${kind} end`, deadline);
      await this.page.mouse.move(a.x, a.y, { steps: 3 });
      if (gesture === 'drag') {
        await this.page.mouse.down();
        await this.page.mouse.move(b.x, b.y, { steps });
        await this.page.mouse.up();
      } else {
        await this.page.mouse.click(a.x, a.y);
        await this.page.mouse.move(b.x, b.y, { steps });
        await this.page.mouse.click(b.x, b.y);
      }
    });
  }

  private async _drawPath(kind: string, vertices: LngLat[], opts: DrawOptions): Promise<void> {
    const finish = opts.finish ?? 'click-last';
    const delay = opts.vertexDelay ?? 0;
    await step(`map.draw.${kind}(${vertices.length} vertices, finish: ${finish})`, async () => {
      const pts: { x: number; y: number }[] = [];
      const deadline = deadlineOf(opts.timeout ?? this.timeout); // one timeout for the whole shape
      for (const v of vertices) pts.push(await this._pointAt(v, opts, `map.draw.${kind} vertex`, deadline));
      for (const p of pts) {
        await this.page.mouse.move(p.x, p.y, { steps: 5 });
        await this.page.mouse.click(p.x, p.y);
        if (delay) await this.page.waitForTimeout(delay); // the caller's own pause (a draw tool that debounces clicks), never a wait of ours
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

  /** `force` also means "even if it is painted invisibly". */
  private wire(opts: ActionOptions): WireQuery {
    return toWire(opts.force && this.query.visible === undefined ? { ...this.query, visible: 'any' } : this.query);
  }

  private pointOpts(opts: ActionOptions, leadMs?: number): ActionPointOptions {
    return { force: opts.force, moving: opts.moving, leadMs, ignoreLayers: [...this.map.ignoreLayers, ...(opts.ignoreLayers ?? [])] };
  }

  /** @internal Run `act` once the feature is actionable; `act` may ask for a retry. */
  async _withActionPoint(
    what: string,
    opts: ActionOptions,
    /** `deadline`: this attempt's; `act`'s round trips before the input leaves are abandoned then. */
    act: (p: { x: number; y: number }, aim: Aim, token: string | undefined, deadline: number) => Promise<{ retry: string } | void>,
    /** Moving targets: arm the click-time check BEFORE the pixel is computed — every round trip after it is lateness. */
    armFirst?: () => Promise<string>,
    /** The deadline of the whole action, when it has more steps than this one (dragTo: its destination first). */
    sharedDeadline?: number,
  ): Promise<void> {
    const timeout = opts.timeout ?? this.map.timeout;
    let panned = false;
    const aim = new Aim(); // moving targets: how far ahead to point, learnt from misses across the attempts
    const action = actionToken(); // this action's pixel-probe verdicts serve its own retries only
    // Nothing that follows a failure may wait for a page that stopped answering: the check armed before it is
    // disarmed without waiting for the answer (the page runs it when it gets to it; its verdict is not needed).
    const release = (token: string | undefined) => void (token && this.map._disarm(token));
    try {
      await this.map._retry<true>(what, timeout, async (deadline) => {
        const arming = armFirst?.();
        const token = arming && (await this.map._armBy(deadline, 'arm', arming));
        // Looking for the pixel may be abandoned at the deadline (a pixel probe it ran puts the style back by itself); real
        // input (below) never is.
        const r = await this.map._callBy<ActionPointResult>(deadline, 'actionPoint', this.wire(opts), { ...this.pointOpts(opts, aim.leadMs), budgetMs: lookBudget(deadline), action }).catch((e) => {
          release(token);
          throw e;
        });
        if (r.ok) aim.velocity = r.velocity;
        if (!r.ok) {
          release(token); // its verdict is not needed: not waited for
          if (opts.autoPan && !panned && (r.reason === 'not-found' || r.reason === 'offscreen')) {
            // The camera move is sent either way; the wait for its answer is abandoned at the deadline, like a query's.
            const revealed =
              typeof opts.autoPan === 'object'
                ? (await this.map._answerBy(deadline, 'revealWorld', this.map._call('revealWorld', opts.autoPan)), true)
                : await this.map._answerBy(deadline, 'reveal', this.map._call<boolean>('reveal', toWire(this.query)));
            if (revealed) {
              panned = true;
              await this.map._callBy(deadline, 'waitForIdle', 2000);
              return { retry: 'auto-panned to feature' };
            }
          }
          return { retry: `${r.reason}: ${r.message}` };
        }
        const outcome = await act(r.client, aim, token, deadline);
        if (!outcome) {
          // Trace friendliness: WHICH pixel, and why that one. One short text attachment per action.
          await attach(`pixel — ${what}`, `client (${r.client.x}, ${r.client.y}) · canvas (${r.surface.x}, ${r.surface.y})${r.feature.world ? ` · ${JSON.stringify(r.feature.world)}` : ''}\n${r.why}`);
        }
        return outcome ?? { value: true };
      }, sharedDeadline);
    } catch (e) {
      if (!(e instanceof GeowrightError)) throw e;
      // The page is not answering: what is on the map, and a screenshot of it, would wait for it.
      if (e instanceof UnresponsiveError) throw new UnresponsiveError(`${e.message}\n\n(What is on the map was not inspected: the page was not answering.)`);
      const by = Date.now() + DIAGNOSTIC_GRACE_MS; // one grace for both
      const explain = await this.map._explain(this.query, by);
      await attach(`map state — ${what}`, explain);
      await this.map._attachFailureScreenshot(`map screenshot — ${what}`, this.query, [], this.pointOpts(opts), by);
      throw new GeowrightError(`${e.message}\n\nWhat is on the map:\n${indent(explain)}`);
    }
  }

  async click(opts: ActionOptions & { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<void> {
    const what = `${this}.${opts.button === 'right' ? 'rightClick' : opts.clickCount === 2 ? 'dblclick' : 'click'}()`;
    await step(what, () =>
      this._withActionPoint(what, opts, async (p, aim, armed, deadline) => {
        // Arm an in-page check that re-runs the hit test at the instant the REAL event arrives.
        const token = armed ?? (await this.map._armBy(deadline, 'armClick', this.map._call<string>('armClick', this.wire(opts), this.pointOpts(opts))));
        let verdict: ClickVerdict | undefined;
        try {
          await sendInput(async () => {
            if (opts.moving !== 'allow') await this.map.page.mouse.move(p.x, p.y); // (mouse.click moves too; for a moving target the extra round trip is lateness)
            await withModifiers(this.map.page, opts.modifiers, () => this.map.page.mouse.click(p.x, p.y, { button: opts.button, clickCount: opts.clickCount }));
          });
        } finally {
          verdict = await this.map._disarm(token);
        }
        // Retried ONLY when the check positively says the click was swallowed, or that nothing reached the page at all.
        if (!verdict) return; // the page it was armed in is gone: the click navigated — delivered, never sent again
        if (verdict.unchecked) throw unverified(what, 'click', verdict.unchecked);
        if (!verdict.fired) return { retry: 'the click never reached the page (is something outside the document covering it?)' };
        if (!verdict.ok) return { retry: `click was intercepted and cancelled: ${verdict.reason}${aim.learn(verdict)}` };
        if (verdict.missed) throw missedAtClick(what, 'click', verdict.missed);
      }, opts.moving === 'allow' ? () => this.map._call<string>('armClick', this.wire(opts), this.pointOpts(opts)) : undefined),
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
    if (opts.moving !== 'allow') return step(what, () => this._withActionPoint(what, opts, async (p) => void (await sendInput(() => this.map.page.mouse.move(p.x, p.y, { steps: 4 })))));
    // A moving target: one move (every extra step is latency), verified at the instant the pointer arrives.
    await step(what, () =>
      this._withActionPoint(what, opts, async (p, aim, armed) => {
        const token = armed!;
        let verdict: ClickVerdict | undefined;
        try {
          await sendInput(() => this.map.page.mouse.move(p.x, p.y));
        } finally {
          verdict = await this.map._disarm(token);
        }
        if (!verdict) return; // the page it was armed in is gone: delivered
        if (!verdict.fired) return { retry: 'the pointer never reached the page' };
        if (!verdict.ok) return { retry: `hover missed the moving target: ${verdict.reason}${aim.learn(verdict)}` };
      }, () => this.map._call<string>('armHover', this.wire(opts), this.pointOpts(opts))),
    );
  }

  /** Real touch tap on the feature (touch-enabled context). Same actionability and click-time verification as click(). */
  async tap(opts: ActionOptions = {}): Promise<void> {
    const what = `${this}.tap()`;
    await step(what, () =>
      this._withActionPoint(what, opts, async (p, aim, _armed, deadline) => {
        const token = await this.map._armBy(deadline, 'armClick', this.map._call<string>('armClick', this.wire(opts), this.pointOpts(opts)));
        let verdict: ClickVerdict | undefined;
        try {
          await sendInput(() => this.map.page.touchscreen.tap(p.x, p.y));
        } finally {
          verdict = await this.map._disarm(token);
        }
        if (!verdict) return; // the page it was armed in is gone: the tap navigated — delivered, never sent again
        if (verdict.unchecked) throw unverified(what, 'tap', verdict.unchecked);
        if (!verdict.fired) return { retry: 'the tap never reached the page' };
        if (!verdict.ok) return { retry: `tap was intercepted and cancelled: ${verdict.reason}${aim.learn(verdict)}` };
        if (verdict.missed) throw missedAtClick(what, 'tap', verdict.missed);
      }),
    );
  }

  /** Drag this feature (e.g. a vertex handle) to a location with real mouse input. Takes no `moving` (see SteadyActionOptions). */
  async dragTo(to: LngLat, opts: SteadyActionOptions & { steps?: number } = {}): Promise<void> {
    refuseMoving('dragTo', opts);
    const what = `${this}.dragTo(${fmt(to)})`;
    await step(what, async () => {
      // The destination first (it may wait for the map, up to the timeout), THEN the source: the press follows the
      // source's verification at once. Resolved after it, a long wait here let the target move before the press.
      const dest = { ...opts, autoPan: false, force: true };
      const deadline = deadlineOf(opts.timeout ?? this.map.timeout); // one timeout for both
      await this.map._pointAt(to, dest, `${what} destination`, deadline);
      await this._withActionPoint(what, opts, async (a, _aim, _token, attempt) => {
        // one round trip, no waiting: the camera may have moved since, so the destination pixel is read afresh
        const b = await this.map._pointNow(to, dest, undefined, attempt);
        if ('retry' in b) return { retry: `destination: ${b.retry}` };
        await sendInput(() => this.map._drag(a, b.value, opts.steps, opts.modifiers));
      }, undefined, deadline);
    });
  }

  /**
   * Move the whole feature: press on it, drag by a lng/lat offset, release. The grab point is the
   * feature's action point, so the pointer travels exactly (dLng, dLat). NOTE: draw tools that
   * recognise a drag only after a pixel threshold (terra-draw: 8px) move the shape by that much
   * less — for users too. Assert the result with a tolerance, or drag a vertex (absolute) instead.
   */
  async dragBy(delta: { dLng: number; dLat: number }, opts: SteadyActionOptions & { steps?: number } = {}): Promise<void> {
    refuseMoving('dragBy', opts);
    const what = `${this}.dragBy(${+delta.dLng.toFixed(5)}, ${+delta.dLat.toFixed(5)})`;
    await step(what, () =>
      this._withActionPoint(what, opts, async (a, _aim, _token, deadline) => {
        const from = await this.map._callBy<LngLat>(deadline, 'worldAt', a);
        // no waiting between the verified source and the press: a destination that is not reachable NOW is a retry
        const b = await this.map._pointNow({ lng: from.lng + delta.dLng, lat: from.lat + delta.dLat }, { ...opts, autoPan: false, force: true }, undefined, deadline);
        if ('retry' in b) return { retry: `destination: ${b.retry}` };
        await sendInput(() => this.map._drag(a, b.value, opts.steps, opts.modifiers));
      }),
    );
  }

  /** The feature's full geometry as the MAP holds it (source data; falls back to rendered pieces). */
  async geometry(opts: { timeout?: number } = {}): Promise<Geometry> {
    return this.map._retry<Geometry>(`${this}.geometry()`, opts.timeout ?? this.map.timeout, async (deadline) => {
      const r = await this.map._callBy<{ ok: true; geometry: Geometry } | { ok: false; message: string }>(deadline, 'geometry', toWire(this.query));
      return r.ok ? { value: r.geometry } : { retry: r.message };
    });
  }

  /**
   * lng/lat of the pixel an action WOULD use: fully verified (on the feature, topmost, not under DOM,
   * map still) — so it waits and fails exactly like `click()`, and takes the same options except `moving`
   * (SteadyActionOptions: on a moving target it would be a predicted, never-verified pixel).
   * (`info().lngLat` is cheaper but only the best GEOMETRIC candidate: on a feature that is mostly
   * covered by another one it can be a covered pixel.)
   */
  async lngLat(opts: SteadyActionOptions = {}): Promise<LngLat> {
    refuseMoving('lngLat', opts);
    const what = `${this}.lngLat()`;
    let at: LngLat | undefined;
    await this._withActionPoint(what, opts, async (p, _aim, _token, deadline) => void (at = await this.map._callBy<LngLat>(deadline, 'worldAt', p)));
    return at!;
  }

  /** The resolved feature (auto-waits until exactly one matches). */
  async info(opts: { timeout?: number } = {}): Promise<FeatureSummary> {
    return this.map._retry<FeatureSummary>(`${this}.info()`, opts.timeout ?? this.map.timeout, async (deadline) => {
      const found = (await this.map._callBy<WireSummary[]>(deadline, 'find', toWire(this.query))).map(fromWire);
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

/**
 * One poll of a retrying matcher: the condition holds (true), does not (false) — or no verdict could be reached
 * (undefined, with why): the map could not be queried, a named layer does not exist, the query is ambiguous where one
 * feature is required, the map had not settled. "Could not look" is never "absent".
 */
interface Poll {
  verdict: boolean | undefined;
  why?: string;
}

/**
 * Polls until a CONCLUSIVE result satisfies the assertion (in its polarity) or the deadline. If the last poll was
 * inconclusive, the assertion fails whichever way it was written (pass = isNot) and `inconclusive` says why — the rule
 * toHaveView has always had for a map that never came to rest. A throw is an inconclusive poll. `attempt` abandons its
 * round trips at `deadline`. A poll abandoned so after the page answered an earlier one ends the polling with THAT
 * answer: the deadline has come, and what the page last said is the verdict, as for any matcher that times out. So an
 * `attempt` sets the findings its message reports only from an answered round trip, never resets them before one.
 * `unanswered`: no poll was ever answered — the page is not answering, and nothing that follows may wait for it. (A
 * page that answered earlier is slow, not stalled: the failure's bounded look at the map still gets its diagnosis —
 * on a loaded machine the last poll is often the one abandoned.)
 */
async function pollVerdict(timeout: number, isNot: boolean, attempt: (i: number, deadline: number) => Promise<Poll>, backoff: number[] = POLL): Promise<{ pass: boolean; inconclusive?: string; unanswered?: boolean }> {
  const deadline = deadlineOf(timeout);
  let last: Poll = { verdict: undefined, why: 'never checked' };
  let answered: Poll | undefined; // the last poll the page answered
  let unanswered = false;
  for (let i = 0; ; i++) {
    unanswered = false;
    try {
      last = answered = await attempt(i, deadline);
    } catch (e) {
      if (e instanceof DeadlineError && answered) {
        last = answered;
        break;
      }
      last = { verdict: undefined, why: (e as Error).message.split('\n')[0] };
      unanswered = e instanceof DeadlineError;
    }
    if (last.verdict !== undefined && last.verdict !== isNot) break;
    const wait = backoff[Math.min(i, backoff.length - 1)];
    if (Date.now() + wait >= deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  return last.verdict === undefined ? { pass: isNot, inconclusive: last.why ?? 'no verdict', unanswered } : { pass: last.verdict };
}

const NOT_INSPECTED = '(not inspected: the page was not answering)';

/**
 * A failed assertion's map state, attached with a screenshot and returned for its message. Bounded: it must not hold up
 * the failure it explains — and skipped when the page stopped answering (`unanswered`): it would only wait for it.
 */
async function failureState(map: MapHandle, matcher: string, query: FeatureQuery, unanswered?: boolean): Promise<string> {
  if (unanswered) return NOT_INSPECTED;
  const by = Date.now() + DIAGNOSTIC_GRACE_MS; // one grace for both
  const explain = await map._explain(query, by);
  await attach(`map state — ${matcher}`, explain);
  await map._attachFailureScreenshot(`map screenshot — ${matcher}`, query, [], {}, by);
  return explain;
}

/**
 * whether the map has SETTLED enough for a verdict of absence (a `.not`, a count): it became idle within a bounded
 * wait, or it was diagnosed as a map that never becomes idle (an animation, a setData loop), where waiting cannot help.
 * A half-loaded map is not evidence that something is absent. Presence needs no settling: a found feature is there.
 * The wait grows (0.5 → 1 → 2 s) only while an absence verdict is what the assertion waits for — enough frames for a
 * slow page to be recognised as never idle — and resolves as soon as the map is idle, so a settled map costs nothing.
 */
class Settle {
  private never = false;
  async wait(map: MapHandle, i: number, deadline: number, grow: boolean): Promise<{ settled: boolean; why?: string }> {
    const cap = this.never || !grow ? 500 : [500, 1000, 2000][Math.min(i, 2)];
    // The in-page wait is bounded by itself; the round trip to it is abandoned at the deadline (a page that cannot answer).
    const r = await map._callBy<{ idle: boolean; never: boolean; why?: string }>(deadline, 'settle', Math.max(50, Math.min(cap, deadline - Date.now())));
    if (r.never) this.never = true;
    return { settled: r.idle || r.never, why: r.why };
  }
}

const notSettled = (why?: string) => `the map had not settled — it was still loading, moving or repainting${why ? ` (${why})` : ''} — so absence could not be concluded`;

/** For a failure message: what "could not decide" was about, and what to do about a missing layer. */
const undecided = (why: string) =>
  `no verdict: ${why}${/(does|do) not exist\. Layers:/.test(why) ? '\n(to assert that a layer was removed, check map.layers())' : ''}`;

export interface ViewExpectation {
  center?: LngLat;
  zoom?: number;
  bearing?: number;
  pitch?: number;
}

/** A matcher as `expect.extend` takes it. */
type Matcher = (this: ExpectMatcherState, receiver: any, ...args: any[]) => Promise<MatcherReturnType>;

/** What a failure message calls the features a query looks for. */
const kindOf = (q: FeatureQuery) => (q.visible === 'any' ? 'rendered' : q.visible === false ? 'invisible' : 'visible');

/** Bearing and pitch: degrees, compared as angles (MapLibre reports a bearing of 270 as -90). */
const ANGLE_TOLERANCE = 0.1;
const angleApart = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

const matchers = {
  /**
   * At least one feature a user can SEE matches (`{ visible: 'any' }` for MapLibre's looser notion of
   * "rendered", which includes opacity-0 features). Retries; `.not` waits for none.
   */
  async toHaveFeature(map: MapHandle, query: FeatureQuery, options?: { timeout?: number; visible?: boolean | 'any' }) {
    if (!(map instanceof MapHandle)) throw new Error('toHaveFeature: receiver must be a MapHandle — expect(map).toHaveFeature(...)');
    const timeout = options?.timeout ?? this.timeout;
    if (options?.visible !== undefined) query = { ...query, visible: options.visible };
    let found: FeatureSummary[] = [];
    const settle = new Settle();
    const { pass, inconclusive, unanswered } = await pollVerdict(timeout, this.isNot, async (i, deadline) => {
      const s = await settle.wait(map, i, deadline, this.isNot);
      const r = await map._findChecked(query, deadline);
      found = r.found;
      if (r.missingLayer) return { verdict: undefined, why: r.missingLayer };
      if (found.length > 0) return { verdict: true };
      // Only absence needs a settled map: for a positive assertion, nothing found is simply "not yet".
      return s.settled || !this.isNot ? { verdict: false } : { verdict: undefined, why: notSettled(s.why) };
    });
    const explain = pass === this.isNot ? await failureState(map, 'toHaveFeature', query, unanswered) : '';
    return {
      pass,
      name: 'toHaveFeature',
      expected: query,
      actual: found,
      message: () =>
        `expect(map).${this.isNot ? 'not.' : ''}toHaveFeature(${show(query)})\n\n` +
        `Expected: ${this.isNot ? 'no' : 'at least one'} ${kindOf(query)} feature matching, within ${timeout}ms\n` +
        `Received: ${inconclusive ? undecided(inconclusive) : `${found.length} match(es)`}\n` +
        (this.isNot ? found.slice(0, 5).map((f) => `  - ${fmtFeature(f)}`).join('\n') + '\n' : '') +
        `\nWhat is on the map:\n${indent(explain)}`,
    };
  },

  /**
   * Exactly N features match — VISIBLE ones by default, as in every query (`visible: 'any'` in the query opts out).
   * Deliberately NOT named toHaveCount: expect.extend is keyed by name, and shadowing Playwright's locator matcher
   * makes its failures point into this file.
   */
  async toHaveFeatureCount(received: FeatureSetHandle, expected: number, options?: { timeout?: number }) {
    if (!(received instanceof FeatureSetHandle)) throw new Error('toHaveFeatureCount: receiver must be map.features(...)');
    const timeout = options?.timeout ?? this.timeout;
    let found: FeatureSummary[] = [];
    const settle = new Settle();
    // A count is a verdict about what is NOT there too (the rest): it needs a settled map in both polarities.
    const { pass, inconclusive, unanswered } = await pollVerdict(timeout, this.isNot, async (i, deadline) => {
      const s = await settle.wait(received.map, i, deadline, true);
      const r = await received.map._findChecked(received.query, deadline);
      found = r.found;
      if (r.missingLayer) return { verdict: undefined, why: r.missingLayer };
      return s.settled ? { verdict: found.length === expected } : { verdict: undefined, why: notSettled(s.why) };
    });
    const explain = pass === this.isNot ? await failureState(received.map, 'toHaveFeatureCount', received.query, unanswered) : '';
    return {
      pass,
      name: 'toHaveFeatureCount',
      expected,
      actual: found.length,
      message: () =>
        `expect(${received}).${this.isNot ? 'not.' : ''}toHaveFeatureCount(${expected})\n\n` +
        `Expected: ${this.isNot ? 'not ' : ''}${expected}\nReceived: ${inconclusive ? `${undecided(inconclusive)}\nLast seen: ${found.length}` : found.length}\n` +
        found.slice(0, 8).map((f) => `  - ${fmtFeature(f)}`).join('\n') +
        `\n\nWhat is on the map:\n${indent(explain)}`,
    };
  },

  /**
   * For layers that have no features to ask about — raster, image, canvas, video, heatmap, hillshade:
   * does `layer` contribute PIXELS at a location? (The canvas pixels there change when the layer is not
   * drawn: same same-task redraw + readPixels probe as toBeVisibleOnMap, public API only.) Retries.
   */
  async toHaveLayerPixels(received: MapHandle, layer: string, options: { at: LngLat; radiusPx?: number; timeout?: number }) {
    if (!(received instanceof MapHandle)) throw new Error('toHaveLayerPixels: receiver must be a geowright map handle');
    let why = 'never checked';
    const settle = new Settle();
    const { pass, inconclusive, unanswered } = await pollVerdict(
      options.timeout ?? this.timeout,
      this.isNot,
      async (i, deadline) => {
        // Absence needs a settled map: a raster whose tiles are still loading contributes nothing YET. A positive
        // assertion waits for pixels to appear and needs no settling — nor the cost of it on an animated source.
        const s: { settled: boolean; why?: string } = this.isNot ? await settle.wait(received, i, deadline, true) : { settled: true };
        const r = await received._call<{ ok: true; diff: number; surface: { x: number; y: number }; hidden?: boolean } | { ok: false; message: string }>('layerPixels', layer, options.at, options.radiusPx ?? 24, probeBudget(deadline));
        if (!r.ok) return { verdict: undefined, why: (why = r.message) };
        why = r.hidden ? `layer "${layer}" is hidden (its visibility is "none")` : r.diff > 0 ? `pixels differ by ${r.diff} with and without the layer` : `hiding the layer changes nothing within ${options.radiusPx ?? 24}px of (${Math.round(r.surface.x)},${Math.round(r.surface.y)})`;
        if (r.diff > 0) return { verdict: true };
        return s.settled ? { verdict: false } : { verdict: undefined, why: `${notSettled(s.why)}; last probe: ${why}` };
      },
      // Each probe re-renders four times, and a layer hidden by `visibility` (data-driven opacity) has its source
      // reloaded after it: back off, so that a slow machine gets to finish that before the next probe knocks it over again.
      [250, 500, 1000, 2000],
    );
    if (inconclusive) why = undecided(inconclusive);
    if (pass === this.isNot && !unanswered) {
      // One bounded look for where to draw the mark: clientPoint() would wait (a full action timeout) for a location
      // that is off-screen or on the far side of the globe — after this assertion's own timeout.
      const by = Date.now() + DIAGNOSTIC_GRACE_MS;
      const mark = await received._callBy<{ client: { x: number; y: number } }>(by, 'clientPoint', options.at).then((r): DebugMark[] => [{ ...r.client, kind: 'target', label: layer }], () => []);
      await received._attachFailureScreenshot('map screenshot — toHaveLayerPixels', undefined, mark, {}, by);
    }
    return {
      pass,
      name: 'toHaveLayerPixels',
      message: () => `expect(map).${this.isNot ? 'not.' : ''}toHaveLayerPixels(${JSON.stringify(layer)}, { at: ${JSON.stringify(options.at)} })\n\n${why}`,
    };
  },

  /**
   * The feature can actually be SEEN, not merely "rendered" (MapLibre's queryRenderedFeatures also
   * returns opacity-0 / transparent / zero-size features). Two checks, both must hold:
   *  1. paint: the layer's paint properties, evaluated for this feature, draw something
   *  2. pixels (default on; `{ pixels: false }` to skip): the canvas pixels at the feature's action
   *     point change when its layer is not drawn. Catches transparent icons and same-colour-as-
   *     background; needs an unoccluded point, so an occluded feature is not visible either.
   * The pixel probe re-renders the map four times (with the layer, again as a control, without, restored) and
   * briefly hides the layer within one task (nothing is composited, but 'styledata' fires) — it runs
   * after the cheap paint check has passed, and its result is reused while the feature does not change.
   */
  async toBeVisibleOnMap(received: FeatureHandle, options?: { timeout?: number; pixels?: boolean }) {
    if (!(received instanceof FeatureHandle)) throw new Error('toBeVisibleOnMap: receiver must be map.feature(...)');
    const timeout = options?.timeout ?? this.timeout;
    const map = received.map;
    const query: FeatureQuery = { ...received.query, visible: 'any' }; // look at it even if invisible: that is the question
    let why = 'never checked';
    const settle = new Settle();
    // a probe re-renders four times (and reloads the source of a layer with data-driven opacity) — once per verdict,
    // not per poll. A conclusive result is reused while the feature looks the same (position, properties, state, paint verdict);
    // a changed feature is probed again at once, an unchanged one again only after 1, 2, 4… s (pixels can change with
    // nothing else changing: an icon image replaced).
    let last: { key: string; at: number; every: number; probe: { ok: true; diff?: number; inconclusive?: string; surface: { x: number; y: number }; layer: string } } | undefined;
    const { pass, inconclusive, unanswered } = await pollVerdict(
      timeout,
      this.isNot,
      async (i, deadline) => {
        const s = await settle.wait(map, i, deadline, this.isNot);
        const r = await map._findChecked(query, deadline);
        const found = r.found;
        if (r.missingLayer) return { verdict: undefined, why: (why = r.missingLayer) };
        // Several matches: "is THE feature visible?" has no answer (strictness) — in either polarity.
        if (found.length > 1) return { verdict: undefined, why: (why = `strict mode violation: ${found.length} features match`) };
        // Not visible — absent, painted invisibly, or its pixels show nothing: a verdict only on a settled map.
        const invisible = (reason: string): Poll => ((why = reason), s.settled || !this.isNot ? { verdict: false } : { verdict: undefined, why: `${notSettled(s.why)}; last seen: ${reason}` });
        if (found.length === 0) return invisible('no rendered feature matches');
        if (!found[0].visible) return invisible(`paint: ${found[0].invisibleBecause}`);
        if (options?.pixels !== false) {
          const key = JSON.stringify(found[0]);
          const reuse = last && last.key === key && Date.now() - last.at < last.every;
          const probe = reuse
            ? last!.probe
            : await map._call<{ ok: true; diff?: number; inconclusive?: string; surface: { x: number; y: number }; layer: string } | { ok: false; message: string }>('pixelProbe', toWire(query), { ignoreLayers: map.ignoreLayers, budgetMs: probeBudget(deadline) });
          if (!probe.ok) return invisible(`pixels: no clean point to probe — ${probe.message}`);
          if (!reuse) last = probe.inconclusive === undefined ? { key, at: Date.now(), every: last?.key === key ? Math.min(last.every * 2, 8000) : 1000, probe } : undefined;
          // No verdict YET — the pixels changed by themselves, or no frame came in time: never "passed on paint alone".
          if (probe.inconclusive !== undefined) return { verdict: undefined, why: (why = `pixels: ${probe.inconclusive}`) };
          if (probe.diff === 0) return invisible(`pixels: hiding layer "${probe.layer}" changes nothing at (${probe.surface.x},${probe.surface.y}) — it paints nothing a user could see there`);
          if (probe.diff === undefined && options?.pixels === true) {
            return { verdict: undefined, why: (why = 'pixels: this map cannot be probed (no WebGL context to read from); { pixels: true } asked for ground truth') };
          }
        }
        why = '';
        return { verdict: true };
      },
      POLL.slice(2),
    );
    if (inconclusive) why = undecided(inconclusive);
    const explain = pass === this.isNot ? await failureState(map, 'toBeVisibleOnMap', query, unanswered) : '';
    return {
      pass,
      name: 'toBeVisibleOnMap',
      message: () =>
        `expect(${received}).${this.isNot ? 'not.' : ''}toBeVisibleOnMap()

` +
        `Expected: ${this.isNot ? 'not visible (absent, or painted invisibly)' : 'exactly one matching feature, visible to a user'}, within ${timeout}ms
` +
        `Received: ${pass && !inconclusive ? 'visible' : why}

What is on the map:
${indent(explain)}`,
    };
  },

  /**
   * The feature's geometry ON THE MAP matches — read from the map's source, not from the app's own
   * state, and compared in pixels. `expected`: a GeoJSON geometry, a list of lng/lat vertices
   * (polygon ring if the feature is a polygon, else a line), or `{ circle: { center, edge } }`.
   * Polygon rings may start at any vertex and wind either way. Retries.
   */
  async toHaveGeometry(received: FeatureHandle, expected: GeometryExpectation | LngLat[], options?: { timeout?: number; tolerancePx?: number }) {
    if (!(received instanceof FeatureHandle)) throw new Error('toHaveGeometry: receiver must be map.feature(...)');
    const timeout = options?.timeout ?? this.timeout;
    const tolerancePx = options?.tolerancePx ?? 2;
    const map = received.map;
    let verdict: GeometryVerdict = { ok: false, reason: 'never checked' };
    const { pass, inconclusive, unanswered } = await pollVerdict(timeout, this.isNot, async (_i, deadline) => {
      await map._callBy(deadline, 'waitForIdle', Math.max(50, Math.min(500, deadline - Date.now())));
      let exp = expected as GeometryExpectation;
      if (Array.isArray(expected)) {
        // Found on a wild app: [[lng, lat], …] here ended as "Invalid LngLat object: (NaN, NaN)" from inside the page.
        if (expected.some((v) => typeof v?.lng !== 'number' || typeof v?.lat !== 'number')) {
          throw new GeowrightError('toHaveGeometry: a vertex list must be [{ lng, lat }, …]. For raw coordinates pass a GeoJSON geometry: { type: "Polygon", coordinates: [[[lng, lat], …]] }');
        }
        const coords = expected.map((v) => [v.lng, v.lat]);
        const found = await map._find(received.query, deadline);
        exp = found[0]?.geometryType === 'Polygon' ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords };
      }
      verdict = await map._callBy<GeometryVerdict>(deadline, 'compareGeometry', toWire(received.query), exp, tolerancePx);
      // Every comparison that was actually made carries the geometry it was made against; without one, nothing was
      // compared (no feature matches, or several do) — "not that geometry" cannot be concluded.
      return verdict.ok || verdict.actual !== undefined ? { verdict: verdict.ok } : { verdict: undefined, why: verdict.reason };
    });
    const explain = pass === this.isNot ? await failureState(map, 'toHaveGeometry', received.query, unanswered) : '';
    return {
      pass,
      name: 'toHaveGeometry',
      expected,
      actual: verdict.actual,
      message: () =>
        `expect(${received}).${this.isNot ? 'not.' : ''}toHaveGeometry(…, { tolerancePx: ${tolerancePx} })\n\n` +
        `Expected: ${JSON.stringify(expected)}\n` +
        `Received: ${inconclusive ? undecided(inconclusive) : verdict.ok ? 'matching geometry' : verdict.reason}\n` +
        `Geometry on the map (${verdict.from ?? 'n/a'}): ${JSON.stringify(verdict.actual)}\n\nWhat is on the map:\n${indent(explain)}`,
    };
  },

  /**
   * A popup is open AND anchored where it should be: at a location, or with its tip on a feature
   * (its anchor pixel hit-tests to the feature). Optional `text`. Retries; `.not` waits for none.
   * For the popup's content use the Locator: `await map.popup({ feature: q })`.
   */
  async toHavePopup(map: MapHandle, where: OverlayWhere & { text?: string | RegExp } = {}, options?: { timeout?: number }) {
    if (!(map instanceof MapHandle)) throw new Error('toHavePopup: receiver must be a MapHandle');
    const timeout = options?.timeout ?? this.timeout;
    const { text, ...loc } = where;
    let matching: Overlay[] = [];
    let all: Overlay[] = [];
    const { pass, inconclusive } = await pollVerdict(timeout, this.isNot, async (_i, deadline) => {
      const moving = await map._callBy<boolean>(deadline, 'isMoving');
      all = await map._overlays('popup', {}, deadline);
      matching = (await map._overlays('popup', loc, deadline)).filter((p) => text === undefined || (typeof text === 'string' ? p.text.includes(text) : text.test(p.text)));
      // Where a popup is anchored is only known once the camera stops — in either polarity: `.not` used to
      // pass on a moving map with the popup open.
      if (moving) return { verdict: undefined, why: 'the map was moving (whether a popup is anchored there is decided once the camera stops)' };
      return { verdict: matching.length > 0 };
    });
    return {
      pass,
      name: 'toHavePopup',
      message: () =>
        `expect(map).${this.isNot ? 'not.' : ''}toHavePopup(${show(where as FeatureQuery)})\n\n` +
        `Expected: ${this.isNot ? 'no' : 'a'} popup ${loc.at ? `anchored within ${loc.tolerancePx ?? 8}px of ${fmt(loc.at)}` : ''}${loc.feature ? ` pointing at ${show(loc.feature)}` : ''}${text !== undefined ? ` with text ${text}` : ''}, within ${timeout}ms\n` +
        (inconclusive ? `Received: ${undecided(inconclusive)}\n` : '') +
        `${inconclusive ? 'Last seen' : 'Received'}: ${matching.length} matching; popups on the map: ${all.length ? all.map((p) => `"${p.text.slice(0, 60)}" anchored @(${Math.round(p.anchor?.x ?? p.rect.x)},${Math.round(p.anchor?.y ?? p.rect.y)})`).join('; ') : 'none'}`,
    };
  },

  /** Camera matches (only the given fields), once the map has stopped moving. Retries. */
  async toHaveView(map: MapHandle, expected: ViewExpectation, options?: { timeout?: number; zoomTolerance?: number; degreesTolerance?: number }) {
    if (!(map instanceof MapHandle)) throw new Error('toHaveView: receiver must be a MapHandle');
    const timeout = options?.timeout ?? this.timeout;
    const zt = options?.zoomTolerance ?? 0.01;
    const dt = options?.degreesTolerance ?? 0.0005;
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
    const deadline = deadlineOf(timeout);
    let view: Awaited<ReturnType<MapHandle['viewState']>> | undefined;
    let pass = false;
    let settled = false;
    let unanswered: string | undefined; // the last poll was abandoned at the deadline, and no earlier one was answered
    let answered = false;
    let failed: string | undefined; // the last poll's error, when no poll was answered (an unregistered mapId, say)
    for (let i = 0; ; i++) {
      unanswered = undefined;
      try {
        // Abandoned at the deadline: on a page that cannot answer, the assertion fails at its timeout, not when it answers.
        const moving = await map._callBy<boolean>(deadline, 'isMoving');
        view = await map._callBy<Awaited<ReturnType<MapHandle['viewState']>>>(deadline, 'viewState');
        settled = !moving;
        pass =
          settled &&
          (expected.zoom === undefined || near(view.zoom, expected.zoom, zt)) &&
          (expected.bearing === undefined || angleApart(view.bearing, expected.bearing) <= ANGLE_TOLERANCE) &&
          (expected.pitch === undefined || near(view.pitch, expected.pitch, ANGLE_TOLERANCE)) &&
          (expected.center === undefined || (near(view.center.lng, expected.center.lng, dt) && near(view.center.lat, expected.center.lat, dt)));
        // A verdict needs the map AT REST, in both polarities. `.not.toHaveView(start)` used to be
        // satisfied by a map that was merely still animating away from `start` — so the next line of
        // the test read a mid-animation camera. Found on Linux CI (slower frames), not on the Mac.
        answered = true;
        if (settled && pass !== this.isNot) break;
      } catch (e) {
        // Abandoned at the deadline after an answered poll: that answer is the verdict (see pollVerdict).
        if (e instanceof DeadlineError) {
          if (answered) break;
          unanswered = e.message;
        } else if (!answered) failed = (e as Error).message.split('\n')[0]; // e.g. not registered YET: retried, and said if it lasts
      }
      const wait = POLL[Math.min(i, POLL.length - 1)];
      if (Date.now() + wait >= deadline) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!settled || unanswered) pass = this.isNot; // never came to rest, or could not be asked: fail, whichever way the assertion was written
    const actual = view && { center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch };
    const seen = actual ? `last seen: ${JSON.stringify(actual)}` : 'nothing seen';
    return {
      pass,
      name: 'toHaveView',
      expected,
      actual,
      message: () =>
        `expect(map).${this.isNot ? 'not.' : ''}toHaveView(${JSON.stringify(expected)})\n\n` +
        `Expected: ${JSON.stringify(expected)} (±${zt} zoom, ±${dt}° centre, ±${ANGLE_TOLERANCE}° bearing and pitch), map at rest, within ${timeout}ms\n` +
        `Received: ${unanswered ? `no verdict: ${unanswered} (${seen})` : !answered && failed ? `no verdict: ${failed} (${seen})` : settled ? JSON.stringify(actual) : `the map never came to rest within ${timeout}ms (${seen})`}`,
    };
  },
} satisfies Record<string, Matcher>;

/** The matchers geowright adds to Playwright's `expect` — e.g. to type an `expect` merged with others (`mergeExpects`). */
export type GeowrightMatchers = typeof matchers;

/**
 * Playwright's `expect`, plus the map matchers. Typed from '@playwright/test' (the package a user installs), never from
 * the `playwright` package behind it, which pnpm and Yarn PnP do not make resolvable from here.
 */
export const expect: Expect<GeowrightMatchers> = baseExpect.extend(matchers);

/* ------------------------------------------------------------------ misc */

export class GeowrightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeowrightError';
  }
}

/** A timeout at which the page was not answering: nothing that follows it may wait for the page. */
class UnresponsiveError extends GeowrightError {}

export function geowright(page: Page, opts?: GeowrightOptions): MapHandle {
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
  `${f.layer}${f.id !== undefined ? `#${f.id}` : ''} ${JSON.stringify(f.properties)}${f.pixel ? ` @(${f.pixel.x},${f.pixel.y})` : ''}${f.visible ? '' : ` [NOT VISIBLE: ${f.invisibleBecause}]`}`;
const indent = (s: string) => s.split('\n').map((l) => '  ' + l).join('\n');
