// Vendoring helper for third-party apps under wild/apps/ — the mechanical part of "Bring your app" (wild/README.md).
//
//   node wild/scripts/apps.mjs new <name> <upstream-repo-url> <commit> <LICENSE-file>...
//       Refuse unless every license file is on the allowlist (docs/decisions/0015). Then scaffold, never overwriting:
//       wild/apps/<name>/<LICENSE> (byte-identical), wild/apps/<name>/UPSTREAM.md, wild/fixtures/sources/<name>.md,
//       a row in wild/fixtures/SOURCES.md and tests/wild/<name>.spec.ts. Every TODO(new-app) is yours to fill in.
//   node wild/scripts/apps.mjs check
//       Every wild/apps/<name>/ keeps a license file on the allowlist, has an UPSTREAM.md naming the upstream
//       repository, a full commit SHA and the hook line, and is opened by a spec in tests/wild/; its built dist/ ships
//       dist/THIRD_PARTY_LICENSES.md with a section and a license text for each package it bundles;
//       wild/maplibre-examples/ keeps its license; every file under wild/fixtures/ is named in SOURCES.md or a
//       sources/*.md record (by path, by name, or — data only, not code — by a directory it is in); each vendored build
//       under wild/fixtures/vendor/ keeps a license file and a THIRD_PARTY_LICENSES.md; no TODO(new-app) is left anywhere.
//       The one-line rule (docs/decisions/0016), as far as it can be checked offline: each app's sources hold the hook
//       line UPSTREAM.md shows, at most one per file, in the files UPSTREAM.md marks "+1 line" and in no other vendored
//       file; each MapLibre example's committed patch is exactly one added line, the hook, and nothing removed (as
//       `patches` below). Not checked: that the rest of a vendored file equals upstream — that needs the upstream copy.
//       Run by tests/unit/wild-apps.unit.spec.ts.
//   node wild/scripts/apps.mjs patches
//       Only the examples' patches: wild/maplibre-examples/patches/<name>.diff (upstream -> vendored, written by
//       `bash wild/scripts/examples.sh patches|verify`) has one added line, the hook, no removed line, and matches the
//       vendored examples/<name>.html. Every line after the diff header counts: blank ones, and ones whose content
//       starts with - or +. Run by examples.sh verify, after it regenerated the patches from upstream.
//
// No network, no dependencies. Paths are relative to this file, so a scratch copy of the tree works the same.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TODO = 'TODO(new-app)';
// What a vendored app's dist/ must carry: the license text of everything its build bundles (decision 0015). Vite writes
// it with `build: { license: { fileName: 'THIRD_PARTY_LICENSES.md' } }`; a build that only copies files writes the same
// format itself (wild/apps/pmtiles/scripts/build.mjs): one `## <package> - <version>` section per package, text below.
const NOTICES = 'dist/THIRD_PARTY_LICENSES.md';
// Bundled into MapLibre GL JS's prebuilt dist by every version the wild apps use (3.6, 5.13, 6.10; read from the source
// maps). A dist that ships maplibre-gl must list these too; the full list is the build's (scripts/maplibre-notices.mjs).
const MAPLIBRE_BUNDLES = ['@mapbox/point-geometry', '@mapbox/tiny-sdf', '@mapbox/unitbezier', '@mapbox/vector-tile', '@maplibre/maplibre-gl-style-spec', 'earcut', 'gl-matrix', 'kdbush', 'murmurhash-js', 'pbf', 'potpack', 'tinyqueue'];
// The hook (docs/decisions/0002). In a MapLibre example it is this exact statement, a line comment allowed after it; a
// wrapper app reaches the map its own way (`e.target`, `e.map`, a ref), so there only the registration itself is fixed.
const EXAMPLE_HOOK = /^\s*\(window\.__geowright_maps \?\?= \{\}\)\.main = map;(\s*\/\/.*)?$/;
const APP_HOOK = /__geowright_maps\s*\?\?=\s*\{\}\s*\)\s*\.main\s*=/;
const ALLOWLIST = 'MIT, BSD, ISC, Apache-2.0, CC0, Unlicense, EDL-1.0 (and OFL for fonts)';

