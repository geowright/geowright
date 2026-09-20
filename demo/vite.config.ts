import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), twoMaps: resolve(__dirname, 'two-maps.html'), dense: resolve(__dirname, 'dense.html') },
    },
  },
});
