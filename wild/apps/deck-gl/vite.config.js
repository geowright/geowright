import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  // The upstream app imports these three classes from the umbrella `deck.gl` package.
  // Resolve that import to its layers package, which exports the same classes without
  // pulling in unrelated CARTO/ColorBrewer packages and their extra license terms.
  resolve: { alias: [{ find: /^deck\.gl$/, replacement: '@deck.gl/layers' }] },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html')
    }
  }
});
