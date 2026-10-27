// Copies the MapLibre GL JS worker (and its shared chunk) into demo/public/maplibre/
// so that `vite build demo` produces a build where the worker can be loaded from a
// same-origin URL at runtime via `setWorkerUrl()`. MapLibre 6 is ESM-only and resolves
// its worker relative to `import.meta.url`, which does not survive bundling, so we ship
// the worker files verbatim and point at them explicitly instead, with MapLibre's LICENSE.txt beside them,
// and THIRD_PARTY_LICENSES.md: the license text of every package MapLibre's build put into them (decision 0020).
// Since 6.15 the worker is self-contained and the shared chunk is an empty file: only files with code are copied, and a
// copy left from an older version is removed (a stale shared chunk beside a newer worker is a mismatched MapLibre).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { bundled, sections as noticeSections, withCode } from '../../scripts/maplibre-notices.mjs';

const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

/** Copies the worker files of the maplibre-gl in `maplibreDir` into `dest`, with their notices. Returns the files copied. */
export function copyWorker(maplibreDir, dest) {
  const src = join(maplibreDir, 'dist');
  mkdirSync(dest, { recursive: true });

  const files = withCode(maplibreDir, FILES);
  for (const f of FILES) {
    if (files.includes(f)) {
      copyFileSync(join(src, f), join(dest, f));
      console.log(`copied ${f} -> ${join(dest, f)}`);
    } else rmSync(join(dest, f), { force: true });
  }
  // The files are MapLibre's code, redistributed (and committed): its BSD-3-Clause license goes with them.
  copyFileSync(join(maplibreDir, 'LICENSE.txt'), join(dest, 'LICENSE.txt'));
  console.log(`copied LICENSE.txt -> ${join(dest, 'LICENSE.txt')}`);

  // LICENSE.txt covers MapLibre and the code it names ("Contains code from ..."), not the npm packages its build bundles:
  // their notices are read from the source maps MapLibre ships beside the files (scripts/maplibre-notices.mjs, shared
  // with the wrapper apps under wild/apps/).
  const sections = noticeSections(bundled(maplibreDir, files));

  const version = JSON.parse(readFileSync(join(maplibreDir, 'package.json'), 'utf8')).version;
  const named = [...files].sort().map((f) => `\`${f}\``).join(' and ');
  writeFileSync(join(dest, 'THIRD_PARTY_LICENSES.md'), `# Licenses

${named} ${files.length > 1 ? 'are' : 'is'} maplibre-gl ${version}'s prebuilt dist, copied verbatim by
\`demo/scripts/copy-worker.mjs\`, which also writes this file. MapLibre's own license is \`LICENSE.txt\` beside it. The
packages below are what ${files.length > 1 ? 'the two files\' source maps' : 'its source map'} (in the npm package, not copied) name as bundled; each text is the
license file of the installed copy (the maps do not record versions; the installed ones satisfy maplibre-gl's ranges).

${sections.join('\n')}`);
  console.log(`wrote ${join(dest, 'THIRD_PARTY_LICENSES.md')} (${sections.length} sections)`);
  return files;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  copyWorker(join(here, '..', '..', 'node_modules', 'maplibre-gl'), join(here, '..', 'public', 'maplibre'));
}
