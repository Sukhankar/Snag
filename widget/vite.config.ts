import { defineConfig } from 'vite';

// Library mode → one self-executing widget.min.js, no external imports, no CSS file
// (styles are injected into the closed shadow root at runtime).
export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'terser',
    terserOptions: {
      compress: { passes: 3, pure_getters: true },
      format: { comments: false },
    },
    lib: {
      entry: 'src/index.tsx',
      name: 'Snag',
      formats: ['iife'],
      fileName: () => 'widget.min.js',
    },
  },
});
