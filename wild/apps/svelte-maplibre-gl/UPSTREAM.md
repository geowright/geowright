# Upstream: MIERUNE/svelte-maplibre-gl

- Repo: https://github.com/MIERUNE/svelte-maplibre-gl (docs-site monorepo; the publishable
  library package lives at its nested `svelte-maplibre-gl/` subdirectory).
- Commit vendored from: `083a6b53a9625d9d6977fce77a3caded1a74cf37`.
- License: dual `(MIT OR Apache-2.0)` (from `svelte-maplibre-gl/package.json`). Both license
  files kept verbatim at [`LICENSE-APACHE.txt`](./LICENSE-APACHE.txt) and
  [`LICENSE-MIT.txt`](./LICENSE-MIT.txt) (copied unmodified from the monorepo root — the
  nested package directory does not carry its own copies).
- The library itself is **not vendored as source** — it's installed from npm
  (`svelte-maplibre-gl@2.2.1`, matching the clone's own declared `"version": "2.2.1"`; `npm view
  svelte-maplibre-gl version` returned `2.2.1` at the time of this vendoring, so the installed
  version and the clone's source are the same release).
- Vendored from: `src/content/examples/{clusters,hover-styles}/*.svelte` (docs-site example
  snippets) and `src/lib/{utils.ts,components/ui/{slider,checkbox,label}/*}` (the shadcn-style UI
  primitives `Clusters.svelte` imports from the docs site's `$lib`).
- Date vendored: 2026-09-20.

## Vendored paths

```
wild/apps/svelte-maplibre-gl/LICENSE-APACHE.txt                        <- LICENSE-APACHE.txt (monorepo root)
wild/apps/svelte-maplibre-gl/LICENSE-MIT.txt                           <- LICENSE-MIT.txt (monorepo root)
wild/apps/svelte-maplibre-gl/examples/Clusters.svelte                  <- src/content/examples/clusters/Clusters.svelte (+1 line, see below)
wild/apps/svelte-maplibre-gl/examples/HoverStyles.svelte               <- src/content/examples/hover-styles/HoverStyles.svelte (+1 line, see below)
wild/apps/svelte-maplibre-gl/lib/utils.ts                              <- src/lib/utils.ts (byte-identical)
wild/apps/svelte-maplibre-gl/lib/components/ui/slider/slider.svelte    <- src/lib/components/ui/slider/slider.svelte (byte-identical)
wild/apps/svelte-maplibre-gl/lib/components/ui/slider/index.ts         <- src/lib/components/ui/slider/index.ts (byte-identical)
wild/apps/svelte-maplibre-gl/lib/components/ui/checkbox/checkbox.svelte <- src/lib/components/ui/checkbox/checkbox.svelte (byte-identical)
wild/apps/svelte-maplibre-gl/lib/components/ui/checkbox/index.ts       <- src/lib/components/ui/checkbox/index.ts (byte-identical)
wild/apps/svelte-maplibre-gl/lib/components/ui/label/label.svelte      <- src/lib/components/ui/label/label.svelte (byte-identical)
wild/apps/svelte-maplibre-gl/lib/components/ui/label/index.ts          <- src/lib/components/ui/label/index.ts (byte-identical)
```

All `lib/` files above are byte-identical to upstream (verified with `diff -q` against the
clone) — they are vendored from a *different part of the same repo* (the docs site's own
`src/lib/`, not the publishable `svelte-maplibre-gl` package), so they carry the same repo/commit
provenance as everything else in this file, but they are **not "ours"** any more than the two
`.svelte` examples are; see "Our build boilerplate" below for what actually is ours.

Everything else in this directory (`package.json`, `vite.config.js`, this file, `clusters/`,
`hover-styles/`) is **ours**, not upstream.

## The one-line change (per example)

Each example's `<MapLibre ...>` element gets one added prop:

```svelte
onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)}
```

Neither example already had an `onload` prop, so nothing was overwritten. `MapLibre.svelte`
accepts `on${eventName}` props for every native MapLibre GL JS `Map` event (see its
`mapEventNames` array and `MapEventProps` type); the `load` event's payload carries `.target` set
to the underlying `maplibregl.Map` instance, exactly like every other MapLibre event.

### `examples/Clusters.svelte`

```diff
--- a/src/content/examples/clusters/Clusters.svelte
+++ b/wild/apps/svelte-maplibre-gl/examples/Clusters.svelte
@@ -33,6 +33,7 @@
 	style="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
 	zoom={2}
 	center={{ lng: 180, lat: 35 }}
+	onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)}
 >
 	<GlobeControl />
 	<GeoJSONSource
```

### `examples/HoverStyles.svelte`

```diff
--- a/src/content/examples/hover-styles/HoverStyles.svelte
+++ b/wild/apps/svelte-maplibre-gl/examples/HoverStyles.svelte
@@ -11,6 +11,7 @@
 	style="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
 	zoom={2}
 	center={{ lng: -100.486052, lat: 37.830348 }}
+	onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)}
 >
 	<GeoJSONSource data="https://maplibre.org/maplibre-gl-js/docs/assets/us_states.geojson">
 		<FillLayer
```

## Our build boilerplate (not upstream)

- `wild/apps/svelte-maplibre-gl/package.json` — private, `"name":
  "geowright-wild-svelte-maplibre-gl"`. `dependencies`: `maplibre-gl ^6.0.0`,
  `svelte-maplibre-gl ^2.2.1` (the actual library, from npm, not vendored source), plus the
  `$lib` UI closure's runtime deps `bits-ui ^2.18.1`, `clsx ^2.1.1`, `tailwind-merge ^3.5.0`,
  `@lucide/svelte ^1.14.0`. `devDependencies`: `svelte ^5.46.4` (peer range required by the
  resolved `@sveltejs/vite-plugin-svelte`), `@sveltejs/vite-plugin-svelte ^7.3.0`, `vite ^8.2.0`.
- `wild/apps/svelte-maplibre-gl/vite.config.js` — multi-page build, `root` = this directory,
  `base: './'`, two inputs (`clusters/index.html`, `hover-styles/index.html`),
  `build.outDir: 'dist'`, `build.sourcemap: false`, `build.emptyOutDir: true`, the
  `@sveltejs/vite-plugin-svelte` plugin, and one `resolve.alias` entry (`$lib` →
  `lib/`, explained below).
- `clusters/index.html`, `clusters/main.js`, `hover-styles/index.html`, `hover-styles/main.js` —
  ours. Each `index.html` gives `html,body,#app` full-viewport sizing and adds `#app > div {
  width:100%; height:100%; }` so the vendored `<MapLibre>` root div (whose own sizing is via
  Tailwind utility classes, e.g. `class="h-[55vh] min-h-75"`, that have no visual effect since no
  Tailwind build is wired up — see below) still gets a real size instead of collapsing to 0×0;
  this is outer-page CSS only, nothing in the vendored `.svelte` files changed. Each `main.js`
  does `mount(Example, { target: document.getElementById('app') })`.
- This file (`UPSTREAM.md`).

Installed versions actually resolved by `npm install` (all within the declared ranges):
`svelte@5.57.1`, `@sveltejs/vite-plugin-svelte@7.3.0`, `vite@8.3.0`, `maplibre-gl@6.10.0`,
`svelte-maplibre-gl@2.2.1`, `bits-ui@2.19.2`, `clsx@2.1.1`, `tailwind-merge@3.7.0`,
`@lucide/svelte@1.47.0`.

## Build command

```
cd wild/apps/svelte-maplibre-gl && npm install && npm run build
```

`npm run build` runs `vite build`. Both install and build succeeded on the first try (no retry
needed). `dist/` is self-contained; the only two entry HTML files (`dist/clusters/index.html`,
`dist/hover-styles/index.html`) reference only same-directory hashed assets.

## Findings worth recording

### The `$lib` / shadcn UI situation: vendored, worked exactly as anticipated

`Clusters.svelte` (unedited) imports `$lib/components/ui/{slider,checkbox,label}/index.js`, the
docs site's SvelteKit alias. The dependency closure was exactly as small as expected — `lib/utils.ts`
(`cn()` via `clsx`+`tailwind-merge`), and the three `bits-ui` wrapper components (`slider`,
`checkbox`, `label`; `checkbox` additionally pulls in `@lucide/svelte`'s `CheckIcon`/`MinusIcon`).
All four `.svelte` files + 3 barrel `index.ts` files were vendored byte-identical into `lib/`, and
a single `resolve.alias: [{ find: '$lib', replacement: resolve(__dirname, 'lib') }]` in our own
`vite.config.js` (config-only, no source edit) makes `Clusters.svelte`'s unedited `$lib` imports
resolve. **No retry was needed** — `npm install` and `vite build` both succeeded on the first
attempt with no type errors and no missing-module errors. One thing worth noting: the source
files reference `$lib/utils.js` (a `.js` specifier pointing at the `.ts` file, the standard
TypeScript/SvelteKit "write `.js`, resolve to `.ts`" convention) — Vite's default resolver handles
this transparently, no extra config needed. Since Tailwind itself isn't configured in this build,
all the Tailwind utility class strings these components render (`"bg-primary text-primary-foreground"`
etc.) have no visual effect — expected and harmless, confirmed no console errors or thrown
exceptions relating to styling.

### The MapLibre 6 worker: verified sufficient, no manual fix needed

Both examples' unedited first script line, `import 'svelte-maplibre-gl/vite'; // Required only
for GL JS v6+`, is enough on its own. Verified two ways:
1. **Built output inspection**: `dist/assets/maplibre-gl-worker-CNLXcz58.js` (500 KB) is emitted,
   and `grep -c maplibre-gl-worker dist/assets/RawLayer-DmwWJtsy.js` finds 2 references to that
   exact filename in the shared chunk that constructs the worker URL — i.e. the `?worker&url`
   asset and its reference both made it into the production build.
2. **Runtime**: with the map's GeoJSON source data fixture *not* blocked (see next finding for
   why the real smoke test does block it), `window.__geowright_maps.main.loaded()` returned
   `true` and `getStyle().layers` returned real layer ids with no worker-related console errors —
   confirming the worker actually initializes and the map actually renders, not just that the
   asset exists on disk.

No `vite.config.js` change or manual `setWorkerUrl(...)` call in `main.js` was required —
identical conclusion to `wild/apps/react-map-gl`'s equivalent finding, for the same underlying
Vite `?worker&url` mechanism, just shipped as the library's own `./vite` subpath export here
rather than something each example does by hand.

### Real smoke test (network policy: abort the real `.geojson` fixtures): `load` never fires — same behavior as react-map-gl's `geojson` example

Under the required test policy — fulfil style URLs with a minimal style, log-and-abort everything
else including `https://maplibre.org/maplibre-gl-js/docs/assets/{earthquakes,us_states}.geojson`
— **`window.__geowright_maps.main` never gets set within 20s for either example**, so `loaded()`
and `getStyle().layers` were unreachable via the intended hook. Root cause, confirmed by two
separate checks:
- The map *is* constructed (its container div gains MapLibre's own `maplibregl-map` class,
  confirmed via `getBoundingClientRect()`/`className` in a throwaway debug page), and the style
  URL fetch is fulfilled and used (no style-related console errors).
- A second, diagnostic-only run (not part of the delivered smoke test, not used for the
  committed hook) additionally fulfilled the `.geojson` request with a minimal valid empty
  `FeatureCollection` instead of aborting it. With that one change, `load` fired immediately in
  both examples: `hover-styles` → `loaded()=true`, `getStyle().layers=['bg', 'svmlgl-layer-0',
  'svmlgl-layer-1']`; `clusters` → `loaded()=true`, `getStyle().layers=['bg', 'svmlgl-layer-0',
  'svmlgl-layer-1', 'svmlgl-layer-2']`.

So `load` firing is gated on the added `GeoJSONSource`'s data fetch resolving (MapLibre's
`Map.loaded()` requires all currently-registered sources, including ones added dynamically right
after map construction, to be loaded — not just the initial style JSON) — aborting that fetch, as
the real no-network-fixtures policy requires, means `load` legitimately never fires. This is the
same shape of finding already recorded in `wild/apps/react-map-gl/UPSTREAM.md` for its `geojson`
example (`Could not load data TypeError: Failed to fetch` → `onLoad` never called either) — it's
inherent to how these wrapper libraries report a "loaded" map when a declared data source can't
be fetched, not a defect in this vendoring or the one-line hook.

### Auto-generated layer ids: `svmlgl-layer-<N>`, a plain incrementing counter

Neither example passes an explicit `id` prop to any `<CircleLayer>`/`<SymbolLayer>`/`<FillLayer>`/
`<LineLayer>`. Confirmed in `svelte-maplibre-gl`'s own source
(`svelte-maplibre-gl/src/lib/utils.ts`): a module-level `layerIdCounter` backs a
`svmlgl-layer-${layerIdCounter++}` generator (and a sibling `svmlgl-source-${sourceIdCounter++}`
for sources), used whenever a `<*Layer>`/`<*Source>` component doesn't get an explicit `id` prop.
This is not derived from the source id or layer type — it's a flat global counter across however
many auto-id'd layers/sources exist on the page, confirmed empirically in the diagnostic run
above: `hover-styles` (2 layers: `FillLayer`, `LineLayer`) → `svmlgl-layer-0`, `svmlgl-layer-1`;
`clusters` (3 layers: `CircleLayer`, `SymbolLayer`, `CircleLayer`) → `svmlgl-layer-0`,
`svmlgl-layer-1`, `svmlgl-layer-2`, in source order. The `'bg'` id in both is our smoke test's own
minimal-style background layer, not the wrapper's doing.

### External requests seen (real smoke test run), and their license/provenance

- `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json` — CARTO's public basemap
  style; fulfilled with a synthetic minimal style per test policy, never fetched for real, never
  downloaded into the repo.
- `https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson` (`clusters`) /
  `.../us_states.geojson` (`hover-styles`) — MapLibre GL JS's own public documentation assets
  (`maplibre.org`), logged and aborted, never downloaded into the repo.
- `https://unpkg.com/maplibre-gl@6.10.0/dist/maplibre-gl.css` — `MapLibre.svelte`'s own
  `autoloadCss` effect (see its source) injects a `<link>` to this CDN URL by default unless the
  `MapLibre` component is passed `autoloadCss={false}` (neither example does, unedited). Logged
  and aborted per policy, so the built pages currently render with MapLibre's default
  chrome/controls unstyled (no visible effect on the map canvas itself, only on control button
  styling) when run against this network policy; worth knowing if a spec ever asserts on visual
  styling of controls.
