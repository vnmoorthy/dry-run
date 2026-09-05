import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: { open: false, port: 5173 },
  esbuild: { target: 'es2022' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ledger: resolve(__dirname, 'ledger.html'),
      },
    },
  },
});
