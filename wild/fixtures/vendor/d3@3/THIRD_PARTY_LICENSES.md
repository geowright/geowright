# Licenses

`d3.v3.min.js` is d3 3.5.17's browser build, byte-identical to `d3.min.js` in the `d3` 3.5.17 npm package. It bundles
nothing but d3's own code: the package declares no `dependencies` (only build and test tools: `smash`, `uglify-js`,
`vows`, `jsdom`, `seedrandom`), its unminified `d3.js` is `smash`'s concatenation of d3's own `src/` and carries no
other copyright or license comment, and the minified file has no banner. Its license is the `LICENSE` beside this
file (BSD-3-Clause, Copyright (c) 2010-2016, Michael Bostock), byte-identical to the one in that npm package. Read on
2026-09-25 (`npm pack d3@3.5.17`).
