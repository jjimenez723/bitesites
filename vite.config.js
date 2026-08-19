import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const releaseId = process.env.VITE_SITE_VERSION
  || process.env.GITHUB_SHA?.slice(0, 12)
  || `build-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)}`;

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SITE_VERSION': JSON.stringify(releaseId)
  },
  server: {
    port: 5173,
    // Every /api/* route is a Firebase Hosting rewrite onto a Cloud Function
    // (see firebase.json), so the Vite dev server has nothing behind those
    // paths and answers 404 — which is what Bit's session open, and the
    // analytics beacon before it, were hitting. Proxying to a deployed
    // Hosting origin lets the rewrites themselves do the path-to-function
    // mapping, so this stays one line instead of a table that drifts.
    //
    // The default target is the Firebase origin rather than the apex domain
    // because the apex sits behind Cloudflare, and a cached edge is not what
    // you want to develop against. Point VITE_API_ORIGIN at the emulator
    // (or anywhere else) to keep dev traffic off production data.
    proxy: {
      '/api': {
        target: process.env.VITE_API_ORIGIN || 'https://bitesites-org.web.app',
        changeOrigin: true
      }
    }
  },
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
