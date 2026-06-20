import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `base` is overridable via env so a project-page deploy (e.g. GitHub Pages at
// /Pharmacographer/) can set VITE_BASE without touching this file. Defaults to
// root for local dev and user/organisation pages.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Explicit imports from 'vitest' in test files (globals stay off) — keeps
    // the engine and tests honest about their dependencies.
    globals: false,
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/data/**'],
      reporter: ['text', 'html'],
    },
  },
});