// Recognised by the license text itself, not by what anyone says it is. Whitespace is normalised first.
const ALLOWED = [
  ['MIT', /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  ['ISC', /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i],
  ['BSD', /Redistribution and use in source and binary forms, with or without modification, are permitted/i],
  ['Apache-2.0', /Apache License,? Version 2\.0/i],
  ['CC0', /CC0 1\.0 Universal/i],
  ['Unlicense', /This is free and unencumbered software released into the public domain/i],
];
// Any of these anywhere in the file refuses it, even next to an allowed text (a dual or mixed license needs a person).
const REFUSED = [
  ['GPL / LGPL / AGPL', /GNU (Affero |Lesser |Library )?General Public License|\b[AL]?GPL-?[23]/i],
  ['MPL', /Mozilla Public License/i],
  ['EPL', /Eclipse Public License/i],
  ['CC-BY (any Creative Commons license with attribution)', /Creative Commons Attribution|\bCC[- ]BY\b/i],
  ['ODbL', /Open Database License|\bODbL\b/i],
  ['SSPL', /Server Side Public License/i],
  ['Business Source License', /Business Source License/i],
  ['OFL (allowed for fonts only, not for an app)', /SIL Open Font License/i],
];

/** { ok: true, kinds } when the text is recognised as allowed and names nothing refused; otherwise { ok: false, why }. */
function classify(text) {
  const t = text.replace(/\s+/g, ' ');
  const refused = REFUSED.filter(([, re]) => re.test(t)).map(([k]) => k);
  if (refused.length) return { ok: false, why: `it is (or mentions) ${refused.join(', ')}` };
  const kinds = ALLOWED.filter(([, re]) => re.test(t)).map(([k]) => k);
  if (!kinds.length) return { ok: false, why: 'its text is not one this script recognises' };
  return { ok: true, kinds };
}

const isLicenseFile = (f) => /^(licen[cs]e|copying)([-._].*)?$/i.test(f);
const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');

function newApp([name, url, commit, ...licenses]) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? '')) problems.push(`<name> must be lower-case letters, digits and dashes (got ${JSON.stringify(name)})`);
  if (!/^https:\/\/\S+$/.test(url ?? '')) problems.push(`<upstream-repo-url> must be an https:// URL (got ${JSON.stringify(url)})`);
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) problems.push(`<commit> must be the full 40-character commit SHA, not a branch or tag (got ${JSON.stringify(commit)})`);
  if (!licenses.length) problems.push('give the upstream license file(s): the LICENSE from the repository at that commit');
  for (const l of licenses) if (!existsSync(l) || !statSync(l).isFile()) problems.push(`no such file: ${l}`);
  for (const l of licenses) if (!isLicenseFile(basename(l))) problems.push(`${l}: keep upstream's file name (LICENSE, LICENSE.md, LICENSE-MIT.txt, COPYING, …)`);
  if (new Set(licenses.map((l) => basename(l))).size < licenses.length) problems.push('two license files with the same name: rename one as upstream would (LICENSE-MIT, LICENSE-APACHE)');
  if (problems.length) fail(problems);

  const kinds = [];
  for (const l of licenses) {
    const c = classify(read(l));
    if (!c.ok) {
      fail([
        `REFUSED: ${l}: ${c.why}.`,
        `Only ${ALLOWLIST} can be vendored under wild/ (docs/decisions/0015). Nothing was written.`,
        'The app cannot be vendored, but the report still counts: help in the issue, reproduce with a first-party page if',
        'the problem allows, and write the friction down there. See wild/README.md, "When the license is not on the list".',
      ]);
    }
    kinds.push(...c.kinds);
  }

  const app = join(ROOT, 'wild/apps', name);
  const record = join(ROOT, 'wild/fixtures/sources', `${name}.md`);
  const spec = join(ROOT, 'tests/wild', `${name}.spec.ts`);
  const sources = join(ROOT, 'wild/fixtures/SOURCES.md');
  const taken = [app, record, spec].filter(existsSync);
  if (taken.length) fail(taken.map((p) => `${rel(p)} already exists; this script never overwrites`));
  if (!existsSync(sources)) fail([`${rel(sources)} is missing: run this from a geowright checkout`]);

  const repo = url.replace(/^https:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
  const license = [...new Set(kinds)].join(' + ');
  const files = licenses.map((l) => basename(l));

  mkdirSync(app, { recursive: true });
  licenses.forEach((l, i) => copyFileSync(l, join(app, files[i])));
  writeFileSync(join(app, 'UPSTREAM.md'), upstreamMd({ name, repo, url, commit, license, files }));
  mkdirSync(join(ROOT, 'wild/fixtures/sources'), { recursive: true });
  writeFileSync(record, sourcesMd({ name }));
  appendFileSync(sources, `| \`sources/${name}.md\` | ${TODO}: what the ${name} app fetches | ${TODO}: the fixtures' license |\n`);
  mkdirSync(join(ROOT, 'tests/wild'), { recursive: true });
  writeFileSync(spec, specTs({ name, repo, commit }));

  console.log(`license: ${license} (${files.join(', ')}) — on the allowlist`);
  for (const p of [...files.map((f) => join(app, f)), join(app, 'UPSTREAM.md'), record, spec]) console.log(`wrote   ${rel(p)}`);
  console.log(`added   a row to ${rel(sources)}`);
  console.log(`
Next (wild/README.md, "Bring your app"):
  1. copy the app's files from upstream @ ${commit.slice(0, 12)} into ${rel(app)}/, unchanged
  2. add the ONE hook line; record it, and every vendored path, in UPSTREAM.md
  3. add package.json + build config, build into ${rel(app)}/dist/ and commit dist/ (served at /apps/${name}/);
     the build writes ${NOTICES} (Vite: build: { license: { fileName: 'THIRD_PARTY_LICENSES.md' } })
  4. run the spec: every request it has no fixture for fails the test, named — answer each one
  5. make the spec fail the way the issue says, then fix the LIBRARY, never the app
  \`node wild/scripts/apps.mjs check\` (and the unit suite) fails until every ${TODO} is gone.`);
}

