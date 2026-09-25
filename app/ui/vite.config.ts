import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 1420,
    strictPort: true,
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    // Allow Cloudflare tunnel hostnames on mobile devices
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'https://windows-live-translation-app-1.onrender.com',
        changeOrigin: true,
        secure: false,
      },
      '/call': {
        target: 'wss://windows-live-translation-app-1.onrender.com',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: true,
  },
});
