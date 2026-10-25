import { test, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { build, transformSync } from 'esbuild';
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

test('detect: a maplibre-gl major outside the tested 2–6 is warned about, and a range with no version is not read as one', () => {
  // Every maplibre-gl range was "supported", 1.x and 7 included, while mapbox-gl@latest was told it is "v2+"
  // (review finding E-7).
  const lib = (deps: Record<string, string>) => detect({ dependencies: deps }).mapLibrary!;
  for (const range of ['2.4.0', '^3.6.2', '~4.7.1', '>=5.0.0 <6', '6.x', '^6.10.0']) {
    expect.soft(lib({ 'maplibre-gl': range }).supported, range).toBe(true);
    expect.soft(lib({ 'maplibre-gl': range }).why, range).toBeUndefined();
  }
  for (const [range, why] of [
    ['^1.15.3', 'MapLibre GL JS 1 is NOT tested by geowright (2–6 are'],
    ['1.13.0-rc.4', 'MapLibre GL JS 1 is NOT tested by geowright (2–6 are'],
    ['^7.0.0', 'MapLibre GL JS 7 is newer than the versions this geowright release is tested with (2–6)'],
    ['latest', 'cannot tell the major version from this range'],
    ['*', 'cannot tell the major version from this range'],
  ]) {
    expect.soft(lib({ 'maplibre-gl': range }).supported, range).toBe(false);
    expect.soft(lib({ 'maplibre-gl': range }).why, range).toContain(why);
  }
  // mapbox-gl: a range with no version is not called "v2+" (today `latest` IS v3, so it is still warned about)
  const latest = lib({ 'mapbox-gl': 'latest' });
  expect.soft(latest.supported).toBe(false);
  expect.soft(latest.why).toContain('cannot tell the major version from this range');
  expect.soft(latest.why).toContain('Mapbox GL JS 1.13');
  // an npm alias is judged by the package it installs: react-map-gl users wrote "mapbox-gl": "npm:maplibre-gl@…"
  const alias4 = lib({ 'mapbox-gl': 'npm:maplibre-gl@^4.7.1' });
  expect.soft(alias4.supported, 'MapLibre 4 under the mapbox-gl name').toBe(true);
  expect.soft(alias4.why, 'MapLibre 4 under the mapbox-gl name').toBeUndefined();
  expect.soft(lib({ 'mapbox-gl': 'npm:maplibre-gl@^1.15.2' }).why, 'MapLibre 1 under the mapbox-gl name').toContain('MapLibre GL JS 1 is NOT tested');
});

test('init prints the warning for a maplibre-gl major outside 2–6, and none for a tested one', () => {
  for (const [range, warned] of [['^1.15.3', true], ['^7.0.0', true], ['^6.10.0', false]] as const) {
    const cwd = test.info().outputPath(`maplibre-${range.replace(/\W/g, '')}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'maplibre-gl': range } }));
    const lines: string[] = [];
    init({ cwd, log: (l) => lines.push(l) });
    const warning = lines.find((l) => l.includes('WARNING'));
    if (warned) expect.soft(warning, range).toContain(`WARNING: maplibre-gl@${range} — MapLibre GL JS`);
    else expect.soft(warning, range).toBeUndefined();
  }
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

test('help and package version: init help prints init usage; package version exits successfully', async () => {
  const cwd = project('help-version', {});
  for (const flag of ['--help', '-h']) {
    const result = await cli(cwd, 'init', flag);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('usage: geowright init');
  }
  const version = await cli(cwd, '--version');
  expect(version.code, version.out).toBe(0);
  expect(version.out.trim()).toBe(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  const invalid = await cli(cwd, 'init', '--unknown');
  expect(invalid.code).toBe(1);
});

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

/** A config like the one `npm init playwright` writes: `baseURL` and `webServer` are there, commented out. */
const SCAFFOLD_CONFIG = `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: {
    /* Base URL to use in actions like \`await page.goto('/')\`. */
    // baseURL: 'http://localhost:3000',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // webServer: { command: 'npm run start', url: 'http://localhost:3000' },
});
`;

test('the CLI: with an existing config, init says the fixture\'s URL is relative to use.baseURL, and how to give it a full one', async () => {
  // Without a baseURL in the user's config the fixture's page.goto('/') fails with "Cannot navigate to invalid URL",
  // and step 2 used to print only the two WebGL lines (review finding E-2).
  const cwd = project('scaffold-config', { dependencies: { 'maplibre-gl': '^6.0.0' }, devDependencies: { vite: '^7.0.0' } }, { 'playwright.config.js': SCAFFOLD_CONFIG });
  const { code, out } = await cli(cwd, 'init');
  expect(code, out).toBe(0);
  const step2 = out.slice(out.indexOf('\n2. '), out.indexOf('\n3. '));
  expect(step2).toContain(`opens '/' relative to use.baseURL`);
  expect(step2).toContain('Cannot navigate to invalid URL');
  expect(step2, 'the app must also be running: the scaffold has webServer commented out').toContain('webServer');
  expect(step2, 'a Vite app is served on 5173').toContain('--force --url http://localhost:5173/');
  // the line Playwright's error frame points at says the same
  expect(readFileSync(join(cwd, 'tests/geowright.fixture.js'), 'utf8')).toContain(`await page.goto('/'); // relative to use.baseURL in playwright.config`);
  expect(readFileSync(join(cwd, 'playwright.config.js'), 'utf8')).toBe(SCAFFOLD_CONFIG);

  // a full URL needs no baseURL: no hint, and no comment on the goto
  const full = project('scaffold-config-full-url', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': SCAFFOLD_CONFIG });
  const abs = await cli(full, 'init', '--url', 'http://localhost:3000/');
  expect(abs.code, abs.out).toBe(0);
  expect(abs.out).not.toContain('baseURL');
  expect(readFileSync(join(full, 'tests/geowright.fixture.js'), 'utf8')).toContain(`await page.goto('http://localhost:3000/');\n`);
});

test('the CLI: where init writes the config itself (with a baseURL), it prints no baseURL hint', async () => {
  const cwd = project('no-config', { dependencies: { 'maplibre-gl': '^6.0.0' } });
  const { code, out } = await cli(cwd, 'init');
  expect(code, out).toBe(0);
  expect(readFileSync(join(cwd, 'playwright.config.js'), 'utf8')).toContain('use: { baseURL }');
  expect(out).not.toContain('relative to use.baseURL');
});

/** The value of a JavaScript string literal that init wrote, or what is wrong with it. */
function literal(text: string | undefined): unknown {
  try {
    return runInNewContext(`(${text})`);
  } catch (e) {
    return `not a string literal: ${text} (${(e as Error).message})`;
  }
}

/** The words a POSIX shell makes of the arguments on init's step-3 line, as the user pastes it. */
async function step3Args(out: string): Promise<string[]> {
  const args = /^3\. npx playwright test (.*?)   — /m.exec(out)?.[1];
  expect(args, out).toBeDefined();
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `printf '%s\\n' ${args}`]);
  return stdout.split('\n').slice(0, -1);
}

/**
 * Whether `npx playwright test <arg>` selects `file`. Playwright reads every file argument as a regular expression over
 * absolute paths (`new RegExp(arg, 'gi')`: forceRegExp in node_modules/playwright/lib/common/index.js; its --help says so).
 */
function playwrightSelects(arg: string, file: string): boolean {
  try {
    return new RegExp(arg, 'gi').test(file);
  } catch {
    return false; // Playwright stops with "Invalid regular expression"
  }
}

test('the CLI: a quote in --url and --dir, and regex characters in --dir, give files that parse and a step-3 command that finds the spec', async () => {
  // init pasted both values raw into single-quoted literals (a SyntaxError when Playwright loads the fixture or the
  // config), and step 3 printed the spec's path shell-quoted only, which Playwright reads as a regular expression:
  // `e2e (map)/map.spec.ts` gave "No tests found" (review finding E-4).
  const url = "/?name=o'brien&re=\\d";
  // the second directory holds what means something to a regex (+ [ ] * $), to String.replace ($&), and to the
  // /** */ comment of geowright.webgl, whose import line ends `…*/geowright.webgl.js'`
  for (const [name, dir] of [['quote-parens', "e2e's (map)"], ['regex-chars', 't+$&[1]*']]) {
    const cwd = project(name, { dependencies: { 'maplibre-gl': '^6.0.0' }, devDependencies: { typescript: '^5.9.0' } });
    const { code, out } = await cli(cwd, 'init', '--dir', dir, '--url', url);
    expect(code, out).toBe(0);
    const files = ['playwright.config.ts', ...['geowright.fixture.ts', 'geowright.webgl.ts', 'map.spec.ts'].map((f) => `${dir}/${f}`)];
    const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(cwd, f), 'utf8')]));
    // soft: one run shows every part that is wrong
    for (const f of files) expect.soft(() => transformSync(text[f], { loader: 'ts' }), `${dir}: ${f} parses`).not.toThrow();

    // each literal reads back as the value the user gave
    const goto = /await page\.goto\((.*)\);/.exec(text[`${dir}/geowright.fixture.ts`])?.[1];
    expect.soft(literal(goto), 'the fixture opens --url').toBe(url);
    const config = text['playwright.config.ts'];
    expect.soft(literal(/^import \{ WEBGL_SOFTWARE_FLAGS \} from (.*);$/m.exec(config)?.[1]), `${dir}: the config's import`).toBe(`./${dir}/geowright.webgl.js`);
    expect.soft(literal(/^ {2}testDir: (.*),$/m.exec(config)?.[1]), `${dir}: testDir`).toBe(`./${dir}`);
    // the line geowright.webgl's comment tells the user to copy imports the same file
    const commented = /^ \* {3}import \{ WEBGL_SOFTWARE_FLAGS \} from (.*);$/m.exec(text[`${dir}/geowright.webgl.ts`])?.[1];
    expect.soft(literal(commented), `${dir}: the import in geowright.webgl's comment`).toBe(`./${dir}/geowright.webgl.js`);

    // step 3, pasted into a shell, selects the spec init wrote
    const args = await step3Args(out);
    expect(args).toHaveLength(1);
    expect.soft(playwrightSelects(args[0], join(cwd, dir, 'map.spec.ts')), `${dir}: step 3 selects the spec with ${args[0]}`).toBe(true);
  }
});

