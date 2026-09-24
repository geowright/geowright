import { test, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { APP_TYPES_REFERENCE, detect, init } from '../../src/cli/init';

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
    expect(lines.join('\n'), 'a JavaScript app gets no TypeScript advice').not.toContain('geowright/app');
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
    expect(lines.join('\n')).toContain('Add these two lines to YOUR playwright.config');
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

test('init in a TypeScript app: prints the geowright/app reference line under the hook, writes it nowhere, leaves tsconfig alone', () => {
  const cwd = test.info().outputPath('ts-app');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'maplibre-gl': '^6.10.0' }, devDependencies: { typescript: '^5.9.0', '@playwright/test': '^1.55.0' } }));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }, null, 2);
  writeFileSync(join(cwd, 'tsconfig.json'), tsconfig);
  const lines: string[] = [];
  const result = init({ cwd, log: (l) => lines.push(l) });
  const out = lines.join('\n');
  expect(APP_TYPES_REFERENCE).toBe('/// <reference types="geowright/app" />');
  // right after the plain hook, in step 1 (the app side), before step 2
  const hookAt = out.indexOf('(window.__geowright_maps ??= {}).main = map;');
  const refAt = out.indexOf(APP_TYPES_REFERENCE);
  expect(hookAt).toBeGreaterThan(0);
  expect(refAt).toBeGreaterThan(hookAt);
  expect(refAt).toBeLessThan(out.indexOf('\n2. '));
  expect(out).toContain("add to a .d.ts your APP's tsconfig includes");
  // printed only: every file init wrote is in the tests dir or the Playwright config; none carries the reference
  expect(result.written.sort()).toEqual(['playwright.config.ts', 'tests/geowright.fixture.ts', 'tests/geowright.webgl.ts', 'tests/map.spec.ts']);
  for (const f of result.written) expect(readFileSync(join(cwd, f), 'utf8')).not.toContain('geowright/app');
  expect(readFileSync(join(cwd, 'tsconfig.json'), 'utf8')).toBe(tsconfig);
});

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

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The `geowright` command itself: src/cli/index.ts bundled the way `npm run build:node` bundles it, run in a scratch project. */
async function cli(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const bin = test.info().outputPath('cli.mjs');
  if (!existsSync(bin)) await build({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bin, logLevel: 'silent' });
  return promisify(execFile)(process.execPath, [bin, ...args], { cwd }).then(
    ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }),
  );
}
function project(name: string, pkg: object | string, files: Record<string, string> = {}): string {
  const cwd = test.info().outputPath(name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(cwd, f), body);
  return cwd;
}

test('the CLI: init --dir e2e --url /app/ in an @vis.gl/react-maplibre app writes there, points the fixture at that URL, prints that wrapper\'s hook', async () => {
  const cwd = project('vis-gl', { dependencies: { '@vis.gl/react-maplibre': '^8.0.0', 'maplibre-gl': '^5.6.0' } });
  const { code, out } = await cli(cwd, 'init', '--dir', 'e2e', '--url', '/app/');
  expect(code, out).toBe(0);
  expect(out).toContain('@vis.gl/react-maplibre detected');
  expect(out).toContain('<Map onLoad={(e) => ((window.__geowright_maps ??= {}).main = e.target)}');
  expect(readdirSync(join(cwd, 'e2e')).sort()).toEqual(['geowright.fixture.js', 'geowright.webgl.js', 'map.spec.js']);
  expect(existsSync(join(cwd, 'tests')), 'nothing written to the default directory').toBe(false);
  expect(readFileSync(join(cwd, 'e2e/geowright.fixture.js'), 'utf8')).toContain(`await page.goto('/app/');`);
  expect(out).toContain('npx playwright test e2e/map.spec.js');
});

test('the CLI: --dir=e2e and --url=/x are the same as the two-word forms', async () => {
  const cwd = project('equals', { dependencies: { 'maplibre-gl': '^6.0.0' } });
  const { code, out } = await cli(cwd, 'init', '--dir=e2e', '--url=/x');
  expect(code, out).toBe(0);
  expect(readFileSync(join(cwd, 'e2e/geowright.fixture.js'), 'utf8')).toContain(`await page.goto('/x');`);
  expect(existsSync(join(cwd, 'tests'))).toBe(false);
});

test('the CLI: a flag without its value, and an unknown option, are errors; nothing is written', async () => {
  const cwd = project('bad-flags', { dependencies: { 'maplibre-gl': '^6.0.0' } });
  const missing = await cli(cwd, 'init', '--dir', '--force');
  expect(missing.code).toBe(1);
  expect(missing.out).toContain('--dir needs a value');
  const unknown = await cli(cwd, 'init', '--dri', 'e2e');
  expect(unknown.code).toBe(1);
  expect(unknown.out).toContain('unknown option --dri');
  expect(readdirSync(cwd)).toEqual(['package.json']);
});

test('the CLI: a path with a space is printed quoted, ready to paste into a shell', async () => {
  const cwd = project('spaces', { dependencies: { 'maplibre-gl': '^6.0.0' } });
  const { code, out } = await cli(cwd, 'init', '--dir', 'map tests');
  expect(code, out).toBe(0);
  expect(out).toContain(`npx playwright test 'map tests/map.spec.js'`);
});

test('the CLI: a package.json that is not JSON gets an error that names the file', async () => {
  const cwd = project('bad-json', '{ "dependencies": { "maplibre-gl": "^6.0.0", } }');
  const { code, out } = await cli(cwd, 'init');
  expect(code).toBe(1);
  expect(out).toContain(`${join(cwd, 'package.json')} is not valid JSON`);
});

test('the CLI: with an existing Playwright config, init prints the two lines to add, and they are the lines in geowright.webgl', async () => {
  const cwd = project('has-config', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': '// mine' });
  const { code, out } = await cli(cwd, 'init');
  expect(code, out).toBe(0);
  const lines = [
    `import { WEBGL_SOFTWARE_FLAGS } from './tests/geowright.webgl.js';`,
    `projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: WEBGL_SOFTWARE_FLAGS } } }],`,
  ];
  expect(out).toContain(`Add these two lines to YOUR playwright.config (init never edits it):\n     ${lines[0]}\n     ${lines[1]}\n`);
  const webgl = readFileSync(join(cwd, 'tests/geowright.webgl.js'), 'utf8');
  for (const l of lines) expect(webgl).toContain(` *   ${l}`);
  expect(readFileSync(join(cwd, 'playwright.config.js'), 'utf8')).toBe('// mine');
});
