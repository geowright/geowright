// geowright's own build boilerplate for the vendored MIERUNE/svelte-maplibre-gl examples.
// NOT upstream — see UPSTREAM.md. Multi-page static build so the two examples
// can be served (and committed) as self-contained dist/ output.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { maplibreNotices } from '../../../scripts/maplibre-notices.mjs';

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

// bits-ui's slider (in the clusters page's chunk) "is adapted from the @melt-ui/svelte slider" (bits-ui 2.19.2,
// dist/bits/slider/slider.svelte.js), but bits-ui's LICENSE carries only its own notice: add Melt UI's after it. Its
// text: the LICENSE of the @melt-ui/svelte 0.86.6 npm package.
const MELT_UI = `MIT License

Copyright (c) 2023 Thomas G. Lopes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const meltUiNotice = {
  name: 'geowright:melt-ui-notice',
  generateBundle: {
    order: 'post',
    handler(_, bundle) {
      const asset = bundle['THIRD_PARTY_LICENSES.md'];
      const parts = String(asset?.source ?? '').split(/^(?=## )/m);
      const at = parts.findIndex((p) => p.startsWith('## bits-ui - '));
      if (at < 0) throw new Error('THIRD_PARTY_LICENSES.md: no bits-ui section to add Melt UI\'s notice after');
      if (!parts[at].endsWith('\n\n')) parts[at] = parts[at].replace(/\n*$/, '\n\n');
      parts.splice(at + 1, 0, `## @melt-ui/svelte (MIT), its slider adapted into bits-ui's\n\n` +
        `bits-ui's slider says it "is adapted from the @melt-ui/svelte slider"; the text below is @melt-ui/svelte's LICENSE.\n\n${MELT_UI}\n\n`);
      asset.source = parts.join('');
    },
  },
};

export default defineConfig({
  root: __dirname,
  base: './',
  // maplibreNotices: Vite lists maplibre-gl as one package; add what MapLibre's prebuilt dist bundles inside itself.
  plugins: [svelte(), svelteMaplibreGlNotice, meltUiNotice, maplibreNotices(__dirname)],
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
    // (decision 0020; `node wild/scripts/apps.mjs check` fails without it).
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rollupOptions: {
      input: {
        clusters: resolve(__dirname, 'clusters/index.html'),
        'hover-styles': resolve(__dirname, 'hover-styles/index.html')
      }
    }
  }
});
