import { test, expect } from '@playwright/test';
import { build, transform } from 'esbuild';
import { parseSync } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two rules of the adapter seam (docs/decisions/0004-the-adapter-seam.md, CONTRIBUTING.md "Ground rules"), checked
 * here in the forms listed below and only those: what a list leaves out (some of it named after it) is still review's
 * job. Node only, no browser. The files are parsed (by the oxc parser Vite exports), not matched as text, so a comment
 * or a string that says `from "x"` or `map.style` is not reported. The last test runs the checker on one planted line
 * per listed form and on look-alikes, so a parser upgrade that reshapes a node fails there, not silently.
 *
 *  1. src/inpage/engine.ts imports nothing from any map library, and the library-neutral files of the seam (NEUTRAL)
 *     import only each other. Read from the source, since esbuild erases the type-only forms: `import … from 'x'` and
 *     `import 'x'`, `export … from 'x'`, each also as `type`; `import('x')` and `require('x')` (a specifier other
 *     than a string literal or a template without substitutions is reported as computed); `import('x').T` and
 *     `typeof import('x')` in a type position; `import x = require('x')`; `declare module 'x'`; and
 *     `/// <reference types|path="x" />` before the first statement (after code, TypeScript reads it as a plain
 *     comment). An esbuild bundle of the neutral files must pull in no package. NEUTRAL is closed: a module the engine
 *     may import is itself on it, so a file split out of the engine has its own imports checked. Not checked: a
 *     library reached through a global (`window.maplibregl`).
 *  2. Nothing in src/inpage, subdirectories included, reads a private field or a known map internal. Read from
 *     esbuild's output, where types, casts and comments are gone (`(map as any)._frame` is `map._frame`). A private
 *     name has leading underscores, any number, before anything else (`_foo`, `___foo`, `_0`; `__geowright*` are our
 *     own globals), or a trailing one (`foo_`, how OpenLayers marks its private members); it is caught as `x.f`,
 *     `x?.f`, `x['f']`, `` x[`f`] ``, `'f' in x`, and destructured anywhere (`const { f } = x`, `({ f } = x)`, a
 *     parameter). The internals are five non-underscore names, `style`, `painter`, `transform`, `handlers` and
 *     `terrain`, caught when read (not called) from `map`, `<anything>.map` or `<anything>['map']` as `.f`, `?.f` or
 *     `['f']`, or destructured straight from it (`const { painter } = map`). Not checked: a map reached through an
 *     alias or an expression (`const m = this.map; m.painter`, `const { painter } = map ?? {}`), reflection
 *     (`Reflect.get(map, '_frame')`, `Object.hasOwn(map, '_frame')`), a key computed at run time
 *     (`const k = '_frame'; map[k]`), and any other internal under a public-looking name (`map.cameraHelper`).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INPAGE = join(ROOT, 'src/inpage');

/** The library-neutral files and the only modules each may import. Every module listed must be a key here too. */
const NEUTRAL: Record<string, string[]> = {
  'engine.ts': ['./types', './types-internal'],
  'mirror.ts': ['./engine', './types'],
  'types.ts': [],
  'types-internal.ts': ['./types'],
};

/** Every source file under src/inpage, subdirectories included, relative to it ('engine.ts', 'adapters/x.ts'). */
const SOURCES = readdirSync(INPAGE, { recursive: true, encoding: 'utf8' })
  .map((f) => f.split(sep).join('/'))
  .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
  .sort();
/** What a file is written in, by its extension (.mts is ts, .cjs is js): esbuild's loader and the parser's lang alike. */
const lang = (f: string) => f.match(/\.[cm]?([jt]sx?)$/)![1] as 'js' | 'jsx' | 'ts' | 'tsx';

/** An ESTree node of any type, read by its fields. */
type Node = { type: string; start: number; end: number; [field: string]: any };

function parse(file: string, code: string, as: 'js' | 'jsx' | 'ts' | 'tsx') {
  const r = parseSync(file, code, { lang: as, sourceType: 'module', preserveParens: false });
  // A file the parser cannot read would otherwise pass as empty.
  expect(r.errors.map((e) => e.message), `${file} parses`).toEqual([]);
  return r;
}