function check() {
  const problems = [];
  const apps = join(ROOT, 'wild/apps');
  const specs = readdirSync(join(ROOT, 'tests/wild')).filter((f) => f.endsWith('.ts'));
  const specText = specs.map((f) => read(join(ROOT, 'tests/wild', f))).join('\n');

  const licensesOf = (dir) => {
    const found = readdirSync(dir).filter((f) => isLicenseFile(f) && statSync(join(dir, f)).isFile());
    if (!found.length) problems.push(`${rel(dir)}/: no LICENSE file (keep upstream's, byte-identical)`);
    for (const f of found) {
      const c = classify(read(join(dir, f)));
      if (!c.ok) problems.push(`${rel(join(dir, f))}: not on the allowlist (${ALLOWLIST}): ${c.why}`);
    }
  };

  for (const name of readdirSync(apps).filter((f) => statSync(join(apps, f)).isDirectory())) {
    const dir = join(apps, name);
    licensesOf(dir);
    const up = join(dir, 'UPSTREAM.md');
    if (!existsSync(up)) { problems.push(`${rel(up)}: missing (upstream repository, commit, license, the one added line)`); continue; }
    const text = read(up);
    if (!/https:\/\/\S+/.test(text)) problems.push(`${rel(up)}: names no upstream repository URL`);
    if (!/`[0-9a-f]{40}`/.test(text)) problems.push(`${rel(up)}: names no full upstream commit SHA in backticks`);
    if (!text.includes('__geowright_maps')) problems.push(`${rel(up)}: does not show the one added hook line`);
    if (!specText.includes(`/apps/${name}/`)) problems.push(`${rel(dir)}/: no spec in tests/wild/ opens /apps/${name}/`);
    noticesOf(dir, problems);
    hookLines(dir, name, text, problems);
  }
  licensesOf(join(ROOT, 'wild/maplibre-examples'));
  examplePatches(problems);

  fixturesRecorded(problems);
  demoPublicRecorded(problems);

  const scaffolded = [
    ...readdirSync(apps).map((n) => join(apps, n, 'UPSTREAM.md')),
    join(ROOT, 'wild/fixtures/SOURCES.md'),
    ...readdirSync(join(ROOT, 'wild/fixtures/sources')).map((f) => join(ROOT, 'wild/fixtures/sources', f)),
    ...specs.map((f) => join(ROOT, 'tests/wild', f)),
  ];
  for (const p of scaffolded) if (existsSync(p) && read(p).includes(TODO)) problems.push(`${rel(p)}: still has ${TODO} placeholders`);

  if (problems.length) fail(problems);
  console.log('wild apps: licenses on the allowlist, upstream pinned, one hook line each (as recorded), each opened by a spec, dist/ notices shipped; example patches: one added line each, the hook');
}

