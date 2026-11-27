import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.resolve(__dirname, 'src/preview/shims');
const SHIM_MAP: Record<string, string> = {
  './mapData': path.join(SHIM_DIR, 'mapData.ts'),
  './fpsBridge': path.join(SHIM_DIR, 'fpsBridge.ts'),
  './textures': path.join(SHIM_DIR, 'textures.ts'),
  './infrastructureSystem': path.join(SHIM_DIR, 'infrastructureSystem.ts'),
  './metroSystem': path.join(SHIM_DIR, 'metroSystem.ts'),
  './trafficSystem': path.join(SHIM_DIR, 'trafficSystem.ts'),
};

function simPreviewShimPlugin(): Plugin {
  return {
    name: 'sim-preview-shims',
    resolveId(source, importer) {
      if (importer && importer.includes(`${path.sep}src${path.sep}sim${path.sep}`) && SHIM_MAP[source]) {
        return SHIM_MAP[source];
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), simPreviewShimPlugin()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: false,
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
