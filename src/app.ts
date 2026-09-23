/**
 * `geowright/app`: the TYPE of the app hook, for the app's TypeScript — and nothing else.
 *
 * In any `.d.ts` file your app's tsconfig includes (a Vite app has `src/vite-env.d.ts`):
 *
 *     /// <reference types="geowright/app" />
 *
 * and the hook line compiles as written, without `(window as any)`:
 *
 *     (window.__geowright_maps ??= {}).main = map;
 *
 * Type-only: package.json exports this entry with a `types` condition and nothing else, and it declares no values,
 * so nothing from geowright can end up in the app's bundle (docs/decisions/0002-the-app-hook-contract.md).
 * The map is `unknown` on purpose: the hook takes a MapLibre GL JS 2–6 or Mapbox GL JS v1 map, or whatever a
 * wrapper hands over, and the app's types never depend on a map library's typings through geowright.
 */
declare global {
  interface Window {
    /** Maps registered for geowright, by name (`geowright(page, { mapId })`, default `'main'`). Test / dev builds only. */
    __geowright_maps?: Record<string, unknown>;
  }
}

export {};