function patchesOnly() {
  const problems = [];
  examplePatches(problems, true);
  if (problems.length) fail(problems);
  console.log('maplibre examples: every patch is one added line, the hook, and nothing removed');
}

/**
 * The one added line of a wrapper app (decision 0016), checked against the app's own record: every source line that
 * names `__geowright_maps` is a hook line, a file holds at most one, the line is the one UPSTREAM.md shows (`+` in its
 * diff), and it sits in a file UPSTREAM.md marks "+1 line" in its vendored paths — or, for an app with no such list,
 * in a file UPSTREAM.md names. A vendored file not marked "+1 line" holds none. dist/ is build output, not source.
 */
function hookLines(dir, name, upstreamMd, problems) {
  const shown = new Set(upstreamMd.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1).trim()));
  const vendored = new Map(); // app-relative path -> marked "+1 line"
  for (const m of upstreamMd.matchAll(new RegExp(`^wild/apps/${name}/(\\S+)\\s+<-.*$`, 'gm'))) vendored.set(m[1], /\(\+1 line/.test(m[0]));
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return f === 'dist' || f === 'node_modules' ? [] : walk(p);
    return f === 'UPSTREAM.md' ? [] : [p];
  });
  let total = 0;
  const hooked = new Set();
  for (const file of walk(dir)) {
    const r = relative(dir, file).split('\\').join('/');
    const lines = read(file).split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.includes('__geowright_maps'));
    if (!lines.length) continue;
    for (const { l, n } of lines) {
      if (!APP_HOOK.test(l)) problems.push(`${rel(file)}:${n}: names __geowright_maps but is not the hook line ((…__geowright_maps ??= {}).main = map): ${l.trim()}`);
      else if (!shown.has(l.trim())) problems.push(`${rel(file)}:${n}: the hook line is not the one ${rel(join(dir, 'UPSTREAM.md'))} shows as its added line: ${l.trim()}`);
    }
    if (lines.length > 1) problems.push(`${rel(file)}: ${lines.length} lines name __geowright_maps (lines ${lines.map((x) => x.n).join(', ')}); a vendored file gets exactly one added line, the hook`);
    total += lines.length;
    hooked.add(r);
    if (vendored.size ? vendored.get(r) !== true : !upstreamMd.includes(r)) {
      problems.push(`${rel(file)}: holds the hook, but ${rel(join(dir, 'UPSTREAM.md'))} does not ${vendored.size ? 'mark it "(+1 line)" in its vendored paths' : 'name it'}`);
    }
  }
  if (!total) problems.push(`${rel(dir)}/: no source file holds the hook line`);
  for (const [r, plusOne] of vendored) if (plusOne && !hooked.has(r)) problems.push(`${rel(join(dir, r))}: marked "(+1 line)" in UPSTREAM.md, but holds no hook line`);
}

/**
 * The MapLibre examples (decision 0016): patches/<name>.diff, upstream -> vendored, is one added line — the hook — and
 * nothing removed; it belongs to examples/<name>.html (its added line is that file's line where the hunk says, and the
 * file names __geowright_maps nowhere else). Every line after the two header lines counts, whatever it holds: a blank
 * added line, a removed line whose content starts with "--", an added one whose content starts with "+".
 */
