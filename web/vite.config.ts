import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:38080',
        changeOrigin: true,
      },
      '/health': 'http://localhost:38080',
      '/status': 'http://localhost:38080',
      '/mcp': 'http://localhost:38080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
