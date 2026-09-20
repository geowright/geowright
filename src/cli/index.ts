#!/usr/bin/env node
import { init } from './init';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (cmd === 'init') {
  try {
    init({ cwd: process.cwd(), dir: flag('dir'), url: flag('url'), force: rest.includes('--force') });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.log('usage: geowright init [--dir tests] [--url /] [--force]\n\n  Writes a Playwright fixture, the software-WebGL launch flags and a first spec that prints map.snapshot(),\n  and prints the one line your app needs (react-map-gl / svelte-maplibre-gl / vue-maplibre-gl are detected).');
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
}
