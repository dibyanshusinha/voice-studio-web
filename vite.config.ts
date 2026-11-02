/** Configures React compilation and the local static development server; no inference backend is started. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  // Relative URLs allow the same build to work at / and GitHub Pages repository paths.
  base: './'
});
