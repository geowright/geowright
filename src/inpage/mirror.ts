import type { Engine } from './engine';
import type { EntityView } from './types';

/** The accessible name of an entity's button. Avoids ": " and " #": both are YAML syntax and break toMatchAriaSnapshot templates. */
export function buttonLabel(e: Pick<EntityView, 'layer' | 'id' | 'geometryType' | 'properties'>): string {
  // nested values (objects, arrays) as JSON: String() prints "[object Object]"
  const props = Object.entries(e.properties).slice(0, 5).map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join(', ');
  return `${e.layer}${e.id !== undefined ? ' ' + e.id : ''} (${e.geometryType}) ${props}`;
}

/**
 * Accessibility mirror: the Flutter-web "semantics tree" idea applied to a map.
 *
 * For every entity on the canvas we keep an invisible, real <button> positioned on the entity's
 * clickable pixel, INSIDE the library's own event container. Consequences:
 *  - the features show up in the ordinary accessibility tree, so Playwright MCP's normal
 *    browser_snapshot lists them (with refs) — no custom tool, no instructions to the agent;
 *  - a normal browser_click on such a ref is a REAL mouse click at that pixel; the event bubbles
 *    from the button to the map's container exactly like a click on a MapLibre Marker does, so the
 *    app's own map click handlers run. Nothing is synthesised.
 *
 * Opt-in and for agent sessions only: it adds DOM to the app, which a test tool must not do.
 */
export function startMirror(engine: Engine<any>, mapId: string, opts: { max?: number } = {}): () => void {
  const max = opts.max ?? 80;
  const surface = engine.adapter.surface();
  const host = surface.parentElement!;
  const root = document.createElement('div');
  root.setAttribute('role', 'group');
  root.setAttribute('data-geowright-mirror', mapId);
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  host.appendChild(root);
  const nodes = new Map<string, HTMLButtonElement>();
  const note = document.createElement('div');
  note.setAttribute('role', 'note');
  note.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);';
  note.hidden = true;
  root.appendChild(note);

  const render = () => {
    const view = engine.adapter.getViewState() as any;
    const all = engine.entities({ max, ignoreDom: (el) => root.contains(el) });
    const usable = all.filter((e) => e.pixel && !e.invisible); // what a user can neither see nor click gets no button
    root.setAttribute(
      'aria-label',
      `Map ${mapId} - ${all.length} features in view` +
        (view.center ? `, center ${view.center.lng.toFixed(4)},${view.center.lat.toFixed(4)} zoom ${view.zoom.toFixed(1)}` : ''),
    );
    // Reconcile by entity key: a node that survives keeps its identity, so accessibility refs an
    // agent is holding stay valid while the map merely re-renders.
    const keep = new Set<string>();
    for (const e of usable.slice(0, max)) {
      keep.add(e.key);
      let b = nodes.get(e.key);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;
        b.style.cssText = 'position:absolute;width:10px;height:10px;opacity:0;padding:0;border:0;background:transparent;pointer-events:auto;cursor:inherit;';
        nodes.set(e.key, b);
        root.appendChild(b);
      }
      const label = buttonLabel(e);
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
      b.style.left = `${e.pixel!.x - 5}px`;
      b.style.top = `${e.pixel!.y - 5}px`;
    }
    for (const [k, b] of nodes) {
      if (!keep.has(k)) {
        b.remove();
        nodes.delete(k);
      }
    }
    const rest = all.length - Math.min(usable.length, max);
    note.textContent = rest > 0 ? `${rest} more map features are not individually listed (covered by other features, or over the limit of ${max}).` : '';
    note.hidden = rest <= 0;
  };
  render();
  const off = engine.adapter.subscribe?.(render);
  return () => {
    off?.();
    root.remove();
  };
}
