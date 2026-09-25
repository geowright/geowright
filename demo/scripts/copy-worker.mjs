// Copies the MapLibre GL JS worker (and its shared chunk) into demo/public/maplibre/
// so that `vite build demo` produces a build where the worker can be loaded from a
// same-origin URL at runtime via `setWorkerUrl()`. MapLibre 6 is ESM-only and resolves
// its worker relative to `import.meta.url`, which does not survive bundling, so we ship
// the worker files verbatim and point at them explicitly instead, with MapLibre's LICENSE.txt beside them,
// and THIRD_PARTY_LICENSES.md: the license text of every package MapLibre's build put into them (decision 0020).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bundled, sections as noticeSections } from '../../scripts/maplibre-notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(here, '..', '..', 'node_modules');
const src = join(nodeModules, 'maplibre-gl', 'dist');
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

// LICENSE.txt covers MapLibre and the code it names ("Contains code from ..."), not the npm packages its build bundles:
// their notices are read from the source maps MapLibre ships beside the two files (scripts/maplibre-notices.mjs, shared
// with the wrapper apps under wild/apps/).
const sections = noticeSections(bundled(join(src, '..'), files));

const version = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8')).version;
writeFileSync(join(dest, 'THIRD_PARTY_LICENSES.md'), `# Licenses

\`maplibre-gl-shared.mjs\` and \`maplibre-gl-worker.mjs\` are maplibre-gl ${version}'s prebuilt dist, copied verbatim by
\`demo/scripts/copy-worker.mjs\`, which also writes this file. MapLibre's own license is \`LICENSE.txt\` beside it. The
packages below are what the two files' source maps (in the npm package, not copied) name as bundled; each text is the
license file of the installed copy (the maps do not record versions; the installed ones satisfy maplibre-gl's ranges).

${sections.join('\n')}`);
console.log(`wrote demo/public/maplibre/THIRD_PARTY_LICENSES.md (${sections.length} sections)`);
