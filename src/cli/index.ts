#!/usr/bin/env node
import { init, parseInitArgs } from './init';
import pkg from '../../package.json' with { type: 'json' };

const USAGE = 'usage: geowright init [--dir tests] [--url /] [--force]\n\n  Writes a Playwright fixture, the software-WebGL launch flags and a first spec that prints map.snapshot(),\n  and prints the one line your app needs (react-map-gl, @vis.gl/react-maplibre, svelte-maplibre-gl, vue-maplibre-gl are detected).';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'init') {
  if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    init({ cwd: process.cwd(), ...parseInitArgs(rest) });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (cmd === '--version') {
  console.log(pkg.version);
  process.exit(0);
} else {
  console.log(USAGE);
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
}
