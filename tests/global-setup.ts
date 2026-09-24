import type { FullConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { stalePreview } from './stale-preview';

/** Runs after the web servers are up (reused or started): refuse to test a stale or foreign demo build. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const problem = await stalePreview(fileURLToPath(new URL('..', import.meta.url)), baseURL);
  if (problem) {
    const port = new URL(baseURL).port;
    throw new Error(
      `stale demo preview: ${problem}.\nStop it and run again, which builds the demo first: GEOWRIGHT_PORT=${port} bash scripts/kill-preview.sh` +
        ` (it stops only this checkout's servers; another checkout's is left alone: use another GEOWRIGHT_PORT then).`,
    );
  }
}
