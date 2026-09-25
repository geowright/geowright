import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The stale-preview trap (AGENTS.md): outside CI, Playwright REUSES a preview server already listening on the port, and
 * then never runs `npm run build:demo` — so a changed demo/ is tested as it was, or another checkout's build is tested
 * instead. Checked once per run (tests/global-setup.ts), cheaply: the server must serve this checkout's
 * demo/dist/index.html, and no file under demo/ may be newer than that build. Undefined: fine; otherwise what is wrong.
 */
export async function stalePreview(root: string, baseURL: string, get: (url: string) => Promise<string> = fromAnyAddress): Promise<string | undefined> {
  const built = join(root, 'demo/dist/index.html');
  if (!existsSync(built)) return `demo/dist/index.html does not exist, yet a server answers on ${baseURL}: it is not serving this checkout's build`;
  // No answer is not a verdict on the build: the check itself could not look, and must not blame another checkout.
  const served = await get(`${baseURL}/`).catch((e: Error) => {
    throw new Error(`the stale-preview check got no answer from ${baseURL}/ (${e.message}), although Playwright found a server there`);
  });
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

/**
 * GET `url` from each address its host resolves to, first answer wins, as the browser and Playwright's readiness check
 * reach it. A plain fetch('http://localhost:…') resolves with ADDRCONFIG: in a Linux container with no global IPv6
 * address that drops ::1, the only address `vite preview` listens on there, and the fetch is refused.
 */
async function fromAnyAddress(url: string): Promise<string> {
  const target = new URL(url);
  const errors: string[] = [];
  for (const { address, family } of await lookup(target.hostname, { all: true })) {
    target.hostname = family === 6 ? `[${address}]` : address;
    try {
      return await fetch(target).then((r) => r.text());
    } catch (e) {
      errors.push(`${address}: ${((e as Error).cause as NodeJS.ErrnoException | undefined)?.code ?? (e as Error).message}`);
    }
  }
  throw new Error(errors.join(', '));
}
