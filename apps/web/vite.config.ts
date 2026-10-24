import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ports can be overridden to run a second copy side by side (e.g. a demo data dir).
const apiPort = Number(process.env.SHIPYARD_PORT ?? 4317);
const webPort = Number(process.env.SHIPYARD_WEB_PORT ?? 5317);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
});
