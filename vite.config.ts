import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: [
      ".ngrok-free.dev",
      ".ngrok-free.app",
      ".ngrok.dev",
      ".ngrok.app",
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Only process node_modules to avoid conflicts with your own source code
          if (id.includes('node_modules')) {

            // 1. Separate Firebase
            if (id.includes('firebase')) {
              return 'vendor-firebase';
            }

            // 2. Separate TanStack Query
            if (id.includes('@tanstack')) {
              return 'vendor-query';
            }

            // 3. Separate React Router
            if (id.includes('react-router') || id.includes('@remix-run')) {
              return 'vendor-router';
            }

            // 3b. Separate xlsx (large library, only needed for exports)
            if (id.includes('xlsx')) {
              return 'vendor-xlsx';
            }

            // 3c. Separate recharts (large, only needed for chart pages)
            if (id.includes('recharts')) {
              return 'vendor-recharts';
            }

            // 4. COMBINED CHUNK: React + UI Libraries
            // We combine these to fix the 'createContext' error.
            // Libraries like @radix-ui need direct, synchronous access to React.
            const reactEcosystem = [
              'react',
              'react-dom',
              '@radix-ui',      // This was causing the crash
              'lucide-react',
              'sonner',
              'class-variance-authority',
              'clsx',
              'tailwind-merge'
            ];

            if (reactEcosystem.some(lib => id.includes(lib))) {
              return 'vendor-react'; // All UI and React go into this single file
            }
          }

          // Return undefined for everything else (src files, other small utilities)
          return undefined;
        },
        // Ensure consistent hashed filenames for cache busting
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
