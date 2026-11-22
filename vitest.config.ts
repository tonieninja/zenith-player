import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/__tests__/setup.ts'],
    // bez tego import App.css?raw jest pusty, a test warstw menu i okien porównuje z-index z tego pliku
    css: { include: [/App\.css/] },
  },
});
