This page contains an interactive map drawn on a <canvas>. The accessibility snapshot cannot see
inside it. To see the map, call browser_evaluate with exactly:

  async () => { await window.__geowright.waitForIdle('main', 5000); return await window.__geowright.snapshot('main'); }

It returns a text snapshot: view state, layers, and every rendered feature with its properties and
its CLIENT pixel position "@(x,y)". To click a feature, call browser_mouse_click_xy with that x,y.
After anything that moves the map (pan, zoom, fly), take a new map snapshot: pixels change.
Features listed as OUTSIDE the viewport must be brought into view before they can be clicked.
On a dense map only the entities nearest the view centre are listed per layer; the "Summary of all N"
line gives counts for the whole layer. A large basemap is condensed first, down to one
"[basemap source ...]" line; to see one of its layers, pass { layers: ['<layer id>'] }. To find
specific features, pass a filter (operators: eq ne gt gte lt lte in matches exists):

  async () => window.__geowright.snapshot('main', { filter: { layer: 'assets', where: { serial: 'SN-12345' } } })

An entry marked "covered-by:..." is under another feature at every pixel tried: clicking its pixel
hits the OTHER feature. Entries marked NOT-VISIBLE are painted invisibly by the app.