/** Every node under `value` with its parent node, depth first. */
function* walk(value: unknown, parent?: Node): Generator<[Node, Node | undefined]> {
  if (Array.isArray(value)) {
    for (const v of value) yield* walk(v, parent);
  } else if (value !== null && typeof value === 'object') {
    const node = typeof (value as Node).type === 'string' ? (value as Node) : undefined;
    if (node) yield [node, parent];
    for (const v of Object.values(value)) yield* walk(v, node ?? parent);
  }
}

/** The text of a string literal or of a template without substitutions; undefined for anything computed. */
const text = (n: Node | null | undefined): string | undefined =>
  n?.type === 'Literal' && typeof n.value === 'string'
    ? n.value
    : n?.type === 'TemplateLiteral' && n.expressions.length === 0
      ? n.quasis[0].value.cooked
      : undefined;

/** Every module the source `code` of `file` refers to, type-only references included. */
function moduleRefs(file: string, code: string): string[] {
  const { program, comments } = parse(file, code, lang(file));
  const refs: string[] = [];
  const ref = (n: Node) => refs.push(text(n) ?? '<computed specifier>');
  for (const [n] of walk(program)) {
    if (/^(ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration|ImportExpression|TSImportType)$/.test(n.type)) {
      if (n.source) ref(n.source); // import, import type, export … from, import(), import('x').T
    } else if (n.type === 'TSExternalModuleReference') ref(n.expression); // import x = require('x')
    else if (n.type === 'TSModuleDeclaration' && n.id.type === 'Literal') ref(n.id); // declare module 'x' { … }
    else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') ref(n.arguments[0]);
  }
  // A triple-slash directive counts only before the first statement: after code, TypeScript reads it as a comment.
  const head = program.body[0]?.start ?? code.length;
  for (const c of comments) {
    const m = c.type === 'Line' && c.start < head && /^\/\s*<reference\s+(?:types|path)\s*=\s*['"]([^'"]+)['"]/.exec(c.value);
    if (m) refs.push(m[1]); // /// <reference types="x" />
  }
  return refs;
}

/** The modules a library-neutral file's `code` refers to outside its allow-list (an extension is not part of a name). */
const outside = (file: string, code: string, allowed: string[]) =>
  moduleRefs(file, code).filter((s) => !allowed.includes(s.replace(/\.[cm]?[jt]s$/, '')));

/**
 * A private name: leading underscores, any number, before anything else (`_foo`, `___foo`, `_0`), except our own
 * `__geowright*` globals; or a trailing underscore (`foo_`, how OpenLayers marks its private members).
 */
const isPrivate = (name: string | undefined) =>
  name !== undefined && (/^(?!__geowright)_+[^_]/.test(name) || /^[A-Za-z$][\w$]*_$/.test(name));
const INTERNALS = new Set(['style', 'painter', 'transform', 'handlers', 'terrain']);
/** The field a member access or a destructured property names; undefined when it is computed or `#private`. */
const field = (computed: boolean, key: Node) => (computed ? text(key) : key.type === 'Identifier' ? key.name : text(key));
/** `map` or `<anything>.map`, as in `this.map.painter` or `this['map'].painter`. */
const isMap = (n: Node | null | undefined) =>
  (n?.type === 'Identifier' && n.name === 'map') || (n?.type === 'MemberExpression' && field(n.computed, n.property) === 'map');

