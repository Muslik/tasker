import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/cockpit',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  publicDir: false,
  build: {
    outDir: '../../dist/cockpit',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    proxy: {
      '/api/': 'http://127.0.0.1:4311',
    },
  },
});
