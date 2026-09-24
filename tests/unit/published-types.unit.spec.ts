import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
 * are not public API (decision on an earlier issue): `stripInternal` keeps them out of the emitted typings. Emits the typings for real
 * (into a temp dir) and reads what a user's editor would see.
 */
test('@internal members are stripped from the emitted typings; the public API is still there', () => {
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const out = mkdtempSync(join(tmpdir(), 'geowright-types-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', out], { cwd: ROOT, encoding: 'utf8' });
    const index = readFileSync(join(out, 'playwright/index.d.ts'), 'utf8');
    const types = readFileSync(join(out, 'inpage/types.d.ts'), 'utf8');
    const stripped = ['_find', '_explain', '_attachFailureScreenshot', '_callBy', '_call', '_retry', '_overlays', '_drag', '_pointAt', '_pointNow', '_withActionPoint', '_findChecked', '_disarm'];
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
