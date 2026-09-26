import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A link to a decision record outside docs/decisions/ points at one that stands: not "Superseded by NNNN" (cite the
 * record that superseded it). Inside docs/decisions/ a superseding record names the one it replaces, so that directory
 * is not read. Walks the working tree, not git: the exported tree runs this suite too.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DECISIONS = join(ROOT, 'docs/decisions');
const READ = ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'docs', 'agent', 'src', 'tests', 'wild/README.md', 'wild/scripts'];
const SKIP = new Set(['node_modules', 'dist', 'decisions', 'test-results']);
const TEXT = /\.(md|ts|mjs|js|sh)$/;

function walk(p: string): string[] {
  if (!existsSync(p)) return [];
  if (!statSync(p).isDirectory()) return TEXT.test(p) ? [p] : [];
  return readdirSync(p).filter((n) => !SKIP.has(n)).flatMap((n) => walk(join(p, n)));
}

test('no link outside docs/decisions/ cites a superseded decision record', () => {
  const status = new Map<string, string>();
  for (const f of readdirSync(DECISIONS).filter((n) => /^\d{4}-.+\.md$/.test(n))) {
    status.set(f, /^- Status: (.*)$/m.exec(readFileSync(join(DECISIONS, f), 'utf8'))?.[1] ?? '');
  }
  const problems: string[] = [];
  for (const file of READ.flatMap((p) => walk(join(ROOT, p)))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/decisions\/(\d{4}-[a-z0-9-]+\.md)/g)) {
        const s = status.get(m[1]);
        const where = `${file.slice(ROOT.length)}:${i + 1}`;
        if (s === undefined) problems.push(`${where}: ${m[1]} is not a decision record`);
        else if (/^Superseded/.test(s)) problems.push(`${where}: ${m[1]} is "${s}": cite that record`);
      }
    });
  }
  expect(problems).toEqual([]);
});
