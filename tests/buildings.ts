/** Fixture data for the demo's vector-tile layer. Invented. Lives with the tests, not in the app. */
const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
let id = 1000;
const block = (lng0: number, lat0: number, cols: number, rows: number) => {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lng = lng0 + c * 0.006;
      const lat = lat0 + r * 0.005;
      const n = ++id;
      features.push({
        type: 'Feature',
        id: n,
        properties: { id: n, kind: (r + c) % 3 === 0 ? 'office' : 'house', floors: 1 + ((r * 7 + c * 3) % 9) },
        geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.004, lat], [lng + 0.004, lat + 0.003], [lng, lat + 0.003], [lng, lat]]] },
      });
    }
  }
};
block(34.702, 32.092, 5, 5); // 25 buildings, north-west corner of the initial view (ids 1001-1025)
block(35.19, 32.09, 3, 2); // 6 buildings far to the east, off-screen initially (ids 1026-1031)

export const BUILDINGS: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
