import { test, expect } from '@playwright/test';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * scripts/kill-preview.sh stops THIS checkout's servers and nothing else, on a shared machine. "This checkout" is the
 * working tree the script lives in, not a path prefix: a worktree nested in the checkout (.claude/worktrees/…) is
 * another checkout, and its servers are left alone.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = `${ROOT}scripts/kill-preview.sh`;

// The script tells this checkout's servers apart by git's top level, and finds listeners with lsof. Where either is
// missing there is nothing to test: scripts/linux-suite.sh runs the suite in a COPY of the tree, without .git.
const ok = (cmd: string, ...args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
test.skip(!ok('git', '-C', ROOT, 'rev-parse', '--is-inside-work-tree'), 'not a git checkout (the Linux container runs a copy of the tree)');
test.skip(!ok('sh', '-c', 'command -v lsof'), 'no lsof: kill-preview.sh finds listeners with it');

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

/** A listening server whose working directory is `cwd`; resolves once it listens. */
async function serverIn(cwd: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `require('node:http').createServer((q, r) => r.end()).listen(${port}, '127.0.0.1', () => console.log('up'))`], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  return child;
}

function killPreview(port: number, env: Record<string, string> = {}): string {
  // Both ports on the one test port: the script must not look at anything else.
  return execFileSync('bash', [SCRIPT], { env: { ...process.env, ...env, GEOWRIGHT_PORT: String(port), GEOWRIGHT_WILD_PORT: String(port) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A server in `dir`, which is not this checkout: the script must leave it alone. */
async function leftAlone(dir: string, env: Record<string, string> = {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const child = await serverIn(dir, port);
  try {
    expect(killPreview(port, env)).not.toContain('stopped');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200); // still serving
  } finally {
    child.kill(); // ours: this test started it
    await exited(child);
  }
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));

test('a server started in this checkout is stopped', async () => {
  const port = await freePort();
  const child = await serverIn(ROOT, port);
  try {
    expect(killPreview(port)).toContain(`stopped server pid ${child.pid} (port ${port}`);
    await exited(child);
  } finally {
    child.kill();
  }
});

test('a server started in a checkout nested inside this one (a worktree under .claude/worktrees) is left alone', async () => {
  const nested = test.info().outputPath('nested-checkout');
  mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q', nested]);
  const port = await freePort();
  const child = await serverIn(nested, port);
  try {
    expect(killPreview(port)).not.toContain('stopped');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200); // still serving
  } finally {
    child.kill(); // ours: this test started it
    await exited(child);
  }
});

test('a server in a sibling directory whose path starts with this checkout\'s ("<checkout>-other") is left alone', async () => {
  const sibling = mkdtempSync(`${ROOT.replace(/\/$/, '')}-other-`);
  try {
    await leftAlone(sibling);
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('a foreign server is left alone even when GIT_DIR and GIT_WORK_TREE point at this checkout', async () => {
  // A git hook or a wrapper tool exports them; `git -C <foreign dir>` then answers with THIS checkout's top level.
  const gitDir = execFileSync('git', ['-C', ROOT, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  const foreign = mkdtempSync(`${tmpdir()}/kill-preview-foreign-`);
  try {
    await leftAlone(foreign, { GIT_DIR: gitDir, GIT_WORK_TREE: ROOT });
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});
