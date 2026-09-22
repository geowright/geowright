import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await cp('index.html', 'dist/index.html');
await cp('node_modules/maplibre-gl/dist/maplibre-gl.js', 'dist/vendor/maplibre-gl.js');
await cp('node_modules/maplibre-gl/dist/maplibre-gl.css', 'dist/vendor/maplibre-gl.css');
await cp('node_modules/maplibre-gl/dist/LICENSE.txt', 'dist/vendor/maplibre-gl.LICENSE.txt');
await cp('node_modules/pmtiles/dist/pmtiles.js', 'dist/vendor/pmtiles.js');
await cp('node_modules/fflate/LICENSE', 'dist/vendor/fflate.LICENSE');

console.log('copied upstream index.html and pinned MapLibre/PMTiles browser assets to dist/');