test('the CLI: with an existing config, the import line step 2 prints for a --dir with a quote parses, and is the line in geowright.webgl', async () => {
  const cwd = project('has-config-quote', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': '// mine' });
  const { code, out } = await cli(cwd, 'init', '--dir', "e2e's");
  expect(code, out).toBe(0);
  const printed = /^ {5}(import \{ WEBGL_SOFTWARE_FLAGS \} from .*)$/m.exec(out)?.[1];
  expect(printed, out).toBeDefined();
  expect.soft(() => transformSync(printed!, { loader: 'ts' }), printed).not.toThrow();
  expect.soft(literal(/ from (.*);$/.exec(printed!)?.[1])).toBe(`./e2e's/geowright.webgl.js`);
  expect(readFileSync(join(cwd, "e2e's/geowright.webgl.js"), 'utf8')).toContain(` *   ${printed}`);
});

test('the CLI: a second run, and a config that already has the flags, are not told to add them again', async () => {
  // A second run told the user to add to "YOUR playwright.config" the two lines the first run had written there;
  // pasting them duplicates the import and the projects key (review finding E-7).
  const cwd = project('second-run', { dependencies: { 'maplibre-gl': '^6.0.0' } });
  const first = await cli(cwd, 'init');
  expect(first.code, first.out).toBe(0);
  const written = readFileSync(join(cwd, 'playwright.config.js'), 'utf8');
  const second = await cli(cwd, 'init');
  expect(second.code, second.out).toBe(0);
  const step2 = second.out.slice(second.out.indexOf('\n2. '), second.out.indexOf('\n3. '));
  expect.soft(step2).toContain('playwright.config.js already has the headless-WebGL launch flags (WEBGL_SOFTWARE_FLAGS): nothing to add.');
  expect.soft(step2).not.toContain('Add these two lines');
  expect.soft(step2).not.toContain('projects: [');
  expect(readFileSync(join(cwd, 'playwright.config.js'), 'utf8')).toBe(written);

  // the user's own config, with the two lines in it as step 2 asked: the same
  const pasted = SCAFFOLD_CONFIG.replace('\n', `\nimport { WEBGL_SOFTWARE_FLAGS } from './tests/geowright.webgl.js';\n`).replace(
    `use: { ...devices['Desktop Chrome'] } }]`,
    `use: { ...devices['Desktop Chrome'], launchOptions: { args: WEBGL_SOFTWARE_FLAGS } } }]`,
  );
  expect(pasted).toContain('launchOptions: { args: WEBGL_SOFTWARE_FLAGS }');
  const own = project('pasted-config', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.ts': pasted });
  const run = await cli(own, 'init');
  expect(run.code, run.out).toBe(0);
  const ownStep2 = run.out.slice(run.out.indexOf('\n2. '), run.out.indexOf('\n3. '));
  expect.soft(ownStep2).toContain('playwright.config.ts already has the headless-WebGL launch flags');
  expect.soft(ownStep2).not.toContain('Add these two lines');
  expect(readFileSync(join(own, 'playwright.config.ts'), 'utf8')).toBe(pasted);
});

/** A project with an existing Playwright config (a scaffold-like one whose `testDir`/`testMatch` lines are given), and its dirs. */
function configured(name: string, configLines: string, dirs: string[] = []): string {
  const projects = configLines.includes('projects:') ? '' : `\n  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],`;
  const config = `import { defineConfig, devices } from '@playwright/test';\nexport default defineConfig({\n${configLines}${projects}\n});\n`;
  const cwd = project(name, { dependencies: { 'maplibre-gl': '^6.0.0' }, devDependencies: { typescript: '^5.9.0' } }, { 'playwright.config.ts': config });
  for (const d of dirs) mkdirSync(join(cwd, d), { recursive: true });
  return cwd;
}

test('the CLI: with an existing config, init writes into its testDir, and step 2 and step 3 name that directory', async () => {
  // init took --dir, else e2e/ if it existed, else tests/, and never read the config: with testDir './tests/e2e' it wrote
  // tests/map.spec.ts, outside it, and step 3 as printed gave "No tests found" (review finding E-11).
  for (const [name, lines, dirs, expected] of [
    ['testdir-nested', `  testDir: './tests/e2e',`, ['tests/unit', 'tests/e2e'], 'tests/e2e'], // the Vue CLI layout
    ['testdir-not-e2e', `  testDir: './tests',`, ['e2e'], 'tests'], // an old Cypress e2e/ folder beside it
    ['testdir-plain', `  testDir: "specs",`, [], 'specs'],
    ['testdir-root', `  testDir: '.',`, [], 'tests'], // tests/ is inside it: the default stays
    ['testdir-commented', `  // testDir: './e2e',`, [], 'tests'], // a commented-out line is not read
  ] as const) {
    const cwd = configured(name, lines, [...dirs]);
    const { code, out } = await cli(cwd, 'init');
    expect(code, out).toBe(0);
    expect.soft(existsSync(join(cwd, expected, 'map.spec.ts')), `${name}: the spec is in ${expected}/\n${out}`).toBe(true);
    expect.soft(existsSync(join(cwd, expected, 'geowright.fixture.ts')), `${name}: the fixture is beside it`).toBe(true);
    if (expected !== 'tests') expect.soft(existsSync(join(cwd, 'tests/map.spec.ts')), `${name}: nothing in tests/`).toBe(false);
    expect.soft(out, `${name}: step 2's import`).toContain(`import { WEBGL_SOFTWARE_FLAGS } from './${expected}/geowright.webgl.js';`);
    const args = await step3Args(out);
    expect.soft(playwrightSelects(args[0], join(cwd, expected, 'map.spec.ts')), `${name}: step 3 selects ${expected}/map.spec.ts with ${args[0]}`).toBe(true);
    expect.soft(out, name).not.toContain('WARNING');
    expect.soft(out, name).not.toContain('note: playwright.config.ts');
  }
});

test('the CLI: a --dir outside the config\'s testDir, and a testMatch that map.spec does not match, are warned about', async () => {
  const run = async (name: string, lines: string, ...args: string[]) => {
    const { code, out } = await cli(configured(name, lines), 'init', ...args);
    expect(code, out).toBe(0);
    return out.slice(out.indexOf('\n3. '));
  };
  // --dir outside testDir: Playwright looks only in testDir
  const outside = await run('dir-outside', `  testDir: './tests/e2e',`, '--dir', 'tests');
  expect.soft(outside).toContain(`WARNING: playwright.config.ts has testDir './tests/e2e'`);
  expect.soft(outside).toContain('tests/map.spec.ts');
  expect.soft(outside).toContain('"No tests found"');
  expect.soft(outside).toContain('--dir tests/e2e');
  expect.soft(await run('dir-inside', `  testDir: './tests/e2e',`, '--dir', 'tests/e2e/maps')).not.toContain('WARNING');
  // a testDir per project: which one is a guess, so none is taken, and the warning names them all
  const perProject = await run('dir-per-project', `  projects: [{ name: 'setup', testDir: './setup' }, { name: 'e2e', testDir: './e2e' }],`);
  expect.soft(perProject).toContain(`WARNING: playwright.config.ts has testDir './setup', './e2e'`);
  expect.soft(perProject).toContain('--dir <one of them>');

  // testMatch: a glob or a regular expression that map.spec.ts does not match; one that it does (alone or in a list)
  for (const [name, testMatch, warned] of [
    ['match-e2e-glob', `'**/*.e2e.ts'`, true],
    ['match-e2e-regex', String.raw`/.*\.e2e\.ts$/`, true],
    ['match-dir-regex', String.raw`/\/e2e\//`, true], // its `//` is not a comment
    ['match-spec-glob', `'**/*.spec.ts'`, false],
    ['match-spec-regex', String.raw`/.*\.spec\.ts$/`, false],
    ['match-list', `['**/*.e2e.ts', '**/*.spec.ts']`, false],
  ] as const) {
    const step3 = await run(name, `  testDir: './tests',\n  testMatch: ${testMatch},`);
    if (warned) {
      expect.soft(step3, name).toContain(`WARNING: playwright.config.ts has testMatch ${testMatch}`);
      expect.soft(step3, name).toContain('tests/map.spec.ts');
      expect.soft(step3, name).toContain('"No tests found"');
    } else expect.soft(step3, name).not.toContain('WARNING');
  }

  // set in a form init does not read: said, not guessed
  const dirCode = await run('dir-code', `  testDir: path.join(__dirname, 'e2e'),`);
  expect.soft(dirCode).not.toContain('WARNING');
  expect.soft(dirCode).toContain('note: playwright.config.ts sets testDir in a form init does not read');
  expect.soft(dirCode).toContain('--dir');
  const matchCode = await run('match-code', `  testDir: './tests',\n  testMatch: E2E_FILES,`);
  expect.soft(matchCode).not.toContain('WARNING');
  expect.soft(matchCode).toContain('note: playwright.config.ts sets testMatch in a form init does not read');
});

/**
 * The projects in which Playwright itself (`playwright test --list`, run in the scratch project) collects `spec`: what
 * init says about testDir and testMatch is checked against Playwright, not against a second reading of the config. The
 * spec is first replaced by one that needs only @playwright/test (the fixture imports geowright, not installed there).
 */
async function collectedIn(cwd: string, spec: string): Promise<string[]> {
  writeFileSync(join(cwd, spec), `import { test } from '@playwright/test';\ntest('collected', () => {});\n`);
  // not this run's worker environment (TEST_WORKER_INDEX, PW_*, FORCE_COLOR): a plain `npx playwright test --list`
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_|PLAYWRIGHT_|FORCE_COLOR$)/.test(k)));
  const { stdout } = await promisify(execFile)(process.execPath, [join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--list'], {
    cwd,
    env: { ...env, NODE_PATH: join(ROOT, 'node_modules') },
  }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
  expect(stdout, 'Playwright listed the tests (or found none)').toMatch(/^Total: \d+ tests? in \d+ files?$/m);
  return [...stdout.matchAll(/^\s+(?:\[(.*)\] › )?\S*map\.spec\.[jt]s:\d+:\d+ › collected$/gm)].map((m) => m[1] ?? '');
}

