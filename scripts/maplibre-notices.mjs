// The notices of what MapLibre GL JS's prebuilt dist bundles inside itself (decision 0020: every committed copy carries
// the notices of everything in it). MapLibre's LICENSE.txt covers MapLibre and the code it names ("Contains code from
// ..."), not the npm packages its build bundles. Which those are is read from the source maps MapLibre ships beside its
// dist files, so the list follows the installed version. Used by demo/scripts/copy-worker.mjs (the demo's copy of the
// worker) and by the build of every wrapper app under wild/apps/ (their dist/THIRD_PARTY_LICENSES.md).
//
// A package may sit inside another's dist/ (the style-spec vendors quickselect, tinyqueue, unitbezier); its text then
// comes from the installed copy, found the way Node resolves it from maplibre-gl's directory, as in
// scripts/third-party-licenses.mjs. Code MapLibre copied into its own source keeps its notice only in a comment, which
// minifying drops. Each such file is named in `inlined` (its notice is added) or in `covered` (the package it came from
// is bundled too, so its text is already listed); any other MapLibre source with a copyright line or a note saying where
// its code came from ("Taken from [X](…)", "Copied from https://…") fails, to be read and added by hand.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

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
  // parseCacheControl()'s regex: "// Taken from [Wreck](https://github.com/hapijs/wreck)". Every MapLibre 3-6 build.
  '/src/util/util.ts': {
    name: 'parseCacheControl() regex from @hapi/wreck', license: 'BSD-3-Clause',
    note: 'it says "Taken from [Wreck](https://github.com/hapijs/wreck)"; the text below is the LICENSE.md of the @hapi/wreck 18.1.2 npm package',
    text: `Copyright (c) 2012-2022, Project contributors
Copyright (c) 2012-2020, Sideway Inc
Copyright (c) 2012-2014, Walmart.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* The names of any contributors may not be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS OFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
  // DOM.sanitize(), in the main-thread bundle only: "Base on https://javascriptsource.com/sanitize-an-html-string-to-
  // reduce-the-risk-of-xss-attacks/ (c) 2021 Chris Ferdinandi, MIT License, https://gomakethings.com".
  '/src/util/dom.ts': {
    name: 'sanitize() by Chris Ferdinandi', license: 'MIT',
    note: 'the notice is "(c) 2021 Chris Ferdinandi, MIT License, https://gomakethings.com"; the text below is the MIT License with that notice',
    text: MIT('2021 Chris Ferdinandi'),
  },
};

// Code copied from a package that the same build bundles as a package: that package's section carries the text.
// "// Copied from https://github.com/mapbox/vector-tile-js/blob/f1457ee…/index.js" (6.x; vector_tile_mlt.ts in 5.x).
const covered = {
  '/src/util/vectortile_to_geojson.ts': '@mapbox/vector-tile',
  '/src/source/vector_tile_mlt.ts': '@mapbox/vector-tile',
};

// What makes a MapLibre source need a notice: a copyright line, or a note that its code came from elsewhere, with a link.
// Plain prose ("taken from the style", "copied from the canvas") is not one.
const NOTICE = /copyright\s+(?:\(c\)|©)|copyright\s+\d{4}|\(c\)\s*\d{4}|©\s*\d{4}|\b(?:taken|copied|adapted|ported|inlined|based?)\s+(?:from|on)\s+(?:\[|<?https?:\/\/)/i;

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

/** The dist files a bundler takes from maplibre-gl: the ESM build (6+: main, shared chunk, worker) or the UMD bundle. */
export function distFiles(maplibreDir) {
  const dist = join(maplibreDir, 'dist');
  return existsSync(join(dist, 'maplibre-gl.mjs')) ? ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs'] : ['maplibre-gl.js'];
}

/**
 * Which of `files` (in maplibre-gl's dist/) hold code. Since 6.15 the worker is self-contained and the shared chunk is a
 * 0-byte file with no source map: there is nothing in it to copy or to read notices from. A missing or empty file is left
 * out, map or not; any other file must have its map.
 */
export function withCode(maplibreDir, files) {
  const dist = join(maplibreDir, 'dist');
  return files.filter((f) => existsSync(join(dist, f)) && statSync(join(dist, f)).size > 0);
}

/** The installed package `name` as Node resolves it from `from`: its directory, or undefined. */
function resolvePackage(name, from) {
  for (let d = from; ; d = dirname(d)) {
    const dir = join(d, 'node_modules', name);
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(d) === d) return undefined;
  }
}

function licenseText(dir, name) {
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  // Line ends as LF: tslib's LICENSE.txt has CRLF, which git would rewrite on commit (a rebuild would then differ).
  if (file) return readFileSync(join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim();
  // murmurhash-js ships no license file; its README ends with the license: "## License (MIT)", the notice, the text.
  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  const section = readme.match(/^#+ Licen[sc]e.*\n([\s\S]*?)(?=^#+ |$(?![\s\S]))/im)?.[1].trim();
  if (section && /copyright/i.test(section)) return section;
  throw new Error(`maplibre-notices: ${name} is bundled into MapLibre's dist but ships no license text: add it by hand`);
}

/**
 * What `files` (in maplibre-gl's dist/) bundle, from their source maps: `packages` (npm packages, each with its installed
 * name, version, license id and text) and `copied` (code copied into MapLibre's own source, with its notice).
 */
