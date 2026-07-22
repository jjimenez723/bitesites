import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // Split the vendors that change on a different cadence from our code, so
        // a copy tweak does not invalidate the cached React runtime. Firebase is
        // reached through a dynamic import (see src/lib/firestore.js) and lands
        // in its own chunk, which is what keeps it off the startup path.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Callable Functions are reached from one button in the admin Users
          // tab. Left in the 'firebase' chunk below they would ride along with
          // the analytics writes every visitor makes, so they get their own.
          if (id.includes('/@firebase/functions') || id.includes('/firebase/functions')) {
            return 'firebase-functions';
          }
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase';
          if (id.includes('/react-router')) return 'router';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react';
          return undefined;
        }
      }
    }
  }
});