/** A scratch project whose playwright.config.ts is `body` after the import of defineConfig and devices. */
function withConfig(name: string, body: string): string {
  const config = `import { defineConfig, devices } from '@playwright/test';\n${body}\n`;
  return project(name, { dependencies: { 'maplibre-gl': '^6.0.0' }, devDependencies: { typescript: '^5.9.0' } }, { 'playwright.config.ts': config });
}

const CHROMIUM = `{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }`;

test('the CLI: a testDir or testMatch that only some projects set is read per project, as Playwright reads it', async () => {
  // init read every `testDir:` and `testMatch:` in the config as if it applied to the whole config. A testMatch that only a
  // setup project sets (Playwright's auth and global-setup docs) gave a false "No tests found" WARNING whose advice moved
  // the spec out of the Chromium project; a testDir that only one project sets drew the files into it, where they ran in
  // that project too. Playwright takes each project's own value, else the config's, else its default (takeFirst in
  // node_modules/playwright/lib/common/index.js).
  for (const [name, body, dir, projects] of [
    // https://playwright.dev/docs/auth: only the setup project matches *.setup.ts; chromium keeps the default testMatch
    ['auth-setup', `export default defineConfig({\n  testDir: './tests',\n  projects: [{ name: 'setup', testMatch: /.*\\.setup\\.ts/ }, { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] }],\n});`, 'tests', ['chromium']],
    // https://playwright.dev/docs/test-global-setup-teardown: a setup and a teardown project, each with its own testMatch
    ['global-setup', `export default defineConfig({\n  testDir: './tests',\n  projects: [\n    { name: 'setup db', testMatch: /global\\.setup\\.ts/, teardown: 'cleanup db' },\n    { name: 'cleanup db', testMatch: /global\\.teardown\\.ts/ },\n    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup db'] },\n  ],\n});`, 'tests', ['chromium']],
    // one project with its own testDir: the others look in the config's directory, and tests/ is in it
    ['one-project-testdir', `export default defineConfig({\n  use: { baseURL: 'http://localhost:3000' },\n  projects: [{ name: 'api', testDir: './api', use: { baseURL: 'http://localhost:3000/api' } }, ${CHROMIUM}],\n});`, 'tests', ['chromium']],
    ['setup-testdir', `export default defineConfig({\n  projects: [{ name: 'setup', testDir: './setup', testMatch: /.*\\.setup\\.ts/ }, ${CHROMIUM}],\n});`, 'tests', ['chromium']],
    // the only project that would collect a map.spec looks in e2e/: init writes there
    ['setup-and-e2e', `export default defineConfig({\n  projects: [{ name: 'setup', testDir: './setup', testMatch: /.*\\.setup\\.ts/ }, { name: 'chromium', testDir: './e2e', use: { ...devices['Desktop Chrome'] } }],\n});`, 'e2e', ['chromium']],
  ] as const) {
    const cwd = withConfig(name, body);
    const { code, out } = await cli(cwd, 'init');
    expect(code, out).toBe(0);
    const spec = `${dir}/map.spec.ts`;
    expect.soft(existsSync(join(cwd, spec)), `${name}: the spec is ${spec}\n${out}`).toBe(true);
    expect.soft(out, name).toContain(`import { WEBGL_SOFTWARE_FLAGS } from './${dir}/geowright.webgl.js';`);
    expect.soft(out, name).toContain(`3. npx playwright test ${spec} `);
    expect.soft(out, name).not.toContain('WARNING');
    expect.soft(out, name).not.toContain('note: playwright.config.ts');
    if (dir === 'tests') expect.soft(out, name).not.toMatch(/^ {2}into /m);
    else expect.soft(out, name).toContain(`  into ${dir}/`);
    expect.soft(await collectedIn(cwd, spec), `${name}: Playwright collects ${spec} in`).toEqual(projects);
  }
});

