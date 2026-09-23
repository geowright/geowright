/**
 * Docs you can trust: every TypeScript / JavaScript code block in README.md and docs/RECIPES.md is a test.
 *
 * `examples.spec.ts` calls `generateExamples()`, which writes one module per runnable block into
 * `tests/docs/.generated/` (git-ignored; TypeScript's `tests` glob skips dot-directories, so `npm run typecheck`
 * never sees a stale copy). That spec then type-checks those modules with `tsc` and runs them as Playwright tests.
 *
 * The rules, all visible in the Markdown source:
 *  - A fence tagged ts / typescript / js / javascript / mjs is an example: it runs as the BODY of a test, with the
 *    names of `tests/docs/prelude.ts` in scope (`page`: the demo app, loaded; `map`: geowright(page), idle;
 *    `expect`; `test`; `buildingsGeoJSON`). Anything else it uses, it declares or imports itself.
 *  - `import … from 'geowright'` / `'geowright/tiles'` is resolved through package.json `exports` to the source file
 *    the published typings are built from. Top-level `import` lines and `test.use(…)` lines are hoisted out of the
 *    test body (module level / the example's describe block), where TypeScript and Playwright require them.
 *  - tsx / jsx fences (app-side component code) cannot run here and must carry a skip marker. Other languages
 *    (sh, text, svelte, vue, …) are not examples. A fence without a language is an error: tag it.
 *  - `<!-- example: skip (reason) -->` on the line before a fence skips it. The reason is required.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const GENERATED = fileURLToPath(new URL('./.generated/', import.meta.url));
/** The Markdown files whose examples are tests (paths relative to the repository root). */
export const DOCS = ['README.md', 'docs/RECIPES.md'];

const RUNNABLE = new Set(['ts', 'typescript', 'js', 'javascript', 'mjs']);
const APP_SIDE = new Set(['tsx', 'jsx']);
/** The prelude's exports (tests/docs/prelude.ts), imported into every example that does not import the name itself; the test destructures `page` and `map`. */
const PRELUDE = ['test', 'expect', 'buildingsGeoJSON'];

export interface Block {
  /** repository-relative Markdown path, e.g. `README.md` */
  doc: string;
  /** 1-based line of the opening fence */
  line: number;
  lang: string;
  heading: string;
  /** the code, one entry per line; `lines[i]` is Markdown line `line + 1 + i` */
  lines: string[];
  skip?: string;
}

export interface Example extends Block {
  /** file name inside `.generated/` */
  file: string;
  /** the generated module */
  source: string;
  /** generated line (1-based) -> Markdown line */
  map: Map<number, number>;
}

export class DocExampleError extends Error {}

/** Every fenced block of a Markdown file, with its marker. Malformed markers and untagged fences go to `problems`. */
export function extractBlocks(doc: string, text: string, problems: string[]): Block[] {
  const src = text.split('\n');
  const blocks: Block[] = [];
  let heading = '';
  let pendingMarker: { line: number; skip: string } | undefined;
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) heading = h[1].replace(/`/g, '').trim();
    const marker = /^\s*<!--\s*example:(.*?)-->\s*$/.exec(l);
    if (marker) {
      const m = /^\s*skip\s*\((.+)\)\s*$/.exec(marker[1]);
      if (!m || !m[1].trim()) problems.push(`${doc}:${i + 1}: an example marker must read <!-- example: skip (reason) -->; got: ${l.trim()}`);
      else pendingMarker = { line: i + 1, skip: m[1].trim() };
      continue;
    }
    const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(l);
    if (!open) {
      if (pendingMarker && l.trim()) {
        problems.push(`${doc}:${pendingMarker.line}: an example marker must be on the line right before a code fence`);
        pendingMarker = undefined;
      }
      continue;
    }
    const [, indent, fence, lang] = open;
    const start = i;
    const lines: string[] = [];
    for (i++; i < src.length; i++) {
      const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (close.test(src[i])) break;
      lines.push(src[i].startsWith(indent) ? src[i].slice(indent.length) : src[i]);
    }
    if (i >= src.length) problems.push(`${doc}:${start + 1}: code fence is never closed`);
    if (!lang) problems.push(`${doc}:${start + 1}: a code fence without a language; tag it (ts, sh, text, …) so the example check knows whether it is code to run`);
    const block: Block = { doc, line: start + 1, lang: lang.toLowerCase(), heading, lines };
    if (pendingMarker) {
      if (!RUNNABLE.has(block.lang) && !APP_SIDE.has(block.lang))
        problems.push(`${doc}:${pendingMarker.line}: a skip marker on a \`${lang || 'untagged'}\` block, which is not an example anyway; remove the marker`);
      block.skip = pendingMarker.skip;
      pendingMarker = undefined;
    } else if (APP_SIDE.has(block.lang)) {
      problems.push(`${doc}:${start + 1}: a \`${lang}\` block cannot run as a test; mark it <!-- example: skip (reason) -->`);
    }
    blocks.push(block);
  }
  if (pendingMarker) problems.push(`${doc}:${pendingMarker.line}: an example marker must be on the line right before a code fence`);
  return blocks;
}

