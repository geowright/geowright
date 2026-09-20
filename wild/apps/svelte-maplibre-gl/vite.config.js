// geowright's own build boilerplate for the vendored MIERUNE/svelte-maplibre-gl examples.
// NOT upstream — see UPSTREAM.md. Multi-page static build so the two examples
// can be served (and committed) as self-contained dist/ output.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [svelte()],
  resolve: {
    alias: [
      // Clusters.svelte (unedited) imports '$lib/components/ui/{slider,checkbox,label}/index.js',
      // the docs site's SvelteKit `$lib` alias. Redirect it to the small, self-contained slice
      // of that library we vendored verbatim into lib/ (see UPSTREAM.md) — config-only, no
      // source edit to Clusters.svelte.
      { find: '$lib', replacement: resolve(__dirname, 'lib') }
    ]
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        clusters: resolve(__dirname, 'clusters/index.html'),
        'hover-styles': resolve(__dirname, 'hover-styles/index.html')
      }
    }
  }
});
