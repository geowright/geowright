// Static server for the version-compat matrix: ONE small page, loaded against whichever map library
// build `?lib=<npm alias>` names.  /lib/<alias>/* -> node_modules/<alias>/*   /glyphs/* -> demo/public/glyphs/*
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = Number(process.env.GEOWRIGHT_COMPAT_PORT ?? 4175);
const ALIASES = /^(mapbox-gl-1|maplibre-gl-[2-5]|maplibre-gl)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.pbf': 'application/x-protobuf', '.png': 'image/png' };

const safeJoin = (dir, rel) => {
  const p = normalize(join(dir, rel));
  return p.startsWith(dir + sep) ? p : null;
};

function resolvePath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return join(ROOT, 'tests/compat/page/index.html');
  const lib = /^\/lib\/([\w.-]+)\/(.+)$/.exec(pathname);
  if (lib && ALIASES.test(lib[1])) return safeJoin(join(ROOT, 'node_modules', lib[1]), lib[2]);
  if (pathname.startsWith('/glyphs/')) return safeJoin(join(ROOT, 'demo/public/glyphs'), pathname.slice('/glyphs/'.length));
  return null;
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const file = resolvePath(decodeURIComponent(pathname)); // throws on a malformed %: a 500 for that request, not a dead server
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
}).listen(PORT, 'localhost', () => console.log(`compat page on http://localhost:${PORT}`)); // this machine only, as vite preview
