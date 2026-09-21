import { test, expect } from '@playwright/test';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, init } from '../../src/cli/init';

/** `geowright init` against scratch copies of the third-party wrapper apps in wild/apps (their real package.json). */
const APPS = fileURLToPath(new URL('../../wild/apps/', import.meta.url));

function scratch(app: string): string {
  const dir = test.info().outputPath(app);
  cpSync(join(APPS, app, 'package.json'), join(dir, 'package.json'), { recursive: true });
  if (existsSync(join(APPS, app, 'tsconfig.json'))) cpSync(join(APPS, app, 'tsconfig.json'), join(dir, 'tsconfig.json'));
  return dir;
}

for (const [app, wrapper, hook] of [
  ['react-map-gl', 'react-map-gl', '<Map onLoad={(e) => ((window.__geowright_maps ??= {}).main = e.target)}'],
  ['svelte-maplibre-gl', 'svelte-maplibre-gl', '<MapLibre onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)}'],
  ['vue-maplibre-gl', 'vue-maplibre-gl', '@map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)"'],
] as const) {
  test(`init in a ${app} app: detects the wrapper, prints ITS hook, writes three files + a config where there is none, never overwrites`, () => {
    const cwd = scratch(app);
    const lines: string[] = [];
    const first = init({ cwd, log: (l) => lines.push(l) });
    expect(first.detection.wrappers.map((w) => w.name)).toEqual([wrapper]);
    expect(first.detection.mapLibrary).toMatchObject({ pkg: 'maplibre-gl', supported: true });
    expect(lines.join('\n')).toContain(hook);
    expect(first.written).toHaveLength(4); // fixture, flags, first spec — and a whole Playwright config: the scratch app has none
    const config = readFileSync(join(cwd, first.config!), 'utf8');
    expect(config).toContain(`from './tests/geowright.webgl.js'`);
    expect(config).toContain('launchOptions: { args: WEBGL_SOFTWARE_FLAGS }');
    expect(config).toContain(`command: 'npm run dev'`);
    for (const f of first.written) expect(existsSync(join(cwd, f))).toBe(true);
    const spec = first.written.find((f) => f.includes('map.spec'))!;
    expect(readFileSync(join(cwd, spec), 'utf8')).toContain('console.log(await map.snapshot())');

    // the hook printed for this wrapper is the line that is actually in the vendored app (the one line we added to it)
    const token = hook.includes('@map:load') ? 'ownerDocument.defaultView.__geowright_maps' : '__geowright_maps ??= {}).main = e.target';
    const hits = ['src', 'docs', 'examples', '.'].some((d) => existsSync(join(APPS, app, d)) && grepDir(join(APPS, app, d), token));
    expect(hits).toBe(true);

    // a second run changes nothing the user may have edited
    writeFileSync(join(cwd, spec), '// mine now');
    const second = init({ cwd, log: () => {} });
    expect(second.written).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);
    expect(second.config).toBeUndefined();
    expect(readFileSync(join(cwd, spec), 'utf8')).toBe('// mine now');
    // --force rewrites OUR three files; a Playwright config is the user's file and is never overwritten
    writeFileSync(join(cwd, first.config!), '// my config');
    const forced = init({ cwd, force: true, log: (l) => lines.push(l) });
    expect(forced.written).toHaveLength(3);
    expect(readFileSync(join(cwd, first.config!), 'utf8')).toBe('// my config');
    expect(lines.join('\n')).toContain('three lines for YOUR playwright.config');
  });
}

function grepDir(dir: string, token: string, depth = 0): boolean {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (depth < 4 && grepDir(p, token, depth + 1)) return true;
    } else if (/\.(jsx?|tsx?|vue|svelte|html)$/.test(name) && readFileSync(p, 'utf8').includes(token)) return true;
  }
  return false;
}

test('detect: plain MapLibre, Mapbox v1 (supported), Mapbox v3 (proprietary: warned, not claimed), nothing', () => {
  expect(detect({ dependencies: { 'maplibre-gl': '^4.7.1' } })).toMatchObject({ wrappers: [], mapLibrary: { pkg: 'maplibre-gl', supported: true } });
  expect(detect({ dependencies: { 'mapbox-gl': '1.13.3' } }).mapLibrary).toMatchObject({ supported: true });
  const v3 = detect({ dependencies: { 'mapbox-gl': '^3.4.0' } }).mapLibrary!;
  expect(v3.supported).toBe(false);
  expect(v3.why).toContain('proprietary');
  expect(detect({}).mapLibrary).toBeUndefined();
});

test('init refuses to run where there is no package.json', () => {
  expect(() => init({ cwd: test.info().outputPath('empty'), log: () => {} })).toThrow(/no package\.json/);
});
