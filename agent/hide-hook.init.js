// CONTROL ONLY: simulate an app that has no test hook. The app's one-liner
// `(window.__geowright_maps ??= {}).main = map` then writes into a throwaway object.
Object.defineProperty(window, '__geowright_maps', { get: () => undefined, set: () => {}, enumerable: false, configurable: false });
