import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: resolve('e2e/harness'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve('e2e/harness/dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('e2e/harness/karaoke.html') },
  },
});