export function bundled(dir, files = distFiles(dir)) {
  const maplibreDir = resolve(dir);
  const src = join(maplibreDir, 'dist');
  const names = new Set();
  const copied = [];
  const coveredBy = [];
  for (const f of withCode(maplibreDir, files)) {
    const map = JSON.parse(readFileSync(join(src, `${f}.map`), 'utf8'));
    map.sources.forEach((source, i) => {
      const parts = source.split('node_modules/').slice(1);
      for (const rest of parts.map((p) => p.split('/'))) names.add(rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]);
      if (parts.length) return;
      const content = map.sourcesContent?.[i] ?? '';
      if (!NOTICE.test(content)) return;
      const from = Object.entries(covered).find(([file]) => source.endsWith(file));
      if (from) { coveredBy.push({ source, pkg: from[1] }); return; }
      const known = Object.entries(inlined).find(([file]) => source.endsWith(file));
      if (!known) throw new Error(`maplibre-notices: ${source} (in ${f}) has a copyright notice or a note on where its code came from that is not in scripts/maplibre-notices.mjs: read it and add it to "inlined" or "covered"`);
      const [file, what] = known;
      const text = what.text === 'comment' ? content.match(/^\/\*([\s\S]*?)\*\//)?.[1].trim() : what.text;
      if (!text) throw new Error(`maplibre-notices: ${source}: no leading comment with the notice`);
      if (!copied.some((c) => c.file === file)) copied.push({ file, ...what, text });
    });
  }
  for (const { source, pkg } of coveredBy) {
    if (!names.has(pkg)) throw new Error(`maplibre-notices: ${source} is code copied from ${pkg}, which is not bundled as a package: its text is not listed; add it to "inlined"`);
  }
  const packages = [...names].sort().map((name) => {
    const dir = resolvePackage(name, maplibreDir);
    if (!dir) throw new Error(`maplibre-notices: ${name} is bundled into MapLibre's dist but is not installed`);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
    return { name: pkg.name, version: pkg.version, license, text: licenseText(dir, name), data: dataNotices[name] };
  });
  return { packages, copied };
}

/**
 * The sections, in the format Vite's `build.license` writes (`## <package> - <version> (<license>)`, the text below).
 * `where`: appended to each heading, to say whose copy it is ("bundled in maplibre-gl 6.10.0").
 */
export function sections({ packages, copied }, where) {
  const out = packages.map((p) => {
    // A choice of licenses is used under the first option that is on the allowlist, and says so (decision 0020). Only a
    // choice and nothing else: in `(A OR B) AND C`, C applies whichever option is used (wild/scripts/apps.mjs agrees).
    const options = p.license.replace(/[()]/g, ' ').trim().split(/\s+OR\s+/);
    const choice = options.length > 1 && options.every((o) => /^[\w.+-]+(\s+WITH\s+[\w.+-]+)?$/.test(o));
    const chosen = choice ? options.find((l) => /^(MIT|ISC|BSD|Apache-2\.0)/.test(l)) : undefined;
    const under = chosen ? `, used under ${chosen} (the file below carries every option's text)` : '';
    return `## ${p.name} - ${p.version} (${p.license})${under}${where ? `, ${where}` : ''}\n\n${p.text}\n${p.data ? `\n${p.data}\n` : ''}`;
  });
  for (const c of copied) {
    out.push(`## ${c.name} (${c.license}), copied into MapLibre's ${c.file.slice(1)}${where ? `, ${where}` : ''}\n\n` +
      `${c.note ? `The source names the origin and license; ${c.note}.\n\n` : ''}${c.text}\n`);
  }
  return out;
}

/**
 * `notices` (a THIRD_PARTY_LICENSES.md in Vite's format) with MapLibre's bundled packages added right after its
 * `## maplibre-gl - ` section. A package already listed at the same version (deck.gl bundles gl-matrix too) is not
 * repeated. Throws when there is no maplibre-gl section to expand.
 */
export function expand(notices, maplibreDir, files = distFiles(maplibreDir)) {
  const version = JSON.parse(readFileSync(join(maplibreDir, 'package.json'), 'utf8')).version;
  const parts = notices.split(/^(?=## )/m);
  const at = parts.findIndex((p) => p.startsWith('## maplibre-gl - '));
  if (at < 0) throw new Error('maplibre-notices: THIRD_PARTY_LICENSES.md has no "## maplibre-gl - " section to expand');
  const listed = new Set(parts.map((p) => p.match(/^## (\S+) - (\S+)/)?.slice(1).join('@')).filter(Boolean));
  const b = bundled(maplibreDir, files);
  b.packages = b.packages.filter((p) => !listed.has(`${p.name}@${p.version}`));
  const added = sections(b, `bundled in maplibre-gl ${version}`).map((s) => `${s}\n`);
  if (!parts[at].endsWith('\n\n')) parts[at] = parts[at].replace(/\n*$/, '\n\n');
  parts.splice(at + 1, 0, ...added);
  return parts.join('').replace(/\n+$/, '\n');
}

/**
 * A Vite plugin for a wrapper app: after `build.license` wrote THIRD_PARTY_LICENSES.md, add what MapLibre's dist bundles
 * (Vite lists maplibre-gl as one package). `appDir`: the app's directory (its node_modules/maplibre-gl is the copy
 * bundled). Put it after any plugin that rewrites the maplibre-gl heading.
 */
export function maplibreNotices(appDir) {
  return {
    name: 'geowright:maplibre-bundled-notices',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const asset = bundle['THIRD_PARTY_LICENSES.md'];
        if (!asset) throw new Error('maplibre-notices: no THIRD_PARTY_LICENSES.md in the bundle (build.license)');
        asset.source = expand(String(asset.source), join(appDir, 'node_modules', 'maplibre-gl'));
      },
    },
  };
}
