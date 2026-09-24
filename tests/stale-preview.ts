import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The stale-preview trap (AGENTS.md): outside CI, Playwright REUSES a preview server already listening on the port, and
 * then never runs `npm run build:demo` — so a changed demo/ is tested as it was, or another checkout's build is tested
 * instead. Checked once per run (tests/global-setup.ts), cheaply: the server must serve this checkout's
 * demo/dist/index.html, and no file under demo/ may be newer than that build. Undefined: fine; otherwise what is wrong.
 */
export async function stalePreview(root: string, baseURL: string, get: (url: string) => Promise<string> = (u) => fetch(u).then((r) => r.text())): Promise<string | undefined> {
  const built = join(root, 'demo/dist/index.html');
  if (!existsSync(built)) return `demo/dist/index.html does not exist, yet a server answers on ${baseURL}: it is not serving this checkout's build`;
  const served = await get(`${baseURL}/`).catch((e: Error) => `(no answer: ${e.message})`);
  if (served !== readFileSync(built, 'utf8')) return `the server on ${baseURL} does not serve this checkout's demo/dist/index.html: another checkout's build, or an older one`;
  const builtAt = statSync(built).mtimeMs;
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return e.name === 'dist' || e.name === 'node_modules' ? [] : walk(p);
      return [p];
    });
  const newer = walk(join(root, 'demo')).filter((p) => statSync(p).mtimeMs > builtAt).map((p) => relative(root, p).split('\\').join('/'));
  if (newer.length) return `changed after demo/dist was built, so the reused preview serves stale code: ${newer.slice(0, 5).join(', ')}${newer.length > 5 ? ` and ${newer.length - 5} more` : ''}`;
  return undefined;
}