type Read = { line: number; why: string; code: string };
/** Every read of a private field or of a known map internal in the source `code` of `file`. */
async function privateReads(file: string, source: string): Promise<Read[]> {
  // What runs: esbuild drops comments and types (the adapter's header NAMES MapGrab's private flags) and keeps every
  // property access, so `(map as any)._frame` is checked as `map._frame`.
  const { code } = await transform(source, { loader: lang(file), format: 'esm' });
  const reads: Read[] = [];
  const hit = (n: Node, why: string) =>
    reads.push({ line: code.slice(0, n.start).split('\n').length, why, code: code.slice(n.start, n.end).slice(0, 80) });
  for (const [n, parent] of walk(parse(file, code, 'js').program)) {
    if (n.type === 'MemberExpression') {
      const name = field(n.computed, n.property);
      if (isPrivate(name)) hit(n, 'private field');
      // Called, `map.x(…)` is a method of the map, not its internal field.
      else if (INTERNALS.has(name ?? '') && isMap(n.object) && !(parent?.type === 'CallExpression' && parent.callee === n)) hit(n, 'map internal');
    } else if (n.type === 'BinaryExpression' && n.operator === 'in' && isPrivate(text(n.left))) {
      hit(n, 'private field');
    } else if (n.type === 'ObjectPattern') {
      const from = parent?.type === 'VariableDeclarator' ? parent.init : parent?.type === 'AssignmentExpression' ? parent.right : undefined;
      for (const p of n.properties as Node[]) {
        if (p.type !== 'Property') continue; // …rest
        const name = field(p.computed, p.key);
        if (isPrivate(name)) hit(n, 'private field, destructured');
        else if (INTERNALS.has(name ?? '') && isMap(from)) hit(n, 'map internal, destructured');
      }
    }
  }
  return reads;
}

const source = (file: string) => readFileSync(join(INPAGE, file), 'utf8');

test('the engine and the seam types import no map library, value or type-only', async () => {
  const problems: string[] = [];
  for (const [file, allowed] of Object.entries(NEUTRAL)) {
    for (const a of allowed) {
      const target = `${posix.join(posix.dirname(file), a)}.ts`;
      if (!(target in NEUTRAL)) problems.push(`src/inpage/${file} may import ${a}, but ${target} is not in NEUTRAL: add it with its own allow-list, or its imports go unchecked`);
    }
    const bad = outside(file, source(file), allowed);
    if (bad.length) problems.push(`src/inpage/${file} imports ${JSON.stringify(bad)}, outside its allow-list ${JSON.stringify(allowed)}`);
  }
  expect(problems, "the seam's library-neutral files").toEqual([]);
  // Transitively, at run time: bundling the neutral files pulls in no package.
  const r = await build({
    entryPoints: Object.keys(NEUTRAL).map((f) => join(INPAGE, f)),
    bundle: true, write: false, metafile: true, logLevel: 'silent', format: 'esm', outdir: 'unwritten',
  });
  expect(Object.keys(r.metafile.inputs).filter((i) => i.includes('node_modules')), 'packages bundled into the neutral files').toEqual([]);
});

test('nothing in src/inpage reads an underscore field or a known map internal', async () => {
  expect(SOURCES).toContain('engine.ts');
  const hits: string[] = [];
  for (const file of SOURCES) {
    for (const r of await privateReads(file, source(file))) hits.push(`${file} (transpiled line ${r.line}): ${r.why}: ${r.code}`);
  }
  expect(hits, 'underscore (private) fields or internals of a map library are read').toEqual([]);
});

/**
 * The checker itself, on planted code: one line per form the header lists, each expected reported, and the look-alikes
 * (a comment, a string, an allowed module, our own globals) expected clean. Both scans read parser node types and fields
 * (oxc's, through Vite), so a parser upgrade that reshapes a node fails here rather than leaving the scan blind.
 */
