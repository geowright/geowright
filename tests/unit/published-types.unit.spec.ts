import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published typings (`npm run build:types`, tsconfig.build.json) are made from every source file in that program.
 * What is internal until 1.0 lives in src/inpage/types-internal.ts, so it must stay out of the program, and its names
 * out of every file in it.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INTERNAL = ['StyleCause', 'StyleBranch', 'InternalCanvasAdapter', 'explainInvisible', 'explainLayerHidden'];

test('internal adapter-seam additions are not in the published typings program', () => {
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const listed = execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--listFilesOnly'], { cwd: ROOT, encoding: 'utf8' });
  const ours = listed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('node_modules'))
    .map((l) => relative(ROOT, l));
  expect(ours).toContain('src/inpage/types.ts'); // the list is real
  expect(ours).not.toContain('src/inpage/types-internal.ts');
  for (const file of ours) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(INTERNAL.filter((name) => new RegExp(`\\b${name}\\b`).test(source)), file).toEqual([]);
  }
});

/**
 * Members tagged `@internal` in the published sources (the MapHandle / FeatureHandle plumbing, `ActionPointOptions.leadMs`)
 * are not public API: `stripInternal` keeps them out of the emitted typings. Emits the typings for real
 * (into a temp dir) and reads what a user's editor would see.
 */
test('@internal members are stripped from the emitted typings; the public API is still there', () => {
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const out = mkdtempSync(join(tmpdir(), 'geowright-types-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', out], { cwd: ROOT, encoding: 'utf8' });
    const index = readFileSync(join(out, 'playwright/index.d.ts'), 'utf8');
    const types = readFileSync(join(out, 'inpage/types.d.ts'), 'utf8');
    const stripped = ['_find', '_explain', '_attachFailureScreenshot', '_callBy', '_call', '_retry', '_overlays', '_drag', '_pointAt', '_pointNow', '_withActionPoint', '_findChecked', '_disarm', '_answerBy'];
    expect(stripped.filter((m) => new RegExp(`^\\s+(async )?${m}\\b`, 'm').test(index))).toEqual([]);
    expect(types).not.toMatch(/\bleadMs\b/);
    expect(index).not.toMatch(/\bleadMs\b/); // nor via a private helper class a stripped member used to reference
    // the public API is untouched
    for (const pub of ['export declare function geowright', 'waitForIdle(', 'snapshot(', 'toBeVisibleOnMap']) expect(index).toContain(pub);
    // the published typings refuse `moving` on dragTo / dragBy / lngLat (tests/moving.spec.ts has the @ts-expect-error uses)
    expect(index).toMatch(/type SteadyActionOptions = Omit<ActionOptions, 'moving'> & \{\s*moving\?: never;?\s*\}/);
    for (const m of ['dragTo', 'dragBy', 'lngLat']) expect(index).toMatch(new RegExp(`${m}\\([^)]*opts\\?: SteadyActionOptions`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/**
 * `expect` is typed from '@playwright/test', the one package a user is told to install: an inferred type
 * named `import("playwright/test")`, which is not resolvable from node_modules/geowright under pnpm (hoist=false) or
 * Yarn PnP — and then, under skipLibCheck, `expect` from 'geowright' silently became `any`. Every type a public
 * signature names can be imported from 'geowright'. Resolvers that do not read `exports` (TypeScript's node10)
 * still find the typings of 'geowright', 'geowright/tiles' and 'geowright/app'.
 */
test('published typings: `expect` typed from @playwright/test, the signature types exported, a node10 fallback', () => {
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const out = mkdtempSync(join(tmpdir(), 'geowright-types-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', out], { cwd: ROOT, encoding: 'utf8' });
    const index = readFileSync(join(out, 'playwright/index.d.ts'), 'utf8');
    const tiles = readFileSync(join(out, 'playwright/tiles.d.ts'), 'utf8');
    for (const [file, dts] of [['index.d.ts', index], ['tiles.d.ts', tiles]]) {
      expect(dts.match(/import\(["']playwright[/"'][^)]*\)/g) ?? [], `${file} names the 'playwright' package`).toEqual([]);
      expect(dts, file).not.toMatch(/from ["']playwright[/"']/);
    }
    expect(index).toMatch(/export declare const expect: Expect</);

    // Everything the typings take from the internal types module is exported under the same name — except the wire
    // formats, whose public faces are the binding's own FeatureQuery / FeatureSummary.
    const imported = index.match(/import type \{([^}]*)\} from ["']\.\.\/inpage\/types\.js["']/)?.[1] ?? '';
    const names = imported.split(',').map((s) => s.trim()).filter((s) => s && !/ as Wire(Query|Summary)$/.test(s));
    expect(names.length).toBeGreaterThan(3); // the list is real
    const exported = new Set([...index.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())));
    for (const m of index.matchAll(/export (?:declare )?(?:interface|type|class|const|function) (\w+)/g)) exported.add(m[1]);
    expect(names.filter((n) => !exported.has(n)), 'named in a public signature, not importable from geowright').toEqual([]);
    for (const t of ['LayerInfo', 'SnapshotOptions', 'WhereValue', 'ActionPointOptions', 'Pt', 'GeowrightMatchers']) expect([...exported]).toContain(t);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.types).toBe(pkg.exports['.'].types);
  const map = pkg.typesVersions?.['*'] ?? {};
  expect(map.tiles).toEqual([pkg.exports['./tiles'].types.replace(/^\.\//, '')]);
  expect(map.app).toEqual([pkg.exports['./app'].types.replace(/^\.\//, '')]);
});

/**
 * As a user meets it: geowright installed the way pnpm (hoist=false) or Yarn PnP lay it out — only
 * '@playwright/test' resolvable from it, not the `playwright` package behind it. `expect` from 'geowright' must still be
 * typed (it used to be `any` under skipLibCheck: no matcher types, no floating-promise lint).
 */
test('`expect` from geowright keeps its type where only @playwright/test is resolvable', () => {
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const dir = mkdtempSync(join(tmpdir(), 'geowright-consumer-'));
  try {
    const pkg = join(dir, 'node_modules/geowright');
    mkdirSync(join(dir, 'node_modules/@playwright'), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));
    execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', join(pkg, 'dist/types')], { cwd: ROOT, encoding: 'utf8' });
    // The real @playwright/test: its own `playwright` resolves from where it really is; geowright's does not.
    symlinkSync(join(ROOT, 'node_modules/@playwright/test'), join(dir, 'node_modules/@playwright/test'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }),
    );
    writeFileSync(
      join(dir, 'spec.ts'),
      [
        `import { expect, geowright, type LayerInfo, type SnapshotOptions, type WhereValue, type ActionPointOptions, type Pt } from 'geowright';`,
        `declare const map: ReturnType<typeof geowright>;`,
        `export const ok: Promise<void> = expect(map).toHaveFeature({ layer: 'alerts' });`,
        `export const types: [LayerInfo?, SnapshotOptions?, WhereValue?, ActionPointOptions?, Pt?] = [];`,
        `export const notAny: number = expect; // must NOT compile: expect is not any`,
        '',
      ].join('\n'),
    );
    const out = (() => {
      try {
        return execFileSync(process.execPath, [tsc, '-p', dir, '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
      } catch (e) {
        return String((e as { stdout?: string }).stdout ?? e);
      }
    })();
    const errors = out.split('\n').filter((l) => /error TS/.test(l));
    expect(errors.length, out).toBe(1);
    expect(errors[0]).toMatch(/spec\.ts\(5,\d+\): error TS2322/); // only the line that must fail
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
