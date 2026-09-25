import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { maplibreNotices } from '../../../scripts/maplibre-notices.mjs';

// maplibre-gl 3's dist/ has a stub package.json (name only), so Vite's notices head its section "maplibre-gl - 0.0.0"
// with no license id (its text, dist/LICENSE.txt, is right). Put the installed version and license id in the heading.
const maplibreNoticeHeading = {
  name: 'geowright:maplibre-notice-heading',
  generateBundle: {
    order: 'post',
    handler(_, bundle) {
      const asset = bundle['THIRD_PARTY_LICENSES.md'];
      const { version, license } = JSON.parse(readFileSync(resolve(__dirname, 'node_modules/maplibre-gl/package.json'), 'utf8'));
      const stub = /^## maplibre-gl - 0\.0\.0$/m;
      if (!asset || !stub.test(String(asset.source))) throw new Error('THIRD_PARTY_LICENSES.md: no "maplibre-gl - 0.0.0" heading to fix');
      asset.source = String(asset.source).replace(stub, `## maplibre-gl - ${version} (${license})`);
    },
  },
};

export default defineConfig({
  root: __dirname,
  base: './',
  // The upstream app imports these three classes from the umbrella `deck.gl` package.
  // Resolve that import to its layers package, which exports the same classes without
  // pulling in unrelated CARTO/ColorBrewer packages and their extra license terms.
  resolve: { alias: [{ find: /^deck\.gl$/, replacement: '@deck.gl/layers' }] },
  // maplibreNotices after the heading fix: it expands the maplibre-gl section with what MapLibre's dist bundles.
  plugins: [maplibreNoticeHeading, maplibreNotices(__dirname)],
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
    // dist/ is committed and redistributed: ship the license text of every package the build bundles next to it
    // (decision 0015; `node wild/scripts/apps.mjs check` fails without it).
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rollupOptions: {
      input: resolve(__dirname, 'index.html')
    }
  }
});
