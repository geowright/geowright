// All data below is fictional, invented for this demo. No real-world data.
import type { FeatureCollection, Feature, Polygon, Point, LineString } from 'geojson';

export type Zoning = 'residential' | 'commercial';
export type Severity = 'low' | 'medium' | 'high';

export interface ParcelProps {
  id: number;
  owner: string;
  zoning: Zoning;
}

export interface AlertProps {
  id: number;
  name: string;
  severity: Severity;
}

export interface StationProps {
  id: number;
  name: string;
}

export interface RoadProps {
  id: number;
  name: string;
}

function rect(cx: number, cy: number, w: number, h: number): number[][] {
  const hw = w / 2;
  const hh = h / 2;
  return [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
    [cx - hw, cy - hh],
  ];
}

// Parcel 105: concave U-shape. bbox is lng [34.770, 34.790] x lat [32.062, 32.078]
// (0.02 x 0.016). The bbox center (34.780, 32.070) sits in the notch, outside the ring.
const parcel105Ring: number[][] = [
  [34.77, 32.062], // bottom-left
  [34.79, 32.062], // bottom-right
  [34.79, 32.078], // top-right (outer)
  [34.7845, 32.078], // top of right leg, inner
  [34.7845, 32.068], // down to top of the bar, inner-right
  [34.7755, 32.068], // across the bar top, inner-left
  [34.7755, 32.078], // up the left leg, inner
  [34.77, 32.078], // top-left (outer)
  [34.77, 32.062], // close
];

export const PARCELS: FeatureCollection<Polygon, ParcelProps> = {
  type: 'FeatureCollection',
  features: [
    feature(101, rect(34.75, 32.1, 0.012, 0.008), { id: 101, owner: 'Meridian Holdings', zoning: 'residential' }),
    feature(102, rect(34.77, 32.106, 0.012, 0.008), { id: 102, owner: 'Solvane Trust', zoning: 'residential' }),
    feature(103, rect(34.805, 32.1, 0.012, 0.008), { id: 103, owner: 'Kestrel Retail Group', zoning: 'commercial' }),
    feature(104, rect(34.748, 32.058, 0.012, 0.008), { id: 104, owner: 'Orin Family Trust', zoning: 'residential' }),
    feature(105, parcel105Ring, { id: 105, owner: 'Talbrook Logistics', zoning: 'commercial' }),
    feature(106, rect(34.8, 32.06, 0.002, 0.002), { id: 106, owner: 'Nella Vance', zoning: 'residential' }),
  ],
};

function feature(id: number, ring: number[][], props: ParcelProps): Feature<Polygon, ParcelProps> {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: props,
  };
}

export const ALERTS: FeatureCollection<Point, AlertProps> = {
  type: 'FeatureCollection',
  features: [
    alertFeature(1, 'Gas leak', 'high', [34.77, 32.085]),
    alertFeature(2, 'Road closure', 'medium', [34.79, 32.095]),
    alertFeature(3, 'Noise complaint', 'low', [34.76, 32.07]),
    alertFeature(4, 'Far east incident', 'low', [35.2, 32.08]),
  ],
};

function alertFeature(id: number, name: string, severity: Severity, coords: number[]): Feature<Point, AlertProps> {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: coords },
    properties: { id, name, severity },
  };
}

// Three tight clusters + two isolated stations, kept clear of parcels/alerts.
function jitteredGroup(startId: number, namePrefix: string, cx: number, cy: number, count: number): Feature<Point, StationProps>[] {
  const feats: Feature<Point, StationProps>[] = [];
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random spread inside a ~0.004deg box using a golden-angle spiral.
    const angle = i * 2.399963;
    const radius = 0.0009 + (i / count) * 0.0011;
    const lng = cx + Math.cos(angle) * radius;
    const lat = cy + Math.sin(angle) * radius * 0.7;
    const id = startId + i;
    feats.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { id, name: `${namePrefix} ${i + 1}` },
    });
  }
  return feats;
}

const stationFeatures: Feature<Point, StationProps>[] = [
  ...jitteredGroup(301, 'North Depot', 34.78, 32.118, 10),
  ...jitteredGroup(311, 'South Depot', 34.78, 32.048, 10),
  ...jitteredGroup(321, 'East Depot', 34.828, 32.085, 8),
  {
    type: 'Feature',
    id: 329,
    geometry: { type: 'Point', coordinates: [34.705, 32.062] },
    properties: { id: 329, name: 'Substation Alpha' },
  },
  {
    type: 'Feature',
    id: 330,
    geometry: { type: 'Point', coordinates: [34.85, 32.108] },
    properties: { id: 330, name: 'Substation Beta' },
  },
];

export const STATIONS: FeatureCollection<Point, StationProps> = {
  type: 'FeatureCollection',
  features: stationFeatures,
};

export const ROADS: FeatureCollection<LineString, RoadProps> = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 201,
      geometry: {
        type: 'LineString',
        coordinates: [
          [34.72, 32.09],
          [34.76, 32.088],
          [34.8, 32.092],
          [34.84, 32.09],
        ],
      },
      properties: { id: 201, name: 'Herzl Street' },
    },
    {
      type: 'Feature',
      id: 202,
      geometry: {
        type: 'LineString',
        coordinates: [
          [34.782, 32.03],
          [34.78, 32.07],
          [34.779, 32.11],
          [34.777, 32.14],
        ],
      },
      properties: { id: 202, name: 'Ben Gurion Avenue' },
    },
  ],
};
