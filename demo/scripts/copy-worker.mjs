// Copies the MapLibre GL JS worker (and its shared chunk) into demo/public/maplibre/
// so that `vite build demo` produces a build where the worker can be loaded from a
// same-origin URL at runtime via `setWorkerUrl()`. MapLibre 6 is ESM-only and resolves
// its worker relative to `import.meta.url`, which does not survive bundling, so we ship
// the worker files verbatim and point at them explicitly instead, with MapLibre's LICENSE.txt beside them.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'node_modules', 'maplibre-gl', 'dist');
const dest = join(here, '..', 'public', 'maplibre');

mkdirSync(dest, { recursive: true });

const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];
for (const f of files) {
  copyFileSync(join(src, f), join(dest, f));
  console.log(`copied ${f} -> demo/public/maplibre/${f}`);
}
// The two files are MapLibre's code, redistributed (and committed): its BSD-3-Clause license goes with them.
copyFileSync(join(src, '..', 'LICENSE.txt'), join(dest, 'LICENSE.txt'));
console.log('copied LICENSE.txt -> demo/public/maplibre/LICENSE.txt');
