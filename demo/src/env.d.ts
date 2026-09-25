declare module '*.css';
declare module '@mapbox/mapbox-gl-draw'; // ships no types; the demo only needs changeMode/getAll
declare module '*.css?inline' {
  const css: string;
  export default css;
}
