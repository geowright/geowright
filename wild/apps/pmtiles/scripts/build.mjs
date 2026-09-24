import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await cp('index.html', 'dist/index.html');
await cp('node_modules/maplibre-gl/dist/maplibre-gl.js', 'dist/vendor/maplibre-gl.js');
await cp('node_modules/maplibre-gl/dist/maplibre-gl.css', 'dist/vendor/maplibre-gl.css');
await cp('node_modules/maplibre-gl/dist/LICENSE.txt', 'dist/vendor/maplibre-gl.LICENSE.txt');
await cp('node_modules/pmtiles/dist/pmtiles.js', 'dist/vendor/pmtiles.js');
await cp('node_modules/fflate/LICENSE', 'dist/vendor/fflate.LICENSE');

// dist/THIRD_PARTY_LICENSES.md: the notices of everything dist/vendor/ redistributes, in the format Vite's
// `build.license` writes for the other wild apps (`node ../../scripts/apps.mjs check` requires it). pmtiles.js bundles
// fflate. The pmtiles npm package ships no license file: its text is the PMTiles repository's root LICENSE, kept
// byte-identical in this directory (UPSTREAM.md).
const notices = [
  ['maplibre-gl', 'node_modules/maplibre-gl/package.json', 'node_modules/maplibre-gl/dist/LICENSE.txt'],
  ['pmtiles', 'node_modules/pmtiles/package.json', 'LICENSE'],
  ['fflate', 'node_modules/fflate/package.json', 'node_modules/fflate/LICENSE'],
];
let md = '# Licenses\n\nThe app bundles dependencies which contain the following licenses:\n';
for (const [name, pkg, license] of notices) {
  const { version, license: id } = JSON.parse(await readFile(pkg, 'utf8'));
  md += `\n## ${name} - ${version} (${id})\n\n${(await readFile(license, 'utf8')).trim()}\n`;
}
await writeFile('dist/THIRD_PARTY_LICENSES.md', md);

console.log('copied upstream index.html and pinned MapLibre/PMTiles browser assets to dist/, with their licenses');