test('the checker reports every form it claims to, and no look-alike', async () => {
  const MAPLIBRE = ['maplibre-gl'];
  /** Source of engine.ts -> what `outside` reports against the engine's allow-list. */
  const IMPORTS: [string, string[]][] = [
    ["import { Map } from 'maplibre-gl';", MAPLIBRE],
    ["import 'maplibre-gl';", MAPLIBRE],
    ["import type { Map } from 'maplibre-gl';", MAPLIBRE],
    ["import { type Map } from 'maplibre-gl';", MAPLIBRE],
    ["export { Map } from 'maplibre-gl';", MAPLIBRE],
    ["export type { Map } from 'maplibre-gl';", MAPLIBRE],
    ["export * from 'maplibre-gl';", MAPLIBRE],
    ["export * as ml from 'maplibre-gl';", MAPLIBRE],
    ["export const ml = await import('maplibre-gl');", MAPLIBRE],
    ['export const ml = await import(`maplibre-gl`);', MAPLIBRE],
    ['export const ml = (name: string) => import(name);', ['<computed specifier>']],
    ["export const ml = require('maplibre-gl');", MAPLIBRE],
    ["export type M = import('maplibre-gl').Map;", MAPLIBRE],
    ["export let m: typeof import('maplibre-gl');", MAPLIBRE],
    ["import ml = require('maplibre-gl');", MAPLIBRE],
    ["declare module 'maplibre-gl' { interface Map { x: number } }", MAPLIBRE],
    ['/// <reference types="maplibre-gl" />\nexport const x = 1;', MAPLIBRE],
    ['/* A header. */\n/// <reference types="maplibre-gl" />\nexport const x = 1;', MAPLIBRE],
    ["/// <reference path='../../node_modules/maplibre-gl/dist/maplibre-gl.d.ts' />", ['../../node_modules/maplibre-gl/dist/maplibre-gl.d.ts']],
    ["import type { Feature } from './types';\nimport type { Map } from 'mapbox-gl';", ['mapbox-gl']],
    ["import { split } from './engine-geometry';", ['./engine-geometry']],
    // Look-alikes.
    ["// import { Map } from 'maplibre-gl';\nexport const x = 1;", []],
    ["/* import('maplibre-gl').Map */\nexport const x = 1;", []],
    ["export const s = \"import { Map } from 'maplibre-gl'\";", []],
    ["export const t = `export * from 'maplibre-gl'`;", []],
    ["import type { Feature } from './types';\nimport { x } from './types-internal.js';", []],
    ['export namespace maplibre { export const x = 1; }', []],
    // After code, TypeScript reads a triple-slash directive as a plain comment.
    ['export const x = 1;\n/// <reference types="maplibre-gl" />', []],
  ];
  /** Source of a file in src/inpage -> the kinds of read `privateReads` reports in it. */
  const READS: [string, string[]][] = [
    ['export const a = x._foo;', ['private field']],
    ['export const a = x?._foo;', ['private field']],
    ["export const a = x['_foo'];", ['private field']],
    ['export const a = x[`_foo`];', ['private field']],
    ['export const a = x.__foo;', ['private field']],
    ['export const a = x.___foo;', ['private field']],
    ['export const a = x._0;', ['private field']],
    ['const { _0: a } = x;\nexport { a };', ['private field, destructured']],
    ['export const a = x.frameState_;', ['private field']],
    ['export const a = (map as any)._frame;', ['private field']],
    ["export const a = '_foo' in x;", ['private field']],
    ['const { _foo: a } = x;\nexport { a };', ['private field, destructured']],
    ['let a;\n({ _foo: a } = x);\nexport { a };', ['private field, destructured']],
    ['export const f = ({ _foo }: any) => _foo;', ['private field, destructured']],
    ['export const a = map.style;', ['map internal']],
    ['export const a = ctx.map.painter;', ['map internal']],
    ['export const a = map?.handlers;', ['map internal']],
    ["export const a = map['terrain'];", ['map internal']],
    ['export const a = (map as any).transform;', ['map internal']],
    ["export const a = (ctx as any)?.['map']?.transform;", ['map internal']],
    ['const { painter } = map;\nexport { painter };', ['map internal, destructured']],
    ['let style;\n({ style } = ctx.map);\nexport { style };', ['map internal, destructured']],
    // Look-alikes.
    ['// x._foo, map.painter\nexport const a = 1;', []],
    ["export const s = 'x._foo map.painter';", []],
    ['export const a = (window as any).__geowright_maps;', []],
    ['export const a = x.foo_bar;', []],
    ['export const a = map.getStyle();', []],
    ['export const a = map.style(1);', []],
    ['export const a = layer.style;', []],
    ['export const a = mapping.painter;', []],
    ['export class A { #x = 1; get() { return this.#x; } }', []],
    ['const { ...rest } = x;\nexport { rest };', []],
  ];
  const declared = 'declare const x: any, map: any, ctx: any, layer: any, mapping: any;\n';
  expect.soft(IMPORTS.map(([code]) => [code, outside('engine.ts', code, NEUTRAL['engine.ts'])]), 'rule 1 on planted engine.ts lines').toEqual(IMPORTS);
  const reads: [string, string[]][] = [];
  for (const [code] of READS) reads.push([code, (await privateReads('planted.ts', declared + code)).map((r) => r.why)]);
  expect(reads, 'rule 2 on planted lines').toEqual(READS);
});
