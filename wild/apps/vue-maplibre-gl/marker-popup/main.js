import { createApp } from 'vue';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import Example from '../examples/marker-popup.vue';

setWorkerUrl(workerUrl);
createApp(Example).mount('#app');