function examplePatches(problems, print = false) {
  const dir = join(ROOT, 'wild/maplibre-examples');
  if (!existsSync(join(dir, 'examples'))) return;
  const names = (sub, ext) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)) : []);
  const examples = names('examples', '.html');
  const patches = names('patches', '.diff');
  for (const n of examples) if (!patches.includes(n)) problems.push(`wild/maplibre-examples/examples/${n}.html: no patches/${n}.diff (bash wild/scripts/examples.sh patches)`);
  for (const n of patches) if (!examples.includes(n)) problems.push(`wild/maplibre-examples/patches/${n}.diff: no examples/${n}.html`);
  for (const n of examples.filter((x) => patches.includes(x))) {
    const where = `wild/maplibre-examples/patches/${n}.diff`;
    const lines = read(join(dir, 'patches', `${n}.diff`)).split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines[0]?.startsWith('--- ') || !lines[1]?.startsWith('+++ ')) {
      problems.push(`${where}: not a unified diff (no ---/+++ header)`);
      continue;
    }
    const added = [];
    let removed = 0;
    let newLine = 0;
    for (const l of lines.slice(2)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (hunk) newLine = Number(hunk[1]);
      else if (l.startsWith('+')) added.push({ text: l.slice(1), at: newLine++ });
      else if (l.startsWith('-')) removed++;
      else if (l.startsWith(' ')) newLine++;
      else if (!l.startsWith('\\')) problems.push(`${where}: a line that is not part of a unified diff: ${JSON.stringify(l)}`);
    }
    if (print) console.log(`${n}: +${added.length} -${removed}`);
    if (added.length !== 1 || removed) problems.push(`${where}: +${added.length} -${removed}; the vendored example must be upstream plus exactly one added line, the hook`);
    for (const a of added) if (!EXAMPLE_HOOK.test(a.text)) problems.push(`${where}: added line ${JSON.stringify(a.text)} is not the hook ((window.__geowright_maps ??= {}).main = map;)`);
    const html = read(join(dir, 'examples', `${n}.html`)).split('\n');
    if (added.length === 1 && html[added[0].at - 1] !== added[0].text) problems.push(`${where}: its added line is not line ${added[0].at} of examples/${n}.html: regenerate it (bash wild/scripts/examples.sh patches)`);
    const named = html.filter((l) => l.includes('__geowright_maps')).length;
    if (named > 1) problems.push(`wild/maplibre-examples/examples/${n}.html: ${named} lines name __geowright_maps; the patch shows one`);
  }
}

/**
 * Every fixture file has a provenance and license row: its path (relative to wild/fixtures/, or from the repository
 * root), or a directory it is in (as `dir/…`), appears in wild/fixtures/SOURCES.md or wild/fixtures/sources/*.md.
 * License and notices files are records themselves. A path counts only whole: `turf.min.js` is not named by a row for
 * `vendor/turf@7/turf.min.js`, and a file name alone names nothing, so a new file cannot pass under a row written for
 * another one with the same name. A directory covers data only (the demotiles/ tiles): code is named by its own path.
 * Each vendored build, wild/fixtures/vendor/<name>/, keeps its license file and a THIRD_PARTY_LICENSES.md beside it:
 * what the build bundles, read from the build, with each text (decision 0015), even when that is only its own code.
 */
const FIXTURE_CODE = /\.(m?js|cjs|css|wasm)$/i;
/** `path` appears in `text` as a whole path: not as the tail of a longer one, nor as the start of a longer name. */
const namesPath = (text, path) =>
  new RegExp(`(?<![\\w.@/-])${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`).test(text);
