/**
 * Entry for AGENT sessions (Playwright MCP --init-script). Same adapter as tests, plus: as soon as
 * the app registers a map, start the accessibility mirror for it. Zero instructions needed by the
 * agent; the map simply becomes visible in the accessibility snapshot.
 */
import './index';

const started = new Set<string>();
const tick = () => {
  const w = window as any;
  for (const id of Object.keys(w.__mapwright_maps ?? {})) {
    if (started.has(id)) continue;
    try {
      const m = w.__mapwright_maps[id];
      if (typeof m.loaded === 'function' && !m.loaded()) continue; // wait for first load
      w.__mapwright.mirror(id);
      started.add(id);
    } catch {
      /* not ready yet */
    }
  }
};
setInterval(tick, 250);
