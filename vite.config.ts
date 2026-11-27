import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { lightRule } from './src/styles/lightTheme';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        {
          postcssPlugin: 'zenith-light-theme',
          Once(root) {
            const file = root.source?.input.file ?? '';
            // nakładka z tekstem wisi nad pulpitem, więc zostaje ciemna w obu motywach
            if (file.includes('node_modules') || /[\\/]overlay[\\/]/.test(file)) return;
            root.walkRules((r) => {
              const decls = r.nodes.flatMap((n) =>
                n.type === 'decl' ? [{ prop: n.prop, value: n.value, important: n.important }] : []
              );
              const light = lightRule(r.selectors, decls);
              if (!light) return;
              const copy = r.clone({ selector: light.selector }).removeAll();
              r.after(copy.append(...light.decls.map((d) => ({ ...d, source: r.source }))));
            });
          },
        },
      ],
    },
  },
  // worker romanizacji dociąga słowniki dynamicznym importem, a format iife nie dzieli kodu
  worker: { format: 'es' as const },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
        mini: path.resolve(__dirname, 'mini.html'),
      },
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}));