function fixturesRecorded(problems) {
  const fixtures = join(ROOT, 'wild/fixtures');
  const sources = join(fixtures, 'sources');
  const records = [join(fixtures, 'SOURCES.md'), ...(existsSync(sources) ? readdirSync(sources).map((f) => join(sources, f)) : [])];
  const text = records.filter(existsSync).map(read).join('\n');
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const file of walk(fixtures)) {
    const r = relative(fixtures, file).split('\\').join('/');
    const name = basename(file);
    if (records.includes(file) || isLicenseFile(name) || name === 'THIRD_PARTY_LICENSES.md' || name === '.DS_Store') continue;
    const dirs = [];
    for (let d = r.split('/').slice(0, -1); d.length; d.pop()) dirs.push(`\`${d.join('/')}/`);
    if (namesPath(text, r) || namesPath(text, `wild/fixtures/${r}`)) continue;
    const code = FIXTURE_CODE.test(name);
    if (!code && dirs.some((d) => text.includes(d))) continue;
    problems.push(code
      ? `wild/fixtures/${r}: code, and not named by its path in wild/fixtures/SOURCES.md or a sources/*.md record (a directory row covers data only)`
      : `wild/fixtures/${r}: not named in wild/fixtures/SOURCES.md or a sources/*.md record (origin, license)`);
  }
  const vendor = join(fixtures, 'vendor');
  for (const d of existsSync(vendor) ? readdirSync(vendor).filter((f) => statSync(join(vendor, f)).isDirectory()) : []) {
    const files = readdirSync(join(vendor, d));
    if (!files.some(isLicenseFile)) problems.push(`wild/fixtures/vendor/${d}/: no license file (keep the package's own, byte-identical)`);
    if (!files.includes('THIRD_PARTY_LICENSES.md')) problems.push(`wild/fixtures/vendor/${d}/: no THIRD_PARTY_LICENSES.md (what the build bundles, established by reading it, and each one's license text: decision 0015)`);
  }
}

/**
 * Every file the demo app serves from demo/public/ (MapLibre's build, the glyphs) is named by its path in
 * docs/THIRD_PARTY_NOTICES.md, with its origin and license. License, notices and README files are records themselves.
 */
function demoPublicRecorded(problems) {
  const dir = join(ROOT, 'demo/public');
  if (!existsSync(dir)) return;
  const notices = join(ROOT, 'docs/THIRD_PARTY_NOTICES.md');
  const text = existsSync(notices) ? read(notices) : '';
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const file of walk(dir)) {
    const name = basename(file);
    if (isLicenseFile(name) || name === 'THIRD_PARTY_LICENSES.md' || name === 'README.md' || name === '.DS_Store') continue;
    const r = rel(file).split('\\').join('/');
    if (!namesPath(text, r)) problems.push(`${r}: not named by its path in docs/THIRD_PARTY_NOTICES.md (origin, license)`);
  }
}

/** dist/ redistributes third-party code, so it ships their notices: a section with a license text per bundled package. */
function noticesOf(dir, problems) {
  const file = join(dir, NOTICES);
  if (!existsSync(file)) {
    problems.push(`${rel(file)}: missing. dist/ redistributes what the build bundles, so it must ship their license texts (Vite: build.license; see wild/README.md, "Bring your app")`);
    return;
  }
  const sections = read(file).split(/^## /m).slice(1).map((s) => {
    const [head, ...body] = s.split('\n');
    return { head: head.trim(), text: body.join('\n').trim() };
  });
  if (!sections.length) problems.push(`${rel(file)}: lists no package (one "## <package> - <version>" section each, license text below)`);
  for (const s of sections) if (!s.text) problems.push(`${rel(file)}: "${s.head}" has no license text (the package ships no license file: add its text to the build)`);
  // Vite lists maplibre-gl as ONE package, but its prebuilt dist bundles others inside itself. The build adds them
  // from MapLibre's source maps (scripts/maplibre-notices.mjs); offline, only a floor can be checked: the packages
  // every MapLibre 3-6 build bundles.
  if (sections.some((s) => s.head.startsWith('maplibre-gl - '))) {
    const listed = new Set(sections.map((s) => s.head.split(' ')[0]));
    const missing = MAPLIBRE_BUNDLES.filter((p) => !listed.has(p));
    if (missing.length) problems.push(`${rel(file)}: lists maplibre-gl but not what its dist bundles (${missing.join(', ')}): add \`maplibreNotices\` from scripts/maplibre-notices.mjs to the build`);
  }
  // Not checked: that every package.json dependency is listed. A dependency whose module only re-exports another
  // package (react-map-gl/maplibre re-exports @vis.gl/react-maplibre) contributes no code, and Vite rightly omits it.
}

