import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { GENERATED, ROOT, generateExamples, markdownLocation } from './examples';

/**
 * Every ts/js code block of README.md and docs/RECIPES.md compiles against the package's real API and runs
 * against the demo app. How a block becomes a test, and how to mark one that cannot: tests/docs/examples.ts.
 */
const { examples, skipped, problems } = generateExamples();

test('doc examples: every fence has a language, every marker a reason', () => {
  expect(problems, 'rules: tests/docs/examples.ts').toEqual([]);
});

test('doc examples: every one type-checks against the real API', async () => {
  // one tsc run over the generated examples and everything they import: well under a second on a laptop
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const run = await promisify(execFile)(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', join(ROOT, 'tests/docs/tsconfig.json')], { cwd: ROOT })
    .then(() => ({ stdout: '' }), (e: { stdout?: string; stderr?: string; message: string }) => ({ stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message }));
  const errors = run.stdout
    .split('\n')
    .map((line) => {
      const m = /^(.*?)\((\d+),(\d+)\): (error .*)$/.exec(line);
      if (!m) return line;
      const where = /\.generated[/\\]/.test(m[1]) ? markdownLocation(m[1], Number(m[2])) : undefined;
      return where ? `${where}: ${m[4]}` : line;
    })
    .filter((l) => l.trim());
  expect(errors, `doc examples that do not compile (generated code: ${GENERATED})`).toEqual([]);
});

for (const block of skipped) {
  test(`${block.doc}:${block.line}${block.heading ? ` (${block.heading})` : ''}`, () => {
    test.skip(true, `example: skip (${block.skip})`);
  });
}

for (const example of examples) {
  // The generated module declares its own describe block and test (see examples.ts: generate()).
  await import(pathToFileURL(join(GENERATED, example.file)).href).catch((e: Error) => {
    // a syntax error reads "…/.generated/README.L77.ts: Missing semicolon. (9:27)"
    const loc = e.message.includes(example.file) ? /\((\d+):\d+\)/.exec(e.message) : null;
    const where = markdownLocation(example.file, loc ? Number(loc[1]) : 0);
    test(`${example.doc}:${example.line} (does not load)`, () => {
      throw new Error(`doc example ${where}: ${e.message}`);
    });
  });
}
