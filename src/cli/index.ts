#!/usr/bin/env node
import { init, parseInitArgs } from './init';

const USAGE = 'usage: geowright init [--dir tests] [--url /] [--force]\n\n  Writes a Playwright fixture, the software-WebGL launch flags and a first spec that prints map.snapshot(),\n  and prints the one line your app needs (react-map-gl, @vis.gl/react-maplibre, svelte-maplibre-gl, vue-maplibre-gl are detected).';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'init') {
  try {
    init({ cwd: process.cwd(), ...parseInitArgs(rest) });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.log(USAGE);
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
}