test('the CLI: where no project would collect the spec, init warns, and where it cannot tell, says so', async () => {
  const step3 = (out: string) => out.slice(out.indexOf('\n3. '));
  // a config-wide testDir that every project overrides: tests/ is in none of them
  const overridden = withConfig('testdir-overridden', `export default defineConfig({\n  testDir: './tests',\n  projects: [{ name: 'a', testDir: './e2e' }, { name: 'b', testDir: './api' }],\n});`);
  const o = await cli(overridden, 'init');
  expect(o.code, o.out).toBe(0);
  expect.soft(step3(o.out)).toContain(`WARNING: playwright.config.ts has testDir './e2e', './api'`);
  expect.soft(step3(o.out)).toContain('"No tests found"');
  expect.soft(step3(o.out)).toContain('--dir <one of them>');
  expect.soft(await collectedIn(overridden, 'tests/map.spec.ts'), 'Playwright collects tests/map.spec.ts in').toEqual([]);

  // the only project's own testMatch: the warning stays
  const own = withConfig('project-testmatch', `export default defineConfig({\n  testDir: './tests',\n  projects: [{ name: 'chromium', testMatch: '**/*.e2e.ts', use: { ...devices['Desktop Chrome'] } }],\n});`);
  const m = await cli(own, 'init');
  expect(m.code, m.out).toBe(0);
  expect.soft(step3(m.out)).toContain(`WARNING: playwright.config.ts has testMatch '**/*.e2e.ts', which tests/map.spec.ts does not match`);
  expect.soft(await collectedIn(own, 'tests/map.spec.ts'), 'Playwright collects tests/map.spec.ts in').toEqual([]);

  // a project built with a spread: what it takes from the spread is not read, so neither a warning nor a guessed directory
  const spread = withConfig('project-spread', `const shared = { testDir: './e2e' };\nexport default defineConfig({\n  projects: [{ ...shared, name: 'chromium', use: { ...devices['Desktop Chrome'] } }],\n});`);
  const s = await cli(spread, 'init');
  expect(s.code, s.out).toBe(0);
  expect.soft(existsSync(join(spread, 'tests/map.spec.ts')), s.out).toBe(true);
  expect.soft(step3(s.out)).not.toContain('WARNING');
  expect.soft(step3(s.out)).toContain('note: playwright.config.ts builds a project in a form init does not read');
  expect.soft(await collectedIn(spread, 'tests/map.spec.ts'), 'Playwright collects tests/map.spec.ts in').toEqual([]);
});

