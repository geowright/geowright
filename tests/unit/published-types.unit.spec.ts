import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
