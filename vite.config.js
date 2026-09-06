import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Served from https://<user>.github.io/battleground.io/ on GitHub Pages, so production
  // asset URLs need that path prefix. The dev server stays at the root.
  base: command === 'build' ? '/battleground.io/' : '/',
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8090',
        ws: true,
      },
    },
  },
}));