test('the CLI: a testDir or testMatch init cannot see (a variable, a spread of the config, a second defineConfig argument) gets the note', async () => {
  // init read only `testDir: <literal>`, and took the config object as built from nothing else. `defineConfig({ testDir })`
  // (the shape playwright-bdd documents), `defineConfig({ ...base })` and `defineConfig(base, { … })` read as configs with
  // no testDir: init wrote tests/map.spec.ts without a word, and step 3 found no tests
  // (review finding E-11).
  const BASE = `export default { testDir: './e2e' };\n`;
  const step3 = (out: string) => out.slice(out.indexOf('\n3. '));
  const at = (name: string, body: string) =>
    project(name, { dependencies: { 'maplibre-gl': '^6.0.0' }, devDependencies: { typescript: '^5.9.0' } }, {
      'playwright.config.ts': `import { defineConfig, devices } from '@playwright/test';\n${body}\n`,
      'playwright.base.ts': BASE,
    });
  for (const [name, body, note] of [
    ['testdir-shorthand', `const testDir = './e2e';\nexport default defineConfig({ testDir, projects: [${CHROMIUM}] });`, 'sets testDir in a form init does not read'],
    ['testmatch-shorthand', `const testMatch = '**/*.e2e.ts';\nexport default defineConfig({ testDir: './tests', testMatch, projects: [${CHROMIUM}] });`, 'sets testMatch in a form init does not read'],
    ['config-spread', `import base from './playwright.base';\nexport default defineConfig({ ...base, projects: [${CHROMIUM}] });`, 'builds its config in a form init does not read'],
    // a key before the spread is replaced by the spread's
    ['config-spread-last', `import base from './playwright.base';\nexport default defineConfig({ testDir: './tests', ...base, projects: [${CHROMIUM}] });`, 'builds its config in a form init does not read'],
    ['config-arguments', `import base from './playwright.base';\nexport default defineConfig(base, { projects: [${CHROMIUM}] });`, 'builds its config in a form init does not read'],
    ['config-imported', `import config from './playwright.base';\nexport default config;`, 'builds its config in a form init does not read'],
  ] as const) {
    const cwd = at(name, body);
    const { code, out } = await cli(cwd, 'init');
    expect(code, out).toBe(0);
    expect.soft(existsSync(join(cwd, 'tests/map.spec.ts')), `${name}\n${out}`).toBe(true);
    expect.soft(step3(out), name).toContain(`note: playwright.config.ts ${note}`);
    expect.soft(step3(out), name).not.toContain('WARNING');
    expect.soft(await collectedIn(cwd, 'tests/map.spec.ts'), `${name}: Playwright collects tests/map.spec.ts in`).toEqual([]);
  }
  // a key after the spread, or in the last argument, replaces what comes before it: the files go into that testDir (a
  // testMatch may still come from the spread: said in the note)
  for (const [name, body, note] of [
    ['spread-then-testdir', `import base from './playwright.base';\nexport default defineConfig({ ...base, testDir: './specs', projects: [${CHROMIUM}] });`, true],
    ['arguments-testdir', `import base from './playwright.base';\nexport default defineConfig(base, { testDir: './specs', projects: [${CHROMIUM}] });`, true],
    ['typed-defineconfig', `export default defineConfig<{ mapUrl: string }>({ testDir: './specs', projects: [${CHROMIUM}] });`, false],
    ['exported-variable', `const config = { testDir: './specs', projects: [${CHROMIUM}] };\nexport default config;`, false],
    // a testDir in another object of the file is not the config's
    ['other-object', `export const apiConfig = { testDir: './api' };\nexport default defineConfig({ testDir: './specs', projects: [${CHROMIUM}] });`, false],
  ] as const) {
    const cwd = at(name, body);
    const { code, out } = await cli(cwd, 'init');
    expect(code, out).toBe(0);
    expect.soft(existsSync(join(cwd, 'specs/map.spec.ts')), `${name}\n${out}`).toBe(true);
    expect.soft(out, name).toContain('  into specs/');
    if (note) expect.soft(step3(out), name).toContain('note: playwright.config.ts builds its config in a form init does not read');
    else expect.soft(out, name).not.toContain('note: playwright.config.ts');
    expect.soft(out, name).not.toContain('WARNING');
    expect.soft(await collectedIn(cwd, 'specs/map.spec.ts'), `${name}: Playwright collects specs/map.spec.ts in`).toEqual(['chromium']);
  }
});

test('the CLI: a spec under a dot directory is found where Playwright finds it, and not warned about', async () => {
  // init matched globs with Node's path.matchesGlob, whose `*` and `**` never match a segment that starts with a dot;
  // Playwright's createFileMatcher passes minimatch `dot: true`. A spec in .e2e/ got a false "No tests found" WARNING, and
  // a testDir './.e2e' was never written into (review finding E-11).
  const step3 = (out: string) => out.slice(out.indexOf('\n3. '));
  const dotDir = configured('dot-testdir', `  testDir: './.e2e',`);
  const d = await cli(dotDir, 'init');
  expect(d.code, d.out).toBe(0);
  expect.soft(existsSync(join(dotDir, '.e2e/map.spec.ts')), d.out).toBe(true);
  expect.soft(d.out).toContain('  into .e2e/');
  expect.soft(step3(d.out)).not.toContain('WARNING');
  expect.soft(await collectedIn(dotDir, '.e2e/map.spec.ts'), 'Playwright collects .e2e/map.spec.ts in').toEqual(['chromium']);

  const nested = configured('dot-dir-flag', `  testDir: './tests',`);
  const n = await cli(nested, 'init', '--dir', 'tests/.maps');
  expect(n.code, n.out).toBe(0);
  expect.soft(step3(n.out)).not.toContain('WARNING');
  expect.soft(await collectedIn(nested, 'tests/.maps/map.spec.ts'), 'Playwright collects tests/.maps/map.spec.ts in').toEqual(['chromium']);

  // a testMatch that does not match the spec is still warned about there
  const e2eOnly = configured('dot-dir-testmatch', `  testDir: './.e2e',\n  testMatch: '**/*.e2e.ts',`);
  const m = await cli(e2eOnly, 'init', '--dir', '.e2e');
  expect(m.code, m.out).toBe(0);
  expect.soft(step3(m.out)).toContain(`WARNING: playwright.config.ts has testMatch '**/*.e2e.ts', which .e2e/map.spec.ts does not match`);
  expect.soft(await collectedIn(e2eOnly, '.e2e/map.spec.ts'), 'Playwright collects .e2e/map.spec.ts in').toEqual([]);
});

