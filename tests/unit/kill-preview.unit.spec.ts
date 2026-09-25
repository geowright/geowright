import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * scripts/kill-preview.sh stops THIS checkout's servers and nothing else, on a shared machine. "This checkout" is the
 * working tree the script lives in, not a path prefix: a worktree nested in the checkout (.claude/worktrees/…) is
 * another checkout, and its servers are left alone.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = `${ROOT}scripts/kill-preview.sh`;

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

function killPreview(port: number): string {
  // Both ports on the one test port: the script must not look at anything else.
  return execFileSync('bash', [SCRIPT], { env: { ...process.env, GEOWRIGHT_PORT: String(port), GEOWRIGHT_WILD_PORT: String(port) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
