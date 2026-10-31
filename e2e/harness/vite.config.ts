import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// builds the karaoke wipe harness used by e2e/karaoke.spec.ts
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