/** The config `npm init playwright` writes (its comments trimmed): three projects, and more commented out. */
const THREE_PROJECTS_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
  ],
});
`;

const FLAGS = ['--disable-gpu', '--enable-unsafe-swiftshader', '--enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes'];

type LaunchOptions = { args?: string[]; executablePath?: string; slowMo?: number };
type Use = { launchOptions?: LaunchOptions };
/** A playwright.config run as Playwright loads it (an object literal's last key wins), with the flags imported from `dir`. */
function loadConfig(config: string, dir: string): { use?: Use; projects?: { name: string; use?: Use }[] } {
  const modules: Record<string, unknown> = {
    '@playwright/test': { defineConfig: (c: object) => c, devices: { 'Desktop Chrome': {}, 'Desktop Firefox': {}, 'Desktop Safari': {} } },
    [`./${dir}/geowright.webgl.js`]: { WEBGL_SOFTWARE_FLAGS: FLAGS },
  };
  const module = { exports: {} as { default?: ReturnType<typeof loadConfig> } };
  runInNewContext(transformSync(config, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: (m: string) => modules[m] });
  return module.exports.default ?? {};
}

/** The projects a playwright.config defines, each with its launch args. */
function projectsOf(config: string, dir = 'tests'): { name: string; args?: string[] }[] {
  return (loadConfig(config, dir).projects ?? []).map((p) => ({ name: p.name, ...(p.use?.launchOptions?.args && { args: p.use.launchOptions.args }) }));
}

/**
 * Each project's launchOptions as the browser gets them: Playwright merges the config's `use` and the project's one level
 * deep (mergeObjects in node_modules/playwright/lib/common/index.js), so a project's launchOptions replaces the config's
 * whole. A config without projects is one project, named ''.
 */
function launchOf(config: string, dir = 'tests'): { name: string; launchOptions?: LaunchOptions }[] {
  const c = loadConfig(config, dir);
  return (c.projects ?? [{ name: '' }]).map((p) => ({ name: p.name, launchOptions: { ...c.use, ...p.use }.launchOptions }));
}

test('the CLI: a config with projects is told to add the flags to its Chromium project, not a second projects key', async () => {
  // Step 2 printed a whole `projects: [{ name: 'chromium', … }],` to add. Pasted after the config's own `projects`, it
  // replaced them: firefox and webkit stopped running, with no error. Pasted before, it was ignored: no project got the
  // flags (review finding E-12).
  expect(projectsOf(THREE_PROJECTS_CONFIG)).toEqual([{ name: 'chromium' }, { name: 'firefox' }, { name: 'webkit' }]);
  const cwd = project('three-projects', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': THREE_PROJECTS_CONFIG });
  const { code, out } = await cli(cwd, 'init');
  expect(code, out).toBe(0);
  const step2 = out.slice(out.indexOf('\n2. '), out.indexOf('\n3. '));
  expect.soft(step2, 'no second `projects` key').not.toContain('projects: [');
  expect.soft(step2).toContain('in the `use` of each Chromium project');
  // the lines to paste: indented by five, like every line init prints for copying
  const printed = step2.split('\n').filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim());
  expect(printed).toEqual([`import { WEBGL_SOFTWARE_FLAGS } from './tests/geowright.webgl.js';`, 'launchOptions: { args: WEBGL_SOFTWARE_FLAGS },']);

  // done as step 2 says, the config keeps its three projects and the Chromium one launches with the flags
  const followed = `${printed[0]}\n${THREE_PROJECTS_CONFIG}`.replace(`use: { ...devices['Desktop Chrome'] },`, `use: { ...devices['Desktop Chrome'], ${printed[1]} },`);
  expect(followed).toContain(printed[1]);
  expect(projectsOf(followed)).toEqual([{ name: 'chromium', args: FLAGS }, { name: 'firefox' }, { name: 'webkit' }]);

  // geowright.webgl's comment says the same, and keeps the `projects` line for a config without one
  const comment = readFileSync(join(cwd, 'tests/geowright.webgl.js'), 'utf8').split('*/')[0];
  expect.soft(comment).toContain('in the `use` of each Chromium project');
  expect.soft(comment).toContain(` *   ${printed[1]}`);
  expect.soft(comment).toContain('where the config has no `projects`');
  expect(readFileSync(join(cwd, 'playwright.config.js'), 'utf8')).toBe(THREE_PROJECTS_CONFIG);

  // a config without `projects` (only commented-out ones) still gets the whole `projects` line, and it works there
  const bare = `import { defineConfig, devices } from '@playwright/test';\nexport default defineConfig({\n  testDir: './tests',\n  // projects: [],\n});\n`;
  const plain = project('no-projects', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': bare });
  const run = await cli(plain, 'init');
  expect(run.code, run.out).toBe(0);
  const lines = run.out.slice(run.out.indexOf('\n2. '), run.out.indexOf('\n3. ')).split('\n').filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim());
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(/^projects: \[/);
  expect(projectsOf(`${lines[0]}\n${bare.replace(`  testDir: './tests',\n`, `  testDir: './tests',\n  ${lines[1]}\n`)}`)).toEqual([{ name: 'chromium', args: FLAGS }]);
});

test('the CLI: a config that imports the flags, or names them in a comment, but launches nothing with them is told what is missing', async () => {
  // "already has the headless-WebGL launch flags: nothing to add" was said wherever the config's TEXT named
  // WEBGL_SOFTWARE_FLAGS: the import alone (step 2 half done), or a comment. Headless Chromium then had no SwiftShader and
  // the map did not render (review finding E-7).
  const IMPORT = `import { WEBGL_SOFTWARE_FLAGS } from './tests/geowright.webgl.js';`;
  const step2Of = async (name: string, config: string) => {
    const cwd = project(name, { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': config });
    const { code, out } = await cli(cwd, 'init');
    expect(code, out).toBe(0);
    expect(readFileSync(join(cwd, 'playwright.config.js'), 'utf8')).toBe(config);
    const step2 = out.slice(out.indexOf('\n2. '), out.indexOf('\n3. '));
    return { step2, printed: step2.split('\n').filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim()) };
  };

  // the import pasted, launchOptions not yet: only launchOptions is printed, and adding it gives chromium the flags
  const imported = `${IMPORT}\n${THREE_PROJECTS_CONFIG}`;
  const half = await step2Of('flags-imported', imported);
  expect.soft(half.step2).not.toContain('nothing to add');
  expect.soft(half.step2).toContain('imports WEBGL_SOFTWARE_FLAGS');
  expect(half.printed).toEqual(['launchOptions: { args: WEBGL_SOFTWARE_FLAGS },']);
  const done = imported.replace(`use: { ...devices['Desktop Chrome'] },`, `use: { ...devices['Desktop Chrome'], ${half.printed[0]} },`);
  expect(projectsOf(done)).toEqual([{ name: 'chromium', args: FLAGS }, { name: 'firefox' }, { name: 'webkit' }]);

  // the same without `projects`: only the projects line
  const bare = `${IMPORT}\nimport { defineConfig, devices } from '@playwright/test';\nexport default defineConfig({\n  testDir: './tests',\n});\n`;
  const bareRun = await step2Of('flags-imported-no-projects', bare);
  expect.soft(bareRun.step2).not.toContain('nothing to add');
  expect(bareRun.printed).toHaveLength(1);
  expect(projectsOf(bare.replace(`  testDir: './tests',\n`, `  testDir: './tests',\n  ${bareRun.printed[0]}\n`))).toEqual([{ name: 'chromium', args: FLAGS }]);

  // named only in a comment: both lines, as for any config
  const commented = THREE_PROJECTS_CONFIG.replace('  projects: [', '  // TODO: wire WEBGL_SOFTWARE_FLAGS into chromium\n  projects: [');
  const todo = await step2Of('flags-in-comment', commented);
  expect.soft(todo.step2).not.toContain('nothing to add');
  expect(todo.printed).toEqual([IMPORT, 'launchOptions: { args: WEBGL_SOFTWARE_FLAGS },']);

  // launched with them inside a longer list: nothing to add
  const spread = `${IMPORT}\n${THREE_PROJECTS_CONFIG}`.replace(`use: { ...devices['Desktop Chrome'] },`, `use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--mute-audio', ...WEBGL_SOFTWARE_FLAGS] } },`);
  expect(projectsOf(spread)).toEqual([{ name: 'chromium', args: ['--mute-audio', ...FLAGS] }, { name: 'firefox' }, { name: 'webkit' }]);
  expect.soft((await step2Of('flags-spread', spread)).step2).toContain('playwright.config.js already has the headless-WebGL launch flags (WEBGL_SOFTWARE_FLAGS): nothing to add.');
});

test('the CLI: a config without projects gets the projects line, whatever its strings say', async () => {
  // Step 2 looked for the word `projects` anywhere in the config's code, strings included: a testDir under an Angular
  // workspace's projects/, or a report folder named projects, got the advice for a config WITH projects ("in the `use` of
  // each Chromium project"), which this one cannot follow, and not the `projects` line it needs
  // (review finding E-12).
  const config = `import { defineConfig, devices } from '@playwright/test';\nexport default defineConfig({\n  testDir: './projects/map-app/e2e',\n  reporter: [['html', { outputFolder: 'reports/projects' }]],\n  use: { baseURL: 'http://localhost:4200', ...devices['Desktop Chrome'] },\n});\n`;
  const cwd = project('workspace-projects', { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': config });
  const { code, out } = await cli(cwd, 'init');
  expect(code, out).toBe(0);
  const step2 = out.slice(out.indexOf('\n2. '), out.indexOf('\n3. '));
  expect.soft(step2).not.toContain('each Chromium project');
  const printed = step2.split('\n').filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim());
  expect(printed).toEqual([`import { WEBGL_SOFTWARE_FLAGS } from './projects/map-app/e2e/geowright.webgl.js';`, expect.stringMatching(/^projects: \[/)]);
  const followed = `${printed[0]}\n${config.replace(`  testDir: './projects/map-app/e2e',\n`, `  testDir: './projects/map-app/e2e',\n  ${printed[1]}\n`)}`;
  expect(projectsOf(followed, 'projects/map-app/e2e')).toEqual([{ name: 'chromium', args: FLAGS }]);
});

test('the CLI: where a `use` has launchOptions already, init says to put the flags in them, not a second launchOptions', async () => {
  // The advice for a config with projects, `launchOptions: { args: WEBGL_SOFTWARE_FLAGS }` in the Chromium project's `use`,
  // gave a second launchOptions where that `use` had one: the later key wins, so the flags or the project's own args were
  // dropped, with no error. And Playwright merges `use` one level deep: a project's launchOptions replaces the config's
  // whole, so the `projects` line given to a config without projects dropped the launchOptions of its `use`
  // (review finding E-12).
  const IMPORT = `import { WEBGL_SOFTWARE_FLAGS } from './tests/geowright.webgl.js';`;
  const CHROME_USE = `use: { ...devices['Desktop Chrome'] },`;
  const step2Of = async (name: string, config: string) => {
    const cwd = project(name, { dependencies: { 'maplibre-gl': '^6.0.0' } }, { 'playwright.config.js': config });
    const { code, out } = await cli(cwd, 'init');
    expect(code, out).toBe(0);
    const step2 = out.slice(out.indexOf('\n2. '), out.indexOf('\n3. '));
    return { step2, printed: step2.split('\n').filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim()) };
  };
  const OWN_USE = "playwright.config.js's own `use` has launchOptions";

  // the Chromium project's launchOptions has args: the flags go at the end of them
  const ANGLE = ['--use-gl=angle', '--ignore-gpu-blocklist'];
  const angle = THREE_PROJECTS_CONFIG.replace(CHROME_USE, `use: { ...devices['Desktop Chrome'], launchOptions: { args: ${JSON.stringify(ANGLE)} } },`);
  const a = await step2Of('launch-options-args', angle);
  expect.soft(a.step2).not.toContain(OWN_USE);
  const atTheEnd = /`(\.\.\.WEBGL_SOFTWARE_FLAGS),?` at the end of its args/.exec(a.step2)?.[1];
  expect(atTheEnd, a.step2).toBe('...WEBGL_SOFTWARE_FLAGS');
  const followedA = `${a.printed[0]}\n${angle.replace(`${JSON.stringify(ANGLE).slice(0, -1)}]`, `${JSON.stringify(ANGLE).slice(0, -1)}, ${atTheEnd}]`)}`;
  expect(projectsOf(followedA)).toEqual([{ name: 'chromium', args: [...ANGLE, ...FLAGS] }, { name: 'firefox' }, { name: 'webkit' }]);
  expect.soft((await step2Of('launch-options-args-done', followedA)).step2).toContain('already has the headless-WebGL launch flags');

  // its launchOptions has no args: `args: WEBGL_SOFTWARE_FLAGS` goes in them
  const slow = THREE_PROJECTS_CONFIG.replace(CHROME_USE, `use: { ...devices['Desktop Chrome'], launchOptions: { slowMo: 50 } },`);
  const b = await step2Of('launch-options-no-args', slow);
  const inIt = /`(args: WEBGL_SOFTWARE_FLAGS),?` in it/.exec(b.step2)?.[1];
  expect(inIt, b.step2).toBe('args: WEBGL_SOFTWARE_FLAGS');
  expect(launchOf(`${b.printed[0]}\n${slow.replace('slowMo: 50 }', `slowMo: 50, ${inIt} }`)}`)[0]).toEqual({ name: 'chromium', launchOptions: { slowMo: 50, args: FLAGS } });

  // no projects, and the config's `use` has launchOptions: the flags go in them (a `projects` line would replace them)
  const exe = `import { defineConfig } from '@playwright/test';\nexport default defineConfig({\n  testDir: './tests',\n  use: { baseURL: 'http://localhost:3000', launchOptions: { executablePath: '/opt/chrome' } },\n});\n`;
  const c = await step2Of('config-launch-options', exe);
  expect.soft(c.step2).not.toContain('projects: [');
  expect(c.printed).toEqual([IMPORT, 'args: WEBGL_SOFTWARE_FLAGS,']);
  const followedC = `${c.printed[0]}\n${exe.replace(`executablePath: '/opt/chrome' }`, `executablePath: '/opt/chrome', ${c.printed[1]} }`)}`;
  expect(launchOf(followedC)).toEqual([{ name: '', launchOptions: { executablePath: '/opt/chrome', args: FLAGS } }]);
  expect.soft((await step2Of('config-launch-options-done', followedC)).step2).toContain('already has the headless-WebGL launch flags');

  // projects, and the config's own `use` has launchOptions: a project's launchOptions replaces them whole, and init says so
  const both = THREE_PROJECTS_CONFIG.replace(`    trace: 'on-first-retry',\n`, `    trace: 'on-first-retry',\n    launchOptions: { executablePath: '/opt/chrome' },\n`);
  const d = await step2Of('config-and-project-launch-options', both);
  expect.soft(d.step2).toContain(OWN_USE);
  expect(d.printed).toEqual([IMPORT, 'launchOptions: { args: WEBGL_SOFTWARE_FLAGS },']);
  // what that line says: pasted as it is, the Chromium project loses the config's executablePath
  const pasted = `${d.printed[0]}\n${both.replace(CHROME_USE, `use: { ...devices['Desktop Chrome'], ${d.printed[1]} },`)}`;
  expect(launchOf(pasted)[0]).toEqual({ name: 'chromium', launchOptions: { args: FLAGS } });
});

