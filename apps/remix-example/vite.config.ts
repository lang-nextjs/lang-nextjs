import { vitePlugin as remix } from '@remix-run/dev';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [remix()],
  server: {
    hmr: { port: 24680 },
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'ai', '@ai-sdk/react'],
  },
});
