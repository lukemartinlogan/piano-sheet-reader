import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built bundle also works from a file:// origin,
  // which is what Capacitor serves when we wrap this for iOS/Android.
  base: './',
  server: { port: 5173, open: true },
});