/** `'geowright'` -> the source file its published typings are built from, via package.json `exports`. */
function packageEntries(): Map<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string | { types?: string }> };
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(pkg.exports)) {
    const types = typeof value === 'object' ? value.types : undefined;
    if (!types) continue;
    const m = /^\.\/dist\/types\/(.+)\.d\.ts$/.exec(types);
    if (!m) continue;
    const source = join(ROOT, 'src', `${m[1]}.ts`);
    if (!existsSync(source)) throw new DocExampleError(`package.json exports["${key}"] types ${types}: no source file ${relative(ROOT, source)}`);
    out.set(key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`, source);
  }
  return out;
}

function importPath(fromDir: string, file: string): string {
  const rel = relative(fromDir, file).split(sep).join('/').replace(/\.ts$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const SINGLE_LINE_IMPORT = /^import\s+(type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+))?\s*(?:from\s+)?(['"])([^'"]+)\5\s*;?\s*(\/\/.*)?$/;

/** The generated module for one example, and its line map. */
export function generate(block: Block, file: string, entries = packageEntries()): Example {
  const out: string[] = [];
  const map = new Map<number, number>();
  const emit = (text: string, mdLine?: number) => {
    out.push(text);
    if (mdLine) map.set(out.length, mdLine);
  };
  const mdLine = (i: number) => block.line + 1 + i;

  const imports: { text: string; md: number }[] = [];
  const uses: { text: string; md: number }[] = [];
  const body: { text: string; md: number }[] = [];
  const importedNames = new Set<string>();
  block.lines.forEach((text, i) => {
    if (/^import[\s{*]/.test(text)) {
      const m = SINGLE_LINE_IMPORT.exec(text);
      if (!m) throw new DocExampleError(`${block.doc}:${mdLine(i)}: keep an example's import on one line (the check hoists it out of the test body): ${text}`);
      const [, , def, named, ns, q, spec] = m;
      if (def) importedNames.add(def);
      if (ns) importedNames.add(ns);
      for (const n of (named ?? '').split(',')) {
        const local = n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
        if (local) importedNames.add(local);
      }
      const target = entries.get(spec);
      const rewritten = target ? text.replace(`${q}${spec}${q}`, `${q}${importPath(GENERATED, target)}${q}`) : text;
      imports.push({ text: rewritten, md: mdLine(i) });
    } else if (/^test\.use\(.*\);?\s*(\/\/.*)?$/.test(text)) {
      uses.push({ text: `  ${text}`, md: mdLine(i) });
    } else {
      body.push({ text: `      ${text}`, md: mdLine(i) });
    }
  });

  const prelude = PRELUDE.filter((n) => !importedNames.has(n));
  const title = `${block.doc}:${block.line}${block.heading ? ` (${block.heading})` : ''}`;
  emit(`// GENERATED by tests/docs/examples.ts from the \`\`\`${block.lang} block at ${block.doc}:${block.line}. Do not edit: edit the Markdown.`);
  emit(`// In scope from the prelude (tests/docs/prelude.ts): ${[...prelude, 'page', 'map'].join(', ')}.`);
  if (prelude.length) emit(`import { ${prelude.join(', ')} } from '../prelude';`);
  emit(`import { runExample } from '../examples';`);
  for (const l of imports) emit(l.text, l.md);
  emit(`test.describe(${JSON.stringify(title)}, () => {`);
  for (const l of uses) emit(l.text, l.md);
  emit(`  test('runs', async ({ page, map }) => {`);
  emit(`    await runExample(${JSON.stringify(file)}, async () => {`);
  for (const l of body) emit(l.text, l.md);
  emit(`    });`);
  emit(`  });`);
  emit(`});`);
  return { ...block, file, map, source: `${out.join('\n')}\n` };
}

