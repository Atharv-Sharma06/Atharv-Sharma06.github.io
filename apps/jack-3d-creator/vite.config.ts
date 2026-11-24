import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative asset paths, so the built page works from any folder (a GitHub Pages subpath, for example).
export default defineConfig({
  base: './',
  plugins: [react()],
});