test('init checks effective flags for every Chromium project, ignoring unused objects', () => {
  const flags = `launchOptions: { args: WEBGL_SOFTWARE_FLAGS }`;
  const cases: [string, string, boolean][] = [
    ['partial', `projects: [{ use: { ${flags} } }, { use: { browserName: 'chromium' } }]`, false],
    ['unused', `projects: [{ use: { browserName: 'chromium' } }]`, false],
    ['override', `use: { ${flags} }, projects: [{}, { use: { launchOptions: { args: [] } } }]`, false],
    ['inherited', `use: { ${flags} }, projects: [{}, { use: { browserName: 'chromium' } }]`, true],
    ['all', `projects: [{ use: { ${flags} } }, { use: { ${flags} } }]`, true],
    ['other-browser', `projects: [{ use: { ${flags} } }, { use: { browserName: 'firefox' } }]`, true],
    ['nested-unused', `use: { contextOptions: { ${flags} } }`, false],
    ['spread-args', `use: { launchOptions: { args: ['--other', ...WEBGL_SOFTWARE_FLAGS] } }`, true],
    ['unknown-spread', `use: { ${flags}, ...customUse }`, false],
    ['quoted-keys', `use: { 'launchOptions': { 'args': WEBGL_SOFTWARE_FLAGS } }`, true],
    ['device-override', `use: { ${flags} }, projects: [{ use: { ...devices['Desktop Chrome'] } }, { use: { ...devices['Desktop Chrome'], launchOptions: { args: [] } } }]`, false],
    ['device-firefox', `projects: [{ use: { ${flags} } }, { use: { ...devices['Desktop Firefox'] } }]`, true],
    ['overwritten', `use: { ${flags}, launchOptions: { args: [] } }`, false],
  ];
  for (const [name, properties, ready] of cases) {
    const cwd = withConfig(`effective-${name}`, `const unused = { ${flags} };\nexport default defineConfig({ ${properties} });`);
    const lines: string[] = [];
    init({ cwd, log: (line) => lines.push(line) });
    expect(lines.join('\n').includes('nothing to add'), name).toBe(ready);
  }
});

test('init treats escaped config literals as unreadable rather than guessing a directory or match', () => {
  for (const [name, property] of [
    ['hex', String.raw`testDir: 'tests\x2fe2e'`],
    ['windows', String.raw`testDir: 'tests\\e2e'`],
    ['match', String.raw`testDir: './tests', testMatch: '**/map\x2espec.ts'`],
  ]) {
    const cwd = withConfig(`escaped-${name}`, `export default defineConfig({ ${property} });`);
    const lines: string[] = [];
    const result = init({ cwd, log: (line) => lines.push(line) });
    expect(result.written).toContain('tests/map.spec.ts');
    expect(lines.join('\n')).toContain(`sets ${name === 'match' ? 'testMatch' : 'testDir'} in a form init does not read`);
    expect(lines.join('\n')).not.toContain('WARNING');
  }
});
