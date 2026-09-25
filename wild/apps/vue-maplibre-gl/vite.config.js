// geowright's own build boilerplate for the vendored indoorequal/vue-maplibre-gl examples.
// NOT upstream — see UPSTREAM.md. Multi-page static build so the three examples can be
// served (and committed) as self-contained dist/ output.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { maplibreNotices } from '../../../scripts/maplibre-notices.mjs';

export default defineConfig({
  root: __dirname,
  base: './',
  // maplibreNotices: Vite lists maplibre-gl as one package; add what MapLibre's prebuilt dist bundles inside itself.
  plugins: [vue(), maplibreNotices(__dirname)],
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
    // dist/ is committed and redistributed: ship the license text of every package the build bundles next to it
    // (decision 0015; `node wild/scripts/apps.mjs check` fails without it).
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rollupOptions: {
      input: {
        filter: resolve(__dirname, 'filter/index.html'),
        geojson: resolve(__dirname, 'geojson/index.html'),
        'marker-popup': resolve(__dirname, 'marker-popup/index.html')
      }
    }
  }
});
