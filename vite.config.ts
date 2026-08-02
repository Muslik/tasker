import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const apiOrigin = process.env.TASKER_API_ORIGIN ?? 'http://127.0.0.1:4311';
const parsedApiOrigin = new URL(apiOrigin);
if (!['http:', 'https:'].includes(parsedApiOrigin.protocol)) {
  throw new Error(`Invalid TASKER_API_ORIGIN protocol: ${parsedApiOrigin.protocol}`);
}

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
      '/api/': parsedApiOrigin.origin,
    },
  },
});
