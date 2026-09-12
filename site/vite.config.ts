import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'node:path';

// GitHub Pages serves this from /<repo>/, so the base path must be relative rather than
// absolute -- otherwise assets 404 the moment the repo is not named exactly as assumed.
export default defineConfig({
  base: './',
  plugins: [preact()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // The dataset lives in public/data and is copied verbatim; it must never be inlined
    // into a JS chunk, so keep the assets limit low to catch accidental imports.
    assetsInlineLimit: 4096,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // A stable, human-readable chunk name makes the CI bundle budget readable.
        entryFileNames: 'assets/app.[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  worker: { format: 'es' },
  server: { host: '0.0.0.0', port: 5173, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
