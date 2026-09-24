// geowright's own build boilerplate for the vendored visgl/react-map-gl examples.
// NOT upstream — see UPSTREAM.md. Multi-page static build so the three examples
// can be served (and committed) as self-contained dist/ output.
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  resolve: {
    // controls/src/app.tsx imports '../../../.data/cities.json' unedited (see UPSTREAM.md).
    // Upstream's own examples/ tree has that file 3 levels up from src/app.tsx; our flat
    // <example>/src/app.tsx layout is only 2 levels below this dir, so the literal relative
    // specifier would resolve outside wild/apps/react-map-gl/. Redirect it here (build-config
    // only, no source edit) to .data/ inside this directory.
    alias: [{ find: /^\.\.\/\.\.\/\.\.\/\.data\//, replacement: resolve(__dirname, '.data') + '/' }]
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
    // dist/ is committed and redistributed: ship the license text of every package the build bundles next to it
    // (decision 0015; `node wild/scripts/apps.mjs check` fails without it).
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rollupOptions: {
      input: {
        controls: resolve(__dirname, 'controls/index.html'),
        geojson: resolve(__dirname, 'geojson/index.html'),
        filter: resolve(__dirname, 'filter/index.html')
      }
    }
  }
});
