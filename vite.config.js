import { defineConfig } from 'vite';

// The API runs separately in dev (`npm run dev` starts both); RIDGELINE_API
// lets a second copy run side by side on other ports.
const api = process.env.RIDGELINE_API || 'http://localhost:3000';

export default defineConfig({
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: api, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // MapLibre is ~1 MB and changes rarely; its own chunk stays cached across app releases.
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ }] },
      },
    },
  },
});
