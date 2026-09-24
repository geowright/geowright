// geowright's own build boilerplate for the vendored MIERUNE/svelte-maplibre-gl examples.
// NOT upstream — see UPSTREAM.md. Multi-page static build so the two examples
// can be served (and committed) as self-contained dist/ output.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// The svelte-maplibre-gl npm package ships no license file, so Vite's notices list it without a text. The license
// files of its repository (kept here as LICENSE-MIT.txt and LICENSE-APACHE.txt, see UPSTREAM.md) are the ones that
// apply: add them under its heading.
const svelteMaplibreGlNotice = {
  name: 'geowright:svelte-maplibre-gl-notice',
  generateBundle: {
    order: 'post',
    handler(_, bundle) {
      const asset = bundle['THIRD_PARTY_LICENSES.md'];
      const heading = /^## svelte-maplibre-gl - .*\n/m;
      if (!asset || !heading.test(String(asset.source))) throw new Error('THIRD_PARTY_LICENSES.md: no svelte-maplibre-gl section to fill');
      const text = ['LICENSE-MIT.txt', 'LICENSE-APACHE.txt'].map((f) => readFileSync(resolve(__dirname, f), 'utf8').trim()).join('\n\n');
      asset.source = String(asset.source).replace(heading, (h) => `${h}\n${text}\n`);
    },
  },
};

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [svelte(), svelteMaplibreGlNotice],
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
    // dist/ is committed and redistributed: ship the license text of every package the build bundles next to it
    // (decision 0015; `node wild/scripts/apps.mjs check` fails without it).
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rollupOptions: {
      input: {
        clusters: resolve(__dirname, 'clusters/index.html'),
        'hover-styles': resolve(__dirname, 'hover-styles/index.html')
      }
    }
  }
});
