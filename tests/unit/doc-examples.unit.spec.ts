import { test, expect } from '@playwright/test';
import { extractBlocks, generate, markdownLine } from '../docs/examples';

/** The rules of the doc-example check (tests/docs/examples.ts) on small Markdown inputs. */
const md = (...lines: string[]) => lines.join('\n');

test('fences: languages decide what runs; skip markers need a reason; untagged fences and bare jsx are refused', () => {
  const problems: string[] = [];
  const blocks = extractBlocks(
    'X.md',
    md(
      '# Title', //                                              1
      '```ts', //                                                2  runs
      'await map.waitForIdle();',
      '```',
      '<!-- example: skip (app-side) -->', //                    5
      '```ts', //                                                6  skipped, with its reason
      'const map = new maplibregl.Map({ … });',
      '```',
      '```sh', //                                                9  not an example
      'npm i',
      '```',
      '```', //                                                 12  untagged: refused
      'output',
      '```',
      '```jsx', //                                              15  app-side markup without a marker: refused
      '<Map />',
      '```',
      '<!-- example: skip -->', //                              18  no reason: refused
      '```ts',
      'x',
      '```',
      '<!-- example: skip (stray) -->', //                      22  not before a fence: refused
      'prose',
    ),
    problems,
  );
  expect(blocks.map((b) => [b.line, b.lang, b.skip])).toEqual([
    [2, 'ts', undefined],
    [6, 'ts', 'app-side'],
    [9, 'sh', undefined],
    [12, '', undefined],
    [15, 'jsx', undefined],
    [19, 'ts', undefined],
  ]);
  expect(blocks[0].heading).toBe('Title');
  expect(problems).toEqual([
    expect.stringMatching(/^X\.md:12: a code fence without a language/),
    expect.stringMatching(/^X\.md:15: a `jsx` block cannot run as a test/),
    expect.stringMatching(/^X\.md:18: an example marker must read <!-- example: skip \(reason\) -->/),
    expect.stringMatching(/^X\.md:22: an example marker must be on the line right before a code fence/),
  ]);
});

test('generated module: package imports resolve to the source, imports and test.use are hoisted, lines map back', () => {
  const [block] = extractBlocks(
    'README.md',
    md(
      '```ts', //                                                           1
      "import { geowright, expect } from 'geowright';", //                  2
      "import { routeVectorTiles } from 'geowright/tiles';", //             3
      'test.use({ hasTouch: true });', //                                   4
      'const map = geowright(page);', //                                    5
      'await map.waitForIdle();', //                                        6
      '```',
    ),
    [],
  );
  const example = generate(block, 'README.L1.ts');
  const lines = example.source.split('\n');
  const at = (text: string) => lines.findIndex((l) => l.includes(text)) + 1;
  expect(example.source).not.toMatch(/from 'geowright/); // package specifiers -> the files package.json exports
  expect(example.source).toContain("import { geowright, expect } from '../../../src/playwright/index';");
  expect(example.source).toContain("import { routeVectorTiles } from '../../../src/playwright/tiles';");
  // the example imports `expect` itself, so the prelude does not
  expect(example.source).toContain("import { test, buildingsGeoJSON } from '../prelude';");
  expect(at('test.use(')).toBeLessThan(at("test('runs'")); // describe level, not inside the test
  expect(markdownLine(example, at('waitForIdle'))).toBe(6);
  expect(markdownLine(example, at('test.use('))).toBe(4);
  expect(markdownLine(example, at('src/playwright/tiles'))).toBe(3);
});

test('generated module: a multi-line import is refused with its Markdown line', () => {
  const [block] = extractBlocks('README.md', md('```ts', 'import {', '  geowright,', "} from 'geowright';", '```'), []);
  expect(() => generate(block, 'README.L1.ts')).toThrow(/^README\.md:2: keep an example's import on one line/);
});
