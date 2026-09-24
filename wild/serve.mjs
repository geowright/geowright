// Static server for the "wild apps" suite: MapLibre apps we did not write, served as their authors
// laid them out. No build step, no rewriting — what is on disk is what the browser gets.
//
//   /test/examples/<name>.html  -> wild/maplibre-examples/examples/<name>.html
//   /dist/*                     -> node_modules/maplibre-gl/dist/*
//       (MapLibre's examples import '../../dist/maplibre-gl-dev.mjs'; serving them at their upstream
//        path means the loading boilerplate needs no adaptation at all)
//   /apps/<name>/*              -> wild/apps/<name>/dist/*   (prebuilt third-party apps)
//
// Everything an app fetches from the NETWORK is the tests' business (page.route + fixtures).
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.GEOWRIGHT_WILD_PORT ?? 4174);

const MOUNTS = [
  ['/test/examples/', join(ROOT, 'wild/maplibre-examples/examples')],
  ['/dist/', join(ROOT, 'node_modules/maplibre-gl/dist')],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json', '.map': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pbf': 'application/x-protobuf', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function resolvePath(pathname) {
  const app = /^\/apps\/([\w.-]+)\/(.*)$/.exec(pathname);
  if (app) return safeJoin(join(ROOT, 'wild/apps', app[1], 'dist'), app[2] || 'index.html');
  for (const [prefix, dir] of MOUNTS) if (pathname.startsWith(prefix)) return safeJoin(dir, pathname.slice(prefix.length));
  return null;
}

function safeJoin(dir, rel) {
  const p = normalize(join(dir, rel));
  return p === dir || p.startsWith(dir + sep) ? p : null;
}

async function index() {
  const examples = (await readdir(MOUNTS[0][1]).catch(() => [])).filter((f) => f.endsWith('.html'));
  const apps = await readdir(join(ROOT, 'wild/apps')).catch(() => []);
  const li = (href) => `<li><a href="${href}">${href}</a></li>`;
  return `<!doctype html><title>geowright wild apps</title><h1>wild apps</h1><ul>${examples.map((f) => li(`/test/examples/${f}`)).join('')}${apps.map((a) => li(`/apps/${a}/`)).join('')}</ul>`;
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(await index());
    }
    let file = resolvePath(decodeURIComponent(pathname));
    if (file && (await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = file && (await readFile(file).catch(() => null));
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`not found: ${pathname}`);
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e));
  }
}).listen(PORT, 'localhost', () => console.log(`wild apps on http://localhost:${PORT}`)); // this machine only, as vite preview