/** The line of an example's Markdown that a generated line came from (the nearest mapped line at or above it). */
export function markdownLine(example: Example, generatedLine: number): number {
  for (let l = generatedLine; l > 0; l--) {
    const md = example.map.get(l);
    if (md) return md;
  }
  return example.line;
}

let cache: { examples: Example[]; skipped: Block[]; problems: string[] } | undefined;

/**
 * Extract every block, write the runnable ones to `.generated/` (only files whose content changed: every Playwright
 * worker calls this while loading the spec) and delete generated files no block produces any more.
 */
export function generateExamples(): { examples: Example[]; skipped: Block[]; problems: string[] } {
  if (cache) return cache;
  const entries = packageEntries();
  const examples: Example[] = [];
  const skipped: Block[] = [];
  const problems: string[] = [];
  for (const doc of DOCS) {
    for (const block of extractBlocks(doc, readFileSync(join(ROOT, doc), 'utf8'), problems)) {
      if (block.skip) skipped.push(block);
      else if (RUNNABLE.has(block.lang)) {
        const file = `${doc.replace(/[/\\]/g, '_').replace(/\.md$/, '')}.L${block.line}.ts`;
        try {
          examples.push(generate(block, file, entries));
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
    }
  }
  mkdirSync(GENERATED, { recursive: true });
  const wanted = new Set(examples.map((e) => e.file));
  for (const name of readdirSync(GENERATED)) if (!wanted.has(name) && name.endsWith('.ts')) rmSync(join(GENERATED, name), { force: true });
  for (const e of examples) {
    const path = join(GENERATED, e.file);
    if (existsSync(path) && readFileSync(path, 'utf8') === e.source) continue;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, e.source);
    renameSync(tmp, path); // atomic: a worker importing it never sees half a file
  }
  cache = { examples, skipped, problems };
  return cache;
}

/** `README.md:57` for a generated location, or undefined when the location is not in a generated example. */
export function markdownLocation(file: string, line: number): string | undefined {
  const example = generateExamples().examples.find((e) => e.file === file.split(/[/\\]/).pop());
  return example && `${example.doc}:${markdownLine(example, line)}`;
}

/**
 * Runs an example's body. A failure is re-thrown with the Markdown location of the line that failed in front of its
 * message, so the report names README.md:57, not a generated file.
 */
export async function runExample(file: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const esc = file.replace(/[.]/g, '\\.');
    const frame = new RegExp(`\\.generated[/\\\\]${esc}:(\\d+):\\d+`).exec(err.stack ?? '');
    const where = markdownLocation(file, frame ? Number(frame[1]) : 0) ?? file;
    const prefix = `doc example ${where}: `;
    if (err.stack) err.stack = err.stack.replace(err.message, prefix + err.message);
    err.message = prefix + err.message;
    throw err;
  }
}