function fail(lines, code = 1) {
  console.error(lines.join('\n'));
  process.exit(code);
}

const upstreamMd = ({ name, repo, url, commit, license, files }) => `# Upstream: ${repo}

- Repository: ${url}
- Pinned commit: \`${commit}\` (${TODO}: branch or tag, and the date it was fetched)
- License: ${license}. The upstream ${files.map((f) => `\`${f}\``).join(' and ')} ${files.length > 1 ? 'are' : 'is'} kept byte-for-byte as ${files.map((f) => `[\`${f}\`](./${f})`).join(' and ')}.
- Upstream app: ${TODO}: the path(s) in the upstream repository this app comes from
- Reported in: ${TODO}: the issue

## Vendored paths

\`\`\`text
${TODO}: one line per file, e.g. wild/apps/${name}/src/app.tsx <- src/app.tsx (+1 line, see below)
\`\`\`

Every vendored file is byte-identical to upstream except the one hook line below. Everything else in this directory
(\`package.json\`, the build config, \`dist/\`, this file) is geowright build boilerplate.

## The one-line change

${TODO}: where the line is and why there, as a diff against upstream. Exactly one added line
([0010](../../../docs/decisions/0010-wild-apps-not-bent.md)):

\`\`\`diff
 const map = new maplibregl.Map({ /* … */ });
+(window.__geowright_maps ??= {}).main = map;
\`\`\`

## Build

${TODO}: the commands (\`npm ci && npm run build\` here), what lands in \`dist/\` (including
\`${NOTICES}\`, the license texts of what it bundles), and the map library, wrapper and versions it resolves.

## Dependencies and license audit

${TODO}: the licenses of what the build bundles into \`dist/\` (all on the allowlist: ${ALLOWLIST}).

## Network calls

${TODO}: every URL the app requests and what answers it in \`tests/wild/${name}.spec.ts\`; the fixtures are recorded in
[\`wild/fixtures/sources/${name}.md\`](../../fixtures/sources/${name}.md).
`;

const sourcesMd = ({ name }) => `# ${name} fixture routes

| URL requested by the upstream app | Test response | License / provenance |
|---|---|---|
| ${TODO}: the URL | ${TODO}: the fixture file, or the generator in \`tests/wild/\` | ${TODO}: synthetic, or a permissive source with its license file kept — never OpenStreetMap-derived (ODbL), CC-BY or vendor tiles |

The upstream URLs stay in the vendored app. \`page.route\` answers them; the wild harness aborts and reports anything else external.
`;

const specTs = ({ name, repo, commit }) => `import { expect, test, type Routes } from './harness';

// ${repo} @ ${commit.slice(0, 12)}, vendored unchanged apart from the hook line (wild/apps/${name}/UPSTREAM.md).
// Everything the app fetches is answered here from fixtures (wild/fixtures/sources/${name}.md). A request with no
// route aborts and FAILS the test, naming the URL — run this first to learn what the app needs.
const routes: Routes = [
  // ${TODO}: e.g. ...DEMOTILES, ['https://example.com/data.geojson', '${name}/data.geojson'], glyphs(/…/)
];

test('wild: ${name} — ${TODO}: what the issue says fails', async ({ wild }) => {
  const map = await wild.open('/apps/${name}/', { routes });
  // ${TODO}: the geowright call from the issue, failing before the library fix and passing after it, e.g.
  // await expect(map).toHaveFeature({ layer: '…', where: { … } });
  expect(await map.layers()).not.toEqual([]);
});
`;

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'new') newApp(args);
else if (cmd === 'check') check();
else if (cmd === 'patches') patchesOnly();
else fail([read(fileURLToPath(import.meta.url)).split('\n').slice(0, 22).join('\n').replace(/^\/\/ ?/gm, '')], 2);
