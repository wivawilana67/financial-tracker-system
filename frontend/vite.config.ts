import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In local development the browser calls /api on the Vite server, which forwards it to Django.
// docker compose sets API_PROXY_TARGET=http://api:8000; outside Docker it defaults to localhost.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:8000', changeOrigin: true },
    },
  },
});
