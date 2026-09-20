This page contains an interactive map drawn on a <canvas>. The accessibility snapshot cannot see
inside it. To see the map, call browser_evaluate with exactly:

  async () => { await window.__mapwright.waitForIdle('main', 5000); return await window.__mapwright.snapshot('main'); }

It returns a text snapshot: view state, layers, and every rendered feature with its properties and
its CLIENT pixel position "@(x,y)". To click a feature, call browser_mouse_click_xy with that x,y.
After anything that moves the map (pan, zoom, fly), take a new map snapshot: pixels change.
Features listed as OUTSIDE the viewport must be brought into view before they can be clicked.
