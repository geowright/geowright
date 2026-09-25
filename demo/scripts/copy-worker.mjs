// Copies the MapLibre GL JS worker (and its shared chunk) into demo/public/maplibre/
// so that `vite build demo` produces a build where the worker can be loaded from a
// same-origin URL at runtime via `setWorkerUrl()`. MapLibre 6 is ESM-only and resolves
// its worker relative to `import.meta.url`, which does not survive bundling, so we ship
// the worker files verbatim and point at them explicitly instead, with MapLibre's LICENSE.txt beside them,
// and THIRD_PARTY_LICENSES.md: the license text of every package MapLibre's build put into them (decision 0015).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// LICENSE.txt covers MapLibre and the code it names ("Contains code from ..."), not the npm packages its build bundles.
// Which those are is read from the source maps MapLibre ships beside the two files, so the list follows the installed
// version. A package may sit inside another's dist/ (the style-spec vendors quickselect, tinyqueue, unitbezier); its
// text then comes from the installed top-level copy, as in scripts/third-party-licenses.mjs.
// Code MapLibre copied into its own source keeps its notice only in a comment, which minifying drops. Each such file is
// named here; any other MapLibre source with a copyright line fails the copy, to be read and added by hand.
const inlined = {
  '/src/util/transferable_grid_index.ts': { name: 'grid-index', license: 'ISC', text: 'comment' },
  '/src/tile/tile_id.ts': {
    name: '@mapbox/whoots-js', license: 'ISC', note: 'its text from the @mapbox/whoots-js 3.1.0 npm package',
    text: `ISC License

Copyright (c) 2017, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`,
  },
};

// Data inside a bundled package that carries its own notice: bidi-js's tables are derived from the Unicode Character
// Database (Unicode 13.0.0), under the Unicode data license. Its text: the copy in the TypeScript npm package's
// NOTICE.txt (typescript 7.0.2, "UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE", copyright 1991-2017; the
// agreement of the Unicode 13 data reads the same with a later year).
const dataNotices = {
  'bidi-js': `Its character tables are derived from the Unicode Character Database, under this license:

UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE

Unicode Data Files include all data files under the directories
http://www.unicode.org/Public/, http://www.unicode.org/reports/,
http://www.unicode.org/cldr/data/, http://source.icu-project.org/repos/icu/, and
http://www.unicode.org/utility/trac/browser/.

Unicode Data Files do not include PDF online code charts under the
directory http://www.unicode.org/Public/.

Software includes any source code published in the Unicode Standard
or under the directories
http://www.unicode.org/Public/, http://www.unicode.org/reports/,
http://www.unicode.org/cldr/data/, http://source.icu-project.org/repos/icu/, and
http://www.unicode.org/utility/trac/browser/.

NOTICE TO USER: Carefully read the following legal agreement.
BY DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING UNICODE INC.'S
DATA FILES ("DATA FILES"), AND/OR SOFTWARE ("SOFTWARE"),
YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT.
IF YOU DO NOT AGREE, DO NOT DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE
THE DATA FILES OR SOFTWARE.

COPYRIGHT AND PERMISSION NOTICE

Copyright (c) 1991-2017 Unicode, Inc. All rights reserved.
Distributed under the Terms of Use in http://www.unicode.org/copyright.html.

Permission is hereby granted, free of charge, to any person obtaining
a copy of the Unicode data files and any associated documentation
(the "Data Files") or Unicode software and any associated documentation
(the "Software") to deal in the Data Files or Software
without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, and/or sell copies of
the Data Files or Software, and to permit persons to whom the Data Files
or Software are furnished to do so, provided that either
(a) this copyright and permission notice appear with all copies
of the Data Files or Software, or
(b) this copyright and permission notice appear in associated
Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT OF THIRD PARTY RIGHTS.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS
NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL
DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder
shall not be used in advertising or otherwise to promote the sale,
use or other dealings in these Data Files or Software without prior
written authorization of the copyright holder.`,
};

const packages = new Set();
const copied = [];
for (const f of files) {
  const map = JSON.parse(readFileSync(join(src, `${f}.map`), 'utf8'));
  map.sources.forEach((source, i) => {
    const parts = source.split('node_modules/').slice(1);
    for (const rest of parts.map((p) => p.split('/'))) packages.add(rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]);
    if (parts.length) return;
    const content = map.sourcesContent?.[i] ?? '';
    if (!/copyright \(c\)|\(c\) \d{4}/i.test(content)) return;
    const known = Object.entries(inlined).find(([file]) => source.endsWith(file));
    if (!known) throw new Error(`copy-worker: ${source} (in ${f}) has a copyright notice that is not in THIRD_PARTY_LICENSES.md: read it and add it to "inlined"`);
    const [file, what] = known;
    const text = what.text === 'comment' ? content.match(/^\/\*([\s\S]*?)\*\//)?.[1].trim() : what.text;
    if (!text) throw new Error(`copy-worker: ${source}: no leading comment with the notice`);
    if (!copied.some((c) => c.file === file)) copied.push({ file, ...what, text });
  });
}

const licenseText = (dir, pkg) => {
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  if (file) return readFileSync(join(dir, file), 'utf8').trim();
  // murmurhash-js ships no license file; its README ends with the license: "## License (MIT)", the notice, the text.
  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  const section = readme.match(/^#+ Licen[sc]e.*\n([\s\S]*?)(?=^#+ |$(?![\s\S]))/im)?.[1].trim();
  if (section && /copyright/i.test(section)) return section;
  throw new Error(`copy-worker: ${pkg.name} is bundled into MapLibre's dist but ships no license text: add it by hand`);
};

const sections = [...packages].sort().map((name) => {
  const dir = join(nodeModules, name);
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`copy-worker: ${name} is bundled into MapLibre's dist but is not installed`);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
  // A choice of licenses is used under the first option that is on the allowlist, and says so (decision 0015).
  const chosen = / OR /.test(license) ? license.replace(/[()]/g, '').split(' OR ').find((l) => /^(MIT|ISC|BSD|Apache-2\.0)/.test(l)) : undefined;
  const under = chosen ? `, used under ${chosen} (the file below carries every option's text)` : '';
  return `## ${pkg.name} - ${pkg.version} (${license})${under}\n\n${licenseText(dir, pkg)}\n${dataNotices[name] ? `\n${dataNotices[name]}\n` : ''}`;
});
for (const c of copied) {
  sections.push(`## ${c.name} (${c.license}), copied into MapLibre's ${c.file.slice(1)}\n\n` +
    `${c.note ? `The source names the origin and license; ${c.note}.\n\n` : ''}${c.text}\n`);
}

const version = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8')).version;
writeFileSync(join(dest, 'THIRD_PARTY_LICENSES.md'), `# Licenses

\`maplibre-gl-shared.mjs\` and \`maplibre-gl-worker.mjs\` are maplibre-gl ${version}'s prebuilt dist, copied verbatim by
\`demo/scripts/copy-worker.mjs\`, which also writes this file. MapLibre's own license is \`LICENSE.txt\` beside it. The
packages below are what the two files' source maps (in the npm package, not copied) name as bundled; each text is the
license file of the installed copy (the maps do not record versions; the installed ones satisfy maplibre-gl's ranges).

${sections.join('\n')}`);
console.log(`wrote demo/public/maplibre/THIRD_PARTY_LICENSES.md (${sections.length} sections)`);
