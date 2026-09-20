// geowright's own build boilerplate for the vendored indoorequal/vue-maplibre-gl examples.
// NOT upstream — see UPSTREAM.md. Multi-page static build so the three examples can be
// served (and committed) as self-contained dist/ output.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        filter: resolve(__dirname, 'filter/index.html'),
        geojson: resolve(__dirname, 'geojson/index.html'),
        'marker-popup': resolve(__dirname, 'marker-popup/index.html')
      }
    }
  }
});
